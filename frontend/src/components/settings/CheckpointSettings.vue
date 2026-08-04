<script setup lang="ts">
/**
 * CheckpointSettings - 存档点设置面板
 *
 * 功能：
 * 1. 启用/禁用存档点功能
 * 2. 配置哪些工具需要在执行前后创建备份
 * 3. 设置最大存档点数量
 */

import { ref, reactive, onMounted, computed, watch, onUnmounted } from 'vue'
import { CustomCheckbox, CustomScrollbar } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useChatStore } from '@/stores'
import {
  previewExclusions,
  pollOperationProgress,
  cancelCheckpointOperation,
  type CheckpointOperationProgress,
  type ExclusionPreviewResult
} from '@/stores/chat/checkpointActions'
import { t } from '@/i18n'
import type { CheckpointRecord } from '@/types'

// 消息类型存档点配置
interface MessageCheckpointConfig {
  beforeMessages: string[]
  afterMessages: string[]
  modelOuterLayerOnly?: boolean
  mergeUnchangedCheckpoints?: boolean
}

// 排除配置（EX-08）
interface CheckpointExclusionConfig {
  enabledProfiles: Record<string, boolean>
  maxFileSizeBytes: number
  customPatterns: string[]
}

// 存档点配置接口
interface CheckpointConfig {
  enabled: boolean
  beforeTools: string[]
  afterTools: string[]
  messageCheckpoint?: MessageCheckpointConfig
  maxCheckpoints: number
  customIgnorePatterns?: string[]
  exclusion?: CheckpointExclusionConfig
}

// 工具信息接口
interface ToolInfo {
  name: string
  description: string
  category?: string
}

// 对话检查点信息
interface ConversationWithCheckpoints {
  conversationId: string
  title: string
  checkpointCount: number
  totalSize: number
  /** M8: 存在缺少 backupBytes 的旧存档时 totalSize 不完整（展示「部分未统计」提示） */
  sizeIncomplete?: boolean
  createdAt?: number
  updatedAt?: number
}

// 使用 chatStore
const chatStore = useChatStore()

// 消息类型列表
const messageTypes = computed(() => [
  {
    name: 'user',
    displayName: t('components.settings.checkpoint.sections.messages.types.user.name'),
    description: t('components.settings.checkpoint.sections.messages.types.user.description')
  },
  {
    name: 'model',
    displayName: t('components.settings.checkpoint.sections.messages.types.model.name'),
    description: t('components.settings.checkpoint.sections.messages.types.model.description')
  }
])

// 配置
const config = reactive<CheckpointConfig>({
  enabled: true,
  beforeTools: [],
  afterTools: [],
  messageCheckpoint: {
    beforeMessages: [],
    afterMessages: [],
    modelOuterLayerOnly: true,
    mergeUnchangedCheckpoints: true
  },
  maxCheckpoints: -1,  // -1 表示无上限
  customIgnorePatterns: [],
  exclusion: {
    enabledProfiles: {},
    maxFileSizeBytes: 50 * 1024 * 1024,  // 默认 50 MiB
    customPatterns: []
  }
})

// 默认排除类别元数据（id 列表；名称走 i18n，模式清单由后端 checkpoint.getExclusionProfiles 提供）
const DEFAULT_PROFILE_IDS = ['logs', 'aiModels', 'datasets', 'caches', 'pythonVenvs', 'buildArtifacts', 'largeMedia', 'archives'] as const

// 后端默认排除类别元数据（模式清单等）
const exclusionProfileMeta = ref<Array<{ id: string; patterns: string[]; defaultEnabled: boolean }>>([])

// 预览排除结果状态（EX-09）
const isPreviewing = ref(false)
const previewResult = ref<ExclusionPreviewResult | null>(null)
const previewError = ref<string | null>(null)
const expandedPreviewProfile = ref<string | null>(null)

// 配置保存错误（如 EX-12 校验拒绝）
const configSaveError = ref<string | null>(null)

// 所有可用的工具列表
const allTools = ref<ToolInfo[]>([])

// 加载状态
const isLoading = ref(false)

// 存档点清理相关状态
const conversationsWithCheckpoints = ref<ConversationWithCheckpoints[]>([])
const searchQuery = ref('')
const isCleanupLoading = ref(false)

// 批量管理：对话多选
const selectedConversationIds = ref<Set<string>>(new Set())

// 批量管理：展开对话的存档点列表
const expandedConversationId = ref<string | null>(null)
const expandedCheckpoints = ref<Array<CheckpointRecord & { size?: number }>>([])
const selectedCheckpointIds = ref<Set<string>>(new Set())
const isExpandedLoading = ref(false)
const isBatchDeleting = ref(false)

// 删除确认（统一处理对话批量 / 存档点批量）
interface DeleteConfirmState {
  kind: 'conversations' | 'checkpoints'
  title: string
  count: number
  size: number
}
const deleteConfirmState = ref<DeleteConfirmState | null>(null)

// 删除结果反馈：批量删除中被拒绝（依赖保留）的存档数量等（CP-05/CP-11）
const deleteFeedback = ref<{ rejectedCount: number; failedCount: number; message: string } | null>(null)

// M7: 进行中存档操作进度（create/restore/delete）轮询展示 + 取消按钮
const operationProgress = ref<CheckpointOperationProgress | null>(null)
let progressPollTimer: ReturnType<typeof setInterval> | null = null
let progressPolling = false

// 轮询后端最近更新的进行中存档操作；无进行中操作或已结束时停止轮询
async function pollOperation() {
  if (progressPolling) return
  progressPolling = true
  try {
    const progress = await pollOperationProgress()
    operationProgress.value = progress
    if (!progress || progress.phase === 'done' || progress.phase === 'failed' || progress.phase === 'cancelled') {
      stopProgressPolling()
    }
  } finally {
    progressPolling = false
  }
}

