<script setup lang="ts">
/**
 * McpServerEditForm - MCP 服务器编辑/创建表单
 *
 * 从 McpSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 表单状态（formData）由父组件持有（reactive 对象），本组件直接绑定其字段
 *   （v-model 写回同一响应式对象，等价于原单文件内的 v-model 行为）；
 * - ID 校验状态（idValidation）只读展示；保存 / 取消 / ID 输入 / 传输类型切换通过 emits 回传父组件。
 */
import { CustomCheckbox } from '../../common'
import { useI18n } from '@/i18n'
import type { McpTransportType } from '@/types'

const { t } = useI18n()

interface McpFormData {
  customId: string
  name: string
  description: string
  transportType: McpTransportType
  command: string
  args: string
  env: string
  url: string
  headers: string
  enabled: boolean
  autoConnect: boolean
  timeout: number
  cleanSchema: boolean
}

interface IdValidation {
  checking: boolean
  valid: boolean | null
  error: string
}

defineProps<{
  isCreating: boolean
  editingServerId: string | undefined
  formData: McpFormData
  idValidation: IdValidation
  isSaving: boolean
  saveError: string
}>()

const emit = defineEmits<{
  (e: 'id-input'): void
  (e: 'select-transport-type', type: McpTransportType): void
  (e: 'cancel'): void
  (e: 'save'): void
}>()
</script>

<template>
  <div class="mcp-edit-view">
    <div class="edit-header">
      <h4>{{ isCreating ? t('components.settings.mcpSettings.form.addTitle') : t('components.settings.mcpSettings.form.editTitle') }}</h4>
      <button class="close-btn" @click="emit('cancel')">
        <i class="codicon codicon-close"></i>
      </button>
    </div>

    <div class="edit-form">
      <!-- 基本信息 -->
      <div class="form-section" data-search-anchor="mcp-basic-info">
        <!-- 自定义 ID（仅创建时显示） -->
        <div v-if="isCreating" class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.serverId') }}</label>
          <div class="id-input-wrapper">
            <input
              type="text"
              v-model="formData.customId"
              :placeholder="t('components.settings.mcpSettings.form.serverIdPlaceholder')"
              class="form-input"
              :class="{
                'input-error': idValidation.valid === false,
                'input-success': idValidation.valid === true
              }"
              @input="emit('id-input')"
            />
            <span v-if="idValidation.checking" class="id-status checking">
              <i class="codicon codicon-loading codicon-modifier-spin"></i>
            </span>
            <span v-else-if="idValidation.valid === true" class="id-status valid">
              <i class="codicon codicon-check"></i>
            </span>
            <span v-else-if="idValidation.valid === false" class="id-status invalid">
              <i class="codicon codicon-error"></i>
            </span>
          </div>
          <div v-if="idValidation.error" class="id-error">{{ idValidation.error }}</div>
          <div class="form-hint">{{ t('components.settings.mcpSettings.form.serverIdHint') }}</div>
        </div>

        <!-- 显示当前 ID（编辑时） -->
        <div v-else class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.serverId') }}</label>
          <div class="id-display">{{ editingServerId }}</div>
        </div>

        <div class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.serverName') }} <span class="required">{{ t('components.settings.mcpSettings.form.required') }}</span></label>
          <input
            type="text"
            v-model="formData.name"
            :placeholder="t('components.settings.mcpSettings.form.serverNamePlaceholder')"
            class="form-input"
          />
        </div>

        <div class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.description') }}</label>
          <input
            type="text"
            v-model="formData.description"
            :placeholder="t('components.settings.mcpSettings.form.descriptionPlaceholder')"
            class="form-input"
          />
        </div>
      </div>

      <!-- 传输类型 -->
      <div class="form-section" data-search-anchor="mcp-transport-type">
        <label class="section-label">{{ t('components.settings.mcpSettings.form.transportType') }}</label>
        <div class="transport-tabs">
          <button
            :class="['transport-tab', { active: formData.transportType === 'stdio' }]"
            @click="emit('select-transport-type', 'stdio')"
          >
            <i class="codicon codicon-terminal"></i>
            Stdio
          </button>
          <button
            :class="['transport-tab', { active: formData.transportType === 'sse' }]"
            @click="emit('select-transport-type', 'sse')"
          >
            <i class="codicon codicon-radio-tower"></i>
            SSE
          </button>
          <button
            :class="['transport-tab', { active: formData.transportType === 'streamable-http' }]"
            @click="emit('select-transport-type', 'streamable-http')"
          >
            <i class="codicon codicon-globe"></i>
            Streamable HTTP
          </button>
        </div>
      </div>

      <!-- Stdio 配置 -->
      <div v-if="formData.transportType === 'stdio'" class="form-section" data-search-anchor="mcp-stdio-config">
        <div class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.command') }} <span class="required">{{ t('components.settings.mcpSettings.form.required') }}</span></label>
          <input
            type="text"
            v-model="formData.command"
            :placeholder="t('components.settings.mcpSettings.form.commandPlaceholder')"
            class="form-input"
          />
        </div>

        <div class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.args') }}</label>
          <input
            type="text"
            v-model="formData.args"
            :placeholder="t('components.settings.mcpSettings.form.argsPlaceholder')"
            class="form-input"
          />
        </div>

        <div class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.env') }}</label>
          <textarea
            v-model="formData.env"
            :placeholder="t('components.settings.mcpSettings.form.envPlaceholder')"
            class="form-textarea"
            rows="3"
          ></textarea>
        </div>
      </div>

      <!-- SSE/Streamable HTTP 配置 -->
      <div v-else class="form-section" data-search-anchor="mcp-url-config">
        <div class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.url') }} <span class="required">{{ t('components.settings.mcpSettings.form.required') }}</span></label>
          <input
            type="text"
            v-model="formData.url"
            :placeholder="formData.transportType === 'sse' ? t('components.settings.mcpSettings.form.urlPlaceholderSse') : t('components.settings.mcpSettings.form.urlPlaceholderHttp')"
            class="form-input"
          />
        </div>

        <div class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.headers') }}</label>
          <textarea
            v-model="formData.headers"
            :placeholder="t('components.settings.mcpSettings.form.headersPlaceholder')"
            class="form-textarea"
            rows="3"
          ></textarea>
        </div>
      </div>

      <!-- 选项 -->
      <div class="form-section" data-search-anchor="mcp-options">
        <label class="section-label">{{ t('components.settings.mcpSettings.form.options') }}</label>

        <div class="form-row">
          <CustomCheckbox
            v-model="formData.enabled"
            :label="t('components.settings.mcpSettings.form.enabled')"
          />

          <CustomCheckbox
            v-model="formData.autoConnect"
            :label="t('components.settings.mcpSettings.form.autoConnect')"
          />
        </div>

        <div class="form-row">
          <CustomCheckbox
            v-model="formData.cleanSchema"
            :label="t('components.settings.mcpSettings.form.cleanSchema')"
          />
        </div>
        <div class="form-hint" style="margin-top: -8px; margin-bottom: 12px;">
          {{ t('components.settings.mcpSettings.form.cleanSchemaHint') }}
        </div>

        <div class="form-group">
          <label>{{ t('components.settings.mcpSettings.form.timeout') }}</label>
          <input
            type="number"
            v-model.number="formData.timeout"
            class="form-input"
            min="1000"
            max="300000"
          />
        </div>
      </div>

      <!-- 错误信息 -->
      <div v-if="saveError" class="form-error">
        <i class="codicon codicon-error"></i>
        {{ saveError }}
      </div>

      <!-- 操作按钮 -->
      <div class="form-actions">
        <button class="action-button secondary" @click="emit('cancel')">
          {{ t('components.settings.mcpSettings.form.cancel') }}
        </button>
        <button
          class="action-button primary"
          @click="emit('save')"
          :disabled="isSaving"
        >
          <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
          <span v-else>{{ isCreating ? t('components.settings.mcpSettings.form.create') : t('components.settings.mcpSettings.form.save') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 编辑视图 */
.mcp-edit-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.edit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.edit-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--vscode-foreground);
  cursor: pointer;
}

