/**
 * Chat Store 检查点操作
 * 
 * 包含检查点的 CRUD 和恢复操作
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import type { Message, Attachment, CheckpointRecord, CheckpointManifest } from '../../types'
import type { ChatStoreState, BranchStreamReplayContext } from './types'
import { sendToExtension } from '../../utils/vscode'
import { generateId } from '../../utils/format'
import { calculateBackendIndex } from './messageActions'
import { syncTotalMessagesFromWindow, setTotalMessagesFromWindow, trimWindowFromTop } from './windowUtils'
import { loadCheckpoints, refreshCurrentConversationBuildSession, loadHistory } from './conversationActions'
import { validateSessionIdentity } from './utils'
import { rebuildMessageIndexById, appendMessage } from './state'
import { setPendingDirtyConfirm } from './dirtyConfirmState'

function resolveConversationModelOverride(state: ChatStoreState): string | undefined {
  const selected = (state.selectedModelId.value || '').trim()
  const configModel = (state.currentConfig.value?.model || '').trim()
  return selected && selected !== configModel ? selected : undefined
}

/**
 * 根据消息索引获取关联的检查点
 */
export function getCheckpointsForMessage(state: ChatStoreState, messageIndex: number): CheckpointRecord[] {
  return state.checkpoints.value.filter(cp => cp.messageIndex === messageIndex)
}

/**
 * 检查消息是否有关联的检查点
 */
export function hasCheckpoint(state: ChatStoreState, messageIndex: number): boolean {
  return state.checkpoints.value.some(cp => cp.messageIndex === messageIndex)
}

/**
 * 添加检查点
 */
export function addCheckpoint(state: ChatStoreState, checkpoint: CheckpointRecord): void {
  // M2：按 cp.id 去重（先 find 再 push，保留顺序语义）——
  // 同一 checkpoint 可能随多个流式事件重复下发，避免重复展示
  if (state.checkpoints.value.some(cp => cp.id === checkpoint.id)) {
    return
  }
  state.checkpoints.value.push(checkpoint)
}

/**
 * 清理指定索引及之后的检查点
 */
export function clearCheckpointsFromIndex(state: ChatStoreState, fromBackendIndex: number, excludeCheckpointId?: string): void {
  // CheckpointRecord.messageIndex 是后端历史中的绝对索引；回档场景下保留刚用于恢复的存档点
  state.checkpoints.value = state.checkpoints.value.filter(cp => cp.messageIndex < fromBackendIndex || cp.id === excludeCheckpointId)
}

/**
 * 手动创建存档点：保存当前工作区/对话状态（用户显式请求，不受自动检查点开关限制）。
 *
 * 用途：AI 执行一系列改动后（或任意时刻）主动存档，之后可放心回档检查点 / 切换分支
 * ——恢复旧状态后，随时可恢复本存档回到现在（检查点列表可见，且已绑定当前分支节点）。
 *
 * @returns 创建的检查点记录；无当前会话 / 创建失败返回 null
 */
export async function createManualCheckpoint(state: ChatStoreState): Promise<CheckpointRecord | null> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return null
  try {
    const result = await sendToExtension<{
      success?: boolean
      checkpoint?: CheckpointRecord
      error?: string
    }>(MESSAGE_NAMES['checkpoint.createManual'], { conversationId })
    if (result?.success && result.checkpoint) {
      addCheckpoint(state, result.checkpoint)
      return result.checkpoint
    }
    console.warn('[checkpointActions] Manual checkpoint creation rejected:', result?.error ?? 'unknown')
    return null
  } catch (err: any) {
    console.warn('[checkpointActions] Failed to create manual checkpoint:', err)
    return null
  }
}

/**
 * 恢复预览（CP-09）：调用后端计算恢复计划（待删除文件清单），不执行任何写入。
 *
 * 前端在展示确认对话框（含待删除文件清单）后，再调用 restoreCheckpoint 真正执行。
 * deletablePaths：快照记录过、按 #29 白名单删除的文件；
 * untrackedPaths：快照后新建的文件，需用户确认后才删除。
 */
