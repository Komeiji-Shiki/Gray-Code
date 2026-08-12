import { ref } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { useI18n } from '../../i18n'
import { onExtensionCommand, sendToExtension, showNotification } from '../../utils/vscode'

const { t } = useI18n()

export interface ApplyDiffAutoSaveConfig {
  autoSave: boolean
  autoSaveDelay: number
}

export interface PendingDiffSession {
  id: string
  toolId?: string
  filePath: string
  diffGuardWarning?: string
  diffGuardDeletePercent?: number
  /** checkpoint 与写锁是否已经完成，只有就绪后后端才启动自动保存倒计时。 */
  writeReady: boolean
  /** 后端自动保存的绝对触发时间；未调度时为空。 */
  autoSaveAt?: number
  /** 本次后端计时器实际使用的延迟。 */
  autoSaveDelay?: number
  /** 后端正在执行保存或拒绝动作。 */
  isProcessing: boolean
}

export const globalApplyDiffConfig = ref<ApplyDiffAutoSaveConfig>({
  autoSave: false,
  autoSaveDelay: 3000
})

export const toolIdToPendingDiffs = ref<Map<string, PendingDiffSession[]>>(new Map())
export const diffGuardWarnings = ref<Map<string, { warning: string; deletePercent: number }>>(new Map())
export const persistedDiffGuardWarnings = ref<Map<string, { warning: string; deletePercent: number }>>(new Map())
export const seenDiffToolIds = ref<Set<string>>(new Set())
export const diffActionErrors = ref<Map<string, string>>(new Map())

/**
 * 页面级时钟。整个聊天页面无论存在多少 ToolMessage，都只运行一个 50ms 定时器。
 * 它只刷新后端倒计时的展示，不再从前端重复发送自动接受请求。
 */
export const diffClockTick = ref(0)

const locallyProcessingDiffSessionIds = ref<Set<string>>(new Set())
const serverProcessingDiffSessionIds = ref<Set<string>>(new Set())
let clockTimer: ReturnType<typeof setInterval> | undefined
let subscriptionsRegistered = false
let configLoadPromise: Promise<void> | undefined
let lastPendingDiffsKey = ''

// 持久化警戒 / 已见 diff 工具集合容量上限（防御：Map/Set 保持插入序，超限时淘汰最旧条目）
const DIFF_STATE_CAP = 500

function capDiffStateMap<K>(map: Map<K, unknown>): void {
  while (map.size > DIFF_STATE_CAP) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) break
    map.delete(oldestKey)
  }
}

function capDiffStateSet<T>(set: Set<T>): void {
  while (set.size > DIFF_STATE_CAP) {
    const oldestValue = set.values().next().value
    if (oldestValue === undefined) break
    set.delete(oldestValue)
  }
}

function normalizeApplyDiffConfig(raw: any): ApplyDiffAutoSaveConfig {
  const autoSave = !!raw?.autoSave
  const delay = Number(raw?.autoSaveDelay)
  const autoSaveDelay = Number.isFinite(delay) ? Math.max(0, delay) : 3000
  return { autoSave, autoSaveDelay }
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stopClock(): void {
  if (clockTimer !== undefined) {
    clearInterval(clockTimer)
    clockTimer = undefined
  }
}

function hasActiveCountdown(now = Date.now()): boolean {
  for (const session of getAllPendingDiffSessions()) {
    if (!session.isProcessing && session.autoSaveAt !== undefined && session.autoSaveAt > now) {
      return true
    }
  }
  return false
}

function syncClock(): void {
  if (!hasActiveCountdown()) {
    stopClock()
    return
  }
  if (clockTimer !== undefined) return

  clockTimer = setInterval(() => {
    diffClockTick.value++
    if (!hasActiveCountdown()) stopClock()
  }, 50)
}

function addLocallyProcessingDiffSessionId(sessionId: string): void {
  if (!sessionId || locallyProcessingDiffSessionIds.value.has(sessionId)) return
  const next = new Set(locallyProcessingDiffSessionIds.value)
  next.add(sessionId)
  locallyProcessingDiffSessionIds.value = next
}

function removeLocallyProcessingDiffSessionId(sessionId: string): void {
  if (!sessionId || !locallyProcessingDiffSessionIds.value.has(sessionId)) return
  const next = new Set(locallyProcessingDiffSessionIds.value)
  next.delete(sessionId)
  locallyProcessingDiffSessionIds.value = next
}

function clearDiffActionError(sessionId: string): void {
  if (!sessionId || !diffActionErrors.value.has(sessionId)) return
  const next = new Map(diffActionErrors.value)
  next.delete(sessionId)
  diffActionErrors.value = next
}

function setDiffActionError(sessionId: string, message: string): void {
  const next = new Map(diffActionErrors.value)
  next.set(sessionId, message)
  diffActionErrors.value = next
}

export function getDiffActionError(sessionId: string): string | undefined {
  return diffActionErrors.value.get(sessionId)
}

export function getAllPendingDiffSessions(): PendingDiffSession[] {
  return Array.from(toolIdToPendingDiffs.value.values()).flatMap((sessions) => sessions)
}

export function getPendingDiffSessions(toolId: string): PendingDiffSession[] {
  return toolIdToPendingDiffs.value.get(toolId) ?? []
}

export function getPendingDiffSession(sessionId: string): PendingDiffSession | undefined {
  return getAllPendingDiffSessions().find((session) => session.id === sessionId)
}

export function hasPendingDiffSession(sessionId: string): boolean {
  return getPendingDiffSession(sessionId) !== undefined
}

export function isDiffSessionProcessing(sessionId: string): boolean {
  return locallyProcessingDiffSessionIds.value.has(sessionId)
    || serverProcessingDiffSessionIds.value.has(sessionId)
}

export function getDiffAutoSaveTimeLeft(session: PendingDiffSession): number {
  void diffClockTick.value
  if (session.autoSaveAt === undefined) return 0
  return Math.max(0, session.autoSaveAt - Date.now())
}

export function getDiffAutoSaveProgress(session: PendingDiffSession): number {
  const remaining = getDiffAutoSaveTimeLeft(session)
  const delay = session.autoSaveDelay ?? globalApplyDiffConfig.value.autoSaveDelay
  if (delay <= 0) return remaining > 0 ? 100 : 0
  return Math.max(0, Math.min(100, (remaining / delay) * 100))
}

export function getDiffAutoSaveTimeLeftById(sessionId: string): number {
  const session = getPendingDiffSession(sessionId)
  return session ? getDiffAutoSaveTimeLeft(session) : 0
}

export function getDiffAutoSaveProgressById(sessionId: string): number {
  const session = getPendingDiffSession(sessionId)
  return session ? getDiffAutoSaveProgress(session) : 0
}

function getActionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  const maybeMessage = (error as any)?.message
  return typeof maybeMessage === 'string' && maybeMessage.trim() ? maybeMessage : fallback
}

