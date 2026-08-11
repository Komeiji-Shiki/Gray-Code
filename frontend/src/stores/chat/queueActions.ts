/**
 * Chat Store 消息队列编排
 *
 * 从 chatStore.ts 迁移：排队消息的入队/出队/编辑/排序/立即发送，
 * 以及回合结束（processQueue）与动作边界（processQueueAfterAction）的自动投递编排。
 *
 * 依赖约定（与 chat/ 其他模块一致）：
 * - 响应式队列状态 state.messageQueue 留在 state.ts（Pinia setup store 的响应式状态
 *   必须留在 store 的 state 内），本模块函数以 state 为第一参数访问；
 * - sendMessage / cancelStream 等绑定 state/computed 的 store 层函数经 QueueActionDeps
 *   注入（chatStore.ts 的薄包装传入），避免循环依赖，同时保证与 store 公开 API 同源；
 * - useBackgroundTaskStore（P2 回执投递）为跨 store 依赖，直接模块级引用。
 */

import type { Attachment } from '../../types'
import type { ChatStoreState, QueuedMessage } from './types'
import type { SendMessageOptions } from './messageActions'
import type { CancelStreamOptions } from './toolActions'
import { sendToExtension } from '../../utils/vscode'
import { generateId } from '../../utils/format'
import { useBackgroundTaskStore } from '../backgroundTaskStore'

/**
 * 队列编排依赖：由 chatStore.ts 注入的 store 层函数（绑定 state/computed 的薄包装）。
 */
export interface QueueActionDeps {
  /** 发送消息（store 层包装，签名与 useChatStore().sendMessage 一致） */
  sendMessage: (
    messageText: string,
    attachments?: Attachment[],
    options?: SendMessageOptions
  ) => Promise<boolean>
  /** 取消当前流（store 层包装，签名与 useChatStore().cancelStream 一致） */
  cancelStream: (options?: CancelStreamOptions) => Promise<void>
}

/**
 * 将消息加入排队队列
 */
export function enqueueMessage(
  state: ChatStoreState,
  content: string,
  attachments: Attachment[] = [],
  sendOptions?: QueuedMessage['sendOptions']
): void {
  const item: QueuedMessage = {
    id: generateId(),
    content,
    attachments: [...attachments],
    timestamp: Date.now(),
    sendOptions,
    conversationId: state.currentConversationId.value
  }
  state.messageQueue.value = [...state.messageQueue.value, item]

  // 用户在响应期间发话：若当前会话正有前台命令在等待，将其转入后台，
  // 让本轮尽快结束、排队消息尽快送达（命令结果稍后以回执回流唤醒模型）。
  // 空闲时无前台命令可转移，跳过无效 IPC。
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    void sendToExtension('terminal.detachToBackground', {
      conversationId: state.currentConversationId.value
    }).catch(() => {})
  }
}

/**
 * 取出队列第一条消息
 */
export function dequeueMessage(state: ChatStoreState): QueuedMessage | null {
  const queue = state.messageQueue.value
  if (queue.length === 0) return null
  const first = queue[0]
  state.messageQueue.value = queue.slice(1)
  return first
}

/**
 * 取出队列中第一条属于指定会话的消息（无 conversationId 视为本会话消息）。
 *
 * 跨会话投递防护：跳过不属于当前会话的消息，取第一条属于当前会话的，
 * 避免跨会话消息卡死队头阻塞后续消息。processQueue 与 processQueueAfterAction
 * 共用此逻辑，返回剩余队列供调用方重新赋值。
 */
function takeNextForConversation(
  queue: QueuedMessage[],
  conversationId: string | null
): { next: QueuedMessage; rest: QueuedMessage[] } | null {
  const matchIndex = queue.findIndex(m =>
    typeof m.conversationId !== 'string' || m.conversationId === conversationId
  )
  if (matchIndex === -1) return null
  const [next] = queue.splice(matchIndex, 1)
  return { next, rest: queue }
}

/**
 * 移除队列中指定消息
 */
export function removeQueuedMessage(state: ChatStoreState, id: string): void {
  state.messageQueue.value = state.messageQueue.value.filter(m => m.id !== id)
}

