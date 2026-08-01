<script setup lang="ts">
/**
 * CheckpointSettings - 存档点设置面板
 *
 * 功能：
 * 1. 启用/禁用存档点功能
 * 2. 配置哪些工具需要在执行前后创建备份
 * 3. 设置最大存档点数量
 */

import { ref, reactive, onMounted, computed } from 'vue'
import { CustomCheckbox, CustomScrollbar } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useChatStore } from '@/stores'
import { t } from '@/i18n'
import type { CheckpointRecord } from '@/types'

// 消息类型存档点配置
interface MessageCheckpointConfig {
  beforeMessages: string[]
  afterMessages: string[]
  modelOuterLayerOnly?: boolean
  mergeUnchangedCheckpoints?: boolean
}

// 存档点配置接口
interface CheckpointConfig {
  enabled: boolean
  beforeTools: string[]
  afterTools: string[]
  messageCheckpoint?: MessageCheckpointConfig
  maxCheckpoints: number
  customIgnorePatterns?: string[]
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
  maxCheckpoints: -1  // -1 表示无上限
})

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
      customIgnorePatterns: config.customIgnorePatterns ? [...config.customIgnorePatterns] : []
    }
    
    await sendToExtension('checkpoint.updateConfig', {
      config: configToSave
    })
  } catch (error) {
    console.error('Failed to save checkpoint config:', error)
  }
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

// 获取工具显示名称
function getToolDisplayName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
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
    if (state.kind === 'conversations') {
      // 批量删除选中的对话（checkpointIds 为空 = 删除该对话全部）
      const targets = selectedConversations.value
      const items = targets.map(c => ({ conversationId: c.conversationId, checkpointIds: [] as string[] }))
      await sendToExtension('checkpoint.deleteBatch', { items })

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
        await sendToExtension('checkpoint.deleteBatch', { items })

        selectedCheckpointIds.value = new Set()
        affectedConversationIds.add(conversationId)
        await loadExpandedCheckpoints(conversationId)
        await loadConversationsWithCheckpoints()
      }
    }

    // 当前对话受影响时，通知聊天视图刷新存档点
    if (chatStore.currentConversationId && affectedConversationIds.has(chatStore.currentConversationId)) {
      await chatStore.loadCheckpoints()
    }
  } catch (error) {
    console.error('Failed to delete checkpoints:', error)
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
              <span class="tool-desc">{{ tool.description }}</span>
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>