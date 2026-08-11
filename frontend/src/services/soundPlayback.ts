/**
 * 声音提醒播放编排：冷却控制、播放槽预留与 playCue（asset / beep 双路径）
 *
 * 设计目标：
 * - 默认优先使用扩展内置音效文件（resources/sound）；若不可用则回退到 Oscillator 生成提示音
 * - 支持导入本地音效覆盖
 * - 受控于 UI 设置（enabled/volume/cues/cooldownMs）
 * - 任何播放失败都必须被吞掉（不能影响主流程）
 */

import { getBuiltinSoundAsset, currentSettings } from './soundCueSettings'
import type { SoundCue, SoundAgentRole } from './soundCueSettings'
import {
  activeOscillators,
  getOrCreateAudioGraph,
  getOscillatorType,
  getPatternForCue,
  masterGain,
  playSoundAsset,
  playSoundUrl
} from './soundAudioEngine'

// 冷却按 key 维度隔离（默认全局；可按 conversation 分组）
export const lastPlayedAtByKey = new Map<string, number>()
// 播放中的 key 预占位，避免异步解码/恢复期间并发穿透冷却
export const inFlightPlayByKey = new Map<string, { token: string; reservedAt: number }>()

/**
 * 判断某类提示音是否被当前设置允许播放。
 *
 * 子代理（role === 'subagent'）事件使用 cues.subagent 独立开关，
 * 主代理事件使用 cues 顶层开关；未标注角色的事件按主代理处理（向后兼容）。
 */
export function isCueEnabled(cue: SoundCue, role: SoundAgentRole = 'main'): boolean {
  if (role === 'subagent') {
    switch (cue) {
      case 'warning':
        return currentSettings.cues.subagent.warning
      case 'error':
        return currentSettings.cues.subagent.error
      case 'taskComplete':
        return currentSettings.cues.subagent.taskComplete
      case 'taskError':
        return currentSettings.cues.subagent.taskError
      default:
        return false
    }
  }

  switch (cue) {
    case 'warning':
      return currentSettings.cues.warning
    case 'error':
      return currentSettings.cues.error
    case 'taskComplete':
      return currentSettings.cues.taskComplete
    case 'taskError':
      return currentSettings.cues.taskError
    default:
      return false
  }
}

function getCooldownKey(options: { cooldownKey?: string }): string {
  return options.cooldownKey || '__global__'
}

