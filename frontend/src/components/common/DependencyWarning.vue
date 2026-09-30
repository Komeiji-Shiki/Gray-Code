<script setup lang="ts">
/**
 * DependencyWarning - 可复用的依赖警告组件
 *
 * 用于在工具面板或设置页面中显示依赖缺失警告
 *
 * @example
 * ```vue
 * <DependencyWarning
 *   :dependencies="['sharp']"
 *   message="此功能需要安装 sharp 库"
 * />
 * ```
 */

import { useSettingsStore } from '../../stores/settingsStore'
import { t } from '../../i18n'

defineProps<{
  /** 缺失的依赖列表 */
  dependencies: string[]
  /** 自定义警告消息（可选） */
  message?: string
  /** 是否显示为紧凑模式（无边框背景） */
  compact?: boolean
}>()

const settingsStore = useSettingsStore()

function goToDependencySettings() {
  settingsStore.showSettings('dependencies')
}
</script>

<template>
  <div :class="['dependency-warning', { compact }]">
    <div class="warning-header">
      <span class="codicon codicon-warning warning-icon"></span>
      <span class="warning-title">{{ t('components.common.dependencyWarning.title') }}</span>
    </div>
    <p v-if="message" class="warning-message">{{ message }}</p>
    <p v-else class="warning-message">
      {{ t('components.common.dependencyWarning.defaultMessage') }}<span class="dep-list">{{ dependencies.join(', ') }}</span>
    </p>
    <div class="warning-hint">
      {{ t('components.common.dependencyWarning.hint') }} <a class="dep-link" @click="goToDependencySettings">{{ t('components.common.dependencyWarning.linkText') }}</a>
    </div>
  </div>
</template>

<style scoped>
.dependency-warning {
  padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
  background: var(--gc-warning-bg);
  border: 1px solid var(--gc-warning-border);
  border-radius: var(--radius-sm, 2px);
}

.dependency-warning.compact {
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: transparent;
  border: none;
}

.warning-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.warning-icon {
  color: var(--gc-chart-orange);
  font-size: 14px;
  flex-shrink: 0;
}

.warning-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--gc-warning);
}

.compact .warning-title {
  font-size: 11px;
}

.warning-message {
  margin: var(--spacing-xs, 4px) 0 0 0;
  font-size: 11px;
  color: var(--gc-warning);
  line-height: 1.5;
}

.compact .warning-message {
  font-size: 10px;
}

.dep-list {
  font-weight: 600;
  font-family: var(--gc-font-code);
}

.warning-hint {
  margin-top: var(--spacing-xs, 4px);
  font-size: 11px;
  color: var(--gc-text-muted);
}

.compact .warning-hint {
  font-size: 10px;
}

.dep-link {
  color: var(--gc-link);
  cursor: pointer;
  text-decoration: underline;
}

.dep-link:hover {
  color: var(--gc-link-active);
}
</style>