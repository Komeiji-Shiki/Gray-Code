import { inject, type InjectionKey, type Ref } from 'vue'
import type { SmoothDisplayText } from '../stores/chat/types'

/** 消息中的文件与任务属于所在对话；工作台项目选择可以独立变化。 */
export const messageConversationKey: InjectionKey<Readonly<Ref<string | null | undefined>>> = Symbol('messageConversation')

/** 错误摘要按消息所在项目显示相对路径，不从当前工作台选择推断路径。 */
export const messageWorkspaceUriKey: InjectionKey<Readonly<Ref<string | undefined>>> = Symbol('messageWorkspaceUri')

/** 每个消息窗口独立解析工具回执，主对话与子代理可能使用相同的调用 ID。 */
export const messageToolResultKey: InjectionKey<(id: string, response?: Record<string, unknown> | null) => Record<string, unknown> | null | undefined> = Symbol('messageToolResult')

/** 显示窗口拥有自己的平滑文本，子代理不把显示状态写入主聊天的会话 Store。 */
export const messageSmoothTextKey: InjectionKey<(id: string) => SmoothDisplayText | undefined> = Symbol('messageSmoothText')

export function useMessageConversation() {
  return inject(messageConversationKey, undefined)
}
