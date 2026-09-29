import { inject, type InjectionKey, type Ref } from 'vue'

/** 消息中的文件与任务属于所在对话；工作台项目选择可以独立变化。 */
export const messageConversationKey: InjectionKey<Readonly<Ref<string | null | undefined>>> = Symbol('messageConversation')

/** 每个消息窗口独立解析工具回执，主对话与子代理可能使用相同的调用 ID。 */
export const messageToolResultKey: InjectionKey<(id: string, response?: Record<string, unknown> | null) => Record<string, unknown> | null | undefined> = Symbol('messageToolResult')

export function useMessageConversation() {
  return inject(messageConversationKey, undefined)
}
