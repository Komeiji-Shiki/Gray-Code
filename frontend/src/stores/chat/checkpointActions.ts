/**
 * Chat Store 检查点操作
 * 
 * 包含检查点的 CRUD 和恢复操作
 */

import type { Message, Attachment, CheckpointRecord } from '../../types'
import type { ChatStoreState, AttachmentData } from './types'
import { sendToExtension } from '../../utils/vscode'
import { generateId } from '../../utils/format'
import { calculateBackendIndex } from './messageActions'
import { syncTotalMessagesFromWindow, setTotalMessagesFromWindow, trimWindowFromTop } from './windowUtils'
import { loadCheckpoints, refreshCurrentConversationBuildSession, loadHistory } from './conversationActions'
import { validateSessionIdentity } from './utils'
import { rebuildMessageIndexById } from './state'

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
    }>(
      'checkpoint.previewRestore',
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
    return await sendToExtension<ExclusionPreviewResult>('checkpoint.previewExclusions', {})
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
 */
export async function restoreCheckpoint(
  state: ChatStoreState,
  checkpointId: string,
  deleteUntrackedFiles?: boolean
): Promise<{
  success: boolean
  restored: number
  deleted?: number
  skipped?: number
  error?: string
  missingBackupDirs?: string[]
  autoPrunedCheckpointCount?: number
  failures?: Array<{ path: string; reason: string }>
  unbackedPaths?: string[]
}> {
  if (!state.currentConversationId.value) {
    return { success: false, restored: 0, error: 'No conversation selected' }
  }
  
  try {
    const result = await sendToExtension<{
      success: boolean
      restored: number
      deleted?: number
      skipped?: number
      error?: string
      missingBackupDirs?: string[]
      autoPrunedCheckpointCount?: number
      failures?: Array<{ path: string; reason: string }>
      unbackedPaths?: string[]
    }>(
      'checkpoint.restore',
      {
        conversationId: state.currentConversationId.value,
        checkpointId,
        deleteUntrackedFiles: deleteUntrackedFiles === true
      }
    )
    
    const normalized = result || { success: false, restored: 0, error: 'Unknown error' }
    if ((normalized.autoPrunedCheckpointCount || 0) > 0) {
      try {
        await loadCheckpoints(state)
      } catch (error) {
        console.error('[checkpointActions] Failed to refresh checkpoints after auto prune:', error)
      }
    }
    if (normalized.success) {
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
 */
export async function restoreAndRetry(
  state: ChatStoreState,
  messageIndex: number,
  checkpointId: string,
  currentModelName: string,
  cancelStream: () => Promise<void>,
  confirmedDeleteUntracked: boolean = false
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
  if (state.allMessages.value[messageIndex]?.id !== targetMessageId) return

  state.error.value = null
  state.isLoading.value = true

  try {
    // 1. 先恢复检查点（只有调用方确认了待删除文件清单才删除快照后新建文件）
    const restoreResult = await restoreCheckpoint(state, checkpointId, confirmedDeleteUntracked)
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

    // 2. 计算后端索引（在删除本地消息之前）
    const backendIndex = calculateBackendIndex(state.allMessages.value, messageIndex, state.windowStartIndex.value)

    // 3. 删除该消息及后续的本地消息和检查点
    state.allMessages.value = state.allMessages.value.slice(0, messageIndex)
    rebuildMessageIndexById(state)
    clearCheckpointsFromIndex(state, backendIndex, checkpointId)
    setTotalMessagesFromWindow(state)

    // 4. 删除后端的消息；失败必须中止重试，否则后端历史截断失败时，
    //    重试生成的消息会追加在旧消息之后，造成历史重复（CP-11）
    let deleteFailed = false
    try {
      const resp = await sendToExtension<any>('deleteMessage', {
        conversationId: originConvId,
        targetIndex: backendIndex,
        preserveCheckpointId: checkpointId
      })
      if (!resp?.success) {
        deleteFailed = true
        console.error('[checkpointActions] restoreAndRetry: backend deleteMessage returned error:', resp)
      }
    } catch (err) {
      deleteFailed = true
      console.error('Failed to delete messages from backend:', err)
    }
    if (deleteFailed) {
      if (validateSessionIdentity(state, originConvId)) {
        state.error.value = {
          code: 'DELETE_MESSAGE_ERROR',
          message: '回档后删除旧消息失败，已中止重试。请刷新对话后重试。'
        }
      }
      // 本地窗口已截断而后端历史未删：重新加载历史恢复一致（CP-11）
      try {
        await loadHistory(state)
      } catch (reloadErr) {
        console.error('[checkpointActions] Failed to reload history after delete failure:', reloadErr)
      }
      state.isLoading.value = false
      return
    }

    // 再次校验归属
    if (!validateSessionIdentity(state, originConvId)) return

    // 5. 开始流式重试
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
    state.allMessages.value.push(assistantMessage)
    syncTotalMessagesFromWindow(state)
    trimWindowFromTop(state)
    state.streamingMessageId.value = assistantMessageId

    // 6. 调用后端重试
    const modelOverride = resolveConversationModelOverride(state)
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    await sendToExtension('retryStream', {
      conversationId: originConvId,
      configId: state.configId.value,
      modelOverride,
      streamId
    })

  } catch (err: any) {
    if (state.isStreaming.value && validateSessionIdentity(state, originConvId)) {
      state.error.value = {
        code: err.code || 'RESTORE_RETRY_ERROR',
        message: err.message || '回档并重试失败'
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
 */
export async function restoreAndDelete(
  state: ChatStoreState,
  messageIndex: number,
  checkpointId: string,
  cancelStream: () => Promise<void>,
  confirmedDeleteUntracked: boolean = false
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
  if (state.allMessages.value[messageIndex]?.id !== targetMessageId) return

  state.error.value = null
  state.isLoading.value = true

  try {
    // 1. 先恢复检查点（只有调用方确认了待删除文件清单才删除快照后新建文件）
    const restoreResult = await restoreCheckpoint(state, checkpointId, confirmedDeleteUntracked)
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

    // 2. 计算后端索引（在删除本地消息之前）
    const backendIndex = calculateBackendIndex(state.allMessages.value, messageIndex, state.windowStartIndex.value)

    // 3. 删除该消息及后续的本地消息和检查点
    state.allMessages.value = state.allMessages.value.slice(0, messageIndex)
    rebuildMessageIndexById(state)
    clearCheckpointsFromIndex(state, backendIndex, checkpointId)
    setTotalMessagesFromWindow(state)

    // 4. 删除后端的消息；失败时明确提示，避免前端已截断而后端历史残留的静默不一致（CP-11）
    let deleteFailed = false
    try {
      const resp = await sendToExtension<any>('deleteMessage', {
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
      // 本地窗口已截断而后端历史未删：重新加载历史恢复一致（CP-11）
      try {
        await loadHistory(state)
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
 * 先恢复到指定检查点，然后编辑消息并重试
 *
 * @param messageIndex allMessages 中的索引
 * @param newContent 新的消息内容
 * @param attachments 附件列表（可选）
 * @param checkpointId 检查点 ID
 * @param currentModelName 当前模型名称
 * @param confirmedDeleteUntracked 用户是否已在确认框中确认待删除文件清单（含快照后新建文件）。
 *        只有确认过的调用才允许删除快照后新建文件，默认 false（#29 保护）。
 */
export async function restoreAndEdit(
  state: ChatStoreState,
  messageIndex: number,
  newContent: string,
  attachments: Attachment[] | undefined,
  checkpointId: string,
  currentModelName: string,
  cancelStream: () => Promise<void>,
  confirmedDeleteUntracked: boolean = false
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

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属
  if (!validateSessionIdentity(state, originConvId)) return
  if (state.allMessages.value[messageIndex]?.id !== targetMessageId) return

  state.error.value = null
  state.isLoading.value = true

  // 计算后端索引（在修改数组之前）
  const backendMessageIndex = calculateBackendIndex(state.allMessages.value, messageIndex, state.windowStartIndex.value)
  
  try {
    // 1. 先恢复检查点（只有调用方确认了待删除文件清单才删除快照后新建文件）
    const restoreResult = await restoreCheckpoint(state, checkpointId, confirmedDeleteUntracked)
    if (!restoreResult.success) {
      state.error.value = {
        code: 'RESTORE_ERROR',
        message: restoreResult.error || '恢复检查点失败'
      }
      state.isLoading.value = false
      return
    }
    
    // 2. 更新本地消息内容和附件
    const targetMessage = state.allMessages.value[messageIndex]
    targetMessage.content = newContent
    targetMessage.parts = [{ text: newContent }]
    targetMessage.attachments = attachments && attachments.length > 0 ? attachments : undefined
    
    // 3. 删除该消息之后的本地消息和该消息及之后的检查点（因为消息内容已变化）
    state.allMessages.value = state.allMessages.value.slice(0, messageIndex + 1)
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
    state.allMessages.value.push(assistantMessage)
    syncTotalMessagesFromWindow(state)
    trimWindowFromTop(state)
    state.streamingMessageId.value = assistantMessageId
    
    // 6. 准备附件数据（序列化为纯对象）
    const attachmentData: AttachmentData[] | undefined = attachments && attachments.length > 0
      ? attachments.map(att => ({
          id: att.id,
          name: att.name,
          type: att.type,
          size: att.size,
          mimeType: att.mimeType,
          data: att.data || '',
          thumbnail: att.thumbnail
        }))
      : undefined
    
    // 7. 调用后端编辑并重试
    const modelOverride = resolveConversationModelOverride(state)
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    await sendToExtension('editAndRetryStream', {
      conversationId: originConvId,
      messageIndex: backendMessageIndex,
      preserveCheckpointId: checkpointId,
      newMessage: newContent,
      attachments: attachmentData,
      configId: state.configId.value,
      modelOverride,
      streamId
    })
    
  } catch (err: any) {
    // 会话已切换时不得污染新会话的错误/流式状态（H1/M2）
    if (state.isStreaming.value && validateSessionIdentity(state, originConvId)) {
      state.error.value = {
        code: err.code || 'RESTORE_EDIT_ERROR',
        message: err.message || '回档并编辑失败'
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
 * 总结上下文
 *
 * 将旧的对话历史压缩为一条总结消息
 * 所有参数（keepRecentRounds、summarizePrompt）从后端配置读取
 *
 * @returns 总结结果
 */
export async function summarizeContext(
  state: ChatStoreState,
  loadHistory: () => Promise<void>
): Promise<{
  success: boolean
  summarizedMessageCount?: number
  errorCode?: string
  error?: string
}> {
  const originConversationId = state.currentConversationId.value

  const setManualSummaryStatusForConversation = (
    status: { isSummarizing: boolean; mode?: 'auto' | 'manual'; message?: string } | null
  ) => {
    // 当前仍是原对话，直接更新当前状态
    if (!originConversationId || originConversationId === state.currentConversationId.value) {
      state.autoSummaryStatus.value = status
      return
    }

    // 对话已切换，更新原对话对应标签页快照，避免跨对话污染
    const tab = state.openTabs.value.find(t => t.conversationId === originConversationId)
    if (!tab) return

    const snapshot = state.sessionSnapshots.value.get(tab.id)
    if (snapshot) {
      snapshot.autoSummaryStatus = status ? { ...status } : null
    }
  }

  if (!originConversationId) {
    return { success: false, errorCode: 'NO_CONVERSATION', error: 'No conversation selected' }
  }
  
  if (!state.configId.value) {
    return { success: false, errorCode: 'NO_CONFIG', error: 'No config selected' }
  }

  // 显示底部提示（对话级隔离）
  setManualSummaryStatusForConversation({
    isSummarizing: true,
    mode: 'manual'
  })
  
  try {
    // 只传递必要参数，所有配置项从后端读取
    const result = await sendToExtension<{
      success: boolean
      summaryContent?: any
      summarizedMessageCount?: number
      error?: { code: string; message: string }
    }>('summarizeContext', {
      conversationId: originConversationId,
      configId: state.configId.value
    })
    
    if (result.success && result.summaryContent) {
      // 重新加载历史以获取更新后的消息列表；
      // 用户在此期间切换会话时跳过重载，避免把新会话历史整体覆盖进 allMessages（H1）
      if (validateSessionIdentity(state, originConversationId)) {
        await loadHistory()
      }

      return {
        success: true,
        summarizedMessageCount: result.summarizedMessageCount
      }
    } else {
      return {
        success: false,
        errorCode: result.error?.code,
        error: result.error?.message || 'Summarize failed'
      }
    }
  } catch (err: any) {
    return {
      success: false,
      errorCode: err?.code,
      error: err.message || 'Summarize failed'
    }
  } finally {
    // 结束提示（对话级隔离）
    setManualSummaryStatusForConversation(null)
  }
}

/**
 * 取消当前对话的总结请求（仅取消总结 API，不影响后续 AI 响应）
 */
export async function cancelSummarizeRequest(state: ChatStoreState): Promise<void> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return

  try {
    await sendToExtension('cancelSummarizeRequest', { conversationId })
  } catch (error) {
    console.error('[checkpointActions] Failed to cancel summarize request:', error)
  }
}

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
      'checkpoint.getOperationProgress',
      { operationId }
    )
    return result?.progress ?? null
  } catch (error: any) {
    console.error('[checkpointActions] Failed to poll operation progress:', error)
    return null
  }
}

/**
 * 取消进行中的存档操作（M7）。
 * @returns 是否存在该操作并已触发取消
 */
export async function cancelCheckpointOperation(operationId: string): Promise<boolean> {
  try {
    const result = await sendToExtension<{ cancelled: boolean }>(
      'checkpoint.cancelOperation',
      { operationId }
    )
    return result?.cancelled === true
  } catch (error: any) {
    console.error('[checkpointActions] Failed to cancel operation:', error)
    return false
  }
}
