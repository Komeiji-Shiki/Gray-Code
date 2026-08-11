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
 *
 * 模板拆分说明（C3 批次，纯结构性拆分，行为零变化）：
 * - CheckpointMessageSettings：消息类型存档点开关区
 * - CheckpointToolSettings：工具备份配置区
 * - CheckpointExclusionSettings：排除配置区（EX-08/09）
 * - CheckpointCleanupPanel：存档点清理列表区（搜索/批量/进度/列表）
 * - CheckpointDeleteConfirmDialog：删除确认弹窗
 * - CheckpointManifestDialog：存档排除清单详情弹窗（EX-11）
 * 所有响应式状态仍由本组件的 composable 单一实例持有，子组件仅通过 props/emits 通信。
 */

import { onMounted, watch, onUnmounted, ref } from 'vue'
import { CustomCheckbox } from '../common'
import { t } from '@/i18n'
import { useChatStore } from '@/stores'
import { useDeferredNumberInput, getSettingsView } from '@/composables/useDeferredNumberInput'
import { useCheckpointConfig } from '@/composables/useCheckpointConfig'
import { useCheckpointExclusion } from '@/composables/useCheckpointExclusion'
import { useCheckpointOperationProgress } from '@/composables/useCheckpointOperationProgress'
import { useCheckpointCleanup } from '@/composables/useCheckpointCleanup'
import { useCheckpointManifest } from '@/composables/useCheckpointManifest'
import BranchCleanupSettings from './BranchCleanupSettings.vue'
import CheckpointMessageSettings from './checkpoint/CheckpointMessageSettings.vue'
import CheckpointToolSettings from './checkpoint/CheckpointToolSettings.vue'
import CheckpointExclusionSettings from './checkpoint/CheckpointExclusionSettings.vue'
import CheckpointCleanupPanel from './checkpoint/CheckpointCleanupPanel.vue'
import CheckpointDeleteConfirmDialog from './checkpoint/CheckpointDeleteConfirmDialog.vue'
import CheckpointManifestDialog from './checkpoint/CheckpointManifestDialog.vue'

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
  syncMaxCheckpointsFromStored()
  syncMaxFileSizeDraft()
  await loadExclusionProfiles()
  await loadTools()
}

// 草稿模式：清空后不立即回填 -1；离开设置页时自动回填已保存值
// 校验器收紧为「-1（无上限）或 ≥1」：Number.isInteger 放行 0/-5，
// 0 个存档上限语义非法（与模板 min="-1" 一致）
const {
  draft: maxCheckpointsDraft,
  handleInput: handleMaxCheckpointsInput,
  syncFromStored: syncMaxCheckpointsFromStored
} = useDeferredNumberInput(() => config.maxCheckpoints, v => v === -1 || v >= 1)