export async function previewRestore(
  state: ChatStoreState,
  checkpointId: string
): Promise<{
  success: boolean
  restored: number
  deleted: number
  skipped: number
  deletablePaths: string[]
  untrackedPaths: string[]
  legacy?: boolean
  error?: string
  failures?: Array<{ path: string; reason: string }>
  missingBackupDirs?: string[]
  autoPrunedCheckpointCount?: number
  unbackedPaths?: string[]
  previewId?: string
  workspaceStateFingerprint?: string
}> {
  if (!state.currentConversationId.value) {
    return { success: false, restored: 0, deleted: 0, skipped: 0, deletablePaths: [], untrackedPaths: [], error: 'No conversation selected' }
  }

  try {
    const result = await sendToExtension<{
      success: boolean
      restored: number
      deleted: number
      skipped: number
      deletablePaths: string[]
      untrackedPaths: string[]
      legacy?: boolean
      error?: string
      failures?: Array<{ path: string; reason: string }>
      missingBackupDirs?: string[]
      autoPrunedCheckpointCount?: number
      unbackedPaths?: string[]
      previewId?: string
      workspaceStateFingerprint?: string
    }>(
      MESSAGE_NAMES['checkpoint.previewRestore'],
      {
        conversationId: state.currentConversationId.value,
        checkpointId
      }
    )

    const normalized = result || { success: false, restored: 0, deleted: 0, skipped: 0, deletablePaths: [], untrackedPaths: [], error: 'Unknown error' }
    if ((normalized.autoPrunedCheckpointCount || 0) > 0) {
      try {
        await loadCheckpoints(state)
      } catch (error) {
        console.error('[checkpointActions] Failed to refresh checkpoints after auto prune:', error)
      }
    }
    return normalized
  } catch (err: any) {
    return { success: false, restored: 0, deleted: 0, skipped: 0, deletablePaths: [], untrackedPaths: [], error: err.message || 'Preview restore failed' }
  }
}

/**
 * 预览排除结果（EX-09）：调用后端按当前排除配置扫描工作区。
 *
 * 返回按默认类别聚合的排除统计（summary / byProfile / ignoreSnapshot / complete）。
 * 只做扫描统计，不哈希大文件、不创建存档。
 */
export interface ExclusionPreviewSummary {
  excludedCount: number
  excludedBytes: number
  byReason: Record<string, { count: number; bytes: number }>
  samples: Array<{
    path: string
    reason: string
    rule?: string
    source?: string
    size?: number
  }>
}

export interface ExclusionPreviewResult {
  summary: ExclusionPreviewSummary
  byProfile: Record<string, ExclusionPreviewSummary>
  ignoreSnapshot: {
    version: number
    forcedRulesVersion: number
    defaultProfileVersion: number
    enabledProfiles: Record<string, boolean>
    maxFileSizeBytes: number
    customPatterns: string[]
  }
  complete: boolean
}

export async function previewExclusions(): Promise<ExclusionPreviewResult | null> {
  try {
    return await sendToExtension<ExclusionPreviewResult>(MESSAGE_NAMES['checkpoint.previewExclusions'], {})
  } catch (err: any) {
    console.error('[checkpointActions] Failed to preview exclusions:', err)
    return null
  }
}

/**
 * 恢复到指定检查点
 *
 * @param deleteUntrackedFiles 是否删除快照后新建的文件（CP-09）。
 *        用户在恢复确认框中确认了待删除文件清单后传 true。
 * @param confirmedDiscardDirty BCP-05（决策 11）：用户已在未保存文件确认框中确认
 *        「丢弃更改并继续」后传 true（后端据此跳过 dirty 拦截）；缺省 false。
 *
 * BCP-05（决策 11）：后端在恢复前检测未保存（dirty）文件——命中且未确认时返回
 * { success: false, dirtyFiles: string[] }（不执行恢复），本函数透传并在
 * pendingDirtyConfirm 中登记待确认动作（DirtyFilesConfirm.vue 据此弹确认框）。
 */
