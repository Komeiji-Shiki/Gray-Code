<script setup lang="ts">
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, reactive, onMounted, onUnmounted, watch, toRaw } from 'vue'
import { CustomCheckbox } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { useDeferredNumberInput } from '@/composables/useDeferredNumberInput'

const { t } = useI18n()

// 诊断严重程度类型
type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint'

// 诊断配置接口
interface DiagnosticsConfig {
  enabled: boolean
  includeSeverities: DiagnosticSeverity[]
  workspaceOnly: boolean
  openFilesOnly: boolean
  maxDiagnosticsPerFile: number
  maxFiles: number
}

// 上下文感知配置接口
interface ContextAwarenessConfig {
  includeWorkspaceFiles: boolean
  maxFileDepth: number
  includeOpenTabs: boolean
  maxOpenTabs: number
  includeActiveEditor: boolean
  diagnostics?: DiagnosticsConfig
  ignorePatterns: string[]
}

// 默认诊断配置
const DEFAULT_DIAGNOSTICS_CONFIG: DiagnosticsConfig = {
  enabled: false,
  includeSeverities: ['error', 'warning'],
  workspaceOnly: true,
  openFilesOnly: false,
  maxDiagnosticsPerFile: 10,
  maxFiles: 20
}

// 配置状态
const config = reactive<ContextAwarenessConfig>({
  includeWorkspaceFiles: true,
  maxFileDepth: 2,
  includeOpenTabs: true,
  maxOpenTabs: 20,
  includeActiveEditor: true,
  diagnostics: { ...DEFAULT_DIAGNOSTICS_CONFIG },
  ignorePatterns: []
})

// 可选的诊断严重程度
const availableSeverities: { value: DiagnosticSeverity; label: string }[] = [
  { value: 'error', label: 'Error' },
  { value: 'warning', label: 'Warning' },
  { value: 'information', label: 'Information' },
  { value: 'hint', label: 'Hint' }
]

// 是否正在加载
const isLoading = ref(true)
// 是否正在保存
const isSaving = ref(false)
// 保存状态消息
const saveMessage = ref('')
// 保存成功消息清除定时器（卸载时清理，避免卸载后仍修改 saveMessage）
let saveMessageTimer: ReturnType<typeof setTimeout> | null = null

// 忽略模式输入框
const newIgnorePattern = ref('')

// 草稿模式：清空后不立即回填默认值；离开设置页时自动回填已保存值
const {
  draft: maxFileDepthDraft,
  handleInput: handleMaxFileDepthInput,
  syncFromStored: syncMaxFileDepthFromStored
} = useDeferredNumberInput(() => config.maxFileDepth)
const {
  draft: maxOpenTabsDraft,
  handleInput: handleMaxOpenTabsInput,
  syncFromStored: syncMaxOpenTabsFromStored
} = useDeferredNumberInput(() => config.maxOpenTabs)
const {
  draft: maxDiagnosticsPerFileDraft,
  handleInput: handleMaxDiagnosticsPerFileInput,
  syncFromStored: syncMaxDiagnosticsPerFileFromStored
} = useDeferredNumberInput(() => config.diagnostics?.maxDiagnosticsPerFile ?? 10)
const {
  draft: maxFilesDraft,
  handleInput: handleMaxFilesInput,
  syncFromStored: syncMaxFilesFromStored
} = useDeferredNumberInput(() => config.diagnostics?.maxFiles ?? 20)

// 预览：打开的标签页
const openTabs = ref<string[]>([])
// 预览：当前活动编辑器
const activeEditor = ref<string | null>(null)

// 自动刷新定时器
let refreshIntervalId: ReturnType<typeof setInterval> | null = null
// 刷新间隔（毫秒）
const REFRESH_INTERVAL = 2000

