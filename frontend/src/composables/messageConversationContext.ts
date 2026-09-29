import { inject, type InjectionKey, type Ref } from 'vue'

/** 消息中的文件与任务属于所在对话；工作台项目选择可以独立变化。 */
export const messageConversationKey: InjectionKey<Readonly<Ref<string | null | undefined>>> = Symbol('messageConversation')

export function useMessageConversation() {
  return inject(messageConversationKey, undefined)
}