export async function restoreCheckpoint(
  state: ChatStoreState,
  checkpointId: string,
  deleteUntrackedFiles?: boolean,
  confirmedDiscardDirty?: boolean,
  previewId?: string,
  confirmedDirtyFiles?: string[]
): Promise<{
  success: boolean
  restored: number
  deleted?: number
  skipped?: number
  error?: string
  dirtyFiles?: string[]
  missingBackupDirs?: string[]
  autoPrunedCheckpointCount?: number
  failures?: Array<{ path: string; reason: string }>
  unbackedPaths?: string[]
  previewId?: string
}> {
  if (!state.currentConversationId.value) {
    return { success: false, restored: 0, error: 'No conversation selected' }
  }
  // BCP-05 归属：固化发起会话（await 前），IPC 目标与 dirty 确认归属使用同一值，
  // 避免 checkpoint.restore 在途切换会话时把归属错记到新会话
  const conversationId = state.currentConversationId.value

  try {
    const result = await sendToExtension<{
      success: boolean
      restored: number
      deleted?: number
      skipped?: number
      error?: string
      dirtyFiles?: string[]
      missingBackupDirs?: string[]
      autoPrunedCheckpointCount?: number
      failures?: Array<{ path: string; reason: string }>
      unbackedPaths?: string[]
      previewId?: string
    }>(
      MESSAGE_NAMES['checkpoint.restore'],
      {
        conversationId,
        checkpointId,
        deleteUntrackedFiles: deleteUntrackedFiles === true,
        ...(confirmedDiscardDirty === true ? { confirmedDiscardDirty: true } : {}),
        ...(typeof previewId === 'string' ? { previewId } : {}),
        ...(confirmedDirtyFiles ? { confirmedDirtyFiles } : {})
      }
    )
    
    const normalized = result || { success: false, restored: 0, error: 'Unknown error' }
    // BCP-05（决策 11）：后端拦截到未保存文件 → 登记待确认动作，前端弹确认框
    // （已确认（confirmedDiscardDirty=true）时后端不会返回 dirtyFiles，此处再防御一次）
    if (
      normalized.dirtyFiles &&
      normalized.dirtyFiles.length > 0 &&
      (confirmedDiscardDirty !== true || normalized.error === 'STALE_DIRTY_CONFIRMATION')
    ) {
      // BCP-05 归属：经 setPendingDirtyConfirm 记录发起会话（conversationId 在函数入口固化，
      // 与 IPC 目标一致，避免 await 期间切换会话把归属错记到新会话）
      setPendingDirtyConfirm(conversationId, {
        kind: 'restore',
        files: normalized.dirtyFiles,
        restore: {
          entry: 'restore',
          checkpointId,
          deleteUntrackedFiles: deleteUntrackedFiles === true,
          previewId: normalized.previewId ?? previewId
        }
      })
      return normalized
    }
    if (normalized.success) {
      if (!validateSessionIdentity(state, conversationId)) {
        return normalized
      }
      // R3-#14: 恢复成功后无条件刷新检查点列表（此前仅在 autoPrune 时刷新，
      // 恢复导致的列表变化可能未反映到前端）
      try {
        await loadCheckpoints(state)
      } catch (error) {
        console.error('[checkpointActions] Failed to refresh checkpoints after restore:', error)
      }
      // 回退后同步会话元数据（activeBuild/todoList）到前端，避免继续显示旧的 Build 壳。
      await refreshCurrentConversationBuildSession(state)
    }
    return normalized
  } catch (err: any) {
    return { success: false, restored: 0, error: err.message || 'Restore failed' }
  }
}

/**
 * 回档并重试
 *
 * 先恢复到指定检查点，然后重试消息
 *
 * @param messageIndex allMessages 中的索引
 * @param checkpointId 检查点 ID
 * @param currentModelName 当前模型名称
 * @param confirmedDeleteUntracked 用户是否已在确认框中确认待删除文件清单（含快照后新建文件）。
 *        只有确认过的调用才允许删除快照后新建文件，默认 false（#29 保护）。
 * @param confirmedDiscardDirty BCP-05（决策 11）：用户已在未保存文件确认框中确认后传 true。
 */
