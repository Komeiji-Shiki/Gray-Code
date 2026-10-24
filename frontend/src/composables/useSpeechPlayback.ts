import { nextTick, onBeforeUnmount, ref } from 'vue'
import type { AppSettings, SpeechSynthesisResult } from '../../../packages/contracts/src'
import { speechSegments } from '@shared/speech'
import { onMessageFromExtension, sendToExtension } from '@/utils/vscode'
import { playClip } from '@/utils/speechPlayback'
import { t } from '@/i18n'
import type { Message, StreamChunk } from '@/types'

export const speechPlaying = ref(false)
export const speechMessageId = ref<string>()
export const speechEnabled = ref(false)
export const speechAutoPlay = ref(false)

let session: AbortController | null = null
let configSequence = 0
const autoSpoken = new Set<string>()

/** 朗读失败显示在聊天错误条里；这个错误码不在可重试列表中，只提供关闭。 */
export function speechFailure(error: unknown): { code: string; message: string } {
  return { code: 'SPEECH_ERROR', message: t('components.message.speech.failed', { message: error instanceof Error ? error.message : String(error) }) }
}

/** 智能体之间的消息只读正文，不读「From → To」元信息。 */
export function speechTextOf(message: Message): string {
  return (message.agentMessage?.text || message.content || '').trim()
}

/** 只采用最后一次读取的结果，设置连续保存时旧的响应不会覆盖新的开关。 */
async function loadSpeechConfig(): Promise<void> {
  const sequence = ++configSequence
  try {
    const settings = await sendToExtension<AppSettings>('platform.settings.get', {})
    if (sequence !== configSequence) return
    speechEnabled.value = settings?.speech?.enabled === true
    speechAutoPlay.value = settings?.speech?.autoPlay === true
  } catch {
    if (sequence !== configSequence) return
    speechEnabled.value = false
    speechAutoPlay.value = false
  }
}

/** 朗读开关被所有消息共用；挂载时读取一次，设置保存后随 settingsChanged 重新读取。 */
export function useSpeechSettingsSync(): void {
  void loadSpeechConfig()
  const dispose = onMessageFromExtension(message => {
    if (message.type === 'settingsChanged') void loadSpeechConfig()
  })
  onBeforeUnmount(dispose)
}

export function stopSpeech(): void {
  session?.abort()
  session = null
  speechPlaying.value = false
  speechMessageId.value = undefined
}

function synthesize(text: string): Promise<SpeechSynthesisResult> {
  const pending = sendToExtension<SpeechSynthesisResult>('speech.synthesize', { text })
  // 停止后不再等待的预取结果不能变成未处理的拒绝。
  pending.catch(() => {})
  return pending
}

/**
 * 朗读一段文字：按句分段，播放当前段的同时合成下一段，首段合成完就开始出声。
 * 再次朗读或停止会中止上一轮，包括仍在合成中的片段。
 */
export async function speak(text: string, messageId?: string): Promise<void> {
  stopSpeech()
  const segments = speechSegments(text)
  if (!segments.length) return
  const controller = new AbortController()
  session = controller
  speechMessageId.value = messageId
  speechPlaying.value = true
  try {
    let next = synthesize(segments[0])
    for (let index = 0; index < segments.length; index++) {
      const { clips } = await next
      if (controller.signal.aborted) return
      if (index + 1 < segments.length) next = synthesize(segments[index + 1])
      for (const clip of clips) await playClip(clip, controller.signal)
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    if (session === controller) {
      session = null
      speechPlaying.value = false
      speechMessageId.value = undefined
    }
  }
}

interface AutoPlayStore {
  currentConversationId: string | null
  allMessages: Message[]
}

/**
 * 只在当前会话收到 complete（整轮任务结束）时自动朗读最后一条助手回复。
 * 审批暂停、取消、出错和切换会话都不是 complete，不会误读铺垫文字或其他会话的消息。
 */
export function useSpeechAutoPlay(store: AutoPlayStore, report: (error: unknown) => void): void {
  const dispose = onMessageFromExtension(message => {
    const chunks = (message.type === 'streamChunk' ? [message.data] : message.type === 'streamChunkBatch' ? message.data : []) as StreamChunk[]
    const conversationId = store.currentConversationId
    if (!chunks.some(chunk => chunk?.type === 'complete' && (chunk.conversationId ?? conversationId) === conversationId)) return
    if (!speechEnabled.value || !speechAutoPlay.value) return
    // 聊天记录先同步处理同一条消息，等它把流式占位替换成持久化消息后再读取。
    void nextTick(() => {
      const last = store.allMessages.at(-1)
      if (!last || last.role !== 'assistant' || last.isSummary || autoSpoken.has(last.id)) return
      const text = speechTextOf(last)
      if (!text) return
      autoSpoken.add(last.id)
      speak(text, last.id).catch(report)
    })
  })
  onBeforeUnmount(dispose)
}