export async function confirmDiff(sessionId: string): Promise<void> {
  if (isDiffSessionProcessing(sessionId)) return

  clearDiffActionError(sessionId)
  if (!hasPendingDiffSession(sessionId)) {
    const message = t('components.message.tool.pendingDiffNotFound')
    setDiffActionError(sessionId, message)
    await showNotification(message, 'error')
    return
  }

  addLocallyProcessingDiffSessionId(sessionId)
  try {
    await sendToExtension(MESSAGE_NAMES['diff.accept'], { sessionId })
    if (!hasPendingDiffSession(sessionId)) removeLocallyProcessingDiffSessionId(sessionId)
  } catch (error) {
    removeLocallyProcessingDiffSessionId(sessionId)
    // 良性终态：diff 已被自动保存/其他入口接受或取消，UI 尚未收到
    // diff.statusChanged 广播而已。不弹错误提示（自动应用后高频弹出
    // 「diff is no longer pending」且无法关闭的用户痛点），本地结算即可。
    if ((error as any)?.code === 'DIFF_NOT_PENDING') {
      console.debug(`[diffReviewController] diff ${sessionId} no longer pending (benign), settling UI`)
      return
    }
    const message = getActionErrorMessage(error, t('components.message.tool.acceptDiffFailed'))
    setDiffActionError(sessionId, message)
    await showNotification(message, 'error')
    console.error('Failed to accept diff:', error)
  }
}

export async function rejectDiff(sessionId: string): Promise<void> {
  if (isDiffSessionProcessing(sessionId)) return

  clearDiffActionError(sessionId)
  if (!hasPendingDiffSession(sessionId)) {
    const message = t('components.message.tool.pendingDiffNotFound')
    setDiffActionError(sessionId, message)
    await showNotification(message, 'error')
    return
  }

  addLocallyProcessingDiffSessionId(sessionId)
  try {
    await sendToExtension(MESSAGE_NAMES['diff.reject'], { sessionId })
    if (!hasPendingDiffSession(sessionId)) removeLocallyProcessingDiffSessionId(sessionId)
  } catch (error) {
    removeLocallyProcessingDiffSessionId(sessionId)
    // 同上：diff 已不在 pending（自动保存/其他入口已结算），良性终态，不弹错误提示。
    if ((error as any)?.code === 'DIFF_NOT_PENDING') {
      console.debug(`[diffReviewController] diff ${sessionId} no longer pending (benign), settling UI`)
      return
    }
    const message = getActionErrorMessage(error, t('components.message.tool.rejectDiffFailed'))
    setDiffActionError(sessionId, message)
    await showNotification(message, 'error')
    console.error('Failed to reject diff:', error)
  }
}

function buildPendingPayloadKey(pendingDiffs: any[]): string {
  return pendingDiffs
    .map((diff: any) => [
      diff.id,
      diff.toolId,
      diff.filePath,
      diff.diffGuardWarning,
      diff.diffGuardDeletePercent,
      diff.writeReady,
      diff.autoSaveAt,
      diff.autoSaveDelay,
      diff.isProcessing
    ]
      .map(value => `${String(value ?? '').length}:${value ?? ''}`)
      .join('\u0000'))
    .join('|')
}

