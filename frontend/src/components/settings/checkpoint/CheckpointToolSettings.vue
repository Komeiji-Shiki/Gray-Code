<script setup lang="ts">
/**
 * CheckpointToolSettings - 工具备份配置区（before/after 开关表）
 *
 * 从 CheckpointSettings.vue 模板拆分（C3 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：状态与动作全部由父组件通过 props 注入（状态仍归父组件的
 *   useCheckpointConfig 单一实例持有），自身不持有任何响应式状态。
 */
import { CustomCheckbox } from '../../common'
import { t } from '@/i18n'
import {
  getToolDisplayName,
  getToolDescription,
  type ToolInfo
} from '@/composables/useCheckpointConfig'

defineProps<{
  configEnabled: boolean
  displayTools: ToolInfo[]
  isToolInBefore: (toolName: string) => boolean
  isToolInAfter: (toolName: string) => boolean
  isAllBeforeSelected: boolean
  isAllAfterSelected: boolean
  toggleToolBefore: (toolName: string, enabled: boolean) => void
  toggleToolAfter: (toolName: string, enabled: boolean) => void
  toggleAllBefore: (enabled: boolean) => void
  toggleAllAfter: (enabled: boolean) => void
}>()
</script>

<template>
  <!-- 工具备份配置 -->
  <div class="setting-group" :class="{ disabled: !configEnabled }" data-search-anchor="checkpoint-tools">
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
            :disabled="!configEnabled"
            @update:modelValue="toggleAllBefore"
          />
        </div>
        <div class="col-after">
          <CustomCheckbox
            :modelValue="isAllAfterSelected"
            :label="t('components.settings.checkpoint.sections.tools.afterLabel')"
            :disabled="!configEnabled"
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
            :disabled="!configEnabled"
            @update:modelValue="(val: boolean) => toggleToolBefore(tool.name, val)"
          />
        </div>
        <div class="col-after">
          <CustomCheckbox
            :modelValue="isToolInAfter(tool.name)"
            :disabled="!configEnabled"
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

/* 空状态 */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
}
</style>