export async function restoreAndRetry(
  state: ChatStoreState,
  messageIndex: number,
  checkpointId: string,
  currentModelName: string,
  cancelStream: () => Promise<void>,
  confirmedDeleteUntracked: boolean = false,
  confirmedDiscardDirty?: boolean,
  previewId?: string,
  confirmedDirtyFiles?: string[]
): Promise<void> {
  if (!state.currentConversationId.value || messageIndex < 0 || messageIndex >= state.allMessages.value.length) {
    return
  }

  // await cancelStream() 之前固化 originConvId 与 targetMessageId
  const originConvId = state.currentConversationId.value
  const targetMessageId = state.allMessages.value[messageIndex]?.id
  if (!targetMessageId) return

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属
  if (!validateSessionIdentity(state, originConvId)) return
  // R3-#13: 按 id 定位后重算索引（await cancelStream 期间数组可能已变化，
  // 直接以下标重读校验/切片会错位），目标消息不存在时中止
  let targetIndex = state.allMessages.value.findIndex(m => m.id === targetMessageId)
  if (targetIndex === -1) return

  state.error.value = null
  state._pendingBranchReplayContext.value = null
  state.isLoading.value = true

  let branchReplayContext: BranchStreamReplayContext | null = null
  try {
    // 1. 先恢复检查点（只有调用方确认了待删除文件清单才删除快照后新建文件）
    const restoreResult = await restoreCheckpoint(
      state,
      checkpointId,
      confirmedDeleteUntracked,
      confirmedDiscardDirty,
      previewId,
      confirmedDirtyFiles
    )
    if (!validateSessionIdentity(state, originConvId)) {
      state.isLoading.value = false
      return
    }
    // BCP-05（决策 11）：后端拦截到未保存文件 → 登记待确认动作（含本入口参数），
    // 不写错误条（确认框由 DirtyFilesConfirm.vue 弹出），流程在此暂停等待确认。
    if (restoreResult.dirtyFiles && restoreResult.dirtyFiles.length > 0) {
      // BCP-05 归属：经 setPendingDirtyConfirm 记录发起会话（originConvId，await 前固化）
      setPendingDirtyConfirm(originConvId, {
        kind: 'restore',
        files: restoreResult.dirtyFiles,
        restore: {
          entry: 'retry',
          checkpointId,
          deleteUntrackedFiles: confirmedDeleteUntracked,
          previewId,
          messageId: targetMessageId
        }
      })
      state.isLoading.value = false
      return
    }
    if (!restoreResult.success) {
      if (validateSessionIdentity(state, originConvId)) {
        state.error.value = {
          code: 'RESTORE_ERROR',
          message: restoreResult.error || '恢复检查点失败'
        }
      }
      state.isLoading.value = false
      return
    }

    targetIndex = state.allMessages.value.findIndex(m => m.id === targetMessageId)
    if (targetIndex === -1) {
      state.isLoading.value = false
      return
    }

    // 2. 计算后端索引（在删除本地消息之前）
    const backendIndex = calculateBackendIndex(state.allMessages.value, targetIndex, state.windowStartIndex.value)
    state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
    rebuildMessageIndexById(state)
    clearCheckpointsFromIndex(state, backendIndex, checkpointId)
    setTotalMessagesFromWindow(state)

    // 再次校验归属
    if (!validateSessionIdentity(state, originConvId)) return

    // 4. 开始流式 reroll
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true

    const assistantMessageId = generateId()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      backendIndex: state.windowStartIndex.value + state.allMessages.value.length,
      streaming: true,
      localOnly: true,
      metadata: {
        modelVersion: currentModelName
      }
    }
    // 改走 appendMessage：raw push 绕过消息索引登记（messageIndexById / toolResponseIndex），
    // 后续按 id 定位会退化为 findIndex 并触发整表重建；appendMessage 增量登记 + 不递增结构版本
    // （纯尾部追加，todoSnapshot / usedTokens 增量缓存可继续走增量路径）
    appendMessage(state, assistantMessage)
    syncTotalMessagesFromWindow(state)
    trimWindowFromTop(state)
    state.streamingMessageId.value = assistantMessageId

    // 置位：流结束（complete/error/cancelled）后刷新分支图，BranchSwitcherBar 显示候选切换器
    state._pendingBranchRefreshAfterStream.value = originConvId

    // 5. 调用后端 reroll（决策 7：旧分支保留，可切换回）
    const modelOverride = resolveConversationModelOverride(state)
    branchReplayContext = {
      kind: 'reroll',
      conversationId: originConvId,
      assistantNodeId: targetMessageId,
      configId: state.configId.value,
      modelOverride,
      promptModeId: state.currentPromptModeId.value
    }
    state._pendingBranchReplayContext.value = branchReplayContext
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    await sendToExtension(MESSAGE_NAMES['chat.rerollStream'], {
      conversationId: originConvId,
      // 目标 assistant 消息的稳定节点 ID（BR-01：Content.id 与 BranchGraph 节点 id 对齐）
      assistantNodeId: targetMessageId,
      configId: state.configId.value,
      modelOverride,
      streamId,
      promptModeId: state.currentPromptModeId.value
    })

  } catch (err: any) {
    if (state._pendingBranchReplayContext.value?.conversationId === originConvId) {
      state._pendingBranchReplayContext.value = null
    }
    // 本次 reroll 已中止：无论会话是否切换，先复位分支图标记，避免残留误消费
    state._pendingBranchRefreshAfterStream.value = null
    if (validateSessionIdentity(state, originConvId)) {
      state.error.value = {
        code: err.code || 'RESTORE_RETRY_ERROR',
        message: err.message || '回档并重试失败',
        branchReplayContext: branchReplayContext ?? undefined
      }
      // reroll 流启动失败：本地窗口已截断而后端主历史可能未截断——
      // 重载最后一页 + 检查点恢复前后端一致，并复位流式状态与分支图刷新标记
      try {
        await loadHistory(state)
        await loadCheckpoints(state)
      } catch (reloadErr) {
        console.error('[checkpointActions] Failed to reload history after reroll start failure:', reloadErr)
      }
      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.activeStreamId.value = null
      state.isWaitingForResponse.value = false
    }
  } finally {
    state.isLoading.value = false
  }
}

