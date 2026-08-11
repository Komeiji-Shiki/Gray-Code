<script setup lang="ts">
/**
 * TokenCountSection - Token 计数（静态/动态分别显示 + 渠道选择 + 刷新）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：计数状态/渠道/格式化函数由父组件通过 props 注入，
 *   渠道变更与刷新通过 emit 上报，自身不持有任何响应式状态。
 */
import { t } from '@/i18n'

type ChannelType = 'gemini' | 'openai' | 'anthropic'

defineProps<{
  isCountingTokens: boolean
  staticTokenCount: number | null
  dynamicTokenCount: number | null
  tokenCountError: string
  selectedChannel: ChannelType
  channelOptions: Array<{ value: ChannelType; label: string }>
  formatTokenCount: (count: number) => string
}>()

const emit = defineEmits<{
  (event: 'update:selectedChannel', value: ChannelType): void
  (event: 'refresh'): void
}>()
</script>

<template>
  <div class="save-section">
    <!-- Token 计数显示 -->
    <div class="token-count-section" data-search-anchor="prompt-token-count">
      <div class="token-count-header">
        <label class="token-label">
          <i class="codicon codicon-symbol-numeric"></i>
          {{ t('components.settings.promptSettings.tokenCount.label') }}
        </label>

        <select
          :value="selectedChannel"
          @change="emit('update:selectedChannel', ($event.target as HTMLSelectElement).value as ChannelType)"
          class="channel-select"
          :title="t('components.settings.promptSettings.tokenCount.channelTooltip')"
        >
          <option v-for="opt in channelOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>

        <button
          class="refresh-btn"
          @click="emit('refresh')"
          :disabled="isCountingTokens"
          :title="t('components.settings.promptSettings.tokenCount.refreshTooltip')"
        >
          <i :class="['codicon', isCountingTokens ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh']"></i>
        </button>
      </div>

      <!-- 分别显示静态和动态 token 数 -->
      <div class="token-count-details">
        <!-- 静态模板 token -->
        <div class="token-count-item">
          <span
            class="token-item-label static-label"
            :title="t('components.settings.promptSettings.tokenCount.staticTooltip')"
          >
            <i class="codicon codicon-lock"></i>
            {{ t('components.settings.promptSettings.tokenCount.staticLabel') }}
          </span>
          <div class="token-value">
            <template v-if="isCountingTokens">
              <i class="codicon codicon-loading codicon-modifier-spin"></i>
            </template>
            <template v-else-if="staticTokenCount !== null">
              <span class="token-number static">{{ formatTokenCount(staticTokenCount) }}</span>
              <span class="token-unit">tokens</span>
            </template>
            <template v-else-if="tokenCountError">
              <span class="token-error" :title="tokenCountError">
                <i class="codicon codicon-warning"></i>
                {{ t('components.settings.promptSettings.tokenCount.failed') }}
              </span>
            </template>
            <template v-else>
              <span class="token-na">--</span>
            </template>
          </div>
        </div>

        <!-- 动态上下文 token -->
        <div class="token-count-item">
          <span
            class="token-item-label dynamic-label"
            :title="t('components.settings.promptSettings.tokenCount.dynamicTooltip')"
          >
            <i class="codicon codicon-sync"></i>
            {{ t('components.settings.promptSettings.tokenCount.dynamicLabel') }}
          </span>
          <div class="token-value">
            <template v-if="isCountingTokens">
              <i class="codicon codicon-loading codicon-modifier-spin"></i>
            </template>
            <template v-else-if="dynamicTokenCount !== null">
              <span class="token-number dynamic">{{ formatTokenCount(dynamicTokenCount) }}</span>
              <span class="token-unit">tokens</span>
            </template>
            <template v-else-if="tokenCountError">
              <span class="token-error" :title="tokenCountError">
                <i class="codicon codicon-warning"></i>
                {{ t('components.settings.promptSettings.tokenCount.failed') }}
              </span>
            </template>
            <template v-else>
              <span class="token-na">--</span>
            </template>
          </div>
        </div>
      </div>

      <p class="token-hint">
        {{ t('components.settings.promptSettings.tokenCount.hint') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.save-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}

/* Token 计数区域 */
.token-count-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.token-count-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.token-count-details {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.token-count-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--vscode-sideBar-background);
  border-radius: 4px;
  min-width: 150px;
}

.token-item-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  cursor: help;
}

.token-item-label.static-label .codicon {
  color: var(--vscode-charts-green);
}

.token-item-label.dynamic-label .codicon {
  color: var(--vscode-charts-blue);
}

.token-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.channel-select {
  padding: 4px 8px;
  font-size: 11px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  outline: none;
  cursor: pointer;
}

.channel-select:focus {
  border-color: var(--vscode-focusBorder);
}

.refresh-btn {
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

.refresh-btn:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.token-value {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.token-count-header .token-value {
  margin-left: auto;
}

.token-number {
  font-weight: 600;
}

.token-number.static {
  color: var(--vscode-charts-green);
}

.token-number.dynamic {
  color: var(--vscode-charts-blue);
}

.token-unit {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.token-error {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vscode-errorForeground);
  cursor: help;
}

.token-na {
  color: var(--vscode-descriptionForeground);
}

.token-hint {
  margin: 0;
  font-size: 11px;
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
</style>