.close-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.edit-form {
  flex: 1;
  overflow-y: auto;
}

.form-section {
  margin-bottom: 20px;
}

.section-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
  margin-bottom: 8px;
}

.form-group {
  margin-bottom: 12px;
}

.form-group label {
  display: block;
  font-size: 12px;
  color: var(--vscode-foreground);
  margin-bottom: 4px;
}

.form-group label .required {
  color: var(--vscode-errorForeground);
}

.form-input,
.form-textarea {
  width: 100%;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
}

.form-input:focus,
.form-textarea:focus {
  border-color: var(--vscode-focusBorder);
}

.form-textarea {
  resize: vertical;
  font-family: var(--vscode-editor-font-family), monospace;
}

/* ID 输入相关样式 */
.id-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.id-input-wrapper .form-input {
  padding-right: 32px;
}

.id-status {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.id-status.checking {
  color: var(--vscode-descriptionForeground);
}

.id-status.valid {
  color: var(--vscode-terminal-ansiGreen);
}

.id-status.invalid {
  color: var(--vscode-errorForeground);
}

.id-error {
  font-size: 11px;
  color: var(--vscode-errorForeground);
  margin-top: 4px;
}

.id-display {
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 12px;
  padding: 6px 10px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
}

.form-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
}

.form-input.input-error {
  border-color: var(--vscode-inputValidation-errorBorder);
}

.form-input.input-success {
  border-color: var(--vscode-terminal-ansiGreen);
}

/* 隐藏数字输入框的上下箭头 */
input[type="number"]::-webkit-outer-spin-button,
input[type="number"]::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

input[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield;
}

.transport-tabs {
  display: flex;
  gap: 4px;
}

.transport-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.transport-tab:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.transport-tab.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.form-row {
  display: flex;
  gap: 24px;
  margin-bottom: 12px;
}

.form-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: 16px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-errorForeground);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-panel-border);
}

.action-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 80px;
  padding: 8px 16px;
  font-size: 13px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.action-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.action-button.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.action-button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.action-button.secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.action-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
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
