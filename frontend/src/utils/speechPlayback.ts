import type { SpeechClip } from '../../../packages/contracts/src'

let active: HTMLAudioElement | null = null
let settle: (() => void) | null = null
let generation = 0

/** 停止当前朗读；等待中的片段会立即结束，不再继续播放后续片段。 */
export function stopSpeechPlayback(): void {
  generation += 1
  if (active) {
    active.onended = null
    active.onerror = null
    active.pause()
    active.src = ''
    active = null
  }
  settle?.()
  settle = null
}

/** 依次播放合成片段。浏览器缺少 Audio 或自动播放被拒绝时向调用方报错。 */
export async function playSpeechClips(clips: SpeechClip[]): Promise<void> {
  stopSpeechPlayback()
  const mine = generation
  if (typeof Audio === 'undefined') throw new Error('当前环境不支持音频播放。')
  for (const clip of clips) {
    if (mine !== generation) return
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(`data:${clip.mimeType};base64,${clip.base64}`)
      active = audio
      settle = resolve
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error('音频播放失败。'))
      void audio.play().catch(reject)
    }).finally(() => { if (active && generation === mine) active = null; settle = null })
  }
  if (mine === generation) active = null
}