function applyPendingDiffStatus(data: any): void {
  const pendingDiffs: any[] = Array.isArray(data?.pendingDiffs) ? data.pendingDiffs : []
  const payloadKey = buildPendingPayloadKey(pendingDiffs)
  if (payloadKey === lastPendingDiffsKey) return
  lastPendingDiffsKey = payloadKey

  const newMapping = new Map<string, PendingDiffSession[]>()
  const newWarnings = new Map<string, { warning: string; deletePercent: number }>()
  const nextServerProcessing = new Set<string>()

  for (const raw of pendingDiffs) {
    if (typeof raw?.id !== 'string' || !raw.id || typeof raw?.toolId !== 'string' || !raw.toolId) {
      continue
    }

    const session: PendingDiffSession = {
      id: raw.id,
      toolId: raw.toolId,
      filePath: typeof raw.filePath === 'string' ? raw.filePath : '',
      diffGuardWarning: typeof raw.diffGuardWarning === 'string' ? raw.diffGuardWarning : undefined,
      diffGuardDeletePercent: finiteNumber(raw.diffGuardDeletePercent),
      writeReady: raw.writeReady !== false,
      autoSaveAt: finiteNumber(raw.autoSaveAt),
      autoSaveDelay: finiteNumber(raw.autoSaveDelay),
      isProcessing: raw.isProcessing === true
    }

    const sessions = newMapping.get(raw.toolId) ?? []
    sessions.push(session)
    newMapping.set(raw.toolId, sessions)

    if (session.isProcessing) nextServerProcessing.add(session.id)
    if (session.diffGuardWarning) {
      const warning = {
        warning: session.diffGuardWarning,
        deletePercent: session.diffGuardDeletePercent ?? 0
      }
      const current = newWarnings.get(raw.toolId)
      if (!current || warning.deletePercent >= current.deletePercent) {
        newWarnings.set(raw.toolId, warning)
      }
    }
  }

  toolIdToPendingDiffs.value = newMapping
  serverProcessingDiffSessionIds.value = nextServerProcessing
  diffGuardWarnings.value = newWarnings

  if (newWarnings.size > 0) {
    const nextPersisted = new Map(persistedDiffGuardWarnings.value)
    for (const [toolId, warning] of newWarnings) nextPersisted.set(toolId, warning)
    // M-6：容量上限兜底（Map 保持插入序，超限时淘汰最旧条目）
    capDiffStateMap(nextPersisted)
    persistedDiffGuardWarnings.value = nextPersisted
  }

  if (newMapping.size > 0) {
    const nextSeen = new Set(seenDiffToolIds.value)
    for (const toolId of newMapping.keys()) nextSeen.add(toolId)
    // M-6：容量上限兜底
    capDiffStateSet(nextSeen)
    seenDiffToolIds.value = nextSeen
  }

  const activeSessionIds = new Set(getAllPendingDiffSessions().map(session => session.id))

  const nextLocalProcessing = new Set(locallyProcessingDiffSessionIds.value)
  for (const sessionId of nextLocalProcessing) {
    if (!activeSessionIds.has(sessionId)) nextLocalProcessing.delete(sessionId)
  }
  locallyProcessingDiffSessionIds.value = nextLocalProcessing

  const nextErrors = new Map(diffActionErrors.value)
  for (const sessionId of nextErrors.keys()) {
    if (!activeSessionIds.has(sessionId)) nextErrors.delete(sessionId)
  }
  diffActionErrors.value = nextErrors

  diffClockTick.value++
  syncClock()
}

function registerSubscriptions(): void {
  if (subscriptionsRegistered) return
  subscriptionsRegistered = true

  onExtensionCommand('tools.applyDiffConfigChanged', (data: any) => {
    globalApplyDiffConfig.value = normalizeApplyDiffConfig(data?.config)
    diffClockTick.value++
    syncClock()
  })
  onExtensionCommand('diff.statusChanged', applyPendingDiffStatus)
}

/** 初始化一次全局 Diff 审阅状态；重复调用只复用同一个配置请求。 */
export function ensureDiffReviewControllerInitialized(): Promise<void> {
  registerSubscriptions()
  if (configLoadPromise) return configLoadPromise

  configLoadPromise = sendToExtension<{ config: ApplyDiffAutoSaveConfig }>(
    MESSAGE_NAMES['tools.getToolConfig'],
    { toolName: 'apply_diff' }
  )
    .then((response) => {
      if (response?.config) {
        globalApplyDiffConfig.value = normalizeApplyDiffConfig(response.config)
      }
    })
    .catch((error) => {
      configLoadPromise = undefined
      console.error('Failed to get diff tool config:', error)
    })

  return configLoadPromise
}
