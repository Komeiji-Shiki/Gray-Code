/**
 * useCheckpointOperationProgress - 存档点设置：进行中存档操作进度轮询（M7/M4）
 *
 * 从 CheckpointSettings.vue 拆分（S2 批次），纯重构不改行为：
 * - 轮询后端进行中的 create/restore/delete 操作并展示进度与取消按钮
 * - M4 容错：瞬时 IPC 错误重试数次后停止；updatedAt 陈旧（疑似悬挂）停止
 * - L-10: 取消失败时保留原进度状态并给出可见反馈
 */

import { ref } from 'vue'
import { pollOperationProgress, cancelCheckpointOperation, type CheckpointOperationProgress } from '@/stores/chat/checkpointActions'
import { t } from '@/i18n'

export function useCheckpointOperationProgress() {
  // M7: 进行中存档操作进度（create/restore/delete）轮询展示 + 取消按钮
  const operationProgress = ref<CheckpointOperationProgress | null>(null)
  let progressPollTimer: ReturnType<typeof setInterval> | null = null
  let progressPolling = false
  // M4: 轮询容错状态
  const operationStale = ref(false) // 操作长时间无进展（updatedAt 陈旧）
  let pollErrorCount = 0 // 连续轮询失败次数
  // L-10: 取消失败反馈（后端未确认取消时保留原进度状态并提示）
  const operationCancelError = ref<string | null>(null)

  /** M4: 连续轮询失败上限：超过后停止（避免后端不可用时无限 IPC） */
  const POLL_ERROR_MAX = 5
  /** M4: 操作无进展（updatedAt 陈旧）阈值：超过后停止轮询，避免后端操作悬挂时永续 IPC */
  const POLL_STALE_THRESHOLD_MS = 120_000

  function isTerminalOperationProgress(progress: CheckpointOperationProgress): boolean {
    return progress.phase === 'done' || progress.phase === 'failed' || progress.phase === 'cancelled'
  }

  function isStaleOperationProgress(progress: CheckpointOperationProgress): boolean {
    const lastUpdate = progress.updatedAt || progress.startedAt
    return Date.now() - lastUpdate > POLL_STALE_THRESHOLD_MS
  }

  // 轮询后端最近更新的进行中存档操作；无进行中操作或已结束时停止轮询。
  // M4: 瞬时 IPC 错误不停止轮询（重试数次后才停）；updatedAt 陈旧（操作疑似悬挂）时停止。
  async function pollOperation() {
    if (progressPolling) return
    progressPolling = true
    try {
      const progress = await pollOperationProgress()
      pollErrorCount = 0
      operationProgress.value = progress
      if (!progress) {
        operationStale.value = false
        stopProgressPolling()
      } else if (isTerminalOperationProgress(progress)) {
        operationStale.value = false
        stopProgressPolling()
      } else if (isStaleOperationProgress(progress)) {
        operationStale.value = true
        stopProgressPolling()
      }
    } catch (error) {
      console.error('[CheckpointSettings] Failed to poll operation progress:', error)
      pollErrorCount += 1
      if (pollErrorCount >= POLL_ERROR_MAX) {
        stopProgressPolling()
        // R3-#10: 连续失败放弃轮询时，若进度仍非终态则标记 stale，
        // 避免进度条卡死且无任何提示；恢复轮询（startProgressPolling）时复位
        const op = operationProgress.value
        if (op && !isTerminalOperationProgress(op)) {
          operationStale.value = true
        }
      }
    } finally {
      progressPolling = false
    }
  }

  function startProgressPolling() {
    if (progressPollTimer) return
    operationStale.value = false
    pollOperation()
    progressPollTimer = setInterval(pollOperation, 800)
  }

  function stopProgressPolling() {
    if (progressPollTimer) {
      clearInterval(progressPollTimer)
      progressPollTimer = null
    }
  }

  // 取消进行中的存档操作（M7/CPF-11）
  // L-10: 后端取消失败（IPC 错误/后端拒绝）时不乐观置 cancelled，
  // 保留原进度状态并给出可见反馈，避免“已取消”误提示。
  async function cancelActiveOperation() {
    const op = operationProgress.value
    if (!op || op.cancelled) return
    let cancelled = false
    try {
      cancelled = await cancelCheckpointOperation(op.operationId)
    } catch (error) {
      console.error('[CheckpointSettings] Failed to cancel operation:', error)
    }
    if (!cancelled) {
      // 后端未确认取消：恢复/保留原进度状态，展示失败提示
      console.warn('[CheckpointSettings] Cancel not confirmed by backend, keeping progress state:', op.operationId)
      operationCancelError.value = t('components.settings.checkpoint.sections.cleanup.progress.cancelFailed')
      return
    }
    operationCancelError.value = null
    operationProgress.value = { ...op, cancelled: true, phase: 'cancelled' }
    // M4: 取消后重新观察后端终态（cancelled/done）
    startProgressPolling()
  }

  // 机器可读 phase → 展示文案（与后端 CheckpointOperationProgress.phase 对齐）
  function operationPhaseLabel(phase: string): string {
    const key = `components.settings.checkpoint.sections.cleanup.progress.${phase}` as const
    const label = t(key)
    return label || phase
  }

  return {
    operationProgress,
    operationStale,
    operationCancelError,
    startProgressPolling,
    stopProgressPolling,
    cancelActiveOperation,
    operationPhaseLabel
  }
}