/**
 * 移动队列中的消息（拖拽排序）
 */
export function moveQueuedMessage(state: ChatStoreState, fromIndex: number, toIndex: number): void {
  const queue = [...state.messageQueue.value]
  if (fromIndex < 0 || fromIndex >= queue.length) return
  if (toIndex < 0 || toIndex >= queue.length) return
  if (fromIndex === toIndex) return

  const [item] = queue.splice(fromIndex, 1)
  queue.splice(toIndex, 0, item)
  state.messageQueue.value = queue
}

/**
 * 更新队列中指定消息的内容和附件（编辑）
 */
export function updateQueuedMessage(
  state: ChatStoreState,
  id: string,
  content: string,
  attachments: Attachment[]
): void {
  state.messageQueue.value = state.messageQueue.value.map(m =>
    m.id === id
      ? { ...m, content, attachments: [...attachments] }
      : m
  )
}

/**
 * 立即发送队列中指定消息。
 * 正在响应时先把前台 SubAgent 转为后台，再取消旧回合并发送新消息。
 */
export async function sendQueuedMessageNow(
  state: ChatStoreState,
  deps: QueueActionDeps,
  id: string
): Promise<void> {
  const item = state.messageQueue.value.find(m => m.id === id)
  if (!item) return

  // 从队列中移除
  removeQueuedMessage(state, id)

  // “立即发送”会替换当前回合；先要求后端同步解除前台 SubAgent 的父信号绑定，
  // 再取消旧流，避免子 Agent 在新流创建前已经被父级 abort 终止。
  if (state.isWaitingForResponse.value) {
    await deps.cancelStream({ preserveSubAgents: true })
  }

  // 发送消息
  const sent = await deps.sendMessage(item.content, item.attachments, item.sendOptions)
  // 发送失败（sendMessage 内部已 catch）：放回队首，等待下次动作边界/回合结束重试，
  // 与 processQueue 的失败回退语义一致，避免消息被静默丢弃
  if (!sent) {
    console.error('[chatStore] Failed to send queued message immediately, put back to queue head')
    state.messageQueue.value = [item, ...state.messageQueue.value]
  }
}

/**
 * 处理队列：AI 响应结束后自动取出下一条消息发送
 *
 * 在 handleComplete / handleCancelled / handleError 中被调用
 */
export async function processQueue(state: ChatStoreState, deps: QueueActionDeps): Promise<void> {
  // 如果仍在响应中，不处理
  if (state.isWaitingForResponse.value) return

  // 跨会话投递防护：只投递属于当前会话的消息（无 conversationId 视为本会话），
  // 避免跨会话消息卡死队头阻塞后续消息
  const taken = takeNextForConversation(state.messageQueue.value, state.currentConversationId.value)
  if (!taken) return
  const { next, rest } = taken
  state.messageQueue.value = rest

  // 发送下一条排队消息；失败时放回队首（去重防死循环），
  // 避免「我排队的消息丢了」（M4）
  const sent = await deps.sendMessage(next.content, next.attachments, next.sendOptions)
  if (!sent) {
    const currentQueue = state.messageQueue.value
    if (!currentQueue.some(m => m.id === next.id)) {
      state.messageQueue.value = [next, ...currentQueue]
    }
  }
}

/**
 * 自动投递进行中标记（按 store state 实例隔离，与 windowUtils 的可见消息缓存同模式）：
 * 防止 toolIteration 边界的连续触发重入
 * （cancelStream 的 IPC 往返是异步的，在 sendMessage 完成前禁止再次投递）。
 */
const queueAfterActionDrainingByState = new WeakMap<ChatStoreState, boolean>()

/**
 * 处理队列（动作边界，P1）：LLM 执行完当前动作（非终结 toolIteration，流继续）后
 * 立即自动取出下一条排队消息发送，不再等待整个回合完整结束。
 *
 * 与 sendQueuedMessageNow 完全同构（取消旧流替换当前回合 + 发送新回合），
 * 因此复用其全部安全保证：
 * 1. 动作彻底结束：toolIteration 由后端在工具结果 settleFunctionResponses/addContent
 *    全部落盘后才发出，当前动作已完整持久化，不存在半截动作；
 * 2. 历史不丢序：cancelStream({ preserveSubAgents: true }) 替换当前回合后，新流由
 *    webview 层 awaitOldStreamCompletion 与后端 waitForOldStreamExit 保证在旧流
 *    finally 完全退出（含工具结算落盘）后才写入新用户消息（H1 写序竞态防护），
 *    插入点之前的完整历史保持原样、不会丢失；
 * 3. 发送失败时把消息放回队首（保持原顺序），避免排队消息静默丢失；
 * 4. 跨会话防护与 processQueue 一致：只投递属于当前会话的消息；
 * 5. 投递窗口（cancelStream/sendMessage 的 IPC 往返）内会话切换或并发发送者
 *    抢先开启新流时，放弃本次投递并放回队列，杜绝「发错会话」与「排队消息
 *    降级为 inbox 中断（乱序且可能滞留不被送达）」。
 */
export async function processQueueAfterAction(state: ChatStoreState, deps: QueueActionDeps): Promise<void> {
  // 投递进行中（cancelStream/sendMessage 未完成）不重入
  if (queueAfterActionDrainingByState.get(state) === true) return

  // 记录投递目标会话：cancelStream 往返期间用户可能切换会话，
  // 用取消息时的会话 ID 做归属校验（跨会话跳过逻辑与 processQueue 一致）
  const currentId = state.currentConversationId.value
  const taken = takeNextForConversation(state.messageQueue.value, currentId)
  if (!taken) {
    // P2 回执完成即插入：无排队消息可投递时，动作边界提前投递已完成后台
    // 任务（后台子代理/后台命令）的回执——与排队消息同构（cancelStream 替换
    // 当前回合 + 新 chatStream），不再等待整个回合完整结束。
    // 队列非空时排队消息优先，回执等下一个动作边界或回合结束补发。
    // 回执投递窗口同样受 queueAfterActionDraining 保护（cancelStream 的 IPC
    // 往返期间不与其他动作边界投递交叠），内部另有 flushing 防重复回流。
    queueAfterActionDrainingByState.set(state, true)
    try {
      await useBackgroundTaskStore().flushReportsAfterAction()
    } finally {
      queueAfterActionDrainingByState.set(state, false)
    }
    return
  }
  const { next, rest } = taken
  state.messageQueue.value = rest

  queueAfterActionDrainingByState.set(state, true)
  try {
    // 当前回合仍在响应中（动作边界必然如此，防御性判断以兼容迟到的调度）：
    // 替换当前回合前先把前台 SubAgent 转为后台，再取消旧流。
    if (state.isWaitingForResponse.value) {
      await deps.cancelStream({ preserveSubAgents: true })
    }

    // 投递窗口内会话已切换（tab 切换）：放回队列——消息保留自身 conversationId，
    // 由跨会话跳过逻辑保护，绝不投递到错误会话。
    if (state.currentConversationId.value !== currentId) {
      state.messageQueue.value = [next, ...state.messageQueue.value]
      return
    }

    // 投递窗口内已有其他发送者（手动发送/后台任务回执/立即发送等）抢先开启新流：
    // 放回队列等下一个动作边界或回合终结时再试——此时 sendMessage 的忙时分支会把
    // 消息降级为 inbox 中断（乱序投递、4000 字符上限、回合无工具调用时可能滞留），
    // 不符合排队消息「成为真实新回合」的语义。
    if (state.isStreaming.value || state.isWaitingForResponse.value) {
      state.messageQueue.value = [next, ...state.messageQueue.value]
      return
    }

    const sent = await deps.sendMessage(next.content, next.attachments, next.sendOptions)
    if (!sent) {
      // 发送未成功（IPC 失败 / 会话切换校验未过等）：放回队首保持原顺序，
      // 由下一个动作边界或回合终结时再次尝试，不静默丢弃排队消息。
      state.messageQueue.value = [next, ...state.messageQueue.value]
    }
  } finally {
    queueAfterActionDrainingByState.set(state, false)
  }
}
