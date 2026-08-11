/**
 * 声音提醒音频引擎：AudioContext 管理、解码缓存（含退避）与播放原语
 *
 * 设计目标：
 * - 默认优先使用扩展内置音效文件（resources/sound）；若不可用则回退到 Oscillator 生成提示音
 * - 支持导入本地音效覆盖
 * - 任何播放失败都必须被吞掉（不能影响主流程）
 */

import { clampNumber, currentSettings, DEFAULT_UI_SOUND_SETTINGS } from './soundCueSettings'
import type { NormalizedUISoundSettings, UISoundAsset, SoundCue } from './soundCueSettings'
import { inFlightPlayByKey, lastPlayedAtByKey } from './soundPlayback'

let audioContext: AudioContext | null = null
export let masterGain: GainNode | null = null
// 活跃播放节点（用于页面切换/卸载时中止试听）
const activeBufferSources = new Set<AudioBufferSourceNode>()
export const activeOscillators = new Set<OscillatorNode>()

// base64/url -> AudioBuffer 缓存（避免重复 decode）
const decodedAudioBufferCache = new Map<string, AudioBuffer>()
const decodingPromises = new Map<string, Promise<AudioBuffer>>()
const decodeFailureRetryAt = new Map<string, number>()
const DECODE_FAILURE_BACKOFF_MS = 30_000

export function pruneDecodedAudioCache(assets: NormalizedUISoundSettings['assets']): void {
  const keep = new Set<string>()
  for (const asset of Object.values(assets)) {
    if (asset?.dataBase64) {
      keep.add(asset.dataBase64)
    }
  }

  for (const key of Array.from(decodedAudioBufferCache.keys())) {
    // url:* 属于内置默认音效的缓存，不做清理
    if (key.startsWith('url:')) continue
    if (!keep.has(key)) {
      decodedAudioBufferCache.delete(key)
    }
  }

  // 同步清理解码中/失败退避缓存，避免移除音效后残留占位（重复解码或永久退避）
  for (const key of Array.from(decodingPromises.keys())) {
    if (key.startsWith('url:')) continue
    if (!keep.has(key)) {
      decodingPromises.delete(key)
    }
  }
  for (const key of Array.from(decodeFailureRetryAt.keys())) {
    if (key.startsWith('url:')) continue
    if (!keep.has(key)) {
      decodeFailureRetryAt.delete(key)
    }
  }
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window.AudioContext || (window as any).webkitAudioContext || null) as typeof AudioContext | null
}

function computeMasterGainValue(volume: number): number {
  // 将 0-100 映射到 0-0.2，避免 100% 时过于刺耳
  const maxGain = 0.2
  return (clampNumber(volume, 0, 100, DEFAULT_UI_SOUND_SETTINGS.volume) / 100) * maxGain
}

export function updateMasterGain(): void {
  if (!masterGain) return
  masterGain.gain.value = computeMasterGainValue(currentSettings.volume)
}

export function getOrCreateAudioGraph(): AudioContext | null {
  const Ctor = getAudioContextCtor()
  if (!Ctor) return null

  if (audioContext && audioContext.state !== 'closed') {
    return audioContext
  }

  audioContext = new Ctor()
  masterGain = audioContext.createGain()
  updateMasterGain()
  masterGain.connect(audioContext.destination)
  return audioContext
}

export async function unlockAudio(): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = getOrCreateAudioGraph()
    if (!ctx) {
      return { success: false, error: 'AudioContext not available' }
    }

    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    return { success: ctx.state === 'running' }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * 停止当前所有正在播放的声音（不关闭 AudioContext，避免后续需要重新解锁）
 */
export function stopAllSounds(): void {
  for (const source of Array.from(activeBufferSources)) {
    try {
      source.stop()
    } catch {
      // ignore
    }
    try {
      source.disconnect()
    } catch {
      // ignore
    }
  }
  activeBufferSources.clear()

  for (const osc of Array.from(activeOscillators)) {
    try {
      osc.stop()
    } catch {
      // ignore
    }
    try {
      osc.disconnect()
    } catch {
      // ignore
    }
  }
  activeOscillators.clear()

  // 停止所有声音后清空冷却与播放占位：用户显式停止后立即重播不应被旧冷却拦截
  lastPlayedAtByKey.clear()
  inFlightPlayByKey.clear()
}

type Beep = {
  freq: number
  durationMs: number
  gapMs?: number
}

export function getOscillatorType(theme: NormalizedUISoundSettings['theme']): OscillatorType {
  return theme === 'soft' ? 'sine' : 'square'
}

