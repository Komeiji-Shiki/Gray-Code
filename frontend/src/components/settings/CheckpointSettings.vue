<script setup lang="ts">
/**
 * CheckpointSettings - 存档点设置面板
 *
 * 功能：
 * 1. 启用/禁用存档点功能
 * 2. 配置哪些工具需要在执行前后创建备份
 * 3. 设置最大存档点数量
 *
 * 拆分说明（S2 批次，纯重构）：
 * - useCheckpointConfig：配置加载/保存（H-1/H-2）+ 消息/工具开关
 * - useCheckpointExclusion：排除配置（EX-08/09）+ 排除预览
 * - useCheckpointCleanup：存档点清理/批量管理（M-6）
 * - useCheckpointOperationProgress：操作进度轮询（M7/M4/L-10）
 * - useCheckpointManifest：存档排除清单详情（EX-11）
 */

import { onMounted, watch, onUnmounted } from 'vue'
import { CustomCheckbox, CustomScrollbar, PatternListEditor } from '../common'
import { t } from '@/i18n'
import { useChatStore } from '@/stores'
import {
  useCheckpointConfig,
  getToolDisplayName,
  getToolDescription
} from '@/composables/useCheckpointConfig'
import { useCheckpointExclusion } from '@/composables/useCheckpointExclusion'
import { useCheckpointOperationProgress } from '@/composables/useCheckpointOperationProgress'
import { useCheckpointCleanup } from '@/composables/useCheckpointCleanup'
import { useCheckpointManifest } from '@/composables/useCheckpointManifest'
import BranchCleanupSettings from './BranchCleanupSettings.vue'

// 使用 chatStore
const chatStore = useChatStore()

// ========== 配置（加载/保存 + 消息/工具开关） ==========
const {
  config,
  configSaveError,
  isLoading,
  loadError,
  loadConfig: loadConfigFromBackend,
  loadTools,
  updateConfigField,
  messageTypes,
  displayTools,
  isMessageInBefore,
  isMessageInAfter,
  toggleMessageBefore,
  toggleMessageAfter,
  toggleModelOuterLayerOnly,
  toggleMergeUnchangedCheckpoints,
  hasModelMessageCheckpoint,
  toggleAllMessageBefore,
  toggleAllMessageAfter,
  isAllMessageBeforeSelected,
  isAllMessageAfterSelected,
  isToolInBefore,
  isToolInAfter,
  toggleToolBefore,
  toggleToolAfter,
  toggleAllBefore,
  toggleAllAfter,
  isAllBeforeSelected,
  isAllAfterSelected
} = useCheckpointConfig()

// ========== 排除配置（EX-08 / EX-09） ==========
const {
  DEFAULT_PROFILE_IDS,
  loadExclusionProfiles,
  isProfileEnabled,
  toggleProfile,
  openProfileEditor,
  saveProfilePatterns,
  profileLabel,
  profilePatterns,
  maxFileSizeMiB,
  maxFileSizeError,
  saveMaxFileSize,
  onCustomPatternsChange,
  runPreview,
  previewRows,
  reasonLabel,
  togglePreviewProfile,
  isPreviewing,
  previewResult,
  previewError,
  expandedPreviewProfile,
  editingProfileId,
  profilePatternsDraft
} = useCheckpointExclusion(config, updateConfigField)

// ========== 操作进度轮询（M7/M4） ==========
const {
  operationProgress,
  operationStale,
  operationCancelError,
  startProgressPolling,
  stopProgressPolling,
  cancelActiveOperation,
  operationPhaseLabel
} = useCheckpointOperationProgress()

// ========== 存档点清理 / 批量管理 ==========
const {
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
  formatRelativeTime,
  formatSize,
  formatCheckpointCount
} = useCheckpointCleanup()