/**
 * 回档并删除
 *
 * 先恢复到指定检查点，然后删除该消息及后续消息
 *
 * @param messageIndex allMessages 中的索引
 * @param checkpointId 检查点 ID
 * @param confirmedDeleteUntracked 用户是否已在确认框中确认待删除文件清单（含快照后新建文件）。
 *        只有确认过的调用才允许删除快照后新建文件，默认 false（#29 保护）。
 * @param confirmedDiscardDirty BCP-05（决策 11）：用户已在未保存文件确认框中确认后传 true。
 */
export async function restoreAndDelete(
  state: ChatStoreState,
  messageIndex: number,
  checkpointId: string,
  cancelStream: () => Promise<void>,
  confirmedDeleteUntracked: boolean = false,
  confirmedDiscardDirty?: boolean,
  previewId?: string,
  confirmedDirtyFiles?: string[]
): Promise<void> {
  if (!state.currentConversationId.value || messageIndex < 0 || messageIndex >= state.allMessages.value.length) {
    return
  }

  // await cancelStream() 之前固化 originConvId 与 targetMessageId
  const originConvId = state.currentConversationId.value
  const targetMessageId = state.allMessages.value[messageIndex]?.id

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属
  if (!validateSessionIdentity(state, originConvId)) return
  // R3-#13: 按 id 定位后重算索引（await cancelStream 期间数组可能已变化）
  let targetIndex = state.allMessages.value.findIndex(m => m.id === targetMessageId)
  if (targetIndex === -1) return

  state.error.value = null
  state.isLoading.value = true

  try {
    // 1. 先恢复检查点（只有调用方确认了待删除文件清单才删除快照后新建文件）
    const restoreResult = await restoreCheckpoint(
      state,
      checkpointId,
      confirmedDeleteUntracked,
      confirmedDiscardDirty,
      previewId,
      confirmedDirtyFiles
    )
    if (!validateSessionIdentity(state, originConvId)) {
      state.isLoading.value = false
      return
    }
    // BCP-05（决策 11）：后端拦截到未保存文件 → 登记待确认动作，不写错误条
    if (restoreResult.dirtyFiles && restoreResult.dirtyFiles.length > 0) {
      // BCP-05 归属：经 setPendingDirtyConfirm 记录发起会话（originConvId，await 前固化）
      setPendingDirtyConfirm(originConvId, {
        kind: 'restore',
        files: restoreResult.dirtyFiles,
        restore: {
          entry: 'delete',
          checkpointId,
          deleteUntrackedFiles: confirmedDeleteUntracked,
          previewId,
          messageId: targetMessageId
        }
      })
      state.isLoading.value = false
      return
    }
    if (!restoreResult.success) {
      if (validateSessionIdentity(state, originConvId)) {
        state.error.value = {
          code: 'RESTORE_ERROR',
          message: restoreResult.error || '恢复检查点失败'
        }
      }
      state.isLoading.value = false
      return
    }

    targetIndex = state.allMessages.value.findIndex(m => m.id === targetMessageId)
    if (targetIndex === -1) {
      state.isLoading.value = false
      return
    }

    // 2. 计算后端索引（在删除本地消息之前）
    const backendIndex = calculateBackendIndex(state.allMessages.value, targetIndex, state.windowStartIndex.value)

    // 3. 删除该消息及后续的本地消息和检查点
    state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
    rebuildMessageIndexById(state)
    clearCheckpointsFromIndex(state, backendIndex, checkpointId)
    setTotalMessagesFromWindow(state)

    // 4. 删除后端的消息；失败时明确提示，避免前端已截断而后端历史残留的静默不一致（CP-11）
    let deleteFailed = false
    try {
      const resp = await sendToExtension<any>(MESSAGE_NAMES.deleteMessage, {
        conversationId: originConvId,
        targetIndex: backendIndex,
        preserveCheckpointId: checkpointId
      })
      if (!resp?.success) {
        deleteFailed = true
        console.error('[checkpointActions] restoreAndDelete: backend deleteMessage returned error:', resp)
      } else {
        // 删除/回滚后刷新 activeBuild，避免展示旧的 Build 壳
        await refreshCurrentConversationBuildSession(state)
      }
    } catch (err) {
      deleteFailed = true
      console.error('Failed to delete messages from backend:', err)
    }
    if (deleteFailed && validateSessionIdentity(state, originConvId)) {
      state.error.value = {
        code: 'DELETE_MESSAGE_ERROR',
        message: '回档后删除旧消息失败，请刷新对话后检查历史状态。'
      }
      // 本地窗口已截断而后端历史未删：重新加载历史 + 检查点恢复一致（CP-11 / M-2）
      try {
        await loadHistory(state)
        await loadCheckpoints(state)
      } catch (reloadErr) {
        console.error('[checkpointActions] Failed to reload history after delete failure:', reloadErr)
      }
    }

  } catch (err: any) {
    if (validateSessionIdentity(state, originConvId)) {
      state.error.value = {
        code: err.code || 'RESTORE_DELETE_ERROR',
        message: err.message || '回档并删除失败'
      }
    }
  } finally {
    state.isLoading.value = false
 }
}