function startProgressPolling() {
  if (progressPollTimer) return
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
async function cancelActiveOperation() {
  const op = operationProgress.value
  if (!op || op.cancelled) return
  await cancelCheckpointOperation(op.operationId)
  operationProgress.value = { ...op, cancelled: true, phase: 'cancelled' }
}

// 机器可读 phase → 展示文案（与后端 CheckpointOperationProgress.phase 对齐）
function operationPhaseLabel(phase: string): string {
  const key = `components.settings.checkpoint.sections.cleanup.progress.${phase}` as const
  const label = t(key)
  return label || phase
}

// 直接使用所有工具（用户可以自由选择哪些需要备份）
const displayTools = computed(() => allTools.value)

// 加载配置
async function loadConfig() {
  isLoading.value = true
  
  try {
    // 加载存档点配置
    const response = await sendToExtension<{ config: CheckpointConfig }>('checkpoint.getConfig', {})
    if (response?.config) {
      Object.assign(config, response.config)
      // 防御：旧后端/旧配置可能没有 exclusion 字段
      if (!config.exclusion) {
        config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
      }
    }
    
    // 加载默认排除类别元数据
    const profilesResponse = await sendToExtension<{ profiles: Array<{ id: string; patterns: string[]; defaultEnabled: boolean }> }>('checkpoint.getExclusionProfiles', {})
    if (profilesResponse?.profiles) {
      exclusionProfileMeta.value = profilesResponse.profiles
    }
    
    // 加载工具列表
    const toolsResponse = await sendToExtension<{ tools: ToolInfo[] }>('tools.getTools', {})
    if (toolsResponse?.tools) {
      allTools.value = toolsResponse.tools
    }
  } catch (error) {
    console.error('Failed to load checkpoint config:', error)
  } finally {
    isLoading.value = false
  }
}

// 更新配置字段并保存
async function updateConfigField(field: keyof CheckpointConfig, value: any) {
  // 更新本地配置
  (config as any)[field] = value
  
  try {
    // 转换为纯 JSON 对象，避免 DataCloneError
    // 需要深拷贝 messageCheckpoint 中的数组
    const messageCheckpointToSave = config.messageCheckpoint ? {
      beforeMessages: [...(config.messageCheckpoint.beforeMessages || [])],
      afterMessages: [...(config.messageCheckpoint.afterMessages || [])],
      modelOuterLayerOnly: config.messageCheckpoint.modelOuterLayerOnly,
      mergeUnchangedCheckpoints: config.messageCheckpoint.mergeUnchangedCheckpoints
    } : {
      beforeMessages: [],
      afterMessages: [],
      modelOuterLayerOnly: true,
      mergeUnchangedCheckpoints: true
    }
    
    const configToSave = {
      enabled: config.enabled,
      beforeTools: [...config.beforeTools],
      afterTools: [...config.afterTools],
      messageCheckpoint: messageCheckpointToSave,
      maxCheckpoints: config.maxCheckpoints,
      customIgnorePatterns: config.customIgnorePatterns ? [...config.customIgnorePatterns] : [],
      exclusion: config.exclusion ? {
        enabledProfiles: { ...(config.exclusion.enabledProfiles || {}) },
        maxFileSizeBytes: config.exclusion.maxFileSizeBytes,
        customPatterns: [...(config.exclusion.customPatterns || [])]
      } : undefined
    }
    
    await sendToExtension('checkpoint.updateConfig', {
      config: configToSave
    })
    configSaveError.value = null
  } catch (error: any) {
    configSaveError.value = error?.message || String(error || 'Unknown error')
    console.error('Failed to save checkpoint config:', error)
  }
}

// ========== 排除配置（EX-08 / EX-09） ==========

// 默认类别是否启用（缺省按默认启用处理）
function isProfileEnabled(profileId: string): boolean {
  return config.exclusion?.enabledProfiles?.[profileId] !== false
}

// 切换默认类别开关
async function toggleProfile(profileId: string, enabled: boolean) {
  if (!config.exclusion) {
    config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
  }
  config.exclusion.enabledProfiles = {
    ...(config.exclusion.enabledProfiles || {}),
    [profileId]: enabled
  }
  await updateConfigField('exclusion', { ...config.exclusion })
}

// 类别显示名（i18n）
function profileLabel(profileId: string): string {
  const key = `components.settings.checkpoint.sections.exclusion.profiles.${profileId}`
  const translated = t(key)
  return translated === key ? profileId : translated
}

// 类别模式清单（后端元数据）
function profilePatterns(profileId: string): string[] {
  return exclusionProfileMeta.value.find(p => p.id === profileId)?.patterns || []
}

// 单文件大小上限（MiB 显示）
const maxFileSizeMiB = computed(() =>
  Math.round((config.exclusion?.maxFileSizeBytes ?? 0) / (1024 * 1024))
)

// 保存大小上限（MiB -> 字节；0 = 不限制）
async function saveMaxFileSize(event: any) {
  const raw = parseInt(String(event.target?.value ?? ''), 10)
  const miB = Number.isNaN(raw) ? 0 : Math.max(0, raw)
  if (!config.exclusion) {
    config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 0, customPatterns: [] }
  }
  config.exclusion.maxFileSizeBytes = miB * 1024 * 1024
  await updateConfigField('exclusion', { ...config.exclusion })
}

// 自定义排除模式文本（每行一条）
// L-5: setter 同步写回 config.exclusion.customPatterns，避免未保存输入在重渲染时丢失；
// 模板使用 v-model.lazy，只在 change 时触发（不会打断输入过程中的换行）。
const customPatternsText = computed({
  get: () => (config.exclusion?.customPatterns || []).join('\n'),
  set: (value: string) => {
    if (!config.exclusion) {
      config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
    }
    config.exclusion.customPatterns = value
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
  }
})

