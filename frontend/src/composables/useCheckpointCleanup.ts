/**
 * useCheckpointCleanup - 存档点设置：存档点清理 / 批量管理
 *
 * 从 CheckpointSettings.vue 拆分（S2 批次），纯重构不改行为：
 * - 带存档点的对话列表加载/搜索/多选/展开
 * - 存档点列表加载（含磁盘占用）、多选
 * - 批量/单条删除确认与执行（M-6 失败保留、CP-05/CP-11 反馈）
 * - 展示格式化辅助（时间/大小/数量/阶段/类型/工具名）
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useChatStore } from '@/stores'
import { t } from '@/i18n'
import type { CheckpointRecord, CheckpointSummaryWithSize } from '@/types'
import { getToolDisplayName } from './useCheckpointConfig'

// 对话检查点信息
export interface ConversationWithCheckpoints {
  conversationId: string
  title: string
  checkpointCount: number
  totalSize: number
  /** M8: 存在缺少 backupBytes 的旧存档时 totalSize 不完整（展示「部分未统计」提示） */
  sizeIncomplete?: boolean
  createdAt?: number
  updatedAt?: number
}

// 删除确认（统一处理对话批量 / 存档点批量）
export interface DeleteConfirmState {
  kind: 'conversations' | 'checkpoints'
  title: string
  count: number
  size: number
  /** L-3: 单条删除取消时清空选中态 */
  single?: boolean
  /** 快照：checkpoints 删除目标——确认弹窗期间展开/选中状态变化不影响删除目标 */
  conversationId?: string
  checkpointIds?: string[]
  /** 快照：conversations 删除目标——确认弹窗期间选中状态变化不影响删除目标 */
  conversationIds?: string[]
}