/**
 * 回档并编辑
 *
 * 先恢复到指定检查点，然后编辑消息并创建编辑候选
 * （TREE-03/决策 7：走 chat.editBranchStream，旧分支保留，不覆盖原消息）。
 *
 * @param messageIndex allMessages 中的索引
 * @param newContent 新的消息内容
 * @param attachments 附件列表（可选）
 * @param checkpointId 检查点 ID
 * @param currentModelName 当前模型名称
 * @param confirmedDeleteUntracked 用户是否已在确认框中确认待删除文件清单（含快照后新建文件）。
 *        只有确认过的调用才允许删除快照后新建文件，默认 false（#29 保护）。
 * @param confirmedDiscardDirty BCP-05（决策 11）：用户已在未保存文件确认框中确认后传 true。
 */
export async function restoreAndEdit(
  state: ChatStoreState,
  messageIndex: number,
  newContent: string,
  attachments: Attachment[] | undefined,
  checkpointId: string,
  currentModelName: string,
  cancelStream: () => Promise<void>,
  confirmedDeleteUntracked: boolean = false,
  confirmedDiscardDirty?: boolean,
  previewId?: string,
  confirmedDirtyFiles?: string[]
): Promise<void> {
  if (!state.currentConversationId.value || messageIndex < 0 || messageIndex >= state.allMessages.value.length) {
    return
  }

  if (!newContent.trim() && (!attachments || attachments.length === 0)) {
    return
  }

  // await cancelStream() 之前固化 originConvId 与 targetMessageId
  const originConvId = state.currentConversationId.value
  const targetMessageId = state.allMessages.value[messageIndex]?.id
  if (!targetMessageId) return

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属
  if (!validateSessionIdentity(state, originConvId)) return
  if (state.allMessages.value[messageIndex]?.id !== targetMessageId) return

  state.error.value = null
  state._pendingBranchReplayContext.value = null
  state.isLoading.value = true

  let branchReplayContext: BranchStreamReplayContext | null = null
  try {
    // 1. 先恢复检查点（只有调用方确认了待删除文件清单才删除快照后新建文件）
    const restoreResult = await restoreCheckpoint(
      state,
      checkpointId,
      confirmedDeleteUntracked,
      confirmedDiscardDirty,
      previewId,
      confirmedDirtyFiles
    )
    if (!validateSessionIdentity(state, originConvId)) {
      state.isLoading.value = false
      return
    }
    // BCP-05（决策 11）：后端拦截到未保存文件 → 登记待确认动作，不写错误条
    if (restoreResult.dirtyFiles && restoreResult.dirtyFiles.length > 0) {
      // BCP-05 归属：经 setPendingDirtyConfirm 记录发起会话（originConvId，await 前固化）
      setPendingDirtyConfirm(originConvId, {
        kind: 'restore',
        files: restoreResult.dirtyFiles,
        restore: {
          entry: 'edit',
          checkpointId,
          deleteUntrackedFiles: confirmedDeleteUntracked,
          previewId,
          messageId: targetMessageId,
          newContent,
          attachments
        }
      })
      state.isLoading.value = false
      return
    }
    if (!restoreResult.success) {
      // R3-#13（编辑同款）：await restoreCheckpoint 期间会话可能已切换，错误只写回原会话
      if (validateSessionIdentity(state, originConvId)) {
        state.error.value = {
          code: 'RESTORE_ERROR',
          message: restoreResult.error || '恢复检查点失败'
        }
      }
      state.isLoading.value = false
      return
    }

    // R3-#13（编辑同款）：await restoreCheckpoint 期间数组可能已变化（如用户发送了新消息），
    // 按 id 重定位目标后重算索引；目标消息已不存在时中止（不写本地窗口）。
    const targetIndex = state.allMessages.value.findIndex(m => m.id === targetMessageId)
    if (targetIndex === -1) {
      state.isLoading.value = false
      return
    }

    // 计算后端索引（在修改数组之前）
    const backendMessageIndex = calculateBackendIndex(state.allMessages.value, targetIndex, state.windowStartIndex.value)

    // 2. 更新本地消息内容和附件
    const targetMessage = state.allMessages.value[targetIndex]
    // 根节点（parentId 为 null/undefined）：BranchGraph 单根模型下无父节点可挂「新 user 编辑
    // 节点」候选，但后端支持根节点编辑重生成（TREE-03-R：原地改写根节点 + 截断其后 +
    // 新建模型候选，旧回答保留为可切换候选）。回档并编辑语义上必然重新生成，恒走 branch。
    targetMessage.content = newContent
    targetMessage.parts = [{ text: newContent }]
    targetMessage.attachments = attachments && attachments.length > 0 ? attachments : undefined

    // 3. 删除该消息之后的本地消息和该消息及之后的检查点（因为消息内容已变化）
    state.allMessages.value = state.allMessages.value.slice(0, targetIndex + 1)
    rebuildMessageIndexById(state)
    clearCheckpointsFromIndex(state, backendMessageIndex, checkpointId)
    setTotalMessagesFromWindow(state)

    // 5. 开始流式编辑重试
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true

    const assistantMessageId = generateId()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      backendIndex: state.windowStartIndex.value + state.allMessages.value.length,
      streaming: true,
      localOnly: true,
      metadata: {
        modelVersion: currentModelName
      }
    }
    // 同 reroll 路径：改走 appendMessage 登记消息索引（见上）
    appendMessage(state, assistantMessage)
    syncTotalMessagesFromWindow(state)
    trimWindowFromTop(state)
    state.streamingMessageId.value = assistantMessageId

    // 置位：流结束（complete/error/cancelled）后刷新分支图，BranchSwitcherBar 显示候选切换器
    state._pendingBranchRefreshAfterStream.value = originConvId

    const effectiveMode = 'branch'

    // 6. 调用后端编辑分支（TREE-03/决策 7：创建编辑候选，旧分支保留，不覆盖原消息）。
    //    附件随请求透传（后端 buildEditUserParts 重建 parts 的 inlineData；缺省时后端保留原消息附件）。
    const modelOverride = resolveConversationModelOverride(state)
    branchReplayContext = {
      kind: 'editBranch',
      conversationId: originConvId,
      userNodeId: targetMessageId,
      newText: newContent,
      // 编辑后保留的附件快照（重放路径原样带回）
      attachments,
      configId: state.configId.value,
      modelOverride,
      promptModeId: state.currentPromptModeId.value,
      // 根节点 branch（TREE-03-R）：后端原地改写根节点 + 截断其后 + 重新生成
      mode: effectiveMode
    }
    state._pendingBranchReplayContext.value = branchReplayContext
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    await sendToExtension(MESSAGE_NAMES['chat.editBranchStream'], {
      conversationId: originConvId,
      // 被编辑用户消息的稳定节点 ID（BR-01：Content.id 与 BranchGraph 节点 id 对齐）
      userNodeId: targetMessageId,
      newText: newContent,
      // 编辑后保留的附件（用户删除图片后保存 = 空数组，后端据此清掉对应 inlineData）
      attachments: attachments && attachments.length > 0 ? attachments : [],
      configId: state.configId.value,
      modelOverride,
      streamId,
      promptModeId: state.currentPromptModeId.value,
      // 根节点 branch（TREE-03-R）：后端原地改写根节点 + 截断其后 + 重新生成
      mode: effectiveMode
    })

  } catch (err: any) {
    if (state._pendingBranchReplayContext.value?.conversationId === originConvId) {
      state._pendingBranchReplayContext.value = null
    }
    // 本次编辑分支流已中止：无论会话是否切换，先复位分支图标记，避免残留误消费
    state._pendingBranchRefreshAfterStream.value = null
    if (validateSessionIdentity(state, originConvId)) {
      state.error.value = {
        code: err.code || 'RESTORE_EDIT_ERROR',
        message: err.message || '回档并编辑失败',
        branchReplayContext: branchReplayContext ?? undefined
      }
      // 编辑分支流启动失败：本地窗口已截断改写而后端主历史可能未截断——
      // 重载历史 + 检查点恢复前后端一致，并复位流式状态与分支图刷新标记
      // （与 restoreAndRetry 的 reroll 模式一致）
      try {
        await loadHistory(state)
        await loadCheckpoints(state)
      } catch (reloadErr) {
        console.error('[checkpointActions] Failed to reload after restoreAndEdit failure:', reloadErr)
      }
      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.activeStreamId.value = null
      state.isWaitingForResponse.value = false
    }
  } finally {
    state.isLoading.value = false
  }
}

