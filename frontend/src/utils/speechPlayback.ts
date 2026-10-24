import type { SpeechClip } from '../../../packages/contracts/src'
import { t } from '@/i18n'

function abortError(): Error {
  return new DOMException('Speech playback stopped.', 'AbortError')
}

/** 播放一段音频；signal 中止时立刻停下并以 AbortError 结束，不会留下挂起的 Promise。 */
export function playClip(clip: SpeechClip, signal: AbortSignal): Promise<void> {
  if (typeof Audio === 'undefined') return Promise.reject(new Error(t('components.message.speech.unsupported')))
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const audio = new Audio(`data:${clip.mimeType};base64,${clip.base64}`)
    const finish = (error?: unknown) => {
      signal.removeEventListener('abort', abort)
      audio.onended = null
      audio.onerror = null
      if (error) reject(error)
      else resolve()
    }
    const abort = () => {
      audio.pause()
      audio.removeAttribute('src')
      finish(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    audio.onended = () => finish()
    audio.onerror = () => finish(new Error(t('components.message.speech.playFailed')))
    audio.play().catch(finish)
  })
}
