import { ref } from 'vue'
import type { AppSettings, SpeechSettings, SpeechSynthesisResult } from '../../../packages/contracts/src'
import { sendToExtension } from '@/utils/vscode'
import { playSpeechClips, stopSpeechPlayback } from '@/utils/speechPlayback'

/** 合成开关被多条历史消息共用，读取一次后在短时间内复用，避免每条消息各发一次 IPC。 */
let cached: SpeechSettings | undefined
let cachedAt = 0
let pending: Promise<SpeechSettings | undefined> | null = null
const autoSpoken = new Set<string>()

export const speechPlaying = ref(false)
export const speechMessageId = ref<string>()
export const speechEnabled = ref(false)
export const speechAutoPlay = ref(false)

async function readConfig(): Promise<SpeechSettings | undefined> {
  if (cached && Date.now() - cachedAt < 10_000) return cached
  if (pending) return pending
  pending = sendToExtension<AppSettings>('platform.settings.get', {})
    .then(settings => {
      cached = settings?.speech
      cachedAt = Date.now()
      speechEnabled.value = !!cached?.enabled
      speechAutoPlay.value = !!cached?.autoPlay
      return cached
    })
    .catch(() => { speechEnabled.value = false; speechAutoPlay.value = false; return undefined })
    .finally(() => { pending = null })
  return pending
}

export function ensureSpeechConfig(): Promise<SpeechSettings | undefined> { return readConfig() }
export function invalidateSpeechConfig(): void { cached = undefined; cachedAt = 0 }
export function speechIsSpeaking(messageId?: string): boolean {
  return speechPlaying.value && (!messageId || speechMessageId.value === messageId)
}

async function synthesize(text: string): Promise<SpeechSynthesisResult> {
  return sendToExtension<SpeechSynthesisResult>('speech.synthesize', { text })
}

/** 试听不要求消息上下文，但仍由服务器检查语音合成是否启用。 */
export async function playSpeechSample(text: string): Promise<void> {
  stopSpeechPlayback()
  speechPlaying.value = true
  try { await playSpeechClips((await synthesize(text)).clips) }
  finally { speechPlaying.value = false; speechMessageId.value = undefined }
}

export async function speakMessage(text: string, messageId?: string, options: { automatic?: boolean } = {}): Promise<void> {
  if (!text.trim()) return
  const config = await readConfig()
  if (!config?.enabled) throw new Error('语音合成未启用。')
  if (options.automatic) {
    if (!config.autoPlay || !messageId || autoSpoken.has(messageId)) return
    autoSpoken.add(messageId)
  }
  stopSpeechPlayback()
  speechMessageId.value = messageId
  speechPlaying.value = true
  try { await playSpeechClips((await synthesize(text)).clips) }
  finally {
    speechPlaying.value = false
    speechMessageId.value = undefined
  }
}

export function stopSpeech(): void {
  stopSpeechPlayback()
  speechPlaying.value = false
  speechMessageId.value = undefined
}
