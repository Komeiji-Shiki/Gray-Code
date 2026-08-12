/**
 * useCheckpointRestoreFlow - checkpoint 删除 / 恢复确认流
 *
 * 从 MessageList.vue 拆分（S4 批次），纯重构不改行为：
 * - 删除确认对话框状态（showDeleteConfirm / pendingDelete* / deleteCount / deleteCheckpoints）
 * - 恢复检查点确认流（CP-09）：预览 → 确认框展示待删除清单 → 确认后执行
 * - 恢复结果分级提示（H-3，restoreNotice 族，不占用错误条）
 * - checkpoint 展示辅助（合并判定 mergeableCheckpointKeys / 标签 / 时间格式化）
 */

import { ref, computed } from 'vue'
import { useChatStore } from '../../stores'
import { formatTime } from '../../utils/format'
import type { CheckpointRecord, Attachment } from '../../types'
import type { RestoreNoticeState } from './messageListUiState'

export interface UseCheckpointRestoreFlowOptions {
  chatStore: ReturnType<typeof useChatStore>
  t: (key: string, params?: Record<string, any>) => string
}

export function useCheckpointRestoreFlow(options: UseCheckpointRestoreFlowOptions) {
  const { chatStore, t } = options

  // 预计算可见消息的增强信息，避免在模板中进行昂贵的计算（checkpoint 分组入口，渲染侧共用）
  const checkpointsByMsgIndex = computed(() => chatStore.checkpointsByMessageIndex)

  const mergeableCheckpointKeys = computed(() => {
    const keys = new Set<string>()
    if (!chatStore.mergeUnchangedCheckpoints) return keys

    for (const [messageIndex, group] of checkpointsByMsgIndex.value.entries()) {
      if (!group.before.length || !group.after.length) continue
      const beforeHashes = new Map<string, string>()
      for (const cp of group.before) {
        if (cp.contentHash) beforeHashes.set(cp.toolName, cp.contentHash)
      }
      for (const cp of group.after) {
        const beforeHash = beforeHashes.get(cp.toolName)
        if (beforeHash && cp.contentHash && beforeHash === cp.contentHash) {
          keys.add(`${messageIndex}:${cp.toolName}`)
        }
      }
    }

    return keys
  })

  // 删除确认对话框状态
  const showDeleteConfirm = ref(false)
  const pendingDeleteMessageId = ref<string | null>(null)
  const pendingDeleteBackendIndex = ref<number | null>(null)

  // 恢复检查点确认对话框状态
  // CP-09: 所有恢复入口（普通恢复 / 回档并重试 / 回档并删除 / 回档并编辑）
  // 先预览（计算待删除文件清单），确认框展示清单，用户确认后才真正执行恢复。
  interface PendingRestoreAction {
    kind: 'restore' | 'retry' | 'delete' | 'edit'
    /** M-8: 发起预览时固化的对话身份；确认时校验，避免恢复错误对话的存档 */
    conversationId: string
    checkpointId: string
    messageId?: string
    newContent?: string
    attachments?: Attachment[]
    preview: Awaited<ReturnType<typeof chatStore.previewRestore>>
  }
  const showRestoreConfirm = ref(false)
  const pendingRestoreAction = ref<PendingRestoreAction | null>(null)

  // 确认框展示的删除清单上限（超出显示省略计数）
  const RESTORE_DELETE_LIST_LIMIT = 30
  const isRestorePreviewing = computed(() => chatStore.isRestorePreviewing)
  // L-1: 当前正在预览的检查点 ID——只对发起预览的那个恢复按钮显示 spinner，避免全局转圈
  const previewingCheckpointId = ref<string | null>(null)

  // H-3: 恢复类结果（失败/部分失败/警告/成功）用独立提示样式展示，不再塞入 chatStore.error，
  // 避免错误条“重试”按钮误触发 retryAfterError → LLM 重新生成。
  const restoreNotice = ref<RestoreNoticeState | null>(null)

  function showRestoreNotice(kind: RestoreNoticeState['kind'], message: string) {
    restoreNotice.value = { kind, message }
  }

  const restoreNoticeIconClass = computed(() => {
    switch (restoreNotice.value?.kind) {
      case 'partial': return 'codicon-warning'
      case 'warning': return 'codicon-info'
      case 'success': return 'codicon-check'
      default: return 'codicon-error'
    }
  })

  const restoreNoticeTitle = computed(() => {
    switch (restoreNotice.value?.kind) {
      case 'partial': return t('components.message.checkpoint.restoreResultPartialTitle')
      case 'warning': return t('components.message.checkpoint.restoreResultWarningTitle')
      case 'success': return t('components.message.checkpoint.restoreResultSuccessTitle')
      default: return t('components.message.checkpoint.restoreResultErrorTitle')
    }
  })

  // 计算要删除的消息数量（使用 allMessages）
  const deleteCount = computed(() => {
    if (pendingDeleteBackendIndex.value === null) return 0
    // backendIndex 为绝对索引：删除数量 = total - index
    const total = chatStore.totalMessages || 0
    const idx = pendingDeleteBackendIndex.value
    if (idx < 0) return 0
    return Math.max(0, total - idx)
  })

  // 处理删除 - 显示确认对话框
  function handleDelete(messageId: string) {
    pendingDeleteMessageId.value = messageId
    const msg = chatStore.allMessages.find(m => m.id === messageId)
    pendingDeleteBackendIndex.value = typeof msg?.backendIndex === 'number' ? msg.backendIndex : null
    showDeleteConfirm.value = true
  }

  // 确认删除 - 使用 allMessages 中的真实索引
  function confirmDelete() {
    if (!pendingDeleteMessageId.value) return
    const actualIndex = chatStore.allMessages.findIndex(m => m.id === pendingDeleteMessageId.value)
    if (actualIndex !== -1) {
      chatStore.deleteMessage(actualIndex)
    }
    pendingDeleteMessageId.value = null
    pendingDeleteBackendIndex.value = null
  }

  // 取消删除
  function cancelDelete() {
    pendingDeleteMessageId.value = null
    pendingDeleteBackendIndex.value = null
  }

  // 获取用于删除消息的最新检查点
  // 之前消息的存档点：包含所有阶段（before/after），因为这些代表已完成的操作状态
  // 当前消息的存档点：只包含 before 阶段，因为用户要撤销的是这条消息的效果
  // 与重试使用相同的策略
  const deleteCheckpoints = computed<CheckpointRecord[]>(() => {
    if (pendingDeleteBackendIndex.value === null) return []
    const messageIndex = pendingDeleteBackendIndex.value

    return chatStore.checkpoints
      .filter(cp => {
        if (cp.messageIndex < messageIndex) return true          // 之前的消息：包含所有阶段
        if (cp.messageIndex === messageIndex && cp.phase === 'before') return true  // 当前消息：只包含 before
        return false
      })
  })

  // 处理回档并删除
  async function handleRestoreAndDelete(checkpointId: string) {
    if (!pendingDeleteMessageId.value) return

    const actualIndex = chatStore.allMessages.findIndex(m => m.id === pendingDeleteMessageId.value)
    if (actualIndex === -1) return

    // 先预览恢复（待删除文件清单），确认后才执行
    await openRestoreConfirm({ kind: 'delete', checkpointId, messageId: pendingDeleteMessageId.value })
  }

  // 处理恢复检查点
  function handleRestoreCheckpoint(checkpointId: string) {
    const checkpoint = chatStore.checkpoints.find(cp => cp.id === checkpointId)
    if (checkpoint) {
      restoreCheckpoint(checkpoint)
    }
  }

  // 处理回档并重试
  async function handleRestoreAndRetry(messageId: string, checkpointId: string) {
    // 找到消息在 allMessages 中的索引
    const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
    if (actualIndex === -1) return

    // 先预览恢复（待删除文件清单），确认后才执行
    await openRestoreConfirm({ kind: 'retry', checkpointId, messageId })
  }

  // 处理回档并编辑
  async function handleRestoreAndEdit(messageId: string, newContent: string, attachments: Attachment[], checkpointId: string) {
    // 找到消息在 allMessages 中的索引
    const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
    if (actualIndex === -1) return

    // 先预览恢复（待删除文件清单），确认后才执行
    await openRestoreConfirm({ kind: 'edit', checkpointId, messageId, newContent, attachments })
  }

  // 检查特定工具的检查点是否需要合并显示（前后内容一致时合并）
  function shouldMergeForTool(messageIndex: number, toolName: string): boolean {
    if (!chatStore.mergeUnchangedCheckpoints) return false
    return mergeableCheckpointKeys.value.has(`${messageIndex}:${toolName}`)
  }

  // 恢复检查点 - 先预览（计算待删除文件清单），确认框展示清单
  async function restoreCheckpoint(checkpoint: CheckpointRecord) {
    await openRestoreConfirm({ kind: 'restore', checkpointId: checkpoint.id })
  }

  // 预览恢复并打开确认框；预览失败（链断裂/存档缺失等）时直接展示错误，不弹确认
  async function openRestoreConfirm(action: Omit<PendingRestoreAction, 'preview' | 'conversationId'>) {
    if (chatStore.isRestorePreviewing) return
    // M-8: 固化对话身份——预览与确认之间可能切换对话，确认时据此校验
    const conversationId = chatStore.currentConversationId
    if (!conversationId) return
    restoreNotice.value = null
    previewingCheckpointId.value = action.checkpointId
    chatStore.isRestorePreviewing = true
    try {
      const preview = await chatStore.previewRestore(action.checkpointId)
      if (!preview.success) {
        showRestoreNotice('error', preview.error || t('components.message.checkpoint.restorePreviewFailed'))
        return
      }
      pendingRestoreAction.value = { ...action, conversationId, preview }
      showRestoreConfirm.value = true
    } catch (err: any) {
      showRestoreNotice('error', err?.message || t('components.message.checkpoint.restorePreviewFailed'))
    } finally {
      chatStore.isRestorePreviewing = false
      previewingCheckpointId.value = null
    }
  }

  // 确认恢复检查点：按入口类型执行真正的恢复 / 回档操作
  async function confirmRestore() {
    const action = pendingRestoreAction.value
    if (!action) return
    showRestoreConfirm.value = false
    pendingRestoreAction.value = null
    restoreNotice.value = null

    // M-8: 校验对话身份——预览/确认期间若用户切换对话，丢弃本次恢复，
    // 避免把恢复/回档执行到错误对话上。
    if (action.conversationId !== chatStore.currentConversationId) {
      showRestoreNotice('error', t('components.message.checkpoint.restoreConversationChanged'))
      return
    }

    const { kind, checkpointId } = action

    try {
      if (kind === 'restore') {
        // 用户在确认框中已确认待删除文件清单（含快照后新建文件）→ deleteUntrackedFiles: true
        const result = await chatStore.restoreCheckpoint(checkpointId, true)

        // CP-10 / H-3: 恢复结果用独立提示分级展示（成功/部分成功/警告/失败），
        // 不再塞入 chatStore.error，避免错误条“重试”误触发 LLM 重新生成。
        if (result && !result.success) {
          showRestoreNotice('error', result.error || t('components.message.checkpoint.restoreResultFailed'))
        } else if (result?.failures && result.failures.length > 0) {
          const shown = result.failures.slice(0, 5).map(f => `${f.path}: ${f.reason}`).join('；')
          showRestoreNotice('partial', result.failures.length > 5
            ? t('components.message.checkpoint.restoreResultPartialMore', { files: shown, count: result.failures.length })
            : t('components.message.checkpoint.restoreResultPartial', { files: shown }))
        } else if (result?.unbackedPaths && result.unbackedPaths.length > 0) {
          // 快照时未备份（超限/不可读）的文件不会被本次恢复删除或恢复，明确告知
          const shown = result.unbackedPaths.slice(0, 5).join('、')
          showRestoreNotice('warning', result.unbackedPaths.length > 5
            ? t('components.message.checkpoint.restoreResultUnbackedMore', { paths: shown, count: result.unbackedPaths.length })
            : t('components.message.checkpoint.restoreResultUnbacked', { paths: shown }))
        } else {
          const pruned = result?.autoPrunedCheckpointCount || 0
          showRestoreNotice('success', pruned > 0
            ? t('components.message.checkpoint.restoreResultSuccessWithPrune', { count: result?.restored ?? 0, pruned })
            : t('components.message.checkpoint.restoreResultSuccess', { count: result?.restored ?? 0 }))
        }
        return
      }

      if (action.messageId === undefined) return
      const actualIndex = chatStore.allMessages.findIndex(m => m.id === action.messageId)
      if (actualIndex === -1) return

      if (kind === 'retry') {
        // 用户在确认框中已确认待删除文件清单 → 允许删除快照后新建文件
        await chatStore.restoreAndRetry(actualIndex, checkpointId, true)
      } else if (kind === 'delete') {
        await chatStore.restoreAndDelete(actualIndex, checkpointId, true)
        pendingDeleteMessageId.value = null
        pendingDeleteBackendIndex.value = null
        // R3-#7: 回档并删除确认后关闭删除确认对话框（此前 DeleteDialog 残留打开）
        showDeleteConfirm.value = false
      } else if (kind === 'edit') {
        await chatStore.restoreAndEdit(actualIndex, action.newContent || '', action.attachments, checkpointId, true)
      }
    } catch (error) {
      console.error('[MessageList] Restore operation failed:', error)
      showRestoreNotice('error', error instanceof Error ? error.message : t('components.message.checkpoint.restoreResultFailed'))
    }
  }

  // 取消恢复确认：清理暂存的预览/动作状态，避免残留旧清单
  function cancelRestoreConfirm() {
    pendingRestoreAction.value = null
  }

  // 确认框动态文案（按入口类型）
  const restoreConfirmTitle = computed(() => {
    if (!pendingRestoreAction.value) return ''
    const kind = pendingRestoreAction.value.kind
    if (kind === 'retry') return t('components.message.checkpoint.restoreConfirmRetryTitle')
    if (kind === 'delete') return t('components.message.checkpoint.restoreConfirmDeleteTitle')
    if (kind === 'edit') return t('components.message.checkpoint.restoreConfirmEditTitle')
    return t('components.message.checkpoint.restoreConfirmTitle')
  })

  const restoreConfirmMessage = computed(() => {
    const preview = pendingRestoreAction.value?.preview
    if (!preview) return ''
    // 旧版存档（无 fileHashes）：预览无法预知数量，恢复以备份目录内容为准
    if (preview.legacy) {
      return t('components.message.checkpoint.restorePreviewLegacy')
    }
    const parts: string[] = []
    if (preview.restored > 0) parts.push(t('components.message.checkpoint.restorePreviewFilesUpdated', { count: preview.restored }))
    if (preview.deleted > 0) parts.push(t('components.message.checkpoint.restorePreviewFilesDeleted', { count: preview.deleted }))
    if (preview.skipped > 0) parts.push(t('components.message.checkpoint.restorePreviewFilesUnchanged', { count: preview.skipped }))
    return parts.length > 0 ? parts.join('，') : t('components.message.checkpoint.restorePreviewNoChanges')
  })

  // 待删除文件清单：快照记录过的（deletablePaths）+ 快照后新建、需确认后删除的（untrackedPaths）
  const restoreDeletablePaths = computed(() => {
    const preview = pendingRestoreAction.value?.preview
    if (!preview) return []
    return [...preview.deletablePaths, ...preview.untrackedPaths]
  })
  const restoreHasUntrackedPaths = computed(() => (pendingRestoreAction.value?.preview.untrackedPaths.length || 0) > 0)
  const restoreShownDeletablePaths = computed(() => restoreDeletablePaths.value.slice(0, RESTORE_DELETE_LIST_LIMIT))
  const restoreHiddenDeletableCount = computed(() => Math.max(0, restoreDeletablePaths.value.length - RESTORE_DELETE_LIST_LIMIT))

  const restoreUnbackedPaths = computed(() => pendingRestoreAction.value?.preview.unbackedPaths || [])

  // 获取检查点标签
  function getCheckpointLabel(cp: CheckpointRecord, phase: 'before' | 'after'): string {
    if (cp.toolName === 'user_message') {
      return phase === 'before' ? t('components.message.checkpoint.userMessageBefore') : t('components.message.checkpoint.userMessageAfter')
    }
    if (cp.toolName === 'model_message') {
      return phase === 'before' ? t('components.message.checkpoint.assistantMessageBefore') : t('components.message.checkpoint.assistantMessageAfter')
    }
    if (cp.toolName === 'tool_batch') {
      return phase === 'before' ? t('components.message.checkpoint.toolBatchBefore') : t('components.message.checkpoint.toolBatchAfter')
    }
    return phase === 'before' ? t('components.message.checkpoint.toolExecutionBefore') : t('components.message.checkpoint.toolExecutionAfter')
  }

  // 获取合并后的标签文案
  function getMergedLabel(cp: CheckpointRecord): string {
    if (cp.toolName === 'user_message') {
      return t('components.message.checkpoint.userMessageUnchanged')
    }
    if (cp.toolName === 'model_message') {
      return t('components.message.checkpoint.assistantMessageUnchanged')
    }
    if (cp.toolName === 'tool_batch') {
      return t('components.message.checkpoint.toolBatchUnchanged')
    }
    return t('components.message.checkpoint.toolExecutionUnchanged')
  }

  // 格式化检查点时间（精确到秒，支持友好显示）
  function formatCheckpointTime(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()

    // 判断是否是今天
    const isToday = date.toDateString() === now.toDateString()

    // 时间部分 HH:mm:ss
    const timeStr = formatTime(timestamp, 'HH:mm:ss')

    if (isToday) {
      // 今天：只显示时间
      return timeStr
    }

    // 计算天数差
    const daysDiff = Math.floor(diff / (1000 * 60 * 60 * 24))

    if (daysDiff === 1) {
      // 昨天
      return `${t('components.message.checkpoint.yesterday')} ${timeStr}`
    }

    if (daysDiff < 7) {
      // 一周内
      return `${t('components.message.checkpoint.daysAgo', { days: daysDiff })} ${timeStr}`
    }

    // 超过一周：显示完整日期
    return formatTime(timestamp, 'YYYY-MM-DD HH:mm:ss')
  }

  return {
    checkpointsByMsgIndex,
    showDeleteConfirm,
    deleteCount,
    deleteCheckpoints,
    confirmDelete,
    cancelDelete,
    handleDelete,
    handleRestoreAndDelete,
    showRestoreConfirm,
    restoreConfirmTitle,
    restoreConfirmMessage,
    confirmRestore,
    cancelRestoreConfirm,
    restoreDeletablePaths,
    restoreHasUntrackedPaths,
    restoreShownDeletablePaths,
    restoreHiddenDeletableCount,
    restoreUnbackedPaths,
    isRestorePreviewing,
    previewingCheckpointId,
    restoreNotice,
    showRestoreNotice,
    restoreNoticeIconClass,
    restoreNoticeTitle,
    restoreCheckpoint,
    handleRestoreCheckpoint,
    handleRestoreAndRetry,
    handleRestoreAndEdit,
    shouldMergeForTool,
    getCheckpointLabel,
    getMergedLabel,
    formatCheckpointTime
  }
}
