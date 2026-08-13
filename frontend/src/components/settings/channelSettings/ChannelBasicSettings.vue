<script setup lang="ts">
/**
 * ChannelBasicSettings - 渠道基础配置表单（启用 / API URL / API Key / 模型 / 流式 /
 * 渠道类型 / 工具调用格式 / 多模态 / Strict Tool Use / 超时 / 上下文 token 上限）
 *
 * 从 ChannelSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：全部状态由父组件注入，自身不持有业务状态；
 * - 所有变更通过 emits 回传父组件（update:field / update:option / 输入类事件）。
 */
import ModelManager from '../ModelManager.vue'
import { CustomSelect, type SelectOption } from '../../common'
import { t } from '@/i18n'
import type { ChannelConfig } from '@/types'

defineProps<{
  config: ChannelConfig
  showApiKey: boolean
  typeOptions: SelectOption[]
  toolModeOptions: SelectOption[]
  timeoutDraft: string
  maxContextTokensDraft: string
}>()

const emit = defineEmits<{
  (e: 'update:field', field: string, value: any): void
  (e: 'update:option', optionKey: string, value: any): void
  (e: 'api-key-url-input', field: 'url' | 'apiKey', value: string): void
  (e: 'timeout-input', value: string): void
  (e: 'max-context-tokens-input', value: string): void
  (e: 'toggle-show-api-key'): void
  (e: 'change-type', newType: string): void
}>()
</script>

