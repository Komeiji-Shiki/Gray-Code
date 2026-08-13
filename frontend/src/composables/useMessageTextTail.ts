import { computed, ref, watch, onUnmounted, type ComputedRef } from 'vue'
import type { Message } from '../types'
import type { RenderBlock } from '../components/message/renderBlocks'
import type { SmoothDisplayText } from '../stores/chat/types'
import { registerSmoothDisplay, unregisterSmoothDisplay } from '../stores/chat/smoothStreamManager'

/**
 * MessageItem 正文活动尾块（text/thought）的平滑流式显示层（F-07 巨型组件拆分）。
 *
 * 从 MessageItem.vue 内联实现原样抽出：
 * - tailInfo：流式期间最后一个 text/thought part 的段落身份（与 smoothText.partKey 对齐）
 * - 正文 text 尾块的 CharFlow 宿主生命周期（注册/释放/渐进 markdown 桥）
 *
 * 语义与原实现严格一致；宿主绑定仍由 watch(primitive partKey) 驱动，避免低频快照反复
 * 注销并重建同一个 CharFlow。
 */
export function useMessageTextTail(
  // 用 getter 而非值快照：props.message 整体替换时（setProps/父组件更新），
  // 值快照会让 tailInfo 持续读到旧 parts，导致 tail 判定滞后（拆分回归修复）。
  getMessage: () => Message,
  isStreaming: ComputedRef<boolean>,
  smoothText: ComputedRef<SmoothDisplayText | undefined>
) {
  // 活动尾块信息：流式期间最后一个 text/thought part（与 smoothText.partKey 匹配）
  // 由 CharFlow 显示层托管。text 尾块在正文挂载独立 host；thought 尾块保留思维卡片，
  // 由 MessageRenderBlock 在中展开预览或完全展开内容中挂载 host。
  const tailInfo = computed<{ type: 'text' | 'thought'; partKey: string } | null>(() => {
    const smooth = smoothText.value
    if (!smooth || !isStreaming.value) return null
    const parts = getMessage().parts
    if (!parts || parts.length === 0) return null
    const lastPart = parts[parts.length - 1]
    if (typeof lastPart.text !== 'string' || !lastPart.text.trim()) return null

    const type = lastPart.thought === true ? 'thought' : 'text'
    const prevPart = parts[parts.length - 2]
    const prevType = prevPart?.thought === true ? 'thought' : 'text'
    if (prevPart && typeof prevPart.text === 'string' && prevType === type) return null

    const key = `${type}:${parts.length - 1}`
    if (key !== smooth.partKey) return null
    return { type, partKey: key }
  })

  function isSmoothThoughtBlock(block: RenderBlock): boolean {
    const tail = tailInfo.value
    return block.type === 'thought' && tail?.type === 'thought' && block.partKey === tail.partKey
  }

  // text 活动尾块 host 生命周期。监听 primitive partKey 而不是整个 smoothText，避免每次
  // 低频快照都注销并重建同一个 CharFlow。
  const tailHostRef = ref<HTMLElement | null>(null)
  let registeredTextHost: HTMLElement | null = null
  let registeredTextMessageId: string | null = null
  let registeredTextPartKey: string | null = null

  // 渐进 markdown：流式期间已定型段落/完整表格行由 CharFlow promote 到这里，
  // 即时渲染格式；未完成尾巴仍在 tailHost 逐字流出。段落切换/终结时清空（稳定块完整接管）。
  const tailRendered = ref('')
  const tailRenderGeneration = ref(0)
  let lastTailRenderedSource = ''
  interface PendingTailRender {
    source: string
    resolve: () => void
  }
  const pendingTailRenders: PendingTailRender[] = []

  function handleTailPromote(text: string, kind: 'delta' | 'replay' = 'delta'): Promise<void> {
    // re-register 会重放完整 promotedText；此时必须替换而不是追加，避免同 host/视图重建时重复。
    tailRendered.value = kind === 'replay' ? text : tailRendered.value + text
    const source = tailRendered.value

    if (lastTailRenderedSource.startsWith(source)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      pendingTailRenders.push({ source, resolve })
    })
  }

  function handleTailMarkdownRendered(source: string): void {
    lastTailRenderedSource = source
    for (let i = pendingTailRenders.length - 1; i >= 0; i--) {
      const pending = pendingTailRenders[i]
      // debounce 可能跳过中间版本；一个较新的完整 source 可以确认多个旧 bridge。
      if (!source.startsWith(pending.source)) continue
      pendingTailRenders.splice(i, 1)
      pending.resolve()
    }
  }

  function resolvePendingTailRenders(): void {
    for (const pending of pendingTailRenders.splice(0)) pending.resolve()
  }

  function releaseTextDisplay(): void {
    if (registeredTextHost && registeredTextMessageId) {
      unregisterSmoothDisplay(registeredTextMessageId, registeredTextHost)
    }
    registeredTextHost = null
    registeredTextMessageId = null
    registeredTextPartKey = null
    resolvePendingTailRenders()
    lastTailRenderedSource = ''
    // 同一 tick 内 S → '' → replay(S) 会被 Vue 合并；换 key 强制新 renderer 发 rendered ack。
    tailRenderGeneration.value++
    // 渐进渲染内容随显示层释放：旧段落由稳定块（renderBlocks）完整接管，避免重复显示
    if (tailRendered.value) tailRendered.value = ''
  }

  watch(
    [
      () => getMessage().id,
      () => tailInfo.value?.type === 'text' ? tailInfo.value.partKey : null,
      tailHostRef
    ],
    ([messageId, partKey, host]) => {
      if (
        registeredTextHost &&
        (
          !partKey ||
          registeredTextHost !== host ||
          registeredTextMessageId !== messageId ||
          registeredTextPartKey !== partKey
        )
      ) {
        releaseTextDisplay()
      }
      if (partKey && host && !registeredTextHost) {
        registerSmoothDisplay(messageId, host, { onPromote: handleTailPromote })
        registeredTextHost = host
        registeredTextMessageId = messageId
        registeredTextPartKey = partKey
      }
    },
    { immediate: true, flush: 'post' }
  )

  // 组件卸载时注销当前组件持有的正文 CharFlow 宿主；按 host 校验，不影响刚切换出的 thought host。
  onUnmounted(() => {
    releaseTextDisplay()
  })

  return {
    tailInfo,
    isSmoothThoughtBlock,
    tailHostRef,
    tailRendered,
    tailRenderGeneration,
    handleTailMarkdownRendered
  }
}
