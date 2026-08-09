import { playCue, unlockAudio, type SoundAgentRole, type SoundCue } from './soundCues'

export type SoundEventSource =
  | 'taskEvent'
  | 'retryStatus'
  | 'streamChunk'
  | 'notification'
  | 'chatError'
  | 'visibilityRestore'

export interface SoundEventPayload {
  cue: SoundCue
  source: SoundEventSource
  createdAt?: number
  conversationId?: string
  /**
   * 事件所属代理角色。
   *
   * - 'subagent'：子代理（SubAgent）事件，受 cues.subagent 独立开关控制
   * - 缺省 / 'main'：主代理事件，受 cues 顶层开关控制（向后兼容）
   */
  role?: SoundAgentRole
}

interface HiddenSoundAggregate {
  cue: SoundCue
  createdAt: number
  count: number
  conversationId?: string
  role?: SoundAgentRole
}

const MAX_SOUND_EVENT_AGE_MS = 3000

const CUE_PRIORITY: Record<SoundCue, number> = {
  error: 4,
  taskError: 3,
  warning: 2,
  taskComplete: 1
}

let hiddenAggregate: HiddenSoundAggregate | null = null
let audioUnlockedThisSession = false
let unlockInFlight: Promise<boolean> | null = null
let unlockHooksCleanup: (() => void) | null = null
let visibilityHooksCleanup: (() => void) | null = null

/**
 * VSCode 窗口是否聚焦（由扩展侧 windowFocusChanged 命令推送）。
 * 默认 true（视为聚焦）：窗口聚焦时用户看得见界面，事件结果已可见，不播放提示音；
 * 窗口失焦（切到其他应用）时才播放提醒。
 */
let vscodeWindowFocused = true

function canUseDocument(): boolean {
  return typeof document !== 'undefined'
}

function normalizeCreatedAt(createdAt?: number): number {
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : Date.now()
}

function isEventExpired(createdAt: number, now: number = Date.now()): boolean {
  return now - createdAt > MAX_SOUND_EVENT_AGE_MS
}

function isDocumentHidden(): boolean {
  if (!canUseDocument()) return false
  return document.hidden || document.visibilityState === 'hidden'
}

/** 更新 VSCode 窗口焦点状态（扩展侧 windowFocusChanged 命令推送） */
export function setVscodeWindowFocused(focused: boolean): void {
  vscodeWindowFocused = focused
}

function getCuePriority(cue: SoundCue): number {
  return CUE_PRIORITY[cue] || 0
}

function clearUnlockHooks(): void {
  if (unlockHooksCleanup) {
    const cleanup = unlockHooksCleanup
    unlockHooksCleanup = null
    cleanup()
  }
}

async function attemptUnlockAudio(): Promise<boolean> {
  if (audioUnlockedThisSession) return true

  if (!unlockInFlight) {
    unlockInFlight = (async () => {
      const result = await unlockAudio()
      if (result.success) {
        audioUnlockedThisSession = true
        clearUnlockHooks()
      }
      return result.success
    })().finally(() => {
      unlockInFlight = null
    })
  }

  return unlockInFlight
}

function updateHiddenAggregate(event: Required<Pick<SoundEventPayload, 'cue' | 'source' | 'createdAt'>> & Pick<SoundEventPayload, 'conversationId' | 'role'>): void {
  if (!hiddenAggregate) {
    hiddenAggregate = {
      cue: event.cue,
      createdAt: event.createdAt,
      count: 1,
      conversationId: event.conversationId,
      role: event.role
    }
    return
  }

  const currentPriority = getCuePriority(hiddenAggregate.cue)
  const nextPriority = getCuePriority(event.cue)

  if (nextPriority > currentPriority) {
    hiddenAggregate = {
      cue: event.cue,
      createdAt: event.createdAt,
      count: hiddenAggregate.count + 1,
      conversationId: event.conversationId,
      role: event.role
    }
    return
  }

  if (nextPriority === currentPriority) {
    hiddenAggregate = {
      cue: hiddenAggregate.cue,
      createdAt: event.createdAt,
      count: hiddenAggregate.count + 1,
      conversationId: event.conversationId ?? hiddenAggregate.conversationId,
      // 同优先级同 cue 事件聚合后按「先到者优先」保留 role：
      // 极端场景（3 秒窗口内主/子代理各一次同 cue 事件）补播时可能少覆盖一种开关，
      // 但两者音效相同，仅门控开关不同，影响可忽略。
      role: hiddenAggregate.role ?? event.role
    }
    return
  }

  hiddenAggregate = {
    ...hiddenAggregate,
    count: hiddenAggregate.count + 1
  }
}