export function getPatternForCue(cue: SoundCue): Beep[] {
  switch (cue) {
    case 'warning':
      return [{ freq: 440, durationMs: 150 }]
    case 'error':
      return [
        { freq: 220, durationMs: 120, gapMs: 80 },
        { freq: 220, durationMs: 120 }
      ]
    case 'taskComplete':
      return [
        { freq: 660, durationMs: 100, gapMs: 50 },
        { freq: 880, durationMs: 120 }
      ]
    case 'taskError':
      return [
        { freq: 196, durationMs: 120, gapMs: 80 },
        { freq: 196, durationMs: 120 }
      ]
    default:
      return []
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // 移除可能的换行/空格
  const clean = base64.replace(/\s+/g, '')
  const binary = atob(clean)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

async function decodeAudioBuffer(ctx: AudioContext, asset: UISoundAsset): Promise<AudioBuffer> {
  const key = asset.dataBase64
  const retryAt = decodeFailureRetryAt.get(key)
  if (retryAt !== undefined && retryAt > Date.now()) {
    throw new Error('Sound asset decode is temporarily backed off after a previous failure')
  }
  const cached = decodedAudioBufferCache.get(key)
  if (cached) return cached

  const inFlight = decodingPromises.get(key)
  if (inFlight) return inFlight

  const promise = (async () => {
    const arr = base64ToArrayBuffer(asset.dataBase64)
    const buffer = await ctx.decodeAudioData(arr)
    decodedAudioBufferCache.set(key, buffer)
    decodeFailureRetryAt.delete(key)
    return buffer
  })()

  decodingPromises.set(key, promise)
  try {
    return await promise
  } catch (error) {
    decodeFailureRetryAt.set(key, Date.now() + DECODE_FAILURE_BACKOFF_MS)
    throw error
  } finally {
    decodingPromises.delete(key)
  }
}

export async function playSoundAsset(ctx: AudioContext, asset: UISoundAsset, abortSignal?: AbortSignal): Promise<boolean> {
  try {
    if (!masterGain) return false
    if (abortSignal?.aborted) return false

    const buffer = await decodeAudioBuffer(ctx, asset)
    if (abortSignal?.aborted) return false

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(masterGain)
    activeBufferSources.add(source)

    // decode 可能较慢：在 start 前再取一次 currentTime，避免 startAt 过期
    const startAt = ctx.currentTime + 0.01
    source.start(startAt)

    source.onended = () => {
      try {
        activeBufferSources.delete(source)
        source.disconnect()
      } catch {
        // ignore
      }
    }

    return true
  } catch (err) {
    console.warn('[soundCues] playSoundAsset failed:', err)
    return false
  }
}

async function decodeAudioBufferFromUrl(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const key = `url:${url}`
  const retryAt = decodeFailureRetryAt.get(key)
  if (retryAt !== undefined && retryAt > Date.now()) {
    throw new Error('Sound URL decode is temporarily backed off after a previous failure')
  }
  const cached = decodedAudioBufferCache.get(key)
  if (cached) return cached

  const inFlight = decodingPromises.get(key)
  if (inFlight) return inFlight

  const promise = (async () => {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to fetch sound: ${res.status}`)
    }
    const arr = await res.arrayBuffer()
    const buffer = await ctx.decodeAudioData(arr)
    decodedAudioBufferCache.set(key, buffer)
    decodeFailureRetryAt.delete(key)
    return buffer
  })()

  decodingPromises.set(key, promise)
  try {
    return await promise
  } catch (error) {
    decodeFailureRetryAt.set(key, Date.now() + DECODE_FAILURE_BACKOFF_MS)
    throw error
  } finally {
    decodingPromises.delete(key)
  }
}

export async function playSoundUrl(ctx: AudioContext, url: string, abortSignal?: AbortSignal): Promise<boolean> {
  try {
    if (!masterGain) return false
    if (abortSignal?.aborted) return false

    const buffer = await decodeAudioBufferFromUrl(ctx, url)
    if (abortSignal?.aborted) return false

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(masterGain)
    activeBufferSources.add(source)

    const startAt = ctx.currentTime + 0.01
    source.start(startAt)

    source.onended = () => {
      try {
        activeBufferSources.delete(source)
        source.disconnect()
      } catch {
        // ignore
      }
    }

    return true
  } catch (err) {
    console.warn('[soundCues] playSoundUrl failed:', err)
    return false
  }
}