// ============ 上下文总结（L-2：职责拆分，实现在 messageActions，此处 re-export 保持导出名不变） ============
// 总结上下文与 checkpoint 职责无关，已迁至 messageActions.ts；
// chatStore 等调用方仍从本模块导入，re-export 保证调用方零改动。
export { summarizeContext, cancelSummarizeRequest } from './messageActions'

// ============ 存档操作进度 / 取消（M7，CPF-11） ============

/** 与后端 CheckpointOperationProgress 对齐的操作进度 */
export interface CheckpointOperationProgress {
  operationId: string
  kind: string
  conversationId?: string
  checkpointId?: string
  phase: string
  processed: number
  total: number
  cancelled: boolean
  startedAt: number
  updatedAt: number
  message?: string
}

/**
 * 轮询进行中存档操作的进度（M7）。
 * operationId 缺省时返回最近更新的进行中操作；无进行中操作返回 null。
 */
export async function pollOperationProgress(
  operationId?: string
): Promise<CheckpointOperationProgress | null> {
  try {
    const result = await sendToExtension<{ progress: CheckpointOperationProgress | null }>(
      MESSAGE_NAMES['checkpoint.getOperationProgress'],
      { operationId }
    )
    return result?.progress ?? null
  } catch (error: any) {
    // M-1/M-4：错误向上抛出（不吞成 null）。null 只表示“无进行中操作”，
    // 调用方（设置页轮询）据此区分“瞬时 IPC 错误（重试）”与“操作已结束（停止轮询）”。
    console.error('[checkpointActions] Failed to poll operation progress:', error)
    throw error
  }
}