// 加载配置
async function loadConfig() {
  isLoading.value = true
  try {
    const response = await sendToExtension<ContextAwarenessConfig>(MESSAGE_NAMES.getContextAwarenessConfig, {})
    if (response) {
      // 确保 diagnostics 配置存在
      if (!response.diagnostics) {
        response.diagnostics = { ...DEFAULT_DIAGNOSTICS_CONFIG }
      }
      Object.assign(config, response)
      syncMaxFileDepthFromStored()
      syncMaxOpenTabsFromStored()
      syncMaxDiagnosticsPerFileFromStored()
      syncMaxFilesFromStored()
    }
    
    // 加载预览数据
    await loadPreview()
  } catch (error) {
    console.error('Failed to load context awareness config:', error)
  } finally {
    isLoading.value = false
  }
}

// 加载预览数据
async function loadPreview() {
  try {
    // 获取打开的标签页
    const tabsResponse = await sendToExtension<{ tabs: string[] }>(MESSAGE_NAMES.getOpenTabs, {})
    if (tabsResponse?.tabs) {
      openTabs.value = tabsResponse.tabs
    }
    
    // 获取当前活动编辑器
    const editorResponse = await sendToExtension<{ path: string | null }>(MESSAGE_NAMES.getActiveEditor, {})
    if (editorResponse) {
      activeEditor.value = editorResponse.path
    }
  } catch (error) {
    console.error('Failed to load preview data:', error)
  }
}

// 保存队列：串行化整包保存，避免开关快速切换时后写覆盖先写（竞态丢更新）
let saveChain: Promise<void> = Promise.resolve()

function saveConfig(): Promise<void> {
  saveChain = saveChain.then(() => doSaveConfig())
  return saveChain
}

async function doSaveConfig() {
  isSaving.value = true
  saveMessage.value = ''
  
  try {
    // 使用 toRaw 将 reactive 对象转换为普通对象，避免 postMessage 克隆错误
    const plainConfig = { ...toRaw(config) }
    await sendToExtension(MESSAGE_NAMES.updateContextAwarenessConfig, { config: plainConfig })
    saveMessage.value = t('components.settings.contextSettings.saveSuccess')
    if (saveMessageTimer) {
      clearTimeout(saveMessageTimer)
    }
    saveMessageTimer = setTimeout(() => {
      saveMessageTimer = null
      saveMessage.value = ''
    }, 2000)
  } catch (error) {
    console.error('Failed to save context awareness config:', error)
    saveMessage.value = t('components.settings.contextSettings.saveFailed')
  } finally {
    isSaving.value = false
  }
}

// 更新配置字段并保存
async function updateConfig<K extends keyof ContextAwarenessConfig>(field: K, value: ContextAwarenessConfig[K]) {
  config[field] = value
  await saveConfig()
}

// 添加忽略模式
async function addIgnorePattern() {
  const pattern = newIgnorePattern.value.trim()
  if (pattern && !config.ignorePatterns.includes(pattern)) {
    config.ignorePatterns.push(pattern)
    newIgnorePattern.value = ''
    await saveConfig()
  }
}

// 移除忽略模式
async function removeIgnorePattern(index: number) {
  config.ignorePatterns.splice(index, 1)
  await saveConfig()
}

// 处理回车添加
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    addIgnorePattern()
  }
}

// 更新诊断配置
async function updateDiagnosticsConfig<K extends keyof DiagnosticsConfig>(field: K, value: DiagnosticsConfig[K]) {
  if (!config.diagnostics) {
    config.diagnostics = { ...DEFAULT_DIAGNOSTICS_CONFIG }
  }
  config.diagnostics[field] = value
  await saveConfig()
}

// 切换诊断严重程度
async function toggleSeverity(severity: DiagnosticSeverity) {
  if (!config.diagnostics) {
    config.diagnostics = { ...DEFAULT_DIAGNOSTICS_CONFIG }
  }
  
  const index = config.diagnostics.includeSeverities.indexOf(severity)
  if (index === -1) {
    config.diagnostics.includeSeverities.push(severity)
  } else {
    config.diagnostics.includeSeverities.splice(index, 1)
  }
  await saveConfig()
}

// 检查严重程度是否选中
function isSeveritySelected(severity: DiagnosticSeverity): boolean {
  return config.diagnostics?.includeSeverities?.includes(severity) ?? false
}

