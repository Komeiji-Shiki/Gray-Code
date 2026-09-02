/**
 * backgroundTaskStore ↔ chatStore 单向桥接（解耦第五批）
 *
 * 背景：chatStore ↔ backgroundTaskStore 曾是双向耦合——
 * - chatStore → chat/queueActions → backgroundTaskStore（flushReportsAfterAction 运行时调用）；
 * - backgroundTaskStore → chatStore（setup 内 useChatStore() 读取会话忙闲/归属状态 + watch + sendMessage/cancelStream）。
 * 模块级 import 环是初始化幂等/HMR 补丁（disposeChatStreamListener / initializedChatStates）
 * 存在的结构性原因之一。
 *
 * 解耦方案（方向收敛为单向 chatStore → backgroundTaskStore）：
 * - chatStore 实例创建时（setup 体内）把「会话状态 + 操作面」注册到本模块的注册表；
 * - backgroundTaskStore 只消费注册表（getChatBridge / resolveChatBridge），不再 import chatStore；
 * - 本模块不静态 import chatStore（仅 type-only import chat/ 下的类型，编译期擦除），
 *   兜底路径使用动态 import，保证任何情况下都不会形成模块级静态循环。
 *
 * 行为保持：
 * - getState() 每次调用都重新读取底层 ref，watch getter 经它求值仍能建立响应式依赖
 *   （与旧实现 watch(() => chatStore.isStreaming) 语义一致）；
 * - resolveChatBridge() 已注册时返回注册桥（单微任务），未注册时动态 import chatStore
 *   兜底包装（真实 store 实例化时会同步自注册；被 mock 的 store 走包装适配）。
 */

import type { Attachment, AgentMessageCardInfo } from '../../types'
import type { SendMessageOptions } from '../chat/messageActions'
import type { CancelStreamOptions } from '../chat/toolActions'
import { ref } from 'vue'
import type { CancelStreamResponse } from '@shared/protocol'

/** 会话忙闲/归属状态快照（每次 getState() 重新求值，保证实时性） */
export interface BackgroundTaskChatState {
  isStreaming: boolean
  isWaitingForResponse: boolean
  currentConversationId: string | null
}

/**
 * agent 间消息卡片本地插入负载（由 backgroundTaskStore 转发给 chatStore）。
 * 后端已把卡片持久化到会话历史；这里只做窗口内的实时同步。
 */
export interface AgentMessageCardInsertPayload {
  /** 卡片元数据 */
  card: AgentMessageCardInfo
  /** 后端最终插入位置；持久化失败时可省略，前端只做本地尾插展示。 */
  insertPosition?: number
  /** true=后端历史已增长；false=仅本地可见回退，不推进后端索引/总数。 */
  persisted: boolean
}

/** chatStore 向 backgroundTaskStore 暴露的会话状态/操作面 */
export interface BackgroundTaskChatBridge {
  /** 实时读取会话状态（供即时判断与 watch getter 求值） */
  getState(): BackgroundTaskChatState
  /** 取消当前流（动作边界替换回合；签名与 useChatStore().cancelStream 一致） */
  cancelStream(options?: CancelStreamOptions): Promise<CancelStreamResponse | void>
  /** 发送消息（签名与 useChatStore().sendMessage 一致） */
  sendMessage(
    messageText: string,
    attachments?: Attachment[],
    options?: SendMessageOptions
  ): Promise<boolean>
  /**
   * 把后端已持久化的 agent 间消息卡片同步插入当前窗口（幂等；
   * 非当前会话/窗口外时由历史加载路径覆盖）。可选：测试 mock 可省略。
   */
  insertAgentMessageCard?(payload: AgentMessageCardInsertPayload): void
}

// 已注册的会话桥用 Vue ref 承载：backgroundTaskStore 的 watch getter 在桥注册前
// （初始化顺序/HMR 重建间隙）也能通过 registeredBridge.value 建立响应式依赖——
// 桥注册/替换时 getter 重新求值并顺带追踪底层 chat ref；若用普通变量，
// 桥未注册时创建的 watch 无任何依赖，注册后也永远不会再求值（watch 永久失效）。
const registeredBridge = ref<BackgroundTaskChatBridge | null>(null)
let fallbackBridge: BackgroundTaskChatBridge | null = null

/**
 * 注册/注销会话桥（chatStore 实例创建时调用；重复注册以最新实例为准）。
 * 传 null 可注销（预留，当前无调用方）。
 */
export function registerChatBridge(bridge: BackgroundTaskChatBridge | null): void {
  registeredBridge.value = bridge
}

/** 同步读取已注册的会话桥；未注册时返回 null（调用方按空闲/无会话兜底） */
export function getChatBridge(): BackgroundTaskChatBridge | null {
  return registeredBridge.value
}

/** 兜底包装的目标形态（兼容真实 store 与测试 mock 的纯对象） */
interface ChatStoreLike {
  isStreaming: boolean
  isWaitingForResponse: boolean
  currentConversationId: string | null
  cancelStream?: (options?: CancelStreamOptions) => Promise<CancelStreamResponse | void>
  sendMessage: (
    messageText: string,
    attachments?: Attachment[],
    options?: SendMessageOptions
  ) => Promise<boolean>
  insertAgentMessageCard?: (payload: AgentMessageCardInsertPayload) => void
}

function wrapChatStore(store: ChatStoreLike): BackgroundTaskChatBridge {
  return {
    getState: () => ({
      isStreaming: store.isStreaming,
      isWaitingForResponse: store.isWaitingForResponse,
      currentConversationId: store.currentConversationId ?? null
    }),
    cancelStream: (options) =>
      store.cancelStream ? store.cancelStream(options) : Promise.resolve({ cancelled: false }),
    sendMessage: (messageText, attachments, options) =>
      store.sendMessage(messageText, attachments, options),
    ...(typeof store.insertAgentMessageCard === 'function'
      ? { insertAgentMessageCard: (payload: AgentMessageCardInsertPayload) => store.insertAgentMessageCard!(payload) }
      : {})
  }
}

/**
 * 异步解析会话桥（flush 路径使用）：
 * - 已注册：直接返回注册桥（单微任务，保持 flush 的重入语义）；
 * - 未注册（chatStore 尚未实例化 / 模块被 mock）：动态 import chatStore 兜底——
 *   真实实例化时 setup 体内会同步自注册；非真实 store（测试 mock）走包装适配。
 */
export async function resolveChatBridge(): Promise<BackgroundTaskChatBridge> {
  if (registeredBridge.value) return registeredBridge.value
  if (fallbackBridge) return fallbackBridge
  const { useChatStore } = await import('../chatStore')
  const store = useChatStore()
  fallbackBridge = registeredBridge.value ?? wrapChatStore(store as unknown as ChatStoreLike)
  return fallbackBridge
}