// 保存自定义排除模式（按行拆分、去空白）
async function saveCustomPatterns(event: any) {
  const lines = String(event.target?.value ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (!config.exclusion) {
    config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
  }
  config.exclusion.customPatterns = lines
  await updateConfigField('exclusion', { ...config.exclusion })
}

// 执行排除预览（EX-09）
async function runPreview() {
  isPreviewing.value = true
  previewError.value = null
  try {
    const result = await previewExclusions()
    previewResult.value = result
    expandedPreviewProfile.value = null
    if (!result) {
      previewError.value = t('components.settings.checkpoint.sections.exclusion.preview.failed')
    }
  } catch (error: any) {
    previewError.value = error?.message || t('components.settings.checkpoint.sections.exclusion.preview.failed')
  } finally {
    isPreviewing.value = false
  }
}

// 预览：按类别聚合的行（默认类别 + other）
const previewRows = computed(() => {
  const result = previewResult.value
  if (!result) return []
  const rows: Array<{ key: string; label: string; summary: ExclusionPreviewResult['summary'] }> = []
  for (const profileId of DEFAULT_PROFILE_IDS) {
    const summary = result.byProfile[profileId]
    if (summary && summary.excludedCount > 0) {
      rows.push({ key: profileId, label: profileLabel(profileId), summary })
    }
  }
  const other = result.byProfile['other']
  if (other && other.excludedCount > 0) {
    rows.push({ key: 'other', label: t('components.settings.checkpoint.sections.exclusion.preview.other'), summary: other })
  }
  return rows
})

// 预览：原因文案
function reasonLabel(reason: string): string {
  const key = `components.settings.checkpoint.sections.exclusion.preview.reasons.${reason}`
  const translated = t(key)
  return translated === key ? reason : translated
}

// 预览：展开/收起某个类别
function togglePreviewProfile(key: string) {
  expandedPreviewProfile.value = expandedPreviewProfile.value === key ? null : key
}

// 检查消息类型是否在 before 列表中
function isMessageInBefore(messageType: string): boolean {
  return config.messageCheckpoint?.beforeMessages?.includes(messageType) ?? false
}

// 检查消息类型是否在 after 列表中
function isMessageInAfter(messageType: string): boolean {
  return config.messageCheckpoint?.afterMessages?.includes(messageType) ?? false
}

// 切换消息类型的 before 状态
async function toggleMessageBefore(messageType: string, enabled: boolean) {
  if (!config.messageCheckpoint) {
    config.messageCheckpoint = { beforeMessages: [], afterMessages: [] }
  }
  const newBeforeMessages = [...(config.messageCheckpoint.beforeMessages || [])]
  if (enabled) {
    if (!newBeforeMessages.includes(messageType)) {
      newBeforeMessages.push(messageType)
    }
  } else {
    const index = newBeforeMessages.indexOf(messageType)
    if (index !== -1) {
      newBeforeMessages.splice(index, 1)
    }
  }
  config.messageCheckpoint.beforeMessages = newBeforeMessages
  await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
}

// 切换消息类型的 after 状态
async function toggleMessageAfter(messageType: string, enabled: boolean) {
  if (!config.messageCheckpoint) {
    config.messageCheckpoint = { beforeMessages: [], afterMessages: [], modelOuterLayerOnly: true }
  }
  const newAfterMessages = [...(config.messageCheckpoint.afterMessages || [])]
  if (enabled) {
    if (!newAfterMessages.includes(messageType)) {
      newAfterMessages.push(messageType)
    }
  } else {
    const index = newAfterMessages.indexOf(messageType)
    if (index !== -1) {
      newAfterMessages.splice(index, 1)
    }
  }
  config.messageCheckpoint.afterMessages = newAfterMessages
  await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
}

// 切换模型消息只在最外层创建存档点
async function toggleModelOuterLayerOnly(enabled: boolean) {
  if (!config.messageCheckpoint) {
    config.messageCheckpoint = { beforeMessages: [], afterMessages: [], modelOuterLayerOnly: enabled }
  } else {
    config.messageCheckpoint.modelOuterLayerOnly = enabled
  }
  await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
}

// 切换是否合并无变更的存档点
async function toggleMergeUnchangedCheckpoints(enabled: boolean) {
  if (!config.messageCheckpoint) {
    config.messageCheckpoint = { beforeMessages: [], afterMessages: [], mergeUnchangedCheckpoints: enabled }
  } else {
    config.messageCheckpoint.mergeUnchangedCheckpoints = enabled
  }
  await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
  
  // 同步更新 chatStore，实现实时响应
  chatStore.setMergeUnchangedCheckpoints(enabled)
}

// 检查是否启用了模型消息存档点
const hasModelMessageCheckpoint = computed(() => {
  const mc = config.messageCheckpoint
  return mc?.beforeMessages?.includes('model') || mc?.afterMessages?.includes('model')
})

// 全选/取消消息 before
async function toggleAllMessageBefore(enabled: boolean) {
  if (!config.messageCheckpoint) {
    config.messageCheckpoint = { beforeMessages: [], afterMessages: [] }
  }
  config.messageCheckpoint.beforeMessages = enabled ? messageTypes.value.map(m => m.name) : []
  await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
}

// 全选/取消消息 after
async function toggleAllMessageAfter(enabled: boolean) {
  if (!config.messageCheckpoint) {
    config.messageCheckpoint = { beforeMessages: [], afterMessages: [] }
  }
  config.messageCheckpoint.afterMessages = enabled ? messageTypes.value.map(m => m.name) : []
  await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
}

// 检查消息类型是否全选
const isAllMessageBeforeSelected = computed(() => {
  return messageTypes.value.every(m => config.messageCheckpoint?.beforeMessages?.includes(m.name))
})

const isAllMessageAfterSelected = computed(() => {
  return messageTypes.value.every(m => config.messageCheckpoint?.afterMessages?.includes(m.name))
})

// 检查工具是否在 before 列表中
function isToolInBefore(toolName: string): boolean {
  return config.beforeTools.includes(toolName)
}

// 检查工具是否在 after 列表中
function isToolInAfter(toolName: string): boolean {
  return config.afterTools.includes(toolName)
}

// 切换工具的 before 状态并保存
async function toggleToolBefore(toolName: string, enabled: boolean) {
  const newBeforeTools = [...config.beforeTools]
  if (enabled) {
    if (!newBeforeTools.includes(toolName)) {
      newBeforeTools.push(toolName)
    }
  } else {
    const index = newBeforeTools.indexOf(toolName)
    if (index !== -1) {
      newBeforeTools.splice(index, 1)
    }
  }
  await updateConfigField('beforeTools', newBeforeTools)
}

// 切换工具的 after 状态并保存
async function toggleToolAfter(toolName: string, enabled: boolean) {
  const newAfterTools = [...config.afterTools]
  if (enabled) {
    if (!newAfterTools.includes(toolName)) {
      newAfterTools.push(toolName)
    }
  } else {
    const index = newAfterTools.indexOf(toolName)
    if (index !== -1) {
      newAfterTools.splice(index, 1)
    }
  }
  await updateConfigField('afterTools', newAfterTools)
}

// 获取工具显示名称（优先 i18n，fallback 机械转换）
function getToolDisplayName(name: string): string {
  const i18nKey = `components.settings.toolsSettings.toolDisplayNames.${name}`
  const translated = t(i18nKey)
  if (translated !== i18nKey) return translated
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// 获取工具描述（优先 i18n，fallback 原文）
function getToolDescription(name: string, fallback: string): string {
  const i18nKey = `components.settings.toolsSettings.toolDescriptions.${name}`
  const translated = t(i18nKey)
  if (translated !== i18nKey) return translated
  return fallback
}

// 全选/取消 before 并保存
async function toggleAllBefore(enabled: boolean) {
  const newBeforeTools = enabled ? displayTools.value.map(t => t.name) : []
  await updateConfigField('beforeTools', newBeforeTools)
}

// 全选/取消 after 并保存
async function toggleAllAfter(enabled: boolean) {
  const newAfterTools = enabled ? displayTools.value.map(t => t.name) : []
  await updateConfigField('afterTools', newAfterTools)
}

// 检查是否全选
const isAllBeforeSelected = computed(() => {
  return displayTools.value.length > 0 && displayTools.value.every(t => config.beforeTools.includes(t.name))
})

const isAllAfterSelected = computed(() => {
  return displayTools.value.length > 0 && displayTools.value.every(t => config.afterTools.includes(t.name))
})

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
async function loadConversationsWithCheckpoints() {
  isCleanupLoading.value = true
  try {
    const response = await sendToExtension<{ conversations: ConversationWithCheckpoints[] }>(
      'checkpoint.getAllConversationsWithCheckpoints',
      {}
    )
    if (response?.conversations) {
      conversationsWithCheckpoints.value = response.conversations
    }
  } catch (error) {
    console.error('Failed to load conversations with checkpoints:', error)
  } finally {
    isCleanupLoading.value = false
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
async function loadExpandedCheckpoints(conversationId: string) {
  isExpandedLoading.value = true
  try {
    const response = await sendToExtension<{ checkpoints: Array<CheckpointRecord & { size?: number }> }>(
      'checkpoint.getCheckpoints',
      { conversationId, withSize: true }
    )
    expandedCheckpoints.value = (response?.checkpoints || [])
      .slice()
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  } catch (error) {
    console.error('Failed to load checkpoints:', error)
    expandedCheckpoints.value = []
  } finally {
    isExpandedLoading.value = false
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
    size: selectedConversationsSize.value
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
    size: selectedCheckpointsSize.value
  }
}

// 请求删除单个存档点
function requestDeleteSingleCheckpoint(cp: CheckpointRecord & { size?: number }) {
  if (isBatchDeleting.value) return
  selectedCheckpointIds.value = new Set([cp.id])
  deleteConfirmState.value = {
    kind: 'checkpoints',
    title: t('components.settings.checkpoint.sections.cleanup.confirmDelete.checkpointsMessage', { count: 1 }),
    count: 1,
    size: cp.size || 0
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
    size: conversation.totalSize || 0
  }
}

// 取消删除
function cancelDelete() {
  deleteConfirmState.value = null
}

// 确认删除（对话批量 / 存档点批量共用）
async function confirmDelete() {
  const state = deleteConfirmState.value
  if (!state) return

  deleteConfirmState.value = null
  isBatchDeleting.value = true
  const affectedConversationIds = new Set<string>()

  try {
    let totalRejected = 0
    let totalFailed = 0

    if (state.kind === 'conversations') {
      // 批量删除选中的对话（checkpointIds 为空 = 删除该对话全部）
      const targets = selectedConversations.value
      const items = targets.map(c => ({ conversationId: c.conversationId, checkpointIds: [] as string[] }))
      const resp = await sendToExtension<any>('checkpoint.deleteBatch', { items })
      const results = resp?.results || []
      totalRejected = results.reduce((sum: number, r: any) => sum + (r.rejectedIds?.length || 0), 0)
      totalFailed = results.filter((r: any) => !r.success).length

      targets.forEach(c => affectedConversationIds.add(c.conversationId))
      const removedIds = new Set(targets.map(c => c.conversationId))
      conversationsWithCheckpoints.value = conversationsWithCheckpoints.value.filter(
        c => !removedIds.has(c.conversationId)
      )
      selectedConversationIds.value = new Set()

      // 若展开的对话被删除，收起展开面板
      if (expandedConversationId.value && removedIds.has(expandedConversationId.value)) {
        expandedConversationId.value = null
        expandedCheckpoints.value = []
        selectedCheckpointIds.value = new Set()
      }
    } else {
      // 删除展开对话中的选中存档点
      if (expandedConversationId.value) {
        const conversationId = expandedConversationId.value
        const items = [{ conversationId, checkpointIds: [...selectedCheckpointIds.value] }]
        const resp = await sendToExtension<any>('checkpoint.deleteBatch', { items })
        const results = resp?.results || []
        totalRejected = results.reduce((sum: number, r: any) => sum + (r.rejectedIds?.length || 0), 0)
        totalFailed = results.filter((r: any) => !r.success).length

        selectedCheckpointIds.value = new Set()
        affectedConversationIds.add(conversationId)
        await loadExpandedCheckpoints(conversationId)
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
function getUnbackedPathsTitle(cp: CheckpointRecord & { size?: number }): string {
  const paths = (cp.unbackedPaths || []).map(toDisplayScopedPath)
  const shown = paths.slice(0, 10).join('\n')
  return paths.length > 10 ? `${shown}\n... 等 ${paths.length} 个文件` : shown
}

// scoped 键（ws_xxx/relative）转为对用户友好的相对路径
function toDisplayScopedPath(scopedKey: string): string {
  return scopedKey.replace(/^ws_[a-f0-9]{16}\//, '')
}

// 格式化时间
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
  if (bytes === 0) return '0 B'
  
  const units = ['B', 'KB', 'MB', 'GB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const size = bytes / Math.pow(k, i)
  
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

// 格式化检查点数量
function formatCheckpointCount(count: number): string {
  return t('components.settings.checkpoint.sections.cleanup.checkpointCount', { count })
}

// 组件挂载
onMounted(() => {
  loadConfig()
  loadConversationsWithCheckpoints()
  // M7: 挂载即开始轮询进行中的存档操作（恢复/删除等），展示进度与取消按钮
  startProgressPolling()
})

// M7: 批量删除期间保持轮询（删除完成后停止）
watch(isBatchDeleting, deleting => {
  if (deleting) {
    startProgressPolling()
  }
})

onUnmounted(() => {
  stopProgressPolling()
})
</script>

<template>
  <div class="checkpoint-settings">
    <!-- 加载状态 -->
    <div v-if="isLoading" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.settings.checkpoint.loading') }}</span>
    </div>
    
    <template v-else>
      <!-- 全局开关 -->
      <div class="setting-group">
        <div class="setting-header">
          <CustomCheckbox
            :modelValue="config.enabled"
            :label="t('components.settings.checkpoint.sections.enable.label')"
            @update:modelValue="(v: boolean) => updateConfigField('enabled', v)"
          />
        </div>
        <p class="setting-description">
          {{ t('components.settings.checkpoint.sections.enable.description') }}
        </p>
      </div>
      
      <div class="divider"></div>
      
      <!-- 消息类型存档点 -->
      <div class="setting-group" :class="{ disabled: !config.enabled }">
        <h4 class="group-title">
          <i class="codicon codicon-comment"></i>
          {{ t('components.settings.checkpoint.sections.messages.title') }}
        </h4>
        <p class="setting-description">
          {{ t('components.settings.checkpoint.sections.messages.description') }}
        </p>
        
        <!-- 消息类型表格 -->
        <div class="tools-table">
          <div class="table-header">
            <div class="col-tool">{{ t('components.settings.checkpoint.sections.messages.title') }}</div>
            <div class="col-before">
              <CustomCheckbox
                :modelValue="isAllMessageBeforeSelected"
                :label="t('components.settings.checkpoint.sections.messages.beforeLabel')"
                :disabled="!config.enabled"
                @update:modelValue="toggleAllMessageBefore"
              />
            </div>
            <div class="col-after">
              <CustomCheckbox
                :modelValue="isAllMessageAfterSelected"
                :label="t('components.settings.checkpoint.sections.messages.afterLabel')"
                :disabled="!config.enabled"
                @update:modelValue="toggleAllMessageAfter"
              />
            </div>
          </div>
          
          <div
            v-for="msg in messageTypes"
            :key="msg.name"
            class="table-row"
          >
            <div class="col-tool">
              <span class="tool-name">{{ msg.displayName }}</span>
              <span class="tool-desc">{{ msg.description }}</span>
            </div>
            <div class="col-before">
              <CustomCheckbox
                :modelValue="isMessageInBefore(msg.name)"
                :disabled="!config.enabled"
                @update:modelValue="(val: boolean) => toggleMessageBefore(msg.name, val)"
              />
            </div>
            <div class="col-after">
              <CustomCheckbox
                :modelValue="isMessageInAfter(msg.name)"
                :disabled="!config.enabled"
                @update:modelValue="(val: boolean) => toggleMessageAfter(msg.name, val)"
              />
            </div>
          </div>
        </div>
        
        <!-- 模型消息高级选项 -->
        <div v-if="hasModelMessageCheckpoint" class="advanced-option">
          <CustomCheckbox
            :modelValue="config.messageCheckpoint?.modelOuterLayerOnly ?? true"
            :label="t('components.settings.checkpoint.sections.messages.options.modelOuterLayerOnly.label')"
            :disabled="!config.enabled"
            @update:modelValue="toggleModelOuterLayerOnly"
          />
          <p class="option-hint">
            {{ t('components.settings.checkpoint.sections.messages.options.modelOuterLayerOnly.hint') }}
          </p>
        </div>
        
        <!-- 合并无变更存档点选项 -->
        <div class="advanced-option">
          <CustomCheckbox
            :modelValue="config.messageCheckpoint?.mergeUnchangedCheckpoints ?? true"
            :label="t('components.settings.checkpoint.sections.messages.options.mergeUnchanged.label')"
            :disabled="!config.enabled"
            @update:modelValue="toggleMergeUnchangedCheckpoints"
          />
          <p class="option-hint">
            {{ t('components.settings.checkpoint.sections.messages.options.mergeUnchanged.hint') }}
          </p>
        </div>
      </div>
      
      <div class="divider"></div>
      
      <!-- 工具备份配置 -->
      <div class="setting-group" :class="{ disabled: !config.enabled }">
        <h4 class="group-title">
          <i class="codicon codicon-file-code"></i>
          {{ t('components.settings.checkpoint.sections.tools.title') }}
        </h4>
        <p class="setting-description">
          {{ t('components.settings.checkpoint.sections.tools.description') }}
        </p>
        
        <!-- 工具列表 -->
        <div class="tools-table">
          <div class="table-header">
            <div class="col-tool">{{ t('components.settings.checkpoint.sections.tools.title') }}</div>
            <div class="col-before">
              <CustomCheckbox
                :modelValue="isAllBeforeSelected"
                :label="t('components.settings.checkpoint.sections.tools.beforeLabel')"
                :disabled="!config.enabled"
                @update:modelValue="toggleAllBefore"
              />
            </div>
            <div class="col-after">
              <CustomCheckbox
                :modelValue="isAllAfterSelected"
                :label="t('components.settings.checkpoint.sections.tools.afterLabel')"
                :disabled="!config.enabled"
                @update:modelValue="toggleAllAfter"
              />
            </div>
          </div>
          
          <div
            v-for="tool in displayTools"
            :key="tool.name"
            class="table-row"
          >
            <div class="col-tool">
              <span class="tool-name">{{ getToolDisplayName(tool.name) }}</span>
              <span class="tool-desc">{{ getToolDescription(tool.name, tool.description) }}</span>
            </div>
            <div class="col-before">
              <CustomCheckbox
                :modelValue="isToolInBefore(tool.name)"
                :disabled="!config.enabled"
                @update:modelValue="(val: boolean) => toggleToolBefore(tool.name, val)"
              />
            </div>
            <div class="col-after">
              <CustomCheckbox
                :modelValue="isToolInAfter(tool.name)"
                :disabled="!config.enabled"
                @update:modelValue="(val: boolean) => toggleToolAfter(tool.name, val)"
              />
            </div>
          </div>
          
          <!-- 空状态 -->
          <div v-if="displayTools.length === 0" class="empty-state">
            <span>{{ t('components.settings.checkpoint.sections.tools.empty') }}</span>
          </div>
        </div>
      </div>
      
      <div class="divider"></div>
      
      <!-- 其他配置 -->
      <div class="setting-group" :class="{ disabled: !config.enabled }">
        <h4 class="group-title">
          <i class="codicon codicon-settings-gear"></i>
          {{ t('components.settings.checkpoint.sections.other.title') }}
        </h4>
        
        <div class="form-row">
          <label>{{ t('components.settings.checkpoint.sections.other.maxCheckpoints.label') }}</label>
          <input
            type="text"
            :value="config.maxCheckpoints"
            @input="(e: any) => { const v = parseInt(e.target.value); updateConfigField('maxCheckpoints', isNaN(v) ? -1 : v); }"
            :disabled="!config.enabled"
            class="number-input"
            placeholder="-1"
          />
          <span class="hint">{{ t('components.settings.checkpoint.sections.other.maxCheckpoints.hint') }}</span>
        </div>
      </div>
      
      
      <div class="divider"></div>
      
      <!-- 排除配置（EX-08 / EX-09） -->
      <div class="setting-group" :class="{ disabled: !config.enabled }">
        <h4 class="group-title">
          <i class="codicon codicon-filter"></i>
          {{ t('components.settings.checkpoint.sections.exclusion.title') }}
        </h4>
        <p class="setting-description">
          {{ t('components.settings.checkpoint.sections.exclusion.description') }}
        </p>

        <!-- 保存错误提示（EX-12 校验拒绝等） -->
        <div v-if="configSaveError" class="exclusion-error">
          <i class="codicon codicon-warning"></i>
          <span>{{ configSaveError }}</span>
        </div>

        <!-- 默认排除类别开关 -->
        <div
          v-for="profileId in DEFAULT_PROFILE_IDS"
          :key="profileId"
          class="profile-row"
        >
          <CustomCheckbox
            :modelValue="isProfileEnabled(profileId)"
            :label="profileLabel(profileId)"
            :disabled="!config.enabled"
            @update:modelValue="(v: boolean) => toggleProfile(profileId, v)"
          />
          <span class="profile-patterns" :title="profilePatterns(profileId).join('\n')">
            {{ profilePatterns(profileId).length }} {{ t('components.settings.checkpoint.sections.exclusion.patterns') }}
          </span>
        </div>

        <!-- 单文件大小上限 -->
        <div class="form-row">
          <label>{{ t('components.settings.checkpoint.sections.exclusion.maxFileSize.label') }}</label>
          <input
            type="text"
            :value="maxFileSizeMiB"
            @change="saveMaxFileSize"
            :disabled="!config.enabled"
            class="number-input"
            placeholder="50"
          />
          <span class="hint">{{ t('components.settings.checkpoint.sections.exclusion.maxFileSize.hint') }}</span>
        </div>

        <!-- 自定义排除模式 -->
        <div class="form-row patterns-row">
          <label>{{ t('components.settings.checkpoint.sections.exclusion.customPatterns.label') }}</label>
          <textarea
            v-model.lazy="customPatternsText"
            @change="saveCustomPatterns"
            :disabled="!config.enabled"
            class="patterns-input"
            rows="4"
            :placeholder="t('components.settings.checkpoint.sections.exclusion.customPatterns.placeholder')"
          ></textarea>
          <span class="hint">{{ t('components.settings.checkpoint.sections.exclusion.customPatterns.hint') }}</span>
          <!-- M-5: 目录型默认类别需同时否定目录本身才能重新纳入其下文件 -->
          <span class="hint">{{ t('components.settings.checkpoint.sections.exclusion.customPatterns.reincludeHint') }}</span>
        </div>

        <!-- 预览排除结果 -->
        <div class="preview-bar">
          <button
            class="preview-btn"
            :disabled="isPreviewing || !config.enabled"
            @click="runPreview"
          >
            <i
              class="codicon"
              :class="isPreviewing ? 'codicon-loading codicon-modifier-spin' : 'codicon-search'"
            ></i>
            {{ isPreviewing
              ? t('components.settings.checkpoint.sections.exclusion.preview.loading')
              : t('components.settings.checkpoint.sections.exclusion.preview.button') }}
          </button>
        </div>

        <div v-if="previewError" class="exclusion-error">
          <i class="codicon codicon-warning"></i>
          <span>{{ previewError }}</span>
        </div>

        <div v-if="previewResult" class="preview-result">
          <div class="preview-total">
            <i class="codicon codicon-database"></i>
            {{ t('components.settings.checkpoint.sections.exclusion.preview.total', {
              count: previewResult.summary.excludedCount,
              size: formatSize(previewResult.summary.excludedBytes)
            }) }}
            <span v-if="!previewResult.complete" class="preview-partial">
              {{ t('components.settings.checkpoint.sections.exclusion.preview.partial') }}
            </span>
          </div>

          <div v-if="previewRows.length === 0" class="preview-empty">
            {{ t('components.settings.checkpoint.sections.exclusion.preview.empty') }}
          </div>

          <div
            v-for="row in previewRows"
            :key="row.key"
            class="preview-row"
          >
            <button
              class="preview-row-header"
              @click="togglePreviewProfile(row.key)"
            >
              <i
                class="codicon"
                :class="expandedPreviewProfile === row.key ? 'codicon-chevron-down' : 'codicon-chevron-right'"
              ></i>
              <span class="preview-row-label">{{ row.label }}</span>
              <span class="preview-row-stats">
                {{ t('components.settings.checkpoint.sections.exclusion.preview.count', { count: row.summary.excludedCount }) }}
                · {{ formatSize(row.summary.excludedBytes) }}
              </span>
            </button>

            <div v-if="expandedPreviewProfile === row.key" class="preview-samples">
              <div
                v-for="sample in row.summary.samples"
                :key="sample.path"
                class="preview-sample"
              >
                <div class="sample-path">{{ sample.path }}</div>
                <div class="sample-meta">
                  <span class="sample-reason">{{ reasonLabel(sample.reason) }}</span>
                  <span v-if="sample.rule" class="sample-rule">
                    {{ t('components.settings.checkpoint.sections.exclusion.preview.rule') }}: {{ sample.rule }}
                  </span>
                  <span v-if="sample.source" class="sample-source">
                    {{ t('components.settings.checkpoint.sections.exclusion.preview.source') }}: {{ sample.source }}
                  </span>
                  <span v-if="sample.size" class="sample-size">{{ formatSize(sample.size) }}</span>
                </div>
              </div>
              <div v-if="row.summary.samples.length === 0" class="preview-no-samples">
                {{ t('components.settings.checkpoint.sections.exclusion.preview.noSamples') }}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <div class="divider"></div>
      
      <!-- 存档点清理 -->
      <div class="setting-group">
        <h4 class="group-title">
          <i class="codicon codicon-trash"></i>
          {{ t('components.settings.checkpoint.sections.cleanup.title') }}
        </h4>
        <p class="setting-description">
          {{ t('components.settings.checkpoint.sections.cleanup.description') }}
        </p>
        
        <!-- 搜索框 -->
        <div class="search-box">
          <i class="codicon codicon-search"></i>
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('components.settings.checkpoint.sections.cleanup.searchPlaceholder')"
            class="search-input"
          />
          <button
            v-if="searchQuery"
            class="clear-search"
            @click="searchQuery = ''"
          >
            <i class="codicon codicon-close"></i>
          </button>
        </div>
        
        <!-- 批量操作栏 -->
        <div v-if="conversationsWithCheckpoints.length > 0" class="batch-bar">
          <span class="batch-info">
            <template v-if="selectedConversations.length > 0">
              {{ t('components.settings.checkpoint.sections.cleanup.selectedCount', { count: selectedConversations.length }) }}
              ·
              {{ t('components.settings.checkpoint.sections.cleanup.selectedSize', { size: formatSize(selectedConversationsSize) }) }}
            </template>
            <template v-else>
              {{ formatCheckpointCount(conversationsWithCheckpoints.reduce((sum, c) => sum + c.checkpointCount, 0)) }}
              <template v-if="totalCheckpointsSize > 0">
                ·
                {{ t('components.settings.checkpoint.sections.cleanup.totalSize', { size: formatSize(totalCheckpointsSize) }) }}
                <span
                  v-if="totalCheckpointsSizeIncomplete"
                  class="size-incomplete"
                  :title="t('components.settings.checkpoint.sections.cleanup.sizeIncompleteHint')"
                >
                  （{{ t('components.settings.checkpoint.sections.cleanup.sizeIncomplete') }}）
                </span>
              </template>
            </template>
          </span>
          <button
            class="batch-delete-btn"
            :disabled="selectedConversations.length === 0 || isBatchDeleting"
            @click="requestDeleteConversations"
          >
            <i v-if="isBatchDeleting" class="codicon codicon-loading codicon-modifier-spin"></i>
            <i v-else class="codicon codicon-trash"></i>
            {{ t('components.settings.checkpoint.sections.cleanup.deleteSelected') }}
          </button>
        </div>
        
        <!-- M7: 进行中存档操作进度（create/restore/delete）+ 取消按钮 -->
        <div
          v-if="operationProgress && operationProgress.phase !== 'done' && operationProgress.phase !== 'failed' && operationProgress.phase !== 'cancelled'"
          class="operation-progress"
        >
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span class="op-label">{{ operationPhaseLabel(operationProgress.phase) }}</span>
          <span v-if="operationProgress.total > 0" class="op-count">
            {{ operationProgress.processed }} / {{ operationProgress.total }}
          </span>
          <button
            class="op-cancel-btn"
            :disabled="operationProgress.cancelled"
            @click="cancelActiveOperation"
          >
            <i class="codicon codicon-close"></i>
            {{ t('components.settings.checkpoint.sections.cleanup.progress.cancel') }}
          </button>
        </div>
        
        <!-- 删除结果反馈（被依赖拒绝/删除失败） -->
        <div v-if="deleteFeedback" class="delete-feedback">
          <i class="codicon codicon-warning"></i>
          <span>{{ deleteFeedback.message }}</span>
          <button class="feedback-close" @click="deleteFeedback = null">
            <i class="codicon codicon-close"></i>
          </button>
        </div>
        
        <!-- 对话列表 -->
        <div class="conversations-list-wrapper">
          <CustomScrollbar>
            <div class="conversations-list">
              <div v-if="isCleanupLoading" class="list-loading">
                <i class="codicon codicon-loading codicon-modifier-spin"></i>
                <span>{{ t('components.settings.checkpoint.sections.cleanup.loading') }}</span>
              </div>
              
              <div v-else-if="filteredConversations.length === 0" class="list-empty">
                <i class="codicon codicon-inbox"></i>
                <span v-if="searchQuery">{{ t('components.settings.checkpoint.sections.cleanup.noMatch') }}</span>
                <span v-else>{{ t('components.settings.checkpoint.sections.cleanup.noCheckpoints') }}</span>
              </div>
              
              <template v-else>
                <!-- 表头：全选 -->
                <div class="list-header">
                  <CustomCheckbox
                    :modelValue="isAllConversationsSelected"
                    @update:modelValue="toggleAllConversationsSelected"
                  />
                  <span class="header-label">{{ t('components.settings.checkpoint.sections.cleanup.selectAll') }}</span>
                </div>
                
                <div
                  v-for="conv in filteredConversations"
                  :key="conv.conversationId"
                  class="conversation-item"
                  :class="{ expanded: expandedConversationId === conv.conversationId }"
                >
                  <CustomCheckbox
                    :modelValue="selectedConversationIds.has(conv.conversationId)"
                    @update:modelValue="(v: boolean) => toggleConversationSelected(conv.conversationId, v)"
                  />
                  <button
                    class="expand-btn"
                    @click="toggleExpandConversation(conv)"
                  >
                    <i class="codicon" :class="expandedConversationId === conv.conversationId ? 'codicon-chevron-down' : 'codicon-chevron-right'"></i>
                  </button>
                  <div class="conversation-info">
                    <div class="conversation-title">{{ conv.title }}</div>
                    <div class="conversation-meta">
                      <span class="checkpoint-count">
                        <i class="codicon codicon-archive"></i>
                        {{ formatCheckpointCount(conv.checkpointCount) }}
                      </span>
                      <span class="size-info">
                        <i class="codicon codicon-database"></i>
                        {{ formatSize(conv.totalSize) }}
                        <span
                          v-if="conv.sizeIncomplete"
                          class="size-incomplete"
                          :title="t('components.settings.checkpoint.sections.cleanup.sizeIncompleteHint')"
                        >
                          {{ t('components.settings.checkpoint.sections.cleanup.sizeIncomplete') }}
                        </span>
                      </span>
                      <span class="update-time">
                        {{ formatRelativeTime(conv.updatedAt) }}
                      </span>
                    </div>
                  </div>
                  <button
                    class="delete-btn"
                    :disabled="isBatchDeleting"
                    @click="showDeleteConfirmDialog(conv)"
                  >
                    <i class="codicon codicon-trash"></i>
                  </button>
                  
                  <!-- 展开的存档点列表 -->
                  <div v-if="expandedConversationId === conv.conversationId" class="checkpoint-sub-list">
                    <div v-if="isExpandedLoading" class="sub-loading">
                      <i class="codicon codicon-loading codicon-modifier-spin"></i>
                      <span>{{ t('components.settings.checkpoint.sections.cleanup.loading') }}</span>
                    </div>
                    
                    <div v-else-if="expandedCheckpoints.length === 0" class="sub-empty">
                      {{ t('components.settings.checkpoint.sections.cleanup.noCheckpointsInConversation') }}
                    </div>
                    
                    <template v-else>
                      <div class="sub-header">
                        <CustomCheckbox
                          :modelValue="isAllCheckpointsSelected"
                          @update:modelValue="toggleAllCheckpointsSelected"
                        />
                        <span class="sub-header-info">
                          <template v-if="selectedCheckpointIds.size > 0">
                            {{ t('components.settings.checkpoint.sections.cleanup.selectedCount', { count: selectedCheckpointIds.size }) }}
                            ·
                            {{ t('components.settings.checkpoint.sections.cleanup.selectedSize', { size: formatSize(selectedCheckpointsSize) }) }}
                          </template>
                          <template v-else>
                            {{ formatCheckpointCount(expandedCheckpoints.length) }}
                          </template>
                        </span>
                        <button
                          class="sub-delete-btn"
                          :disabled="selectedCheckpointIds.size === 0 || isBatchDeleting"
                          @click="requestDeleteCheckpoints"
                        >
                          <i class="codicon codicon-trash"></i>
                          {{ t('components.settings.checkpoint.sections.cleanup.deleteSelected') }}
                        </button>
                      </div>
                      
                      <div
                        v-for="cp in expandedCheckpoints"
                        :key="cp.id"
                        class="checkpoint-item"
                      >
                        <CustomCheckbox
                          :modelValue="selectedCheckpointIds.has(cp.id)"
                          @update:modelValue="(v: boolean) => toggleCheckpointSelected(cp.id, v)"
                        />
                        <div class="checkpoint-info">
                          <div class="checkpoint-title">
                            <span class="cp-phase" :class="cp.phase">{{ getPhaseLabel(cp.phase) }}</span>
                            <span class="cp-tool">{{ getToolLabel(cp.toolName) }}</span>
                            <span v-if="cp.type" class="cp-type">{{ getTypeLabel(cp.type) }}</span>
                          </div>
                          <div class="checkpoint-meta">
                            <span>{{ formatRelativeTime(cp.timestamp) }}</span>
                            <span>{{ t('components.settings.checkpoint.sections.cleanup.checkpointFiles', { count: cp.fileCount }) }}</span>
                            <span class="cp-size">{{ formatSize(cp.size || 0) }}</span>
                            <span
                              v-if="cp.unbackedPaths?.length"
                              class="cp-unbacked"
                              :title="getUnbackedPathsTitle(cp)"
                            >
                              {{ t('components.settings.checkpoint.sections.cleanup.unbackedFiles', { count: cp.unbackedPaths.length }) }}
                            </span>
                          </div>
                        </div>
                        <button
                          class="delete-btn"
                          :disabled="isBatchDeleting"
                          @click="requestDeleteSingleCheckpoint(cp)"
                        >
                          <i class="codicon codicon-trash"></i>
                        </button>
                      </div>
                    </template>
                  </div>
                </div>
              </template>
            </div>
          </CustomScrollbar>
        </div>
        
        <!-- 刷新按钮 -->
        <button
          class="refresh-btn"
          :disabled="isCleanupLoading || isBatchDeleting"
          @click="loadConversationsWithCheckpoints"
        >
          <i class="codicon codicon-refresh" :class="{ 'codicon-modifier-spin': isCleanupLoading }"></i>
          {{ t('components.settings.checkpoint.sections.cleanup.refresh') }}
        </button>
      </div>
      
    </template>
    
    <!-- 删除确认对话框 -->
    <div v-if="deleteConfirmState" class="delete-confirm-overlay" @click.self="cancelDelete">
      <div class="delete-confirm-dialog">
        <div class="dialog-header">
          <i class="codicon codicon-warning"></i>
          <span>{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.title') }}</span>
        </div>
        <div class="dialog-body">
          <p>{{ deleteConfirmState.title }}</p>
          <p class="delete-stats">
            {{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.stats', {
              count: deleteConfirmState.count,
              size: formatSize(deleteConfirmState.size)
            }) }}
          </p>
          <p class="warning-text">{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.warning') }}</p>
        </div>
        <div class="dialog-footer">
          <button class="btn-cancel" @click="cancelDelete">{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.cancel') }}</button>
          <button class="btn-delete" :disabled="isBatchDeleting" @click="confirmDelete">{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.delete') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.checkpoint-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 加载状态 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--vscode-descriptionForeground);
}

.loading-state .codicon {
  font-size: 24px;
}

/* 设置组 */
.setting-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: opacity 0.2s;
}

.setting-group.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.setting-header {
  display: flex;
  align-items: center;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.group-title .codicon {
  font-size: 14px;
  color: var(--vscode-foreground);
}

.setting-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* 工具表格 */
.tools-table {
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  margin-top: 8px;
}

.table-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 12px;
  font-weight: 500;
}

.table-row {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.table-row:last-child {
  border-bottom: none;
}

.table-row:hover {
  background: var(--vscode-list-hoverBackground);
}

.col-tool {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.col-before,
.col-after {
  width: 80px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
}

.tool-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.tool-desc {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* 空状态 */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
}

/* 高级选项 */
.advanced-option {
  margin-top: 12px;
  padding: 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 6px;
}

.option-hint {
  margin: 8px 0 0 24px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

/* 表单行 */
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-row label {
  font-size: 12px;
  font-weight: 500;
}

.number-input {
  width: 100px;
  padding: 6px 10px;
  font-size: 13px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
}

.number-input:focus {
  border-color: var(--vscode-focusBorder);
}

.number-input:disabled {
  opacity: 0.6;
}

.hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}


/* 分割线 */
.divider {
  height: 1px;
  background: var(--vscode-panel-border);
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 搜索框 */
.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 6px;
  margin-top: 8px;
}

.search-box .codicon-search {
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--vscode-input-foreground);
  font-size: 13px;
  outline: none;
}

.search-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.clear-search {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 4px;
}

.clear-search:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

/* 对话列表容器 */
.conversations-list-wrapper {
  margin-top: 12px;
  height: 300px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editor-background);
  overflow: hidden;
}

/* 对话列表 */
.conversations-list {
  display: flex;
  flex-direction: column;
}

.list-loading,
.list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
}

.list-empty .codicon {
  font-size: 24px;
  opacity: 0.5;
}

.conversation-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.conversation-item:last-child {
  border-bottom: none;
}

.conversation-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.conversation-item.expanded {
  background: var(--vscode-list-hoverBackground);
}

.conversation-item.expanded:last-child {
  border-bottom: 1px solid var(--vscode-panel-border);
}

/* 列表表头（全选） */
.list-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 12px;
}

.header-label {
  color: var(--vscode-descriptionForeground);
}

/* 批量操作栏 */
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 6px;
}

.batch-info {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-delete-btn,
.sub-delete-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.batch-delete-btn:hover:not(:disabled),
.sub-delete-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.batch-delete-btn:disabled,
.sub-delete-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 展开按钮 */
.expand-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
}

.expand-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

/* 展开的存档点列表 */
.checkpoint-sub-list {
  flex-basis: 100%;
  margin: 4px 0 4px 26px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editor-background);
  overflow: hidden;
}

.sub-loading,
.sub-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.sub-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.sub-header-info {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.checkpoint-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.checkpoint-item:last-child {
  border-bottom: none;
}

.checkpoint-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.checkpoint-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.checkpoint-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.cp-phase {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}

.cp-phase.before {
  background: var(--vscode-editorWarning-background);
  color: var(--vscode-editorWarning-foreground);
}

.cp-phase.after {
  background: var(--vscode-editorInfo-background);
  color: var(--vscode-editorInfo-foreground);
}

.cp-tool {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-type {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.checkpoint-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.cp-size {
  font-weight: 500;
  color: var(--vscode-foreground);
}

.cp-unbacked {
  color: var(--vscode-editorWarning-foreground);
  cursor: help;
}

.conversation-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.conversation-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.conversation-meta .codicon {
  font-size: 12px;
  margin-right: 3px;
}

.checkpoint-count {
  display: flex;
  align-items: center;
}

.size-info {
  display: flex;
  align-items: center;
}

.update-time {
  margin-left: auto;
}

.delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
}

.delete-btn:hover:not(:disabled) {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
}

.delete-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.delete-feedback {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-inputValidation-errorBorder));
  background: var(--vscode-inputValidation-warningBackground, var(--vscode-inputValidation-errorBackground));
  color: var(--vscode-inputValidation-warningForeground, var(--vscode-inputValidation-errorForeground));
  font-size: 12px;
  border-radius: 4px;
}

.delete-feedback .feedback-close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  opacity: 0.7;
}

.delete-feedback .feedback-close:hover {
  opacity: 1;
}

/* M7: 进行中存档操作进度条 + 取消按钮 */
.operation-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder));
  background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  border-radius: 4px;
  font-size: 12px;
}

.operation-progress .codicon-loading {
  color: var(--vscode-progressBar-background);
}

.op-label {
  font-weight: 600;
}

.op-count {
  opacity: 0.8;
}

.op-cancel-btn {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 3px;
  padding: 3px 8px;
  font-size: 12px;
  cursor: pointer;
}

.op-cancel-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.op-cancel-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* M8: 对话大小不完整提示 */
.size-incomplete {
  opacity: 0.75;
  font-style: italic;
  margin-left: 2px;
}

.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  margin-top: 12px;
  border: 1px solid var(--vscode-button-secondaryBackground);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 删除确认对话框 */
.delete-confirm-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.delete-confirm-dialog {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  width: 400px;
  max-width: 90%;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-weight: 500;
  font-size: 14px;
}

.dialog-header .codicon-warning {
  color: var(--vscode-inputValidation-warningForeground);
  font-size: 18px;
}

.dialog-body {
  padding: 16px;
}

.dialog-body p {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.5;
}

.dialog-body p:last-child {
  margin-bottom: 0;
}

.delete-stats {
  color: var(--vscode-descriptionForeground);
}

.warning-text {
  color: var(--vscode-inputValidation-warningForeground);
  font-weight: 500;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-panel-border);
}

.btn-cancel,
.btn-delete {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  border: none;
}

.btn-cancel {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.btn-cancel:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.btn-delete {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}

.btn-delete:hover {
  opacity: 0.9;
}

.btn-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ========== 排除配置（EX-08 / EX-09） ========== */
.profile-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}

.profile-patterns {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}

.patterns-row {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}

.patterns-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  resize: vertical;
}