// 初始化
onMounted(() => {
  loadConfig()
  
  // 启动自动刷新预览
  startAutoRefresh()
})

// 组件卸载时清理
onUnmounted(() => {
  stopAutoRefresh()
  // 清理保存成功消息清除定时器，避免卸载后仍修改 saveMessage
  if (saveMessageTimer) {
    clearTimeout(saveMessageTimer)
    saveMessageTimer = null
  }
})

// 启动自动刷新
function startAutoRefresh() {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId)
  }
  refreshIntervalId = setInterval(() => {
    // 两个预览开关都关闭时不轮询，避免无条件每 2 秒发请求
    if (!config.includeOpenTabs && !config.includeActiveEditor) return
    loadPreview()
  }, REFRESH_INTERVAL)
}

// 预览开关变化时：立即刷新一次预览并重启轮询（开关全关时停止轮询）
watch(() => [config.includeOpenTabs, config.includeActiveEditor], () => {
  startAutoRefresh()
  if (config.includeOpenTabs || config.includeActiveEditor) {
    loadPreview()
  }
})

// 停止自动刷新
function stopAutoRefresh() {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId)
    refreshIntervalId = null
  }
}

</script>

<template>
  <div class="context-settings">
    <div v-if="isLoading" class="loading">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.settings.contextSettings.loading') }}</span>
    </div>
    
    <div v-else class="settings-form">
      <!-- 文件树设置 -->
      <div class="form-group" data-search-anchor="file-tree">
        <label class="group-label">
          <i class="codicon codicon-list-tree"></i>
          {{ t('components.settings.contextSettings.workspaceFiles.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.contextSettings.workspaceFiles.description') }}</p>
        
        <div class="setting-block">
          <div class="setting-row">
            <CustomCheckbox
              :model-value="config.includeWorkspaceFiles"
              :label="t('components.settings.contextSettings.workspaceFiles.sendFileTree')"
              @update:model-value="(v: boolean) => updateConfig('includeWorkspaceFiles', v)"
            />
          </div>
          
          <div class="setting-row indented" :class="{ disabled: !config.includeWorkspaceFiles }">
            <label>{{ t('components.settings.contextSettings.workspaceFiles.maxDepth') }}</label>
            <div class="input-with-hint">
              <input
                type="number"
                :value="maxFileDepthDraft"
                min="-1"
                max="100"
                :disabled="!config.includeWorkspaceFiles"
                class="number-input"
                @input="(e: any) => handleMaxFileDepthInput(e.target.value, v => updateConfig('maxFileDepth', v))"
              />
              <span class="hint">{{ t('components.settings.contextSettings.workspaceFiles.unlimitedHint') }}</span>
            </div>
          </div>
        </div>
      </div>
      
      <div class="divider"></div>
      
      <!-- 打开的标签页设置 -->
      <div class="form-group" data-search-anchor="open-tabs">
        <label class="group-label">
          <i class="codicon codicon-files"></i>
          {{ t('components.settings.contextSettings.openTabs.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.contextSettings.openTabs.description') }}</p>
        
        <div class="setting-block">
          <div class="setting-row">
            <CustomCheckbox
              :model-value="config.includeOpenTabs"
              :label="t('components.settings.contextSettings.openTabs.sendOpenTabs')"
              @update:model-value="(v: boolean) => updateConfig('includeOpenTabs', v)"
            />
          </div>
          
          <div class="setting-row indented" :class="{ disabled: !config.includeOpenTabs }">
            <label>{{ t('components.settings.contextSettings.openTabs.maxCount') }}</label>
            <div class="input-with-hint">
              <input
                type="number"
                :value="maxOpenTabsDraft"
                min="-1"
                max="100"
                :disabled="!config.includeOpenTabs"
                class="number-input"
                @input="(e: any) => handleMaxOpenTabsInput(e.target.value, v => updateConfig('maxOpenTabs', v))"
              />
              <span class="hint">{{ t('components.settings.contextSettings.workspaceFiles.unlimitedHint') }}</span>
            </div>
          </div>
        </div>
      </div>
      
      <div class="divider"></div>
      
      <!-- 当前活动编辑器设置 -->
      <div class="form-group" data-search-anchor="active-editor">
        <label class="group-label">
          <i class="codicon codicon-file-code"></i>
          {{ t('components.settings.contextSettings.activeEditor.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.contextSettings.activeEditor.description') }}</p>
        
        <div class="setting-block">
          <div class="setting-row">
            <CustomCheckbox
              :model-value="config.includeActiveEditor"
              :label="t('components.settings.contextSettings.activeEditor.sendActiveEditor')"
              @update:model-value="(v: boolean) => updateConfig('includeActiveEditor', v)"
            />
          </div>
        </div>
      </div>
      
      <div class="divider"></div>
      
      <!-- 诊断信息设置 -->
      <div class="form-group" data-search-anchor="diagnostics">
        <label class="group-label">
          <i class="codicon codicon-warning"></i>
          {{ t('components.settings.contextSettings.diagnostics.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.contextSettings.diagnostics.description') }}</p>
        
        <div class="setting-block">
          <div class="setting-row">
            <CustomCheckbox
              :model-value="config.diagnostics?.enabled ?? false"
              :label="t('components.settings.contextSettings.diagnostics.enableDiagnostics')"
              @update:model-value="(v: boolean) => updateDiagnosticsConfig('enabled', v)"
            />
          </div>
          
          <!-- 严重程度选择 -->
          <div class="setting-row indented" :class="{ disabled: !config.diagnostics?.enabled }">
            <label>{{ t('components.settings.contextSettings.diagnostics.severityTypes') }}</label>
            <div class="severity-checkboxes">
              <label
                v-for="severity in availableSeverities"
                :key="severity.value"
                class="severity-checkbox"
                :class="{
                  checked: isSeveritySelected(severity.value),
                  disabled: !config.diagnostics?.enabled
                }"
              >
                <input
                  type="checkbox"
                  :checked="isSeveritySelected(severity.value)"
                  :disabled="!config.diagnostics?.enabled"
                  @change="toggleSeverity(severity.value)"
                />
                <span class="severity-label" :class="severity.value">
                  {{ t(`components.settings.contextSettings.diagnostics.severity.${severity.value}`) }}
                </span>
              </label>
            </div>
          </div>
          
          <!-- 范围选项 -->
          <div class="setting-row indented" :class="{ disabled: !config.diagnostics?.enabled }">
            <CustomCheckbox
              :model-value="config.diagnostics?.workspaceOnly ?? true"
              :label="t('components.settings.contextSettings.diagnostics.workspaceOnly')"
              :disabled="!config.diagnostics?.enabled"
              @update:model-value="(v: boolean) => updateDiagnosticsConfig('workspaceOnly', v)"
            />
          </div>
          
          <div class="setting-row indented" :class="{ disabled: !config.diagnostics?.enabled }">
            <CustomCheckbox
              :model-value="config.diagnostics?.openFilesOnly ?? false"
              :label="t('components.settings.contextSettings.diagnostics.openFilesOnly')"
              :disabled="!config.diagnostics?.enabled"
              @update:model-value="(v: boolean) => updateDiagnosticsConfig('openFilesOnly', v)"
            />
          </div>
          
          <!-- 数量限制 -->
          <div class="setting-row indented" :class="{ disabled: !config.diagnostics?.enabled }">
            <label>{{ t('components.settings.contextSettings.diagnostics.maxPerFile') }}</label>
            <div class="input-with-hint">
              <input
                type="number"
                :value="maxDiagnosticsPerFileDraft"
                min="-1"
                max="100"
                :disabled="!config.diagnostics?.enabled"
                class="number-input"
                @input="(e: any) => handleMaxDiagnosticsPerFileInput(e.target.value, v => updateDiagnosticsConfig('maxDiagnosticsPerFile', v))"
              />
              <span class="hint">{{ t('components.settings.contextSettings.workspaceFiles.unlimitedHint') }}</span>
            </div>
          </div>
          
          <div class="setting-row indented" :class="{ disabled: !config.diagnostics?.enabled }">
            <label>{{ t('components.settings.contextSettings.diagnostics.maxFiles') }}</label>
            <div class="input-with-hint">
              <input
                type="number"
                :value="maxFilesDraft"
                min="-1"
                max="100"
                :disabled="!config.diagnostics?.enabled"
                class="number-input"
                @input="(e: any) => handleMaxFilesInput(e.target.value, v => updateDiagnosticsConfig('maxFiles', v))"
              />
              <span class="hint">{{ t('components.settings.contextSettings.workspaceFiles.unlimitedHint') }}</span>
            </div>
          </div>
        </div>
      </div>
      
      <div class="divider"></div>
      
      <!-- 忽略模式设置 -->
      <div class="form-group" data-search-anchor="ignore-patterns">
        <label class="group-label">
          <i class="codicon codicon-exclude"></i>
          {{ t('components.settings.contextSettings.ignorePatterns.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.contextSettings.ignorePatterns.description') }}</p>
        
        <div class="setting-block">
          <div class="ignore-patterns">
            <!-- 现有模式列表 -->
            <div class="pattern-list" v-if="config.ignorePatterns.length > 0">
              <div
                v-for="(pattern, index) in config.ignorePatterns"
                :key="index"
                class="pattern-item"
              >
                <code>{{ pattern }}</code>
                <button class="remove-btn" @click="removeIgnorePattern(index)" :title="t('components.settings.contextSettings.ignorePatterns.removeTooltip')">
                  <i class="codicon codicon-close"></i>
                </button>
              </div>
            </div>
            
            <p v-else class="empty-hint">{{ t('components.settings.contextSettings.ignorePatterns.emptyHint') }}</p>
            
            <!-- 添加新模式 -->
            <div class="add-pattern">
              <input
                type="text"
                v-model="newIgnorePattern"
                :placeholder="t('components.settings.contextSettings.ignorePatterns.inputPlaceholder')"
                class="pattern-input"
                @keydown="handleKeydown"
              />
              <button class="add-btn" @click="addIgnorePattern" :disabled="!newIgnorePattern.trim()">
                <i class="codicon codicon-add"></i>
                {{ t('components.settings.contextSettings.ignorePatterns.addButton') }}
              </button>
            </div>
            
            <!-- 通配符说明 -->
            <div class="pattern-help">
              <p><strong>{{ t('components.settings.contextSettings.ignorePatterns.helpTitle') }}</strong></p>
              <ul>
                <li><code>*</code> - {{ t('components.settings.contextSettings.ignorePatterns.helpItems.wildcard') }}</li>
                <li><code>**</code> - {{ t('components.settings.contextSettings.ignorePatterns.helpItems.recursive') }}</li>
                <li>{{ t('components.settings.contextSettings.ignorePatterns.helpItems.examples') }}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      
      <div class="divider"></div>
      
      <!-- 预览区域 -->
      <div class="form-group" data-search-anchor="context-preview">
        <div class="preview-header">
          <label class="group-label">
            <i class="codicon codicon-eye"></i>
            {{ t('components.settings.contextSettings.preview.title') }}
            <span class="auto-refresh-badge">
              <i class="codicon codicon-sync codicon-modifier-spin"></i>
              {{ t('components.settings.contextSettings.preview.autoRefreshBadge') }}
            </span>
          </label>
        </div>
        <p class="field-description">{{ t('components.settings.contextSettings.preview.description') }}</p>
        
        <div class="preview-block">
          <!-- 活动编辑器预览 -->
          <div class="preview-section" v-if="config.includeActiveEditor">
            <div class="preview-label">{{ t('components.settings.contextSettings.preview.activeEditorLabel') }}</div>
            <div class="preview-content">
              <code v-if="activeEditor">{{ activeEditor }}</code>
              <span v-else class="empty">{{ t('components.settings.contextSettings.preview.noValue') }}</span>
            </div>
          </div>
          
          <!-- 打开标签页预览 -->
          <div class="preview-section" v-if="config.includeOpenTabs">
            <div class="preview-label">{{ t('components.settings.contextSettings.preview.openTabsLabel', { count: openTabs.length }) }}</div>
            <div class="preview-content">
              <div v-if="openTabs.length > 0" class="tabs-list">
                <code v-for="(tab, index) in openTabs.slice(0, config.maxOpenTabs === -1 ? undefined : config.maxOpenTabs)" :key="index">
                  {{ tab }}
                </code>
                <span v-if="config.maxOpenTabs !== -1 && openTabs.length > config.maxOpenTabs" class="truncated">
                  {{ t('components.settings.contextSettings.preview.moreItems', { count: openTabs.length - config.maxOpenTabs }) }}
                </span>
              </div>
              <span v-else class="empty">{{ t('components.settings.contextSettings.preview.noValue') }}</span>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 保存状态 -->
      <div class="save-status" v-if="isSaving || saveMessage">
        <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
        <span v-if="saveMessage" :class="{ success: saveMessage === t('components.settings.contextSettings.saveSuccess') }">{{ saveMessage }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.context-settings {
  padding: 0;
}

.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  color: var(--vscode-descriptionForeground);
}

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
  margin: 4px 0 8px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.setting-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.setting-row.indented {
  margin-left: 24px;
}