// ========== 存档排除清单详情（EX-11） ==========
const {
  manifestCheckpointId,
  manifestDetail,
  isManifestLoading,
  manifestLoadError,
  manifestExcludedCount,
  manifestEnabledProfileIds,
  manifestRulesChanged,
  openManifestDetail,
  closeManifestDetail
} = useCheckpointManifest(config, loadError)

// 加载配置（H-2: 失败时展示错误横幅并禁用表单，直到重试成功）
async function loadConfig() {
  await loadConfigFromBackend()
  await loadExclusionProfiles()
  await loadTools()
}

// 组件挂载
onMounted(async () => {
  // L-4: await loadConfig，确保 H-2 加载失败状态立即可见（失败时表单禁用）
  await loadConfig()
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

// M4: 设置页打开期间，聊天侧创建/恢复/删除存档（会触发 loadCheckpoints）时重启轮询
watch(() => chatStore.checkpoints, () => {
  startProgressPolling()
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

    <!-- H-2: 配置加载失败时展示错误横幅并禁用表单（不把默认值暴露为可编辑配置），直到重试成功 -->
    <div v-else-if="loadError" class="load-error-state">
      <div class="load-error-text">
        <i class="codicon codicon-error"></i>
        <span>{{ t('components.settings.checkpoint.loadError') }}</span>
        <span class="load-error-detail">{{ loadError }}</span>
      </div>
      <button class="load-retry-btn" @click="loadConfig">
        <i class="codicon codicon-refresh"></i>
        {{ t('components.settings.checkpoint.loadRetry') }}
      </button>
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

        <!-- 默认排除类别开关（每类别可编辑模式清单） -->
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
          <button
            class="profile-edit-btn"
            :disabled="!config.enabled"
            @click="openProfileEditor(profileId)"
          >
            <i class="codicon codicon-edit"></i>
            {{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.edit') }}
          </button>
        </div>

        <!-- 类别模式编辑面板 -->
        <div v-if="editingProfileId" class="profile-edit-panel">
          <div class="profile-edit-header">
            <span class="profile-edit-title">
              <i class="codicon codicon-pencil"></i>
              {{ profileLabel(editingProfileId) }}
            </span>
            <button
              class="profile-edit-clear"
              :disabled="!config.enabled"
              @click="profilePatternsDraft = []"
            >
              {{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.clear') }}
            </button>
          </div>
          <PatternListEditor
            v-model="profilePatternsDraft"
            :disabled="!config.enabled"
            :placeholder="t('components.settings.checkpoint.sections.exclusion.profilePatterns.placeholder')"
            :empty-text="t('components.settings.checkpoint.sections.exclusion.profilePatterns.empty')"
            :add-label="t('components.settings.checkpoint.sections.exclusion.patternsAdd')"
          />
          <div class="profile-edit-actions">
            <button
              class="profile-edit-save"
              @click="saveProfilePatterns(editingProfileId)"
            >
              {{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.save') }}
            </button>
            <button class="profile-edit-cancel" @click="editingProfileId = null">
              {{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.cancel') }}
            </button>
            <span class="hint">{{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.hint') }}</span>
          </div>
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
          <span v-if="maxFileSizeError" class="exclusion-error">
            <i class="codicon codicon-warning"></i>
            <span>{{ maxFileSizeError }}</span>
          </span>
        </div>

        <!-- 自定义排除模式 -->
        <div class="form-row patterns-row">
          <label>
            {{ t('components.settings.checkpoint.sections.exclusion.customPatterns.label') }}
            <span class="pattern-count">{{ (config.exclusion?.customPatterns || []).length }}</span>
          </label>
          <PatternListEditor
            :model-value="config.exclusion?.customPatterns || []"
            :disabled="!config.enabled"
            :placeholder="t('components.settings.checkpoint.sections.exclusion.customPatterns.placeholder')"
            :empty-text="t('components.settings.checkpoint.sections.exclusion.customPatterns.empty')"
            :add-label="t('components.settings.checkpoint.sections.exclusion.patternsAdd')"
            @update:model-value="onCustomPatternsChange"
          />
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
          <span v-if="operationStale" class="op-stale">
            {{ t('components.settings.checkpoint.sections.cleanup.progress.stale') }}
          </span>
          <button
            class="op-cancel-btn"
            :disabled="operationProgress.cancelled"
            @click="cancelActiveOperation"
          >
            <i class="codicon codicon-close"></i>
            {{ t('components.settings.checkpoint.sections.cleanup.progress.cancel') }}
          </button>
          <span v-if="operationCancelError" class="op-cancel-error">
            <i class="codicon codicon-warning"></i>
            {{ operationCancelError }}
          </span>
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
                          class="manifest-btn"
                          :title="t('components.settings.checkpoint.sections.cleanup.manifestDetail')"
                          @click="openManifestDetail(cp)"
                        >
                          <i class="codicon codicon-filter"></i>
                        </button>
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
      
      <!-- TREE-09：分支清理区块（与存档清理并列） -->
      <BranchCleanupSettings />
      
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
    <!-- EX-11: 存档排除清单详情 -->
    <div v-if="manifestCheckpointId" class="manifest-overlay" @click.self="closeManifestDetail">
      <div class="manifest-dialog">
        <div class="dialog-header">
          <i class="codicon codicon-filter"></i>
          <span>{{ t('components.settings.checkpoint.sections.cleanup.manifestDetail') }}</span>
        </div>
        <div class="dialog-body manifest-body">
          <div v-if="isManifestLoading" class="manifest-loading">
            <i class="codicon codicon-loading codicon-modifier-spin"></i>
            <span>{{ t('components.settings.checkpoint.sections.cleanup.loading') }}</span>
          </div>
          <p v-else-if="manifestLoadError" class="manifest-error">
            <i class="codicon codicon-warning"></i>
            {{ t('components.settings.checkpoint.sections.cleanup.manifestLoadFailed') }}
          </p>
          <div v-else-if="!manifestDetail" class="manifest-unavailable">
            <i class="codicon codicon-info"></i>
            <span>{{ t('components.settings.checkpoint.sections.cleanup.manifestUnavailable') }}</span>
          </div>
          <div v-else class="manifest-content">
            <div class="manifest-stat">
              <span class="manifest-stat-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestExcludedCount') }}</span>
              <span class="manifest-stat-value">{{ manifestExcludedCount }}</span>
            </div>
            <p class="manifest-note">
              {{ t('components.settings.checkpoint.sections.cleanup.manifestNote', { count: manifestExcludedCount }) }}
            </p>
            <p v-if="manifestRulesChanged()" class="manifest-rules-changed">
              <i class="codicon codicon-warning"></i>
              {{ t('components.settings.checkpoint.sections.cleanup.manifestRulesChanged') }}
            </p>
            <template v-if="manifestDetail.ignoreSnapshot">
              <div class="manifest-section-title">
                {{ t('components.settings.checkpoint.sections.cleanup.manifestIgnoreSnapshot') }}
              </div>
              <div class="manifest-rows">
                <div class="manifest-row">
                  <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestRuleVersion') }}</span>
                  <span>{{ manifestDetail.ignoreSnapshot.version }}</span>
                </div>
                <div class="manifest-row">
                  <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestForcedRulesVersion') }}</span>
                  <span>{{ manifestDetail.ignoreSnapshot.forcedRulesVersion }}</span>
                </div>
                <div class="manifest-row">
                  <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestDefaultProfileVersion') }}</span>
                  <span>{{ manifestDetail.ignoreSnapshot.defaultProfileVersion }}</span>
                </div>
                <div class="manifest-row">
                  <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestMaxFileSize') }}</span>
                  <span>{{ formatSize(manifestDetail.ignoreSnapshot.maxFileSizeBytes) }}</span>
                </div>
                <div class="manifest-row">
                  <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestEnabledProfiles') }}</span>
                  <span v-if="manifestEnabledProfileIds.length > 0" class="manifest-profiles">
                    {{ manifestEnabledProfileIds.map(profileLabel).join('、') }}
                  </span>
                  <span v-else>{{ t('components.settings.checkpoint.sections.cleanup.manifestNone') }}</span>
                </div>
                <div class="manifest-row">
                  <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestCustomPatterns') }}</span>
                  <span v-if="manifestDetail.ignoreSnapshot.customPatterns?.length > 0" class="manifest-patterns">
                    {{ manifestDetail.ignoreSnapshot.customPatterns.join('、') }}
                  </span>
                  <span v-else>{{ t('components.settings.checkpoint.sections.cleanup.manifestNone') }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn-cancel" @click="closeManifestDetail">
            {{ t('components.settings.checkpoint.sections.cleanup.manifestClose') }}
          </button>
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

.pattern-count {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  margin-left: 6px;
  border-radius: 8px;
  background: var(--vscode-badge-background, rgba(128, 128, 128, 0.25));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  font-size: 10px;
  font-weight: 500;
  vertical-align: middle;
}

/* 类别模式编辑面板 */
.profile-edit-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.profile-edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.profile-edit-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-edit-clear {
  flex-shrink: 0;
  padding: 2px 8px;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
}

.profile-edit-clear:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.profile-edit-clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.profile-edit-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.profile-edit-save,
.profile-edit-cancel {
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.profile-edit-save {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.profile-edit-save:hover {
  background: var(--vscode-button-hoverBackground);
}

.profile-edit-cancel {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.profile-edit-cancel:hover {
  background: var(--vscode-button-secondaryHoverBackground);
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

/* H-2: 配置加载失败横幅 */
.load-error-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  border-radius: 6px;
  background: var(--vscode-inputValidation-errorBackground, rgba(190, 17, 0, 0.12));
}

.load-error-text {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: var(--vscode-errorForeground, #f48771);
}

.load-error-text .codicon {
  flex-shrink: 0;
  margin-top: 2px;
}

.load-error-detail {
  font-size: 12px;
  opacity: 0.85;
  word-break: break-all;
}

.load-retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  font-size: 12px;
}

.load-retry-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

/* M4: 操作进度陈旧提示 */
.op-stale {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* L-10: 操作取消失败提示 */
.op-cancel-error {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--vscode-errorForeground, #f14c4c);
}

/* EX-11: 存档排除清单入口按钮 */
.manifest-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-left: 6px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 13px;
}

.manifest-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

/* EX-11: 排除清单详情对话框 */
.manifest-overlay {
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

.manifest-dialog {
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  width: 460px;
  max-width: 92%;
  max-height: 80vh;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.dialog-header .codicon-filter {
  color: var(--vscode-descriptionForeground);
  font-size: 16px;
}

.manifest-body {
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.5;
}

.manifest-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-descriptionForeground);
}

.manifest-loading .codicon {
  color: var(--vscode-progressBar-background);
}

.manifest-error,
.manifest-unavailable {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--vscode-descriptionForeground);
}

.manifest-error {
  color: var(--vscode-errorForeground, #f14c4c);
}

.manifest-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.08));
  border: 1px solid var(--vscode-panel-border);
}

.manifest-stat-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.manifest-stat-value {
  font-size: 18px;
  font-weight: 600;
}

.manifest-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.manifest-rules-changed {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 0 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.12));
  border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 200, 0, 0.5));
  color: var(--vscode-inputValidation-warningForeground, #cca700);
  font-size: 12px;
}

.manifest-section-title {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.manifest-rows {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
}

.manifest-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
}

.manifest-row:last-child {
  border-bottom: none;
}

.manifest-row-label {
  flex-shrink: 0;
  color: var(--vscode-descriptionForeground);
}

.manifest-profiles,
.manifest-patterns {
  text-align: right;
  word-break: break-all;
  max-width: 260px;
}
</style>