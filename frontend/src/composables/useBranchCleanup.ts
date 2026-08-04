/**
 * useBranchCleanup - 分支清理设置（TREE-09 / MIG-06）
 *
 * 设置页「分支清理」区块（BranchCleanupSettings.vue）：
 * - 软删分支数量展示（conversation.getDeletedBranchCount，全量扫描）
 * - 一键清理过期软删（conversation.pruneDeletedBranches）
 * - 保留期配置输入（conversation.getBranchRetentionConfig /
 *   conversation.updateBranchRetentionConfig，默认 30 天，0 = 不自动清理）
 */

import { ref, computed } from 'vue'
import { sendToExtension } from '@/utils/vscode'

export interface BranchDeletedCountResult {
  conversationCount: number
  deletedNodeCount: number
}

export interface BranchPruneResult {
  conversationsScanned: number
  conversationsChanged: number
  prunedNodeCount: number
  corruptConversations: string[]
  skippedConversations: string[]
}

export function useBranchCleanup() {
  // ========== 软删分支数量 ==========
  const deletedCount = ref(0)
  const deletedConversationCount = ref(0)
  const isCountLoading = ref(false)
  const countError = ref<string | null>(null)

  // ========== 一键清理 ==========
  const isPruning = ref(false)
  const pruneFeedback = ref<string | null>(null)
  const pruneError = ref<string | null>(null)
  /** R8c-P4：本次清理被跳过的会话数（孤儿 sidecar：会话已不存在，未清理） */
  const pruneSkippedCount = ref(0)

  // ========== 保留期配置 ==========
  const retentionDays = ref(30)
  const retentionDraft = ref('30')
  const isRetentionLoading = ref(false)
  const isRetentionSaving = ref(false)
  const retentionError = ref<string | null>(null)

  const retentionDaysValid = computed(() => {
    const value = Number(retentionDraft.value)
    return Number.isInteger(value) && value >= 0
  })

  /** 加载软删分支数量（全量扫描所有对话） */
  async function loadDeletedCount(): Promise<void> {
    isCountLoading.value = true
    countError.value = null
    try {
      const result = await sendToExtension<BranchDeletedCountResult>('conversation.getDeletedBranchCount', {})
      if (result && typeof result.deletedNodeCount === 'number') {
        deletedCount.value = result.deletedNodeCount
      }
      if (result && typeof result.conversationCount === 'number') {
        deletedConversationCount.value = result.conversationCount
      }
    } catch (error: any) {
      countError.value = error?.message || String(error || 'Unknown error')
    } finally {
      isCountLoading.value = false
    }
  }

  /** 一键清理过期软删分支；成功后刷新数量 */
  async function pruneDeleted(): Promise<void> {
    if (isPruning.value) return
    isPruning.value = true
    pruneFeedback.value = null
    pruneError.value = null
    pruneSkippedCount.value = 0
    try {
      const result = await sendToExtension<BranchPruneResult>('conversation.pruneDeletedBranches', {})
      const pruned = result && typeof result.prunedNodeCount === 'number' ? result.prunedNodeCount : 0
      pruneFeedback.value = String(pruned)
      // R8c-P4：被跳过（会话已不存在）的 sidecar 数量透出给设置页提示
      pruneSkippedCount.value = result && Array.isArray(result.skippedConversations)
        ? result.skippedConversations.length
        : 0
      await loadDeletedCount()
    } catch (error: any) {
      pruneError.value = error?.message || String(error || 'Unknown error')
    } finally {
      isPruning.value = false
    }
  }

  /** 加载保留期配置 */
  async function loadRetention(): Promise<void> {
    isRetentionLoading.value = true
    retentionError.value = null
    try {
      const result = await sendToExtension<{ retentionDays: number }>('conversation.getBranchRetentionConfig', {})
      if (result && typeof result.retentionDays === 'number') {
        retentionDays.value = result.retentionDays
        retentionDraft.value = String(result.retentionDays)
      }
    } catch (error: any) {
      retentionError.value = error?.message || String(error || 'Unknown error')
    } finally {
      isRetentionLoading.value = false
    }
  }

  /** 保存保留期配置（0 = 不自动清理） */
  async function saveRetention(): Promise<boolean> {
    if (isRetentionSaving.value || !retentionDaysValid.value) return false
    isRetentionSaving.value = true
    retentionError.value = null
    try {
      const value = Number(retentionDraft.value)
      const result = await sendToExtension<{ success: boolean; retentionDays: number }>(
        'conversation.updateBranchRetentionConfig',
        { retentionDays: value }
      )
      if (result && typeof result.retentionDays === 'number') {
        retentionDays.value = result.retentionDays
        retentionDraft.value = String(result.retentionDays)
      }
      return true
    } catch (error: any) {
      retentionError.value = error?.message || String(error || 'Unknown error')
      return false
    } finally {
      isRetentionSaving.value = false
    }
  }

  return {
    deletedCount,
    deletedConversationCount,
    isCountLoading,
    countError,
    isPruning,
    pruneFeedback,
    pruneError,
    pruneSkippedCount,
    retentionDays,
    retentionDraft,
    isRetentionLoading,
    isRetentionSaving,
    retentionError,
    retentionDaysValid,
    loadDeletedCount,
    pruneDeleted,
    loadRetention,
    saveRetention
  }
}