.setting-row.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.setting-row label {
  font-size: 12px;
  min-width: 60px;
}

.input-with-hint {
  display: flex;
  align-items: center;
  gap: 8px;
}

.number-input {
  width: 80px;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  /* 隐藏数字输入框的上下箭头 */
  appearance: textfield;
  -moz-appearance: textfield;
}

/* Chrome, Safari, Edge, Opera - 隐藏 spinner 按钮 */
.number-input::-webkit-outer-spin-button,
.number-input::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

.number-input:focus {
  border-color: var(--vscode-focusBorder);
}

.hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.divider {
  height: 1px;
  background: var(--vscode-panel-border);
  margin: 4px 0;
}

/* 忽略模式样式 */
.ignore-patterns {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pattern-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pattern-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 4px;
  font-size: 12px;
}

.pattern-item code {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
}

.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  border-radius: 2px;
  opacity: 0.7;
}

.remove-btn:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

.empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

.add-pattern {
  display: flex;
  gap: 8px;
}

.pattern-input {
  flex: 1;
  padding: 6px 10px;
  font-size: 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
}

.pattern-input:focus {
  border-color: var(--vscode-focusBorder);
}

.add-btn {
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
}

.add-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pattern-help {
  margin-top: 4px;
  padding: 8px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textBlockQuote-border);
  border-radius: 0 4px 4px 0;
}

.pattern-help p {
  margin: 0 0 4px 0;
  font-size: 11px;
  color: var(--vscode-foreground);
}

.pattern-help ul {
  margin: 0;
  padding-left: 16px;
}

.pattern-help li {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin: 2px 0;
}

.pattern-help code {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  padding: 0 3px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 2px;
}

/* 预览区域 */
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.auto-refresh-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: normal;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
}

.auto-refresh-badge .codicon {
  font-size: 10px;
}

.preview-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.preview-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preview-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.preview-content {
  font-size: 12px;
}

.preview-content code {
  display: inline-block;
  padding: 2px 6px;
  margin: 2px;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
}

.tabs-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.truncated {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

.empty {
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/* 保存状态 */
.save-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.save-status .success {
  color: var(--vscode-terminal-ansiGreen);
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 诊断严重程度样式 */
.severity-checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.severity-checkbox {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  transition: all 0.15s;
}

.severity-checkbox:hover:not(.disabled) {
  border-color: var(--vscode-focusBorder);
}

.severity-checkbox.checked {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
}

.severity-checkbox.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.severity-checkbox input[type="checkbox"] {
  display: none;
}

.severity-label {
  font-size: 11px;
  font-weight: 500;
}

.severity-label.error {
  color: var(--vscode-errorForeground);
}

.severity-label.warning {
  color: var(--vscode-editorWarning-foreground);
}

.severity-label.information {
  color: var(--vscode-editorInfo-foreground);
}

.severity-label.hint {
  color: var(--vscode-editorHint-foreground, var(--vscode-descriptionForeground));
}
</style>