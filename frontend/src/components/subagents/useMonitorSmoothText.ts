import { onBeforeUnmount, provide, shallowReactive, watch, type Ref } from 'vue'
import type { Content, Message } from '../../types'
import type { SmoothDisplayText } from '../../stores/chat/types'
import { useSettingsStore } from '../../stores/settingsStore'
import { isAppendOnlyStreamChange } from '../../stores/agentRun/contentDelta'
import { finishSmoothStream, pushSmoothText } from '../../stores/chat/smoothStreamManager'
import { messageSmoothTextKey } from '../../composables/messageConversationContext'
import { getSmoothTextTail } from '../../composables/useMessageTextTail'

/** 只为当前挂载的流式消息驱动 CharFlow；历史翻页和权威快照直接恢复真实正文。 */
export function useMonitorSmoothText(messages: Readonly<Ref<Message[]>>, contents: () => Content[] | undefined): void {
  const settings = useSettingsStore()
  const texts = shallowReactive(new Map<string, SmoothDisplayText>())
  let activeId: string | undefined
  provide(messageSmoothTextKey, id => texts.get(id))

  function finish() {
    if (!activeId) return
    finishSmoothStream(activeId)
    texts.delete(activeId)
    activeId = undefined
  }

  watch(() => ({ message: messages.value.at(-1), contents: contents(), mode: settings.smoothStreaming }), (current, previous) => {
    const message = current.message
    const tail = message?.streaming ? getSmoothTextTail(message) : null
    if (!message || !tail || !current.contents || current.mode === 'off') { finish(); return }
    if (activeId && activeId !== message.id) finish()
    const before = previous?.message ? getSmoothTextTail(previous.message) : null
    if (activeId === message.id && previous?.mode === current.mode && before?.partKey === tail.partKey && before.text === tail.text) return

    const appending = previous?.message?.streaming && previous.message.id === message.id && previous.mode === current.mode
      && previous.contents && isAppendOnlyStreamChange(previous.contents, current.contents)
    const base = appending ? (before?.partKey === tail.partKey ? before.text : '') : tail.text
    // 快照改写先交还真实正文，下一次追加再恢复平滑，确保旧段落的 Markdown 宿主也已释放。
    if (activeId === message.id && (!appending || tail.text.length < base.length)) { finish(); return }
    const baseText = tail.text.length < base.length ? tail.text : base
    activeId = message.id
    pushSmoothText(message.id, tail.partKey, tail.text.slice(baseText.length), current.mode, baseText, (id, partKey, text) => {
      const old = texts.get(id)
      if (!old || old.partKey !== partKey || old.text !== text) texts.set(id, { partKey, text })
    })
  }, { immediate: true })
  onBeforeUnmount(finish)
}