async function playSoundEvent(event: SoundEventPayload & { createdAt: number }): Promise<void> {
  if (isEventExpired(event.createdAt)) return

  const unlocked = await attemptUnlockAudio()
  if (!unlocked) return

  await playCue(event.cue, {
    cooldownKey: event.conversationId ? `conv:${event.conversationId}` : undefined,
    role: event.role
  })
}

export async function handleSoundEvent(event: SoundEventPayload): Promise<void> {
  const createdAt = normalizeCreatedAt(event.createdAt)
  if (isEventExpired(createdAt)) return

  const normalizedEvent = {
    ...event,
    createdAt
  }

  if (isDocumentHidden()) {
    updateHiddenAggregate(normalizedEvent)
    return
  }

  // VSCode 窗口聚焦（vscodeWindowFocused）：用户正看着界面，事件结果已可见，
  // 不再播放提示音，避免「看着也要响」的打扰；窗口失焦（切到其他应用）时才播放提醒。
  if (vscodeWindowFocused) return

  await playSoundEvent(normalizedEvent)
}

export async function flushHiddenSoundEvent(): Promise<void> {
  const pending = hiddenAggregate
  hiddenAggregate = null

  if (!pending) return
  if (isEventExpired(pending.createdAt)) return

  await playSoundEvent({
    cue: pending.cue,
    source: 'visibilityRestore',
    createdAt: pending.createdAt,
    conversationId: pending.conversationId,
    role: pending.role
  })
}

function handleVisibilityChange(): void {
  if (!isDocumentHidden()) {
    void flushHiddenSoundEvent()
  }
}

export function registerGlobalAudioUnlockHooks(): () => void {
  if (!canUseDocument() || audioUnlockedThisSession) {
    return () => {}
  }

  if (unlockHooksCleanup) {
    return unlockHooksCleanup
  }

  const onUserGesture = () => {
    void attemptUnlockAudio()
  }

  document.addEventListener('pointerdown', onUserGesture, true)
  document.addEventListener('keydown', onUserGesture, true)

  const cleanup = () => {
    document.removeEventListener('pointerdown', onUserGesture, true)
    document.removeEventListener('keydown', onUserGesture, true)
    if (unlockHooksCleanup === cleanup) {
      unlockHooksCleanup = null
    }
  }

  unlockHooksCleanup = cleanup
  return cleanup
}

export function registerVisibilityChangeHooks(): () => void {
  if (!canUseDocument()) {
    return () => {}
  }

  if (visibilityHooksCleanup) {
    return visibilityHooksCleanup
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)

  const cleanup = () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    if (visibilityHooksCleanup === cleanup) {
      visibilityHooksCleanup = null
    }
  }

  visibilityHooksCleanup = cleanup
  return cleanup
}

export function resetSoundEventControllerForTests(): void {
  hiddenAggregate = null
  audioUnlockedThisSession = false
  unlockInFlight = null
  clearUnlockHooks()
  vscodeWindowFocused = true

  if (visibilityHooksCleanup) {
    const cleanup = visibilityHooksCleanup
    visibilityHooksCleanup = null
    cleanup()
  }
}

export const soundEventControllerTesting = {
  MAX_SOUND_EVENT_AGE_MS,
  getHiddenAggregate: (): HiddenSoundAggregate | null => hiddenAggregate
}