.patterns-input:focus {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.patterns-input:disabled {
  opacity: 0.6;
}

.exclusion-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
  border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.4));
  color: var(--vscode-errorForeground, #f14c4c);
  font-size: 12px;
  word-break: break-all;
}

.preview-bar {
  margin-top: 10px;
}

.preview-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  font-size: 12px;
}

.preview-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.preview-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.preview-result {
  margin-top: 10px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
  border-radius: 4px;
  overflow: hidden;
}

.preview-total {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  background: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.1));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
}

.preview-partial {
  font-weight: 400;
  color: var(--vscode-descriptionForeground);
}

.preview-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.preview-row {
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
}

.preview-row:last-child {
  border-bottom: none;
}

.preview-row-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}

.preview-row-header:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.1));
}

.preview-row-label {
  flex: 1;
}

.preview-row-stats {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  white-space: nowrap;
}

.preview-samples {
  padding: 2px 10px 8px 26px;
}

.preview-sample {
  padding: 4px 0;
  border-bottom: 1px dashed var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
  font-size: 12px;
}

.preview-sample:last-child {
  border-bottom: none;
}

.sample-path {
  word-break: break-all;
}

.sample-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.sample-reason {
  color: var(--vscode-charts-yellow, #cca700);
}

.preview-no-samples {
  padding: 6px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
</style>