<script setup lang="ts">
/**
 * GeneralSettingsSection - 通用页签内容（代理 / 语言 / 更新 / 存储路径 / 导入导出 / 应用信息）
 *
 * 从 SettingsPanel.vue 模板拆分（T12 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：全部状态与动作由父组件通过 props/emits 注入（状态仍归父组件持有），
 *   自身不持有任何响应式业务状态；
 * - 仅内聚纯展示逻辑：语言选项 / 更新渠道选项 / 代理 URL 校验（不触碰状态）。
 * - 双向绑定通过 v-model 协议回写父组件（update:xxx emits）。
 */
import { computed } from 'vue'
import { t, SUPPORTED_LANGUAGES } from '@/i18n'
import { CustomCheckbox, CustomSelect, type SelectOption } from '../../common'

defineProps<{
  // 代理设置
  proxyEnabled: boolean
  proxyUrl: string
  isSaving: boolean
  saveMessage: string
  saveMessageType: 'success' | 'error'
  // 语言设置
  language: string
  // 更新设置
  checkUpdatesEnabled: boolean
  updateInstallerKind: 'auto' | 'portable' | 'installed'
  isUpdateChecking: boolean
  isUpdating: boolean
  updateCheckResult: { type: 'success' | 'error' | 'info'; text: string } | null
  // 存储路径设置
  storageSettings: {
    currentPath: string
    defaultPath: string
    customPath: string
    isCustom: boolean
  }
  customPath: string
  isValidatingPath: boolean
  pathValidationResult: { valid: boolean; message?: string } | null
  isMigrating: boolean
  storageMessage: string
  storageMessageType: 'success' | 'error' | 'info'
  needsReload: boolean
  // 导入/导出
  isExporting: boolean
  isImporting: boolean
  importExportMessage: string
  importExportMessageType: 'success' | 'error'
  // 工作区行为（桌面版独有）
  workspaceBehavior: string
  workspaceBehaviorOptions: SelectOption[]
  // 应用信息
  appInfo: { name: string; displayName: string; version: string }
}>()

const emit = defineEmits<{
  (e: 'update:proxyEnabled', value: boolean): void
  (e: 'update:proxyUrl', value: string): void
  (e: 'saveProxy'): void
  (e: 'update:language', value: string): void
  (e: 'update:checkUpdatesEnabled', value: boolean): void
  (e: 'update:updateInstallerKind', value: 'auto' | 'portable' | 'installed'): void
  (e: 'checkUpdateNow'): void
  (e: 'updateNow'): void
  (e: 'update:customPath', value: string): void
  (e: 'pickStoragePath'): void
  (e: 'applyStoragePath'): void
  (e: 'resetStoragePath'): void
  (e: 'openInExplorer'): void
  (e: 'reloadWindow'): void
  (e: 'exportSettings'): void
  (e: 'importSettings'): void
  (e: 'update:workspaceBehavior', value: string): void
}>()

// 语言选项（使用 computed 以便语言切换时自动更新）
const languageOptions = computed<SelectOption[]>(() => SUPPORTED_LANGUAGES.map(lang => ({
  value: lang.value,
  label: lang.labelKey ? t(lang.labelKey) : lang.label,
  description: lang.value === 'auto' ? t('components.settings.settingsPanel.language.autoDescription') : lang.nativeLabel
})))

// 验证代理 URL 格式
function isValidProxyUrl(url: string): boolean {
  if (!url.trim()) return true // 空值允许
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function onProxyUrlInput(event: Event) {
  emit('update:proxyUrl', (event.target as HTMLInputElement).value)
}

function onCustomPathInput(event: Event) {
  emit('update:customPath', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="settings-form">
    <!-- 代理设置 -->
    <div class="form-group" data-search-anchor="proxy">
      <label class="group-label">
        <i class="codicon codicon-globe"></i>
        {{ t('components.settings.settingsPanel.proxy.title') }}
      </label>
      <p class="field-description">{{ t('components.settings.settingsPanel.proxy.description') }}</p>

      <div class="proxy-settings">
        <div class="proxy-enable">
          <CustomCheckbox
            :model-value="proxyEnabled"
            :label="t('components.settings.settingsPanel.proxy.enable')"
            @update:model-value="emit('update:proxyEnabled', $event)"
          />
        </div>

        <div class="proxy-url-group" :class="{ disabled: !proxyEnabled }">
          <label>{{ t('components.settings.settingsPanel.proxy.url') }}</label>
          <input
            type="text"
            :value="proxyUrl"
            :placeholder="t('components.settings.settingsPanel.proxy.urlPlaceholder')"
            :disabled="!proxyEnabled"
            class="proxy-url-input"
            :class="{ invalid: proxyUrl && !isValidProxyUrl(proxyUrl) }"
            @input="onProxyUrlInput"
          />
          <p v-if="proxyUrl && !isValidProxyUrl(proxyUrl)" class="error-hint">
            {{ t('components.settings.settingsPanel.proxy.urlError') }}
          </p>
        </div>

        <div class="proxy-actions">
          <button
            class="save-btn"
            @click="emit('saveProxy')"
            :disabled="isSaving || (!!proxyUrl && !isValidProxyUrl(proxyUrl))"
          >
            <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
            <span v-else>{{ t('components.settings.settingsPanel.proxy.save') }}</span>
          </button>
          <span v-if="saveMessage" class="save-message" :class="{ success: saveMessageType === 'success' }">
            {{ saveMessage }}
          </span>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <!-- 语言设置 -->
    <div class="form-group" data-search-anchor="language">
      <label class="group-label">
        <i class="codicon codicon-globe"></i>
        {{ t('components.settings.settingsPanel.language.title') }}
      </label>
      <p class="field-description">{{ t('components.settings.settingsPanel.language.description') }}</p>

      <div class="language-settings">
        <CustomSelect
          :model-value="language"
          :options="languageOptions"
          :placeholder="t('components.settings.settingsPanel.language.placeholder')"
          @update:model-value="emit('update:language', $event)"
        />
      </div>
    </div>

    <div class="divider"></div>

    <!-- 更新设置 -->
    <div class="form-group" data-search-anchor="update">
      <label class="group-label">
        <i class="codicon codicon-cloud-download"></i>
        {{ t('components.settings.settingsPanel.update.title') }}
      </label>
      <p class="field-description">{{ t('components.settings.settingsPanel.update.description') }}</p>

      <div class="update-settings">
        <CustomCheckbox
          :model-value="checkUpdatesEnabled"
          :label="t('components.settings.settingsPanel.update.enableLabel')"
          @update:model-value="emit('update:checkUpdatesEnabled', $event)"
        />

        <!-- 下载版本选择：auto 跟随运行形态 / 显式指定便携版或安装版 -->
        <div class="update-kind-row">
          <label class="update-kind-label">
            {{ t('components.settings.settingsPanel.update.kindLabel') }}
          </label>
          <select
            class="update-kind-select"
            :value="updateInstallerKind"
            @change="emit('update:updateInstallerKind', ($event.target as HTMLSelectElement).value as 'auto' | 'portable' | 'installed')"
          >
            <option value="auto">{{ t('components.settings.settingsPanel.update.kindAuto') }}</option>
            <option value="portable">{{ t('components.settings.settingsPanel.update.kindPortable') }}</option>
            <option value="installed">{{ t('components.settings.settingsPanel.update.kindInstalled') }}</option>
          </select>
          <p class="field-hint">{{ t('components.settings.settingsPanel.update.kindHint') }}</p>
        </div>

        <div class="update-check-row">
          <button class="save-btn" :disabled="isUpdateChecking || isUpdating" @click="emit('checkUpdateNow')">
            <i v-if="isUpdateChecking" class="codicon codicon-loading codicon-modifier-spin"></i>
            <span v-else>{{ t('components.settings.settingsPanel.update.checkNow') }}</span>
          </button>
          <button class="update-now-btn" :disabled="isUpdateChecking || isUpdating" @click="emit('updateNow')">
            <i v-if="isUpdating" class="codicon codicon-loading codicon-modifier-spin"></i>
            <span v-else>{{ t('components.settings.settingsPanel.update.updateNow') }}</span>
          </button>
          <span v-if="updateCheckResult" class="save-message" :class="updateCheckResult.type">
            {{ updateCheckResult.text }}
          </span>
        </div>
      </div>
    </div>

    <!-- 存储路径设置 -->
    <div class="form-group" data-search-anchor="storage">
      <label class="group-label">
        <i class="codicon codicon-folder"></i>
        {{ t('components.settings.storageSettings.title') }}
      </label>
      <p class="field-description">{{ t('components.settings.storageSettings.description') }}</p>

      <div class="storage-settings">
        <!-- 存储路径输入（合并当前路径与自定义路径） -->
        <div class="storage-custom-path">
          <label>{{ t('components.settings.storageSettings.customPath') }}</label>
          <div class="path-input-group">
            <input
              type="text"
              :value="customPath"
              :placeholder="storageSettings.currentPath || t('components.settings.storageSettings.customPathPlaceholder')"
              class="path-input"
              :class="{
                valid: pathValidationResult?.valid === true,
                invalid: pathValidationResult?.valid === false
              }"
              @input="onCustomPathInput"
            />
            <button
              class="path-picker-btn"
              :title="t('components.settings.storageSettings.browse')"
              :disabled="isMigrating"
              @click="emit('pickStoragePath')"
            >
              <i class="codicon codicon-folder-opened"></i>
            </button>
          </div>
          <p class="field-hint">{{ t('components.settings.storageSettings.customPathHint') }}</p>
          <p class="current-path-note">
            {{ t('components.settings.storageSettings.currentPath') }}：
            <span class="path-note-value" :title="storageSettings.currentPath">{{ storageSettings.currentPath || '-' }}</span>
            <span v-if="storageSettings.isCustom" class="path-badge custom">{{ t('common.custom') }}</span>
            <span v-else class="path-badge default">{{ t('common.default') }}</span>
          </p>
          <p v-if="pathValidationResult?.valid === false && pathValidationResult?.message" class="error-hint">
            {{ pathValidationResult.message }}
          </p>
        </div>

        <!-- 操作按钮 -->
        <div class="storage-actions">
          <button
            class="action-btn primary"
            @click="emit('applyStoragePath')"
            :disabled="isMigrating || isValidatingPath || (customPath.trim() !== '' && !pathValidationResult?.valid)"
          >
            <i class="codicon codicon-check"></i>
            {{ t('components.settings.storageSettings.apply') }}
          </button>
          <button
            class="action-btn"
            @click="emit('resetStoragePath')"
            :disabled="isMigrating"
            :title="!storageSettings.isCustom ? t('components.settings.storageSettings.notifications.alreadyDefaultTitle') : ''"
          >
            <i class="codicon codicon-discard"></i>
            {{ t('components.settings.storageSettings.reset') }}
          </button>
          <button
            class="action-btn"
            @click="emit('openInExplorer')"
            :disabled="isMigrating || !storageSettings.currentPath"
            :title="t('components.settings.storageSettings.openInExplorerTitle')"
          >
            <i class="codicon codicon-link-external"></i>
            {{ t('components.settings.storageSettings.openInExplorer') }}
          </button>
        </div>

        <!-- 状态消息 -->
        <div v-if="storageMessage" class="storage-message" :class="storageMessageType">
          <i :class="['codicon', storageMessageType === 'success' ? 'codicon-check' : storageMessageType === 'info' ? 'codicon-info' : 'codicon-error']"></i>
          {{ storageMessage }}
          <!-- 重新加载按钮 -->
          <button
            v-if="needsReload"
            class="reload-btn"
            @click="emit('reloadWindow')"
          >
            <i class="codicon codicon-refresh"></i>
            {{ t('components.settings.storageSettings.reloadWindow') }}
          </button>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <!-- 设置导入/导出 -->
    <div class="form-group" data-search-anchor="importExport">
      <label class="group-label">
        <i class="codicon codicon-export"></i>
        {{ t('components.settings.settingsPanel.exportImport.title') }}
      </label>
      <p class="field-description">{{ t('components.settings.settingsPanel.exportImport.description') }}</p>

      <div class="import-export-actions">
        <button
          class="action-btn primary"
          @click="emit('exportSettings')"
          :disabled="isExporting"
        >
          <i v-if="isExporting" class="codicon codicon-loading codicon-modifier-spin"></i>
          <i v-else class="codicon codicon-export"></i>
          {{ isExporting ? t('components.settings.settingsPanel.exportImport.exporting') : t('components.settings.settingsPanel.exportImport.exportBtn') }}
        </button>
        <button
          class="action-btn"
          @click="emit('importSettings')"
          :disabled="isImporting"
        >
          <i v-if="isImporting" class="codicon codicon-loading codicon-modifier-spin"></i>
          <i v-else class="codicon codicon-import"></i>
          {{ isImporting ? t('components.settings.settingsPanel.exportImport.importing') : t('components.settings.settingsPanel.exportImport.importBtn') }}
        </button>
      </div>

      <!-- 状态消息 -->
      <div v-if="importExportMessage" class="storage-message" :class="importExportMessageType">
        <i :class="['codicon', importExportMessageType === 'success' ? 'codicon-check' : 'codicon-error']"></i>
        {{ importExportMessage }}
      </div>
    </div>

    <div class="divider"></div>

    <!-- 工作区行为（桌面版独有） -->
    <div class="form-group" data-search-anchor="workspace-behavior">
      <label class="group-label">
        <i class="codicon codicon-folder-opened"></i>
        {{ t('components.settings.settingsPanel.workspaceBehavior.title') }}
      </label>
      <p class="field-description">{{ t('components.settings.settingsPanel.workspaceBehavior.description') }}</p>

      <div class="workspace-behavior-settings">
        <CustomSelect
          :model-value="workspaceBehavior"
          :options="workspaceBehaviorOptions"
          @update:model-value="emit('update:workspaceBehavior', $event)"
        />
      </div>
    </div>

    <div class="divider"></div>

    <!-- 应用信息 -->
    <div class="form-group" data-search-anchor="appInfo">
      <label class="group-label">
        <i class="codicon codicon-info"></i>
        {{ t('components.settings.settingsPanel.appInfo.title') }}
      </label>
      <div class="info-text">
        <p>{{ t('components.settings.settingsPanel.appInfo.name', { appName: appInfo.displayName || appInfo.name }) }}</p>
        <p class="version">{{ t('components.settings.settingsPanel.appInfo.version', { version: appInfo.version }) }}</p>
        <div class="github-links">
          <a href="https://github.com/Komeiji-Shiki/Gray-Code" target="_blank" class="github-link">
            <svg class="github-icon" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            {{ t('components.settings.settingsPanel.appInfo.repository') }}
          </a>
          <a href="https://github.com/Komeiji-Shiki" target="_blank" class="github-link">
            <svg class="github-icon" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            {{ t('components.settings.settingsPanel.appInfo.developer') }}
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 表单样式 */
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 12px;
  font-weight: 500;
}

.info-text {
  padding: 8px 12px;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}

.info-text p {
  margin: 0;
  font-size: 13px;
}

.info-text .version {
  margin-top: 4px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.github-links {
  display: flex;
  gap: 16px;
  margin-top: 10px;
}

.github-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background-color 0.15s;
}

.github-link:hover {
  background: var(--vscode-list-hoverBackground);
  text-decoration: underline;
}

.github-icon {
  width: 16px;
  height: 16px;
}

/* 代理设置样式 */
.group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.group-label .codicon {
  font-size: 14px;
  color: var(--vscode-foreground);
}

.field-description {
  margin: 4px 0 12px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.proxy-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.proxy-enable {
  display: flex;
  align-items: center;
}

.proxy-url-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: opacity 0.2s;
}

.proxy-url-group.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.proxy-url-group label {
  font-size: 12px;
  color: var(--vscode-foreground);
}

.proxy-url-input {
  width: 100%;
  padding: 6px 10px;
  font-size: 13px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
}

.proxy-url-input:focus {
  border-color: var(--vscode-focusBorder);
}

.proxy-url-input:disabled {
  background: var(--vscode-input-background);
  opacity: 0.6;
}

.proxy-url-input.invalid {
  border-color: var(--vscode-inputValidation-errorBorder);
}

.error-hint {
  margin: 0;
  font-size: 11px;
  color: var(--vscode-errorForeground);
}

.proxy-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.save-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 60px;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.save-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.save-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.save-message {
  font-size: 12px;
  color: var(--vscode-errorForeground);
}

.save-message.success {
  color: var(--vscode-terminal-ansiGreen);
}

.save-message.info {
  color: var(--vscode-descriptionForeground);
}

/* 更新设置 */
.update-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.update-check-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 下载版本选择（auto/portable/installed） */
.update-kind-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.update-kind-label {
  font-size: 12px;
  color: var(--vscode-foreground);
  font-weight: 500;
}

.update-kind-select {
  max-width: 280px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 13px;
  font-family: inherit;
}

.update-now-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.update-now-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.update-now-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.divider {
  height: 1px;
  background: var(--vscode-panel-border);
  margin: 8px 0;
}

/* 语言设置 */
.language-settings {
  max-width: 240px;
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 存储路径设置样式 */
.storage-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.path-badge {
  flex-shrink: 0;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 500;
  border-radius: 3px;
  text-transform: uppercase;
}

.path-badge.default {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.path-badge.custom {
  background: var(--vscode-statusBarItem-prominentBackground);
  color: var(--vscode-statusBarItem-prominentForeground);
}

.storage-custom-path {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.storage-custom-path label {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.path-input-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}

.path-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  font-size: 13px;
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
}

.path-picker-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.path-picker-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.path-picker-btn .codicon {
  font-size: 16px;
}

.current-path-note {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.path-note-value {
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vscode-editor-font-family, monospace);
}

.path-input:focus {
  border-color: var(--vscode-focusBorder);
}

.path-input.valid {
  border-color: var(--vscode-terminal-ansiGreen);
}

.path-input.invalid {
  border-color: var(--vscode-inputValidation-errorBorder);
}

.field-hint {
  margin: 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.storage-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.action-btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.storage-message {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
}

.storage-message.success {
  background: rgba(0, 200, 0, 0.1);
  color: var(--vscode-terminal-ansiGreen);
}

.storage-message.error {
  background: rgba(200, 0, 0, 0.1);
  color: var(--vscode-errorForeground);
}

.reload-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 12px;
  padding: 4px 10px;
  font-size: 12px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.reload-btn:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>
