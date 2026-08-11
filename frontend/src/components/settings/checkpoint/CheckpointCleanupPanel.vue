<script setup lang="ts">
/**
 * CheckpointCleanupPanel - 存档点清理区（搜索 / 批量操作 / 进度 / 对话与存档点列表）
 *
 * 从 CheckpointSettings.vue 模板拆分（C3 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：状态与动作全部由父组件通过 props/emits 注入（状态仍归父组件的
 *   useCheckpointCleanup / useCheckpointOperationProgress / useCheckpointManifest
 *   单一实例持有），自身不持有任何响应式状态。
 * - searchQuery 通过 v-model 协议回写父组件 ref；deleteFeedback 关闭通过 closeDeleteFeedback 事件。
 */
import { CustomCheckbox, CustomScrollbar } from '../../common'
import { t } from '@/i18n'
import type { CheckpointSummaryWithSize } from '@shared/protocol'
import type { ConversationWithCheckpoints } from '@/composables/useCheckpointCleanup'
import type { CheckpointRecord } from '@/types'
import type { CheckpointOperationProgress } from '@/stores/chat/checkpointActions'

defineProps<{
  searchQuery: string
  conversationsWithCheckpoints: ConversationWithCheckpoints[]
  selectedConversations: ConversationWithCheckpoints[]
  selectedConversationsSize: number
  totalCheckpointsSize: number
  totalCheckpointsSizeIncomplete: boolean
  isAllConversationsSelected: boolean
  toggleAllConversationsSelected: (enabled: boolean) => void
  selectedConversationIds: Set<string>
  toggleConversationSelected: (conversationId: string, enabled: boolean) => void
  expandedConversationId: string | null
  toggleExpandConversation: (conversation: ConversationWithCheckpoints) => void
  isExpandedLoading: boolean
  expandedCheckpoints: Array<CheckpointSummaryWithSize>
  isAllCheckpointsSelected: boolean
  toggleAllCheckpointsSelected: (enabled: boolean) => void
  selectedCheckpointIds: Set<string>
  selectedCheckpointsSize: number
  toggleCheckpointSelected: (checkpointId: string, enabled: boolean) => void
  requestDeleteCheckpoints: () => void
  requestDeleteConversations: () => void
  requestDeleteSingleCheckpoint: (checkpoint: CheckpointSummaryWithSize) => void
  showDeleteConfirmDialog: (conversation: ConversationWithCheckpoints) => void
  openManifestDetail: (checkpoint: CheckpointRecord & { size?: number }) => void
  isBatchDeleting: boolean
  isCleanupLoading: boolean
  filteredConversations: ConversationWithCheckpoints[]
  loadConversationsWithCheckpoints: () => void
  getPhaseLabel: (phase: 'before' | 'after') => string
  getTypeLabel: (type?: string) => string
  getToolLabel: (toolName: string) => string
  getUnbackedPathsTitle: (checkpoint: CheckpointRecord & { size?: number }) => string
  formatRelativeTime: (timestamp?: number) => string
  formatSize: (size: number) => string
  formatCheckpointCount: (count: number) => string
  operationProgress: CheckpointOperationProgress | null
  operationPhaseLabel: (phase: string) => string
  operationStale: boolean
  cancelActiveOperation: () => void
  operationCancelError: string | null
  deleteFeedback: { rejectedCount: number; failedCount: number; message: string } | null
}>()

defineEmits<{
  (e: 'update:searchQuery', value: string): void
  (e: 'closeDeleteFeedback'): void
}>()
</script>

<template>
  <!-- 存档点清理 -->
  <div class="setting-group" data-search-anchor="checkpoint-cleanup">
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
        :value="searchQuery"
        @input="$emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
        type="text"
        :placeholder="t('components.settings.checkpoint.sections.cleanup.searchPlaceholder')"
        class="search-input"
      />
      <button
        v-if="searchQuery"
        class="clear-search"
        @click="$emit('update:searchQuery', '')"
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
      <button class="feedback-close" @click="$emit('closeDeleteFeedback')">
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
</template>

<style scoped>
/* 设置组 */
.setting-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: opacity 0.2s;
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
  background: var(--gc-surface-editor-bg);
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
  background: var(--gc-surface-editor-bg);
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
</style>