export function useCheckpointCleanup() {
  const chatStore = useChatStore()

  // 存档点清理相关状态
  const conversationsWithCheckpoints = ref<ConversationWithCheckpoints[]>([])
  const searchQuery = ref('')
  const isCleanupLoading = ref(false)

  // 批量管理：对话多选
  const selectedConversationIds = ref<Set<string>>(new Set())

  // 批量管理：展开对话的存档点列表（getCheckpoints withSize 响应：契约 CheckpointSummaryWithSize）
  const expandedConversationId = ref<string | null>(null)
  const expandedCheckpoints = ref<Array<CheckpointSummaryWithSize>>([])
  const selectedCheckpointIds = ref<Set<string>>(new Set())
  const isExpandedLoading = ref(false)
  const isBatchDeleting = ref(false)

  // 删除确认（统一处理对话批量 / 存档点批量）
  const deleteConfirmState = ref<DeleteConfirmState | null>(null)

  // 删除结果反馈：批量删除中被拒绝（依赖保留）的存档数量等（CP-05/CP-11）
  const deleteFeedback = ref<{ rejectedCount: number; failedCount: number; message: string } | null>(null)

  // 筛选后的对话列表
  const filteredConversations = computed(() => {
    if (!searchQuery.value.trim()) {
      return conversationsWithCheckpoints.value
    }
    const query = searchQuery.value.toLowerCase()
    return conversationsWithCheckpoints.value.filter(c =>
      c.title.toLowerCase().includes(query) ||
      c.conversationId.toLowerCase().includes(query)
    )
  })

  // 已选对话列表
  const selectedConversations = computed(() =>
    conversationsWithCheckpoints.value.filter(c => selectedConversationIds.value.has(c.conversationId))
  )

  // 已选对话的存档点总数与磁盘占用
  const selectedConversationsCheckpointCount = computed(() =>
    selectedConversations.value.reduce((sum, c) => sum + c.checkpointCount, 0)
  )
  const selectedConversationsSize = computed(() =>
    selectedConversations.value.reduce((sum, c) => sum + (c.totalSize || 0), 0)
  )

  // 全部对话存档点的总磁盘占用（含 sizeIncomplete 标记的未统计部分）
  const totalCheckpointsSize = computed(() =>
    conversationsWithCheckpoints.value.reduce((sum, c) => sum + (c.totalSize || 0), 0)
  )
  const totalCheckpointsSizeIncomplete = computed(() =>
    conversationsWithCheckpoints.value.some(c => c.sizeIncomplete)
  )

  // 对话全选状态
  const isAllConversationsSelected = computed(() =>
    filteredConversations.value.length > 0 &&
    filteredConversations.value.every(c => selectedConversationIds.value.has(c.conversationId))
  )

  // 存档点全选状态
  const isAllCheckpointsSelected = computed(() =>
    expandedCheckpoints.value.length > 0 &&
    expandedCheckpoints.value.every(cp => selectedCheckpointIds.value.has(cp.id))
  )

  // 已选存档点磁盘占用
  const selectedCheckpointsSize = computed(() =>
    expandedCheckpoints.value
      .filter(cp => selectedCheckpointIds.value.has(cp.id))
      .reduce((sum, cp) => sum + (cp.size || 0), 0)
  )

  // 加载带有存档点的对话列表
  // 防重入：请求序号——仅最新请求可写列表/复位加载态，过期响应不覆盖新结果
  let conversationListRequestSeq = 0

  async function loadConversationsWithCheckpoints() {
    const requestSeq = ++conversationListRequestSeq
    isCleanupLoading.value = true
    try {
      const response = await sendToExtension<{ conversations: ConversationWithCheckpoints[] }>(
        MESSAGE_NAMES['checkpoint.getAllConversationsWithCheckpoints'],
        {}
      )
      // 过期响应（序号落后）不覆盖列表，避免旧请求覆盖新请求结果
      if (response?.conversations && requestSeq === conversationListRequestSeq) {
        conversationsWithCheckpoints.value = response.conversations
      }
    } catch (error) {
      console.error('Failed to load conversations with checkpoints:', error)
    } finally {
      // 仅最新请求复位加载态（旧请求的 finally 不干扰新请求的 loading 状态）
      if (requestSeq === conversationListRequestSeq) {
        isCleanupLoading.value = false
      }
    }
  }

  // 切换对话选中状态
  function toggleConversationSelected(conversationId: string, selected: boolean) {
    const next = new Set(selectedConversationIds.value)
    if (selected) {
      next.add(conversationId)
    } else {
      next.delete(conversationId)
    }
    selectedConversationIds.value = next
  }

  // 全选/取消全选对话
  function toggleAllConversationsSelected(selected: boolean) {
    const next = new Set<string>()
    if (selected) {
      filteredConversations.value.forEach(c => next.add(c.conversationId))
    }
    selectedConversationIds.value = next
  }

  // 展开/收起对话的存档点列表
  async function toggleExpandConversation(conv: ConversationWithCheckpoints) {
    if (expandedConversationId.value === conv.conversationId) {
      expandedConversationId.value = null
      expandedCheckpoints.value = []
      selectedCheckpointIds.value = new Set()
      return
    }
    expandedConversationId.value = conv.conversationId
    selectedCheckpointIds.value = new Set()
    await loadExpandedCheckpoints(conv.conversationId)
  }

  // 加载展开对话的存档点列表（含磁盘占用）
  // 请求序号：过期响应（收起/切换后返回）不复位 isExpandedLoading，仅最新请求管理加载态
  let expandedLoadRequestSeq = 0

  async function loadExpandedCheckpoints(conversationId: string) {
    const requestSeq = ++expandedLoadRequestSeq
    isExpandedLoading.value = true
    try {
      const response = await sendToExtension<{
        success?: boolean
        checkpoints?: CheckpointSummaryWithSize[]
        error?: string
      }>(
        MESSAGE_NAMES['checkpoint.getCheckpoints'],
        { conversationId, withSize: true }
      )
      // M-5: 过期响应竞态防护——响应返回时仍展开同一对话才赋值，
      // 避免“展开 A → 收起 → 展开 B”时 A 的响应覆盖 B 的列表
      if (expandedConversationId.value !== conversationId) return
      if (response?.success === false || response?.error) {
        throw new Error(response.error || 'Failed to load checkpoints')
      }
      expandedCheckpoints.value = (response?.checkpoints || [])
        .slice()
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    } catch (error) {
      if (expandedConversationId.value !== conversationId) return
      console.error('Failed to load checkpoints, keeping previous list:', error)
    } finally {
      // M-5: 过期响应时 isExpandedLoading 不复位（旧实现导致收起后 loading 卡死）——
      // 仅最新请求复位加载态，新请求进行中时旧请求的 finally 不误关 loading
      if (requestSeq === expandedLoadRequestSeq) {
        isExpandedLoading.value = false
      }
    }
  }

  // 切换存档点选中状态
  function toggleCheckpointSelected(id: string, selected: boolean) {
    const next = new Set(selectedCheckpointIds.value)
    if (selected) {
      next.add(id)
    } else {
      next.delete(id)
    }
    selectedCheckpointIds.value = next
  }

  // 全选/取消全选存档点
  function toggleAllCheckpointsSelected(selected: boolean) {
    const next = new Set<string>()
    if (selected) {
      expandedCheckpoints.value.forEach(cp => next.add(cp.id))
    }
    selectedCheckpointIds.value = next
  }

  // 请求删除选中的对话（全部存档点）
  function requestDeleteConversations() {
    if (selectedConversations.value.length === 0 || isBatchDeleting.value) return
    deleteConfirmState.value = {
      kind: 'conversations',
      title: t('components.settings.checkpoint.sections.cleanup.confirmDelete.conversationsMessage', {
        count: selectedConversations.value.length
      }),
      count: selectedConversationsCheckpointCount.value,
      size: selectedConversationsSize.value,
      // 快照删除目标：确认弹窗期间选中状态变化不影响删除目标
      conversationIds: [...selectedConversationIds.value]
    }
  }

  // 请求删除选中的存档点
  function requestDeleteCheckpoints() {
    if (selectedCheckpointIds.value.size === 0 || isBatchDeleting.value) return
    deleteConfirmState.value = {
      kind: 'checkpoints',
      title: t('components.settings.checkpoint.sections.cleanup.confirmDelete.checkpointsMessage', {
        count: selectedCheckpointIds.value.size
      }),
      count: selectedCheckpointIds.value.size,
      size: selectedCheckpointsSize.value,
      // 快照删除目标：确认弹窗期间展开/选中状态变化不影响删除目标
      conversationId: expandedConversationId.value || undefined,
      checkpointIds: [...selectedCheckpointIds.value]
    }
  }

  // 请求删除单个存档点
  function requestDeleteSingleCheckpoint(cp: CheckpointSummaryWithSize) {
    if (isBatchDeleting.value) return
    selectedCheckpointIds.value = new Set([cp.id])
    deleteConfirmState.value = {
      kind: 'checkpoints',
      title: t('components.settings.checkpoint.sections.cleanup.confirmDelete.checkpointsMessage', { count: 1 }),
      count: 1,
      size: cp.size || 0,
      single: true,
      // 快照删除目标：确认弹窗期间展开状态变化不影响删除目标
      conversationId: expandedConversationId.value || undefined,
      checkpointIds: [cp.id]
    }
  }

  // 显示单个对话的删除确认
  function showDeleteConfirmDialog(conversation: ConversationWithCheckpoints) {
    if (isBatchDeleting.value) return
    selectedConversationIds.value = new Set([conversation.conversationId])
    deleteConfirmState.value = {
      kind: 'conversations',
      title: conversation.title || conversation.conversationId,
      count: conversation.checkpointCount,
      size: conversation.totalSize || 0,
      // L-3: 单条对话删除取消时同样清空残留选中态（见 cancelDelete）
      single: true,
      // 快照删除目标：确认弹窗期间选中状态变化不影响删除目标
      conversationIds: [conversation.conversationId]
    }
  }

  // 取消删除
  function cancelDelete() {
    // L-3: 单条删除取消后清空残留的选中态（存档点单选 / 对话单条删除均适用；
    // 批量删除取消保留多选，便于用户调整选择后重试）
    if (deleteConfirmState.value?.single) {
      selectedCheckpointIds.value = new Set()
      selectedConversationIds.value = new Set()
    }
    deleteConfirmState.value = null
  }

  // 确认删除（对话批量 / 存档点批量共用）
  async function confirmDelete() {
    // M-6: 防重入（同一 tick 内二次点击不双发）
    if (isBatchDeleting.value) return
    const state = deleteConfirmState.value
    if (!state) return

    deleteConfirmState.value = null
    isBatchDeleting.value = true
    const affectedConversationIds = new Set<string>()

    try {
      let totalRejected = 0
      let totalFailed = 0

      if (state.kind === 'conversations') {
        // 删除选中的对话（checkpointIds 为空 = 删除该对话全部）——
        // 使用确认时快照（state.conversationIds），与 checkpoints 分支一致，
        // 避免弹窗期间选中状态变化导致删错目标
        const conversationIds = state.conversationIds
        if (!conversationIds || conversationIds.length === 0) {
          // 快照校验失败（正常流程不会出现）：按失败处理，不发送删除请求
          totalFailed = 1
        } else {
          const items = conversationIds.map(conversationId => ({ conversationId, checkpointIds: [] as string[] }))
          const resp = await sendToExtension<any>(MESSAGE_NAMES['checkpoint.deleteBatch'], { items })
          const results = Array.isArray(resp?.results) ? resp.results : []
          totalRejected = results.reduce((sum: number, r: any) => sum + (r.rejectedIds?.length || 0), 0)
          totalFailed = results.filter((r: any) => !r.success).length

          // M-6: 只移除后端确认成功的对话；失败/被拒的对话保留在列表中（随后刷新权威计数）
          const succeededIds = new Set(
            results.filter((r: any) => r.success).map((r: any) => r.conversationId)
          )
          if (results.length === 0) {
            // 后端未返回 results（异常响应）：保守处理，不删除任何对话
            totalFailed = conversationIds.length
          }

          conversationIds.forEach(id => affectedConversationIds.add(id))
          const removedIds = new Set(
            conversationIds.filter(id => succeededIds.has(id))
          )
          if (removedIds.size > 0) {
            conversationsWithCheckpoints.value = conversationsWithCheckpoints.value.filter(
              c => !removedIds.has(c.conversationId)
            )
          }
          selectedConversationIds.value = new Set()

          // 刷新列表，更新保留（失败/被拒）对话的权威存档计数
          await loadConversationsWithCheckpoints()

          // 若展开的对话被删除，收起展开面板
          if (expandedConversationId.value && removedIds.has(expandedConversationId.value)) {
            expandedConversationId.value = null
            expandedCheckpoints.value = []
            selectedCheckpointIds.value = new Set()
          }
        }
      } else {
        // 删除展开对话中的选中存档点——使用确认时快照（state.conversationId/checkpointIds），
        // 避免弹窗期间用户收起/切换展开对话导致删错目标
        const conversationId = state.conversationId
        const checkpointIds = state.checkpointIds
        if (!conversationId || !checkpointIds || checkpointIds.length === 0) {
          // 快照校验失败（正常流程不会出现）：按失败处理，不发送删除请求
          totalFailed = 1
        } else {
          const items = [{ conversationId, checkpointIds }]
          const resp = await sendToExtension<any>(MESSAGE_NAMES['checkpoint.deleteBatch'], { items })
          const results = Array.isArray(resp?.results) ? resp.results : []
          totalRejected = results.reduce((sum: number, r: any) => sum + (r.rejectedIds?.length || 0), 0)
          totalFailed = results.filter((r: any) => !r.success).length

          // 后端未返回 results（异常响应）：保守处理，按全部失败反馈（与 conversations 分支一致）
          if (results.length === 0) {
            totalFailed = checkpointIds.length
          }

          selectedCheckpointIds.value = new Set()
          affectedConversationIds.add(conversationId)
          // 重载展开列表与对话列表：失败/被拒的存档仍保留可见（M-6）；
          // 仅当快照对话仍处于展开状态时才重载展开列表（已切换则跳过，避免无效请求）
          if (expandedConversationId.value === conversationId) {
            await loadExpandedCheckpoints(conversationId)
          }
          await loadConversationsWithCheckpoints()
        }
      }

      // CP-05/CP-11: 被后续存档依赖而拒绝删除的存档、删除失败项，向用户明确展示
      if (totalRejected > 0 || totalFailed > 0) {
        const parts: string[] = []
        if (totalRejected > 0) {
          parts.push(t('components.settings.checkpoint.sections.cleanup.rejectedByDependency', { count: totalRejected }))
        }
        if (totalFailed > 0) {
          parts.push(t('components.settings.checkpoint.sections.cleanup.deleteFailedCount', { count: totalFailed }))
        }
        deleteFeedback.value = {
          rejectedCount: totalRejected,
          failedCount: totalFailed,
          message: parts.join('；')
        }
      } else {
        deleteFeedback.value = null
      }

      // 当前对话受影响时，通知聊天视图刷新存档点
      if (chatStore.currentConversationId && affectedConversationIds.has(chatStore.currentConversationId)) {
        await chatStore.loadCheckpoints()
      }
    } catch (error) {
      console.error('Failed to delete checkpoints:', error)
      deleteFeedback.value = {
        rejectedCount: 0,
        failedCount: 0,
        message: t('components.settings.checkpoint.sections.cleanup.deleteRequestFailed')
      }
    } finally {
      isBatchDeleting.value = false
    }
  }

  // 存档点展示辅助
  function getPhaseLabel(phase: 'before' | 'after'): string {
    return phase === 'before'
      ? t('components.settings.checkpoint.sections.cleanup.phaseBefore')
      : t('components.settings.checkpoint.sections.cleanup.phaseAfter')
  }

  function getTypeLabel(type?: string): string {
    return type === 'full'
      ? t('components.settings.checkpoint.sections.cleanup.typeFull')
      : t('components.settings.checkpoint.sections.cleanup.typeIncremental')
  }

  function getToolLabel(toolName: string): string {
    switch (toolName) {
      case 'user_message':
        return t('components.settings.checkpoint.sections.cleanup.toolUserMessage')
      case 'model_message':
        return t('components.settings.checkpoint.sections.cleanup.toolModelMessage')
      case 'tool_batch':
        return t('components.settings.checkpoint.sections.cleanup.toolBatch')
      default:
        return getToolDisplayName(toolName)
    }
  }

  // 未备份文件的悬停提示：展示前 10 个路径（去掉工作区作用域前缀，展示相对路径）
  // 注：getCheckpoints 只下发摘要（无 unbackedPaths），该字段仅旧存档兼容，恒缺省（防御读取）
  function getUnbackedPathsTitle(cp: CheckpointRecord): string {
    const paths = (cp.unbackedPaths || []).map(toDisplayScopedPath)
    const shown = paths.slice(0, 10).join('\n')
    return paths.length > 10 ? `${shown}\n... 等 ${paths.length} 个文件` : shown
  }

  // scoped 键（ws_xxx/relative）转为对用户友好的相对路径
  function toDisplayScopedPath(scopedKey: string): string {
    return scopedKey.replace(/^ws_[a-f0-9]{16}\//, '')
  }

  // 格式化时间
  // 本地实现（i18n 输出 + falsy 空值保护），与 utils/format.ts 的 formatRelativeTime
  // （硬编码中文、必填 number）签名/行为不一致，保留本地副本不并入。
  function formatRelativeTime(timestamp?: number): string {
    if (!timestamp) return ''
    
    const now = Date.now()
    const diff = now - timestamp
    
    const minute = 60 * 1000
    const hour = 60 * minute
    const day = 24 * hour
    
    if (diff < minute) {
      return t('components.settings.checkpoint.sections.cleanup.timeFormat.justNow')
    } else if (diff < hour) {
      return t('components.settings.checkpoint.sections.cleanup.timeFormat.minutesAgo', { count: Math.floor(diff / minute) })
    } else if (diff < day) {
      return t('components.settings.checkpoint.sections.cleanup.timeFormat.hoursAgo', { count: Math.floor(diff / hour) })
    } else if (diff < 7 * day) {
      return t('components.settings.checkpoint.sections.cleanup.timeFormat.daysAgo', { count: Math.floor(diff / day) })
    } else {
      return new Date(timestamp).toLocaleDateString()
    }
  }

  // 格式化文件大小
  function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    const k = 1024
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
    const size = bytes / Math.pow(k, i)

    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
  }

  // 格式化检查点数量
  function formatCheckpointCount(count: number): string {
    return t('components.settings.checkpoint.sections.cleanup.checkpointCount', { count })
  }

  return {
    conversationsWithCheckpoints,
    searchQuery,
    isCleanupLoading,
    selectedConversationIds,
    expandedConversationId,
    expandedCheckpoints,
    selectedCheckpointIds,
    isExpandedLoading,
    isBatchDeleting,
    deleteConfirmState,
    deleteFeedback,
    filteredConversations,
    selectedConversations,
    selectedConversationsCheckpointCount,
    selectedConversationsSize,
    totalCheckpointsSize,
    totalCheckpointsSizeIncomplete,
    isAllConversationsSelected,
    isAllCheckpointsSelected,
    selectedCheckpointsSize,
    loadConversationsWithCheckpoints,
    toggleConversationSelected,
    toggleAllConversationsSelected,
    toggleExpandConversation,
    loadExpandedCheckpoints,
    toggleCheckpointSelected,
    toggleAllCheckpointsSelected,
    requestDeleteConversations,
    requestDeleteCheckpoints,
    requestDeleteSingleCheckpoint,
    showDeleteConfirmDialog,
    cancelDelete,
    confirmDelete,
    getPhaseLabel,
    getTypeLabel,
    getToolLabel,
    getUnbackedPathsTitle,
    toDisplayScopedPath,
    formatRelativeTime,
    formatSize,
    formatCheckpointCount
  }
}
