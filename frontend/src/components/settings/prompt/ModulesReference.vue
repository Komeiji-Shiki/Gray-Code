<script setup lang="ts">
/**
 * ModulesReference - 可用变量参考（可收缩，默认收起；静态变量组 + 动态变量组）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：收缩态/展开模块/模块列表由父组件通过 props 注入，
 *   折叠、展开与插入动作通过 emit 上报，自身不持有任何响应式状态。
 */
import { t } from '@/i18n'
import type { PromptModule } from './types'

defineProps<{
  collapsed: boolean
  expandedModule: string | null
  staticModules: PromptModule[]
  dynamicModules: PromptModule[]
  formatModuleId: (id: string) => string
}>()

const emit = defineEmits<{
  (event: 'update:collapsed', value: boolean): void
  (event: 'toggle-module', moduleId: string): void
  (event: 'insert-static', moduleId: string): void
  (event: 'insert-dynamic', moduleId: string): void
}>()
</script>

<template>
  <!-- 可用变量参考（可收缩，默认收起） -->
  <div class="modules-reference collapsible" data-search-anchor="prompt-modules">
    <button
      type="button"
      class="reference-header"
      :aria-expanded="!collapsed"
      aria-controls="prompt-modules-reference-content"
      @click="emit('update:collapsed', !collapsed)"
    >
      <span class="reference-title">
        <i class="codicon codicon-references"></i>
        {{ t('components.settings.promptSettings.modulesReference.title') }}
      </span>
      <i class="codicon" :class="collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'"></i>
    </button>

    <div v-if="!collapsed" id="prompt-modules-reference-content">
      <!-- 静态变量组 -->
      <div class="modules-group">
        <div class="group-header">
          <i class="codicon codicon-lock"></i>
          <span class="group-title">{{ t('components.settings.promptSettings.staticModules.title') }}</span>
          <span class="group-badge static-badge">{{ t('components.settings.promptSettings.staticModules.badge') }}</span>
        </div>
        <p class="group-description">{{ t('components.settings.promptSettings.staticModules.description') }}</p>

        <div class="modules-list">
          <div
            v-for="module in staticModules"
            :key="module.id"
            class="module-item"
            :class="{ expanded: expandedModule === module.id }"
          >
            <div class="module-header" @click="emit('toggle-module', module.id)">
              <div class="module-info">
                <code class="module-id">{{ formatModuleId(module.id) }}</code>
                <span class="module-name">{{ t(`components.settings.promptSettings.modules.${module.id}.name`) }}</span>
              </div>
              <button
                class="insert-btn"
                @click.stop="emit('insert-static', module.id)"
                :title="t('components.settings.promptSettings.modulesReference.insertTooltip')"
              >
                <i class="codicon codicon-add"></i>
              </button>
            </div>

            <div v-if="expandedModule === module.id" class="module-details">
              <p class="module-description">{{ t(`components.settings.promptSettings.modules.${module.id}.description`) }}</p>

              <div v-if="module.requiresConfig" class="module-requires">
                <i class="codicon codicon-info"></i>
                <span>{{ t('components.settings.promptSettings.requiresConfigLabel') }} {{ t(`components.settings.promptSettings.modules.${module.id}.requiresConfig`) }}</span>
              </div>

              <div v-if="module.example" class="module-example">
                <label>{{ t('components.settings.promptSettings.exampleOutput') }}</label>
                <pre>{{ module.example }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 动态变量组 -->
      <div class="modules-group">
        <div class="group-header">
          <i class="codicon codicon-sync"></i>
          <span class="group-title">{{ t('components.settings.promptSettings.dynamicModules.title') }}</span>
          <span class="group-badge dynamic-badge">{{ t('components.settings.promptSettings.dynamicModules.badge') }}</span>
        </div>
        <p class="group-description">{{ t('components.settings.promptSettings.dynamicModules.description') }}</p>

        <div class="modules-list">
          <div
            v-for="module in dynamicModules"
            :key="module.id"
            class="module-item"
            :class="{ expanded: expandedModule === module.id }"
          >
            <div class="module-header" @click="emit('toggle-module', module.id)">
              <div class="module-info">
                <code class="module-id">{{ formatModuleId(module.id) }}</code>
                <span class="module-name">{{ t(`components.settings.promptSettings.modules.${module.id}.name`) }}</span>
              </div>
              <button
                class="insert-btn"
                @click.stop="emit('insert-dynamic', module.id)"
                :title="t('components.settings.promptSettings.modulesReference.insertTooltip')"
              >
                <i class="codicon codicon-add"></i>
              </button>
            </div>

            <div v-if="expandedModule === module.id" class="module-details">
              <p class="module-description">{{ t(`components.settings.promptSettings.modules.${module.id}.description`) }}</p>

              <div v-if="module.requiresConfig" class="module-requires">
                <i class="codicon codicon-info"></i>
                <span>{{ t('components.settings.promptSettings.requiresConfigLabel') }} {{ t(`components.settings.promptSettings.modules.${module.id}.requiresConfig`) }}</span>
              </div>

              <div v-if="module.example" class="module-example">
                <label>{{ t('components.settings.promptSettings.exampleOutput') }}</label>
                <pre>{{ module.example }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 模块参考（可收缩） */
.modules-reference {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-panel-border);
}

.modules-reference .reference-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
  user-select: none;
}

.modules-reference .reference-header:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 2px;
}

.modules-reference .reference-header:hover .reference-title {
  color: var(--vscode-foreground);
}

.modules-reference .reference-header .codicon {
  color: var(--vscode-descriptionForeground);
  font-size: 14px;
}

.reference-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 12px 0;
  font-size: 13px;
  font-weight: 500;
}

.modules-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.module-item {
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
}

.module-item.expanded {
  border-color: var(--vscode-focusBorder);
}

.module-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.module-header:hover {
  background: var(--vscode-list-hoverBackground);
}

.module-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.module-id {
  font-size: 11px;
  padding: 2px 6px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
  color: var(--vscode-textPreformat-foreground);
}

.module-name {
  font-size: 12px;
  color: var(--vscode-foreground);
}

.insert-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.insert-btn:hover:not(:disabled) {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

.insert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.module-details {
  padding: 10px 12px;
  background: var(--vscode-sideBar-background);
  border-top: 1px solid var(--vscode-panel-border);
}

.module-description {
  margin: 0 0 8px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.module-requires {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 11px;
  color: var(--vscode-notificationsInfoIcon-foreground);
}

.module-example {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.module-example label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.module-example pre {
  margin: 0;
  padding: 8px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family), monospace;
  line-height: 1.4;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 变量分组样式 */
.modules-group {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.modules-group:last-child {
  margin-bottom: 0;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.group-header .codicon {
  font-size: 14px;
  color: var(--vscode-foreground);
}

.group-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.group-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: 500;
}

.static-badge {
  background: var(--vscode-charts-green);
  color: var(--vscode-editor-background);
}

.dynamic-badge {
  background: var(--vscode-charts-blue);
  color: var(--vscode-editor-background);
}

.group-description {
  margin: 0 0 12px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
}
</style>