// 单文件大小上限：编辑期间允许清空（不报错不保存），离开设置页时回填已保存值
const maxFileSizeDraft = ref('')
function syncMaxFileSizeDraft() {
  maxFileSizeDraft.value = String(maxFileSizeMiB.value)
}
function handleMaxFileSizeInput(event: Event) {
  maxFileSizeDraft.value = (event.target as HTMLInputElement).value
  maxFileSizeError.value = null
}
function handleMaxFileSizeChange() {
  void saveMaxFileSize(maxFileSizeDraft.value).then(() => {
    // 保存成功后回读后端归一化值（maxFileSizeMiB 保留 1 位小数）：
    // 如输入 50.55 → 后端保存 50.5，若不同步草稿，输入框会一直显示 50.55 直到下次加载；
    // 空值（不保存）时同样回填已保存值，避免草稿与存储分叉。
    syncMaxFileSizeDraft()
  })
}
watch(
  getSettingsView,
  (view) => {
    if (view !== 'settings') {
      const text = maxFileSizeDraft.value.trim()
      const parsed = parseFloat(text)
      if (text === '' || !Number.isFinite(parsed) || parsed < 0) {
        maxFileSizeError.value = null
        syncMaxFileSizeDraft()
      }
    }
  }
)
syncMaxFileSizeDraft()

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
      <div class="setting-group" data-search-anchor="checkpoint-enable">
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
      
      <!-- 消息类型存档点（C3：拆至 CheckpointMessageSettings） -->
      <CheckpointMessageSettings
        :config-enabled="config.enabled"
        :message-checkpoint="config.messageCheckpoint"
        :message-types="messageTypes"
        :is-message-in-before="isMessageInBefore"
        :is-message-in-after="isMessageInAfter"
        :is-all-message-before-selected="isAllMessageBeforeSelected"
        :is-all-message-after-selected="isAllMessageAfterSelected"
        :has-model-message-checkpoint="hasModelMessageCheckpoint"
        :toggle-message-before="toggleMessageBefore"
        :toggle-message-after="toggleMessageAfter"
        :toggle-all-message-before="toggleAllMessageBefore"
        :toggle-all-message-after="toggleAllMessageAfter"
        :toggle-model-outer-layer-only="toggleModelOuterLayerOnly"
        :toggle-merge-unchanged-checkpoints="toggleMergeUnchangedCheckpoints"
      />
      
      <div class="divider"></div>
      
      <!-- 工具备份配置（C3：拆至 CheckpointToolSettings） -->
      <CheckpointToolSettings
        :config-enabled="config.enabled"
        :display-tools="displayTools"
        :is-tool-in-before="isToolInBefore"
        :is-tool-in-after="isToolInAfter"
        :is-all-before-selected="isAllBeforeSelected"
        :is-all-after-selected="isAllAfterSelected"
        :toggle-tool-before="toggleToolBefore"
        :toggle-tool-after="toggleToolAfter"
        :toggle-all-before="toggleAllBefore"
        :toggle-all-after="toggleAllAfter"
      />
      
      <div class="divider"></div>
      
      <!-- 其他配置 -->
      <div class="setting-group" :class="{ disabled: !config.enabled }" data-search-anchor="checkpoint-other">
        <h4 class="group-title">
          <i class="codicon codicon-settings-gear"></i>
          {{ t('components.settings.checkpoint.sections.other.title') }}
        </h4>
        
        <div class="form-row">
          <label>{{ t('components.settings.checkpoint.sections.other.maxCheckpoints.label') }}</label>
          <input
            type="text"
            :value="maxCheckpointsDraft"
            @input="(e: any) => handleMaxCheckpointsInput(e.target.value, v => updateConfigField('maxCheckpoints', v))"
            :disabled="!config.enabled"
            class="number-input"
            placeholder="-1"
          />
          <span class="hint">{{ t('components.settings.checkpoint.sections.other.maxCheckpoints.hint') }}</span>
        </div>
      </div>
      
      
      <div class="divider"></div>
      
      <!-- 排除配置（EX-08 / EX-09）（C3：拆至 CheckpointExclusionSettings） -->
      <CheckpointExclusionSettings
        :config-enabled="config.enabled"
        :config-save-error="configSaveError"
        :default-profile-ids="DEFAULT_PROFILE_IDS"
        :is-profile-enabled="isProfileEnabled"
        :toggle-profile="toggleProfile"
        :open-profile-editor="openProfileEditor"
        :save-profile-patterns="saveProfilePatterns"
        :profile-label="profileLabel"
        :profile-patterns="profilePatterns"
        v-model:editingProfileId="editingProfileId"
        v-model:profilePatternsDraft="profilePatternsDraft"
        :max-file-size-draft="maxFileSizeDraft"
        :handle-max-file-size-input="handleMaxFileSizeInput"
        :handle-max-file-size-change="handleMaxFileSizeChange"
        :max-file-size-error="maxFileSizeError"
        :custom-patterns="config.exclusion?.customPatterns || []"
        :on-custom-patterns-change="onCustomPatternsChange"
        :is-previewing="isPreviewing"
        :run-preview="runPreview"
        :preview-error="previewError"
        :preview-result="previewResult"
        :preview-rows="previewRows"
        :toggle-preview-profile="togglePreviewProfile"
        :expanded-preview-profile="expandedPreviewProfile"
        :reason-label="reasonLabel"
        :format-size="formatSize"
      />
      
      <div class="divider"></div>
      
      <!-- 存档点清理（C3：拆至 CheckpointCleanupPanel） -->
      <CheckpointCleanupPanel
        v-model:searchQuery="searchQuery"
        :conversations-with-checkpoints="conversationsWithCheckpoints"
        :selected-conversations="selectedConversations"
        :selected-conversations-size="selectedConversationsSize"
        :total-checkpoints-size="totalCheckpointsSize"
        :total-checkpoints-size-incomplete="totalCheckpointsSizeIncomplete"
        :is-all-conversations-selected="isAllConversationsSelected"
        :toggle-all-conversations-selected="toggleAllConversationsSelected"
        :selected-conversation-ids="selectedConversationIds"
        :toggle-conversation-selected="toggleConversationSelected"
        :expanded-conversation-id="expandedConversationId"
        :toggle-expand-conversation="toggleExpandConversation"
        :is-expanded-loading="isExpandedLoading"
        :expanded-checkpoints="expandedCheckpoints"
        :is-all-checkpoints-selected="isAllCheckpointsSelected"
        :toggle-all-checkpoints-selected="toggleAllCheckpointsSelected"
        :selected-checkpoint-ids="selectedCheckpointIds"
        :selected-checkpoints-size="selectedCheckpointsSize"
        :toggle-checkpoint-selected="toggleCheckpointSelected"
        :request-delete-checkpoints="requestDeleteCheckpoints"
        :request-delete-conversations="requestDeleteConversations"
        :request-delete-single-checkpoint="requestDeleteSingleCheckpoint"
        :show-delete-confirm-dialog="showDeleteConfirmDialog"
        :open-manifest-detail="openManifestDetail"
        :is-batch-deleting="isBatchDeleting"
        :is-cleanup-loading="isCleanupLoading"
        :filtered-conversations="filteredConversations"
        :load-conversations-with-checkpoints="loadConversationsWithCheckpoints"
        :get-phase-label="getPhaseLabel"
        :get-type-label="getTypeLabel"
        :get-tool-label="getToolLabel"
        :get-unbacked-paths-title="getUnbackedPathsTitle"
        :format-relative-time="formatRelativeTime"
        :format-size="formatSize"
        :format-checkpoint-count="formatCheckpointCount"
        :operation-progress="operationProgress"
        :operation-phase-label="operationPhaseLabel"
        :operation-stale="operationStale"
        :cancel-active-operation="cancelActiveOperation"
        :operation-cancel-error="operationCancelError"
        :delete-feedback="deleteFeedback"
        @close-delete-feedback="deleteFeedback = null"
      />
      
      <!-- TREE-09：分支清理区块（与存档清理并列） -->
      <BranchCleanupSettings />
      
    </template>
    
    <!-- 删除确认对话框（C3：拆至 CheckpointDeleteConfirmDialog） -->
    <CheckpointDeleteConfirmDialog
      :state="deleteConfirmState"
      :is-batch-deleting="isBatchDeleting"
      :format-size="formatSize"
      @cancel="cancelDelete"
      @confirm="confirmDelete"
    />
    <!-- EX-11: 存档排除清单详情（C3：拆至 CheckpointManifestDialog） -->
    <CheckpointManifestDialog
      :checkpoint-id="manifestCheckpointId"
      :detail="manifestDetail"
      :is-loading="isManifestLoading"
      :load-error="manifestLoadError"
      :excluded-count="manifestExcludedCount"
      :enabled-profile-ids="manifestEnabledProfileIds"
      :rules-changed="manifestRulesChanged"
      :profile-label="profileLabel"
      :format-size="formatSize"
      @close="closeManifestDetail"
    />
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
</style>
