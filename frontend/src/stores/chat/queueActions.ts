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

import { MESSAGE_NAMES, type CancelStreamResponse, type ForegroundWorkTransition } from '@shared/protocol'
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
  cancelStream: (options?: CancelStreamOptions) => Promise<CancelStreamResponse | void>
}

/** 入队后仍在等待 terminal.detachToBackground 回执的任务；按 store 隔离，避免标签页串线。 */
const pendingTerminalDetachByState = new WeakMap<ChatStoreState, Map<string, Promise<ForegroundWorkTransition>>>()

function normalizeForegroundWorkTransition(
  value?: Partial<ForegroundWorkTransition>
): ForegroundWorkTransition {
  const terminalCommands = Number.isFinite(value?.terminalCommands)
    ? Math.max(0, Math.floor(value?.terminalCommands ?? 0))
    : 0
  const subAgentTasks = Number.isFinite(value?.subAgentTasks)
    ? Math.max(0, Math.floor(value?.subAgentTasks ?? 0))
    : 0
  return { terminalCommands, subAgentTasks }
}

function mergeForegroundWorkTransitions(
  ...values: Array<Partial<ForegroundWorkTransition> | undefined>
): ForegroundWorkTransition {
  return values.reduce<ForegroundWorkTransition>((total, value) => {
    const normalized = normalizeForegroundWorkTransition(value)
    return {
      terminalCommands: total.terminalCommands + normalized.terminalCommands,
      subAgentTasks: total.subAgentTasks + normalized.subAgentTasks
    }
  }, { terminalCommands: 0, subAgentTasks: 0 })
}

function withForegroundWorkTransition(
  options: QueuedMessage['sendOptions'],
  transition: ForegroundWorkTransition
): QueuedMessage['sendOptions'] {
  if (transition.terminalCommands + transition.subAgentTasks === 0) return options
  return { ...options, foregroundWorkTransition: transition }
}

async function resolveQueuedForegroundWorkTransition(
  state: ChatStoreState,
  item: QueuedMessage
): Promise<ForegroundWorkTransition> {
  const pending = pendingTerminalDetachByState.get(state)?.get(item.id)
  if (!pending) {
    return normalizeForegroundWorkTransition(item.sendOptions?.foregroundWorkTransition)
  }

  try {
    return mergeForegroundWorkTransitions(
      item.sendOptions?.foregroundWorkTransition,
      await pending
    )
  } finally {
    const pendingById = pendingTerminalDetachByState.get(state)
    pendingById?.delete(item.id)
    if (pendingById?.size === 0) pendingTerminalDetachByState.delete(state)
  }
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
  // 空闲时无前台命令可转移，跳过无效 IPC；无会话归属（空白标签页）时
  // conversationId 为 null，无法转移，同样跳过（避免向后端发送 null 会话）
  if ((state.isStreaming.value || state.isWaitingForResponse.value) && state.currentConversationId.value) {
    const pendingById = pendingTerminalDetachByState.get(state) ?? new Map<string, Promise<ForegroundWorkTransition>>()
    pendingTerminalDetachByState.set(state, pendingById)
    const detachPromise = sendToExtension<{ success?: boolean; detached?: unknown }>(
      MESSAGE_NAMES['terminal.detachToBackground'],
      { conversationId: state.currentConversationId.value }
    ).then(result => ({
      terminalCommands: Array.isArray(result?.detached) ? result.detached.length : 0,
      subAgentTasks: 0
    })).catch(() => ({ terminalCommands: 0, subAgentTasks: 0 }))
    pendingById.set(item.id, detachPromise)
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
  pendingTerminalDetachByState.get(state)?.delete(first.id)
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
  pendingTerminalDetachByState.get(state)?.delete(id)
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
 * 更新队列中指定消息的内容和附件（编辑），并在传入了拆分/压缩偏好时
 * 合并进 sendOptions（保留其余选项，如 dynamicContextStrategyOverride）。
 */
export function updateQueuedMessage(
  state: ChatStoreState,
  id: string,
  content: string,
  attachments: Attachment[],
  deepSeekVisionTileSplit?: boolean
): void {
  state.messageQueue.value = state.messageQueue.value.map(m =>
    m.id === id
      ? {
          ...m,
          content,
          attachments: [...attachments],
          ...(deepSeekVisionTileSplit !== undefined
            ? { sendOptions: { ...m.sendOptions, deepSeekVisionTileSplit } }
            : {})
        }
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

  let foregroundWorkTransition = await resolveQueuedForegroundWorkTransition(state, item)
  item.sendOptions = withForegroundWorkTransition(item.sendOptions, foregroundWorkTransition)
  // 等待 terminal detach 回执后再移除，确保只上报实际成功转后台的命令。
  removeQueuedMessage(state, id)

  // “立即发送”会替换当前回合；先要求后端同步解除前台 SubAgent 的父信号绑定，
  // 再取消旧流，避免子 Agent 在新流创建前已经被父级 abort 终止。
  // cancelStream 抛错（本地状态机异常/IPC 意外失败）时本次投递中止：把消息放回队首
  // 保持原顺序，等待下次动作边界/回合结束重试，保证任何路径下排队消息不静默丢失。
  if (state.isWaitingForResponse.value) {
    try {
      const cancelResult = await deps.cancelStream({ preserveSubAgents: true })
      foregroundWorkTransition = mergeForegroundWorkTransitions(
        foregroundWorkTransition,
        cancelResult?.foregroundWorkTransition
      )
      item.sendOptions = withForegroundWorkTransition(item.sendOptions, foregroundWorkTransition)
    } catch (err) {
      console.error('[chatStore] cancelStream failed during immediate send, put back to queue head:', err)
      state.messageQueue.value = [item, ...state.messageQueue.value]
      throw err
    }
  }

  // 发送消息
  const sent = await deps.sendMessage(
    item.content,
    item.attachments,
    item.sendOptions
  )
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
  const foregroundWorkTransition = await resolveQueuedForegroundWorkTransition(state, next)

  // 发送下一条排队消息；发送失败（IPC 异常等）时放回队首保持原顺序，
  // 由下一个投递时机再次尝试，不静默丢弃排队消息
  next.sendOptions = withForegroundWorkTransition(next.sendOptions, foregroundWorkTransition)
  const sent = await deps.sendMessage(
    next.content,
    next.attachments,
    next.sendOptions
  )
  if (!sent) {
    state.messageQueue.value = [next, ...state.messageQueue.value]
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
    let foregroundWorkTransition = await resolveQueuedForegroundWorkTransition(state, next)
    next.sendOptions = withForegroundWorkTransition(next.sendOptions, foregroundWorkTransition)
    // 当前回合仍在响应中（动作边界必然如此，防御性判断以兼容迟到的调度）：
    // 替换当前回合前先把前台 SubAgent 转为后台，再取消旧流。
    if (state.isWaitingForResponse.value) {
      const cancelResult = await deps.cancelStream({ preserveSubAgents: true })
      foregroundWorkTransition = mergeForegroundWorkTransitions(
        foregroundWorkTransition,
        cancelResult?.foregroundWorkTransition
      )
      next.sendOptions = withForegroundWorkTransition(next.sendOptions, foregroundWorkTransition)
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

    const sent = await deps.sendMessage(
      next.content,
      next.attachments,
      next.sendOptions
    )
    if (!sent) {
      // 发送未成功（IPC 失败 / 会话切换校验未过等）：放回队首保持原顺序，
      // 由下一个动作边界或回合终结时再次尝试，不静默丢弃排队消息。
      state.messageQueue.value = [next, ...state.messageQueue.value]
    }
  } finally {
    queueAfterActionDrainingByState.set(state, false)
  }
}
