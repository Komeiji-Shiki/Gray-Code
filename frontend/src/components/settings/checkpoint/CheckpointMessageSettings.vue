<script setup lang="ts">
/**
 * CheckpointMessageSettings - 消息类型存档点开关区
 *
 * 从 CheckpointSettings.vue 模板拆分（C3 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：状态与动作全部由父组件通过 props 注入（状态仍归父组件的
 *   useCheckpointConfig 单一实例持有），自身不持有任何响应式状态。
 */
import { CustomCheckbox } from '../../common'
import { t } from '@/i18n'
import type { MessageCheckpointConfig } from '@/composables/useCheckpointConfig'

defineProps<{
  configEnabled: boolean
  messageCheckpoint?: MessageCheckpointConfig
  messageTypes: Array<{ name: string; displayName: string; description: string }>
  isMessageInBefore: (messageType: string) => boolean
  isMessageInAfter: (messageType: string) => boolean
  isAllMessageBeforeSelected: boolean
  isAllMessageAfterSelected: boolean
  hasModelMessageCheckpoint: boolean | undefined
  toggleMessageBefore: (messageType: string, enabled: boolean) => void
  toggleMessageAfter: (messageType: string, enabled: boolean) => void
  toggleAllMessageBefore: (enabled: boolean) => void
  toggleAllMessageAfter: (enabled: boolean) => void
  toggleModelOuterLayerOnly: (enabled: boolean) => void
  toggleMergeUnchangedCheckpoints: (enabled: boolean) => void
}>()
</script>

<template>
  <!-- 消息类型存档点 -->
  <div class="setting-group" :class="{ disabled: !configEnabled }" data-search-anchor="checkpoint-messages">
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
            :disabled="!configEnabled"
            @update:modelValue="toggleAllMessageBefore"
          />
        </div>
        <div class="col-after">
          <CustomCheckbox
            :modelValue="isAllMessageAfterSelected"
            :label="t('components.settings.checkpoint.sections.messages.afterLabel')"
            :disabled="!configEnabled"
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
            :disabled="!configEnabled"
            @update:modelValue="(val: boolean) => toggleMessageBefore(msg.name, val)"
          />
        </div>
        <div class="col-after">
          <CustomCheckbox
            :modelValue="isMessageInAfter(msg.name)"
            :disabled="!configEnabled"
            @update:modelValue="(val: boolean) => toggleMessageAfter(msg.name, val)"
          />
        </div>
      </div>
    </div>

    <!-- 模型消息高级选项 -->
    <div v-if="hasModelMessageCheckpoint" class="advanced-option">
      <CustomCheckbox
        :modelValue="messageCheckpoint?.modelOuterLayerOnly ?? true"
        :label="t('components.settings.checkpoint.sections.messages.options.modelOuterLayerOnly.label')"
        :disabled="!configEnabled"
        @update:modelValue="toggleModelOuterLayerOnly"
      />
      <p class="option-hint">
        {{ t('components.settings.checkpoint.sections.messages.options.modelOuterLayerOnly.hint') }}
      </p>
    </div>

    <!-- 合并无变更存档点选项 -->
    <div class="advanced-option">
      <CustomCheckbox
        :modelValue="messageCheckpoint?.mergeUnchangedCheckpoints ?? true"
        :label="t('components.settings.checkpoint.sections.messages.options.mergeUnchanged.label')"
        :disabled="!configEnabled"
        @update:modelValue="toggleMergeUnchangedCheckpoints"
      />
      <p class="option-hint">
        {{ t('components.settings.checkpoint.sections.messages.options.mergeUnchanged.hint') }}
      </p>
    </div>
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

.setting-group.disabled {
  opacity: 0.5;
  pointer-events: none;
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
  background: var(--gc-surface-editor-bg);
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
</style>
