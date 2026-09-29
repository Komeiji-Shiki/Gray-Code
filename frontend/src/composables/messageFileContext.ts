import { inject, type InjectionKey, type Ref } from 'vue'

/** 消息中的相对文件属于所在对话；工作台项目选择可以独立变化。 */
export const messageFileConversationKey: InjectionKey<Readonly<Ref<string | null | undefined>>> = Symbol('messageFileConversation')

export function useMessageFileConversation() {
  return inject(messageFileConversationKey, undefined)
}
