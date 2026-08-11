<script setup lang="ts">
/**
 * ToolPolicySection - 模式工具策略（inherit / custom 单选 + 搜索 + 分组工具勾选）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：策略/搜索/工具列表/选中态由父组件通过 props 注入，
 *   变更与动作通过 emit 上报，自身不持有任何响应式状态。
 */
import { t } from '@/i18n'
import type { ToolPolicyMode, ToolInfo } from './types'

defineProps<{
  modelValue: ToolPolicyMode
  searchQuery: string
  isLoadingTools: boolean
  availableTools: ToolInfo[]
  groupedTools: Record<string, ToolInfo[]>
  getCategoryDisplayName: (category: string) => string
  isToolSelected: (name: string) => boolean
  toolPolicy: string[]
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: ToolPolicyMode): void
  (event: 'update:searchQuery', value: string): void
  (event: 'selectAll'): void
  (event: 'clear'): void
  (event: 'toggleTool', name: string, enabled: boolean): void
}>()
</script>

<template>
  <!-- 模式工具策略 -->
  <div class="template-section tool-policy-section" data-search-anchor="tool-policy">
    <div class="section-header">
      <label class="section-label">
        <i class="codicon codicon-tools"></i>
        {{ t('components.settings.promptSettings.toolPolicy.title') }}
      </label>
    </div>

    <p class="section-description">
      {{ t('components.settings.promptSettings.toolPolicy.description') }}
    </p>

    <div class="tool-policy-mode-row">
      <label class="radio-option">
        <input type="radio" value="inherit" :checked="modelValue === 'inherit'" @change="emit('update:modelValue', 'inherit')" />
        <span class="radio-text">{{ t('components.settings.promptSettings.toolPolicy.inherit') }}</span>
      </label>
      <label class="radio-option">
        <input type="radio" value="custom" :checked="modelValue === 'custom'" @change="emit('update:modelValue', 'custom')" />
        <span class="radio-text">{{ t('components.settings.promptSettings.toolPolicy.custom') }}</span>
      </label>
    </div>

    <div v-if="modelValue === 'inherit'" class="tool-policy-notice">
      <i class="codicon codicon-info"></i>
      <span>{{ t('components.settings.promptSettings.toolPolicy.inheritHint') }}</span>
    </div>

    <div v-else class="tool-policy-custom">
      <div class="tool-policy-toolbar">
        <div class="tool-search">
          <i class="codicon codicon-search"></i>
          <input
            :value="searchQuery"
            @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
            type="text"
            class="tool-search-input"
            :placeholder="t('components.settings.promptSettings.toolPolicy.searchPlaceholder')"
          />
        </div>

        <div class="tool-policy-buttons">
          <button
            class="small-btn"
            @click="emit('selectAll')"
            :disabled="isLoadingTools || availableTools.length === 0"
          >
            {{ t('components.settings.promptSettings.toolPolicy.selectAll') }}
          </button>
          <button
            class="small-btn"
            @click="emit('clear')"
            :disabled="toolPolicy.length === 0"
          >
            {{ t('components.settings.promptSettings.toolPolicy.clear') }}
          </button>
        </div>
      </div>

      <div v-if="isLoadingTools" class="tool-policy-loading">
        <i class="codicon codicon-loading codicon-modifier-spin"></i>
        <span>{{ t('components.settings.promptSettings.toolPolicy.loadingTools') }}</span>
      </div>

      <div v-else class="tool-policy-list">
        <div v-if="availableTools.length === 0" class="tool-policy-empty">
          {{ t('components.settings.promptSettings.toolPolicy.noTools') }}
        </div>
        <template v-else>
          <div v-for="(tools, category) in groupedTools" :key="category" class="tool-category">
            <div class="tool-category-header">
              <span class="tool-category-name">{{ getCategoryDisplayName(category) }}</span>
              <span class="tool-category-count">{{ tools.length }}</span>
            </div>
            <div class="tool-items">
              <label v-for="tool in tools" :key="tool.name" class="tool-item">
                <input
                  type="checkbox"
                  :checked="isToolSelected(tool.name)"
                  @change="emit('toggleTool', tool.name, ($event.target as HTMLInputElement).checked)"
                />
                <span class="tool-item-main">
                  <span class="tool-name">{{ tool.name }}</span>
                  <span v-if="tool.description" class="tool-desc">{{ tool.description }}</span>
                </span>
                <span v-if="tool.enabled === false" class="tool-disabled-badge">
                  {{ t('components.settings.promptSettings.toolPolicy.disabledBadge') }}
                </span>
              </label>
            </div>
          </div>
        </template>
      </div>

      <div v-if="toolPolicy.length === 0" class="tool-policy-warning">
        <i class="codicon codicon-warning"></i>
        <span>{{ t('components.settings.promptSettings.toolPolicy.emptyWarning') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.template-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* 工具策略 */
.tool-policy-mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 2px;
}

.radio-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.radio-option input {
  margin: 0;
}

.tool-policy-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--vscode-inputValidation-infoBackground);
  border: 1px solid var(--vscode-inputValidation-infoBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.tool-policy-notice .codicon {
  color: var(--vscode-notificationsInfoIcon-foreground);
}

.tool-policy-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.tool-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 220px;
  padding: 6px 10px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 6px;
}

.tool-search .codicon {
  font-size: 14px;
  color: var(--vscode-descriptionForeground);
}

.tool-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--vscode-input-foreground);
  font-size: 12px;
}

.tool-policy-buttons {
  display: flex;
  gap: 8px;
}

.small-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 10px;
  font-size: 11px;
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}

.small-btn:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder);
}

.small-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tool-policy-loading,
.tool-policy-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.tool-policy-list {
  margin-top: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-sideBar-background);
  overflow: auto;
  max-height: 260px;
}

.tool-category + .tool-category {
  border-top: 1px solid var(--vscode-panel-border);
}

.tool-category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  background: var(--vscode-editor-background);
}

.tool-category-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.tool-category-count {
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.tool-items {
  display: flex;
  flex-direction: column;
}

.tool-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  cursor: pointer;
  border-top: 1px solid var(--vscode-panel-border);
}

.tool-item:first-child {
  border-top: none;
}

.tool-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.tool-item input[type="checkbox"] {
  margin-top: 2px;
}

.tool-item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.tool-name {
  font-size: 12px;
  font-family: var(--vscode-editor-font-family), monospace;
  color: var(--vscode-foreground);
  word-break: break-word;
}

.tool-desc {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.35;
  word-break: break-word;
}

.tool-disabled-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  color: var(--vscode-foreground);
  white-space: nowrap;
}

.tool-policy-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-top: 8px;
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.tool-policy-warning .codicon {
  color: var(--vscode-notificationsWarningIcon-foreground);
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