function createPlaybackReservationToken(): string {
  return `play_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function reservePlaybackSlot(cooldownKey: string, now: number): string | null {
  if (inFlightPlayByKey.has(cooldownKey)) return null

  const cooldown = currentSettings.cooldownMs
  const lastPlayedAt = lastPlayedAtByKey.get(cooldownKey) || 0
  if (cooldown > 0 && now - lastPlayedAt < cooldown) {
    return null
  }

  const token = createPlaybackReservationToken()
  inFlightPlayByKey.set(cooldownKey, { token, reservedAt: now })

  if (inFlightPlayByKey.size > 200) {
    // FIFO 驱逐时优先踢掉超时（疑似悬挂/长期未释放）的旧占位：
    // 踢掉进行中播放的占位会让并发播放穿透冷却，因此先只驱逐明显过期的项
    const STALE_RESERVATION_MS = 10_000
    const now = Date.now()
    let evicted = false
    for (const key of inFlightPlayByKey.keys()) {
      const entry = inFlightPlayByKey.get(key)
      if (entry && now - entry.reservedAt > STALE_RESERVATION_MS) {
        inFlightPlayByKey.delete(key)
        evicted = true
        break
      }
    }
    if (!evicted) {
      // 无过期项（全部占位较新）：兜底驱逐最旧占位（Map 迭代序 = 插入序），
      // 避免 map 无上限增长；被驱逐占位对应播放结束后 token 不匹配自然释放，无副作用
      const oldestKey = inFlightPlayByKey.keys().next().value
      if (oldestKey !== undefined) {
        inFlightPlayByKey.delete(oldestKey)
      }
    }
  }

  return token
}

function releasePlaybackSlot(cooldownKey: string, token: string | null): void {
  if (!token) return
  const reserved = inFlightPlayByKey.get(cooldownKey)
  if (reserved?.token === token) {
    inFlightPlayByKey.delete(cooldownKey)
  }
}

function commitPlaybackSlot(cooldownKey: string, token: string | null, timestamp: number, updateCooldown = true): void {
  releasePlaybackSlot(cooldownKey, token)
  // bypassCooldown 播放（试听等）只释放占位、不写 lastPlayedAt，避免污染全局冷却
  if (updateCooldown) {
    setLastPlayedAt(cooldownKey, timestamp)
  }
}

function setLastPlayedAt(cooldownKey: string, timestamp: number): void {
  lastPlayedAtByKey.set(cooldownKey, timestamp)

  // 简单上限控制，避免极端场景下 key 无限增长
  if (lastPlayedAtByKey.size > 200) {
    const firstKey = lastPlayedAtByKey.keys().next().value
    if (firstKey) lastPlayedAtByKey.delete(firstKey)
  }
}

export async function playCue(
  cue: SoundCue,
  options: { ignoreEnabled?: boolean; bypassCooldown?: boolean; cooldownKey?: string; abortSignal?: AbortSignal; role?: SoundAgentRole } = {}
): Promise<boolean> {
  try {
    if (options.abortSignal?.aborted) return false

    if (!options.ignoreEnabled) {
      if (!currentSettings.enabled) return false
      if (!isCueEnabled(cue, options.role)) return false
    }

    const now = Date.now()
    const cooldownKey = getCooldownKey(options)
    const reservationToken = options.bypassCooldown ? null : reservePlaybackSlot(cooldownKey, now)
    if (!options.bypassCooldown && !reservationToken) {
      return false
    }

    let committed = false

    try {
      const ctx = getOrCreateAudioGraph()
      if (!ctx || !masterGain) return false

      // 尝试自动恢复（可能会因 autoplay 策略失败）
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume()
        } catch {
          // ignore
        }
      }
      if (options.abortSignal?.aborted) return false
      if (ctx.state !== 'running') return false

      // 优先播放自定义音效
      const asset = currentSettings.assets[cue]
      if (asset) {
        const ok = await playSoundAsset(ctx, asset, options.abortSignal)
        if (ok) {
          commitPlaybackSlot(cooldownKey, reservationToken, now, !options.bypassCooldown)
          committed = true
          return true
        }
      }

      // 默认内置提示音（resources/sound）
      const builtin = getBuiltinSoundAsset(cue)
      if (builtin?.url) {
        const ok = await playSoundUrl(ctx, builtin.url, options.abortSignal)
        if (ok) {
          commitPlaybackSlot(cooldownKey, reservationToken, now, !options.bypassCooldown)
          committed = true
          return true
        }
      }

      const pattern = getPatternForCue(cue)
      if (pattern.length === 0) return false

      const oscType = getOscillatorType(currentSettings.theme)

      // 留一点点时间给调度，避免 currentTime 太接近导致 start/stop 报错
      let t = ctx.currentTime + 0.01

      for (const beep of pattern) {
        if (options.abortSignal?.aborted) return false
        const durationSec = Math.max(0.01, beep.durationMs / 1000)

        const osc = ctx.createOscillator()
        osc.type = oscType
        osc.frequency.setValueAtTime(beep.freq, t)

        const gain = ctx.createGain()
        gain.gain.setValueAtTime(0, t)

        // 简单包络，避免“咔哒”声
        const attack = Math.min(0.01, durationSec / 3)
        const release = Math.min(0.02, durationSec / 2)
        const sustainEnd = Math.max(t + attack, t + durationSec - release)

        gain.gain.linearRampToValueAtTime(1, t + attack)
        gain.gain.setValueAtTime(1, sustainEnd)
        gain.gain.linearRampToValueAtTime(0, t + durationSec)

        osc.connect(gain)
        gain.connect(masterGain)

        activeOscillators.add(osc)
        osc.start(t)
        osc.stop(t + durationSec + 0.03)

        osc.onended = () => {
          try {
            activeOscillators.delete(osc)
            osc.disconnect()
            gain.disconnect()
          } catch {
            // ignore
          }
        }

        t = t + durationSec + (beep.gapMs ? beep.gapMs / 1000 : 0)
      }

      commitPlaybackSlot(cooldownKey, reservationToken, now, !options.bypassCooldown)
      committed = true
      return true
    } finally {
      if (!committed) {
        releasePlaybackSlot(cooldownKey, reservationToken)
      }
    }
  } catch (err) {
    // 绝不能影响主流程
    console.warn('[soundCues] playCue failed:', err)
    return false
  }
}