/**
 * 取消进行中的存档操作（M7）。
 * @returns 是否存在该操作并已触发取消
 */
export async function cancelCheckpointOperation(operationId: string): Promise<boolean> {
  try {
    const result = await sendToExtension<{ cancelled: boolean }>(
      MESSAGE_NAMES['checkpoint.cancelOperation'],
      { operationId }
    )
    return result?.cancelled === true
  } catch (error: any) {
    console.error('[checkpointActions] Failed to cancel operation:', error)
    return false
  }
}

/**
 * 获取存档完整 manifest（EX-11 / L-9：checkpoint.getManifest 前端调用方）。
 *
 * 设置页「排除详情」入口使用：展示该存档创建时的排除统计/排除规则快照摘要。
 * 旧版存档（无 manifest 文件）后端返回 { manifest: null }，调用方据此提示不可用。
 */
export async function getCheckpointManifest(
  checkpointId: string
): Promise<{ manifest: CheckpointManifest | null; error?: string }> {
  try {
    const result = await sendToExtension<{ manifest: CheckpointManifest | null }>(
      MESSAGE_NAMES['checkpoint.getManifest'],
      { checkpointId }
    )
    return { manifest: result?.manifest ?? null }
  } catch (error: any) {
    console.error('[checkpointActions] Failed to load checkpoint manifest:', error)
    return { manifest: null, error: error?.message || 'Failed to load checkpoint manifest' }
  }
}