<template>
  <!-- 启用此配置（置于表单顶部，一眼可见） -->
  <div class="form-group checkbox-group" data-search-anchor="channel-enabled">
    <label class="custom-checkbox">
      <input
        type="checkbox"
        :checked="config.enabled"
        @change="(e: any) => emit('update:field', 'enabled', e.target.checked)"
      />
      <span class="checkmark"></span>
      <span class="checkbox-text">{{ t('components.settings.channelSettings.form.enabled.label') }}</span>
    </label>
  </div>

  <div class="form-group" data-search-anchor="api-url">
    <label>{{ t('components.settings.channelSettings.form.apiUrl.label') }}</label>
    <input
      :value="config.url"
      type="text"
      :placeholder="config.type === 'openai-responses'
        ? t('components.settings.channelSettings.form.apiUrl.placeholderResponses')
        : t('components.settings.channelSettings.form.apiUrl.placeholder')"
      @input="(e: any) => emit('api-key-url-input', 'url', e.target.value)"
    />
  </div>

  <div class="form-group" data-search-anchor="api-key">
    <label>{{ t('components.settings.channelSettings.form.apiKey.label') }}</label>
    <div class="input-with-action">
      <input
        :type="showApiKey ? 'text' : 'password'"
        :value="config.apiKey"
        :placeholder="t('components.settings.channelSettings.form.apiKey.placeholder')"
        @input="(e: any) => emit('api-key-url-input', 'apiKey', e.target.value)"
      />
      <button
        class="input-action-btn"
        :title="showApiKey ? t('components.settings.channelSettings.form.apiKey.hide') : t('components.settings.channelSettings.form.apiKey.show')"
        @click="emit('toggle-show-api-key')"
      >
        <i :class="['codicon', showApiKey ? 'codicon-eye-closed' : 'codicon-eye']"></i>
      </button>
    </div>

    <!-- 使用 Authorization 格式（仅 Gemini 和 Anthropic） -->
    <div v-if="config.type === 'gemini' || config.type === 'anthropic'" class="checkbox-group api-key-option">
      <label class="custom-checkbox">
        <input
          type="checkbox"
          :checked="config.useAuthorizationHeader ?? false"
          @change="(e: any) => emit('update:field', 'useAuthorizationHeader', e.target.checked)"
        />
        <span class="checkmark"></span>
        <span class="checkbox-text">{{ t('components.settings.channelSettings.form.apiKey.useAuthorization') }}</span>
      </label>
      <span class="field-hint api-key-hint">
        {{ config.type === 'gemini'
          ? t('components.settings.channelSettings.form.apiKey.useAuthorizationHintGemini')
          : t('components.settings.channelSettings.form.apiKey.useAuthorizationHintAnthropic')
        }}
      </span>
    </div>
  </div>

  <!-- 模型管理器 -->
  <div class="form-group" data-search-anchor="model-list">
    <ModelManager
      :config-id="config.id"
      :models="config.models || []"
      :selected-model="config.model || ''"
      @update:models="(m: any) => emit('update:field', 'models', m)"
      @update:selected-model="(id: string) => emit('update:field', 'model', id)"
    />
  </div>

  <!-- 流式输出 -->
  <div class="form-group checkbox-group" data-search-anchor="stream-output">
    <label class="custom-checkbox">
      <input
        type="checkbox"
        :checked="config.options?.stream ?? true"
        @change="(e: any) => emit('update:option', 'stream', e.target.checked)"
      />
      <span class="checkmark"></span>
      <span class="checkbox-text">{{ t('components.settings.channelSettings.form.stream.label') }}</span>
    </label>
  </div>

  <!-- 渠道类型（可更改，切换后类型特有参数重置为新类型默认值） -->
  <div class="form-group" data-search-anchor="channel-type">
    <label>{{ t('components.settings.channelSettings.form.channelType.label') }}</label>
    <CustomSelect
      :model-value="config.type"
      :options="typeOptions"
      :placeholder="t('components.settings.channelSettings.dialog.new.typePlaceholder')"
      @update:model-value="(v: string) => emit('change-type', v)"
    />
    <span class="field-hint">
      {{ t('components.settings.channelSettings.form.channelType.changeHint') }}
    </span>
  </div>

  <!-- 工具调用格式 -->
  <div class="form-group" data-search-anchor="tool-mode">
    <label>{{ t('components.settings.channelSettings.form.toolMode.label') }}</label>
    <CustomSelect
      :model-value="config.toolMode || 'function_call'"
      :options="toolModeOptions"
      :placeholder="t('components.settings.channelSettings.form.toolMode.placeholder')"
      @update:model-value="(v: string) => emit('update:field', 'toolMode', v)"
    />
    <span class="field-hint">
      {{ t('components.settings.channelSettings.form.toolMode.hint.functionCall') }}<br>
      {{ t('components.settings.channelSettings.form.toolMode.hint.xml') }}<br>
      {{ t('components.settings.channelSettings.form.toolMode.hint.json') }}
    </span>
    <!-- OpenAI Function Call 模式警告 -->
    <div v-if="config.type === 'openai' && (config.toolMode === 'function_call' || !config.toolMode)" class="tool-mode-warning">
      <i class="codicon codicon-warning"></i>
      <span>{{ t('components.settings.channelSettings.form.toolMode.openaiWarning') }}</span>
    </div>
  </div>

  <!-- 多模态工具 -->
  <div class="form-group" data-search-anchor="multimodal">
    <div class="checkbox-with-hint">
      <label class="custom-checkbox">
        <input
          type="checkbox"
          :checked="config.multimodalToolsEnabled ?? false"
          @change="(e: any) => emit('update:field', 'multimodalToolsEnabled', e.target.checked)"
        />
        <span class="checkmark"></span>
        <span class="checkbox-text">{{ t('components.settings.channelSettings.form.multimodal.label') }}</span>
      </label>
      <div class="multimodal-support-info">
        <div class="support-header">{{ t('components.settings.channelSettings.form.multimodal.supportedTypes') }}</div>
        <div class="support-list">
          <div class="support-item">
            <span class="type-label">{{ t('components.settings.channelSettings.form.multimodal.image') }}</span>
            <span class="type-formats">{{ t('components.settings.channelSettings.form.multimodal.imageFormats') }}</span>
          </div>
          <div class="support-item">
            <span class="type-label">{{ t('components.settings.channelSettings.form.multimodal.document') }}</span>
            <span class="type-formats">{{ t('components.settings.channelSettings.form.multimodal.documentFormats') }}</span>
          </div>
        </div>

        <div class="support-header" style="margin-top: 8px;">{{ t('components.settings.channelSettings.form.multimodal.capabilities') }}</div>
        <div class="channel-support-table detailed">
          <div class="channel-row header-row">
            <span class="channel-name">{{ t('components.settings.channelSettings.form.multimodal.table.channel') }}</span>
            <span class="channel-feature">{{ t('components.settings.channelSettings.form.multimodal.table.readImage') }}</span>
            <span class="channel-feature">{{ t('components.settings.channelSettings.form.multimodal.table.readDocument') }}</span>
            <span class="channel-feature">{{ t('components.settings.channelSettings.form.multimodal.table.generateImage') }}</span>
            <span class="channel-feature">{{ t('components.settings.channelSettings.form.multimodal.table.historyMultimodal') }}</span>
          </div>
          <div class="channel-row" :class="{ current: config.type === 'gemini' }">
            <span class="channel-name">{{ t('components.settings.channelSettings.form.multimodal.channels.geminiAll') }}</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-yes">✓</span>
          </div>
          <div class="channel-row" :class="{ current: config.type === 'anthropic' }">
            <span class="channel-name">{{ t('components.settings.channelSettings.form.multimodal.channels.anthropicAll') }}</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-yes">✓</span>
          </div>
          <div class="channel-row" :class="{ current: config.type === 'openai-responses' }">
            <span class="channel-name">{{ t('components.settings.channelSettings.form.multimodal.channels.openaiResponses') }}</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-no">✗</span>
            <span class="channel-feature support-yes">✓</span>
          </div>
          <div class="channel-row" :class="{ current: config.type === 'openai' && config.toolMode !== 'function_call' }">
            <span class="channel-name">{{ t('components.settings.channelSettings.form.multimodal.channels.openaiXmlJson') }}</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-no">✗</span>
            <span class="channel-feature support-yes">✓</span>
            <span class="channel-feature support-yes">✓</span>
          </div>
          <div class="channel-row" :class="{ current: config.type === 'openai' && config.toolMode === 'function_call' }">
            <span class="channel-name">{{ t('components.settings.channelSettings.form.multimodal.channels.openaiFunction') }}</span>
            <span class="channel-feature support-no">✗</span>
            <span class="channel-feature support-no">✗</span>
            <span class="channel-feature support-no">✗</span>
            <span class="channel-feature support-no">✗</span>
          </div>
        </div>

        <div class="support-legend">
          <span class="legend-item">
            <span class="legend-symbol support-yes">✓</span>
            <span class="legend-text">{{ t('components.settings.channelSettings.form.multimodal.legend.supported') }}</span>
          </span>
          <span class="legend-item">
            <span class="legend-symbol support-no">✗</span>
            <span class="legend-text">{{ t('components.settings.channelSettings.form.multimodal.legend.notSupported') }}</span>
          </span>
        </div>

        <div class="support-notes">
          <div class="note-item highlight">
            <i class="codicon codicon-lightbulb note-icon"></i>
            <span class="note-text">{{ t('components.settings.channelSettings.form.multimodal.notes.requireEnable') }}</span>
          </div>
          <div class="note-item">
            <i class="codicon codicon-info note-icon"></i>
            <span class="note-text">{{ t('components.settings.channelSettings.form.multimodal.notes.userAttachment') }}</span>
          </div>
          <div class="note-item">
            <i class="codicon codicon-info note-icon"></i>
            <span class="note-text">{{ t('components.settings.channelSettings.form.multimodal.notes.geminiAnthropic') }}</span>
          </div>
          <div class="note-item">
            <i class="codicon codicon-info note-icon"></i>
            <span class="note-text">{{ t('components.settings.channelSettings.form.multimodal.notes.openaiResponses') }}</span>
          </div>
          <div class="note-item">
            <i class="codicon codicon-info note-icon"></i>
            <span class="note-text">{{ t('components.settings.channelSettings.form.multimodal.notes.openaiXmlJson') }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Strict Tool Use -->
  <div class="form-group" data-search-anchor="strict-tools">
    <div class="checkbox-with-hint">
      <label class="custom-checkbox">
        <input
          type="checkbox"
          :checked="config.strictToolsEnabled ?? false"
          @change="(e: any) => emit('update:field', 'strictToolsEnabled', e.target.checked)"
        />
        <span class="checkmark"></span>
        <span class="checkbox-text">{{ t('components.settings.channelSettings.form.strictTools.label') }}</span>
      </label>
      <span class="field-hint">{{ t('components.settings.channelSettings.form.strictTools.hint') }}</span>
      <div class="multimodal-support-info" style="margin-top: 4px;">
        <div class="support-list">
          <div class="support-item" :class="{ current: config.type === 'anthropic' }">
            <span class="type-label">
              <span :class="config.type === 'anthropic' ? 'support-yes' : ''">{{ t('components.settings.channelSettings.form.strictTools.support.anthropic') }}</span>
            </span>
          </div>
          <div class="support-item" :class="{ current: config.type === 'openai' }">
            <span class="type-label">
              <span :class="config.type === 'openai' ? 'support-yes' : ''">{{ t('components.settings.channelSettings.form.strictTools.support.openai') }}</span>
            </span>
          </div>
          <div class="support-item" :class="{ current: config.type === 'openai-responses' }">
            <span class="type-label">
              <span :class="config.type === 'openai-responses' ? 'support-yes' : ''">{{ t('components.settings.channelSettings.form.strictTools.support.openaiResponses') }}</span>
            </span>
          </div>
          <div class="support-item" :class="{ current: config.type === 'gemini' }">
            <span class="type-label">
              <span class="support-no">{{ t('components.settings.channelSettings.form.strictTools.support.gemini') }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="form-group" data-search-anchor="timeout">
    <label>{{ t('components.settings.channelSettings.form.timeout.label') }}</label>
    <input
      :value="timeoutDraft"
      type="number"
      :placeholder="t('components.settings.channelSettings.form.timeout.placeholder')"
      @input="(e: any) => emit('timeout-input', e.target.value)"
    />
  </div>

  <div class="form-group" data-search-anchor="max-context-tokens">
    <label>{{ t('components.settings.channelSettings.form.maxContextTokens.label') }}</label>
    <input
      :value="maxContextTokensDraft"
      type="number"
      :placeholder="t('components.settings.channelSettings.form.maxContextTokens.placeholder')"
      @input="(e: any) => emit('max-context-tokens-input', e.target.value)"
    />
    <span class="field-hint">{{ t('components.settings.channelSettings.form.maxContextTokens.hint') }}</span>
  </div>
</template>

<style scoped>
/* 表单 */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.form-group input[type="text"],
.form-group input[type="password"],
.form-group input[type="number"] {
  padding: 6px 10px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 13px;
}

/* 隐藏数字输入框的上下箭头 */
.form-group input[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield; /* Firefox */
}

.form-group input[type="number"]::-webkit-outer-spin-button,
.form-group input[type="number"]::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

.form-group input:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

/* 带操作按钮的输入框 */
.input-with-action {
  display: flex;
  gap: 4px;
}

.input-with-action input {
  flex: 1;
}

.input-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  padding: 0;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  cursor: pointer;
}

.input-action-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

/* 自定义勾选框 */
.checkbox-group {
  flex-direction: row;
  align-items: center;
}

.custom-checkbox {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 13px;
  font-weight: normal;
  position: relative;
  padding-left: 26px;
  user-select: none;
}

.custom-checkbox input {
  position: absolute;
  opacity: 0;
  cursor: pointer;
  height: 0;
  width: 0;
}

.custom-checkbox .checkmark {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 16px;
  width: 16px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  transition: all 0.15s;
}

.custom-checkbox:hover .checkmark {
  border-color: var(--vscode-focusBorder);
}

.custom-checkbox input:checked ~ .checkmark {
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.custom-checkbox .checkmark::after {
  content: '';
  position: absolute;
  display: none;
  left: 5px;
  top: 2px;
  width: 4px;
  height: 8px;
  border: solid var(--vscode-button-foreground);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.custom-checkbox input:checked ~ .checkmark::after {
  display: block;
}

.checkbox-text {
  margin-left: 4px;
}

/* 字段提示文字 */
.field-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
  opacity: 0.8;
}

/* 带提示的勾选框容器 */
.checkbox-with-hint {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.checkbox-with-hint .custom-checkbox {
  padding-left: 26px;
}

.checkbox-with-hint .field-hint {
  margin-left: 26px;
}

/* 多模态支持信息 */
.multimodal-support-info {
  margin-left: 26px;
  margin-top: 8px;
  padding: 10px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  font-size: 11px;
}

.multimodal-support-info .support-header {
  font-weight: 500;
  color: var(--vscode-foreground);
  margin-bottom: 6px;
}

.multimodal-support-info .support-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.multimodal-support-info .support-item {
  display: flex;
  gap: 8px;
}

.multimodal-support-info .type-label {
  color: var(--vscode-descriptionForeground);
  min-width: 40px;
}

.multimodal-support-info .type-formats {
  color: var(--vscode-foreground);
}

/* 渠道支持表格 */
.channel-support-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 10px;
}

.channel-support-table.detailed {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
}

.channel-row {
  display: grid;
  grid-template-columns: 120px repeat(4, 1fr);
  gap: 4px;
  padding: 4px 6px;
  border-radius: 2px;
}

.channel-support-table.detailed .channel-row {
  border-radius: 0;
}

.channel-row.header-row {
  background: var(--vscode-editor-background);
  font-weight: 500;
  color: var(--vscode-foreground);
  opacity: 0.8;
}

.channel-row.current {
  background: rgba(0, 122, 204, 0.15);
}

.channel-row .channel-name {
  font-weight: 500;
}

.channel-row .channel-feature {
  text-align: center;
}

.channel-feature.support-yes {
  color: var(--vscode-charts-green, #89d185);
}

.channel-feature.support-no {
  color: var(--vscode-errorForeground, #f48771);
}

.channel-feature.support-partial {
  color: var(--vscode-charts-yellow, #ddb92f);
}

/* 图例 */
.support-legend {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  font-size: 10px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.legend-symbol {
  font-weight: bold;
}

.legend-text {
  color: var(--vscode-descriptionForeground);
}

/* 支持说明 */
.support-notes {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.note-item {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}

.note-item.warning {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.note-icon {
  font-size: 14px;
  flex-shrink: 0;
  color: var(--vscode-charts-blue, #3794ff);
}

.note-item.warning .note-icon {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.note-text {
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

.note-item.warning .note-text {
  color: var(--vscode-charts-yellow, #ddb92f);
}

/* 工具模式警告 */
.tool-mode-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(221, 185, 47, 0.1);
  border: 1px solid var(--vscode-charts-yellow, #ddb92f);
  border-radius: 4px;
  font-size: 11px;
  color: var(--vscode-charts-yellow, #ddb92f);
  line-height: 1.5;
}

.tool-mode-warning .codicon {
  flex-shrink: 0;
  font-size: 14px;
  margin-top: 1px;
}

/* 高亮提示 */
.note-item.highlight {
  background: rgba(0, 122, 204, 0.1);
  padding: 6px 8px;
  border-radius: 4px;
  margin-bottom: 4px;
}

.note-item.highlight .note-icon {
  color: var(--vscode-button-background, #007acc);
}

.note-item.highlight .note-text {
  color: var(--vscode-foreground);
}
</style>
