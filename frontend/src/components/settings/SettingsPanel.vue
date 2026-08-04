<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useSettingsStore, type SettingsTab } from '@/stores/settingsStore'
import ChannelSettings from './ChannelSettings.vue'
import ToolsSettings from './ToolsSettings.vue'
import AutoExecSettings from './AutoExecSettings.vue'
import McpSettings from './McpSettings.vue'
import CheckpointSettings from './CheckpointSettings.vue'
import SummarizeSettings from './SummarizeSettings.vue'
import GenerateImageSettings from './GenerateImageSettings.vue'
import DependencySettings from './DependencySettings.vue'
import ContextSettings from './ContextSettings.vue'
import PromptSettings from './PromptSettings.vue'
import TokenCountSettings from './TokenCountSettings.vue'
import SubAgentsSettings from './SubAgentsSettings.vue'
import MemorySettings from './MemorySettings.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import SoundSettings from './SoundSettings.vue'
import { CustomScrollbar, CustomCheckbox, CustomSelect, Modal, type SelectOption } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n, SUPPORTED_LANGUAGES } from '@/i18n'

const settingsStore = useSettingsStore()
const { t, setLanguage } = useI18n()

interface TabItem {
  id: SettingsTab
  label: string
  icon: string
}

// 语言选项（使用 computed 以便语言切换时自动更新）
const languageOptions = computed<SelectOption[]>(() => SUPPORTED_LANGUAGES.map(lang => ({
  value: lang.value,
  label: lang.label,
  description: lang.value === 'auto' ? t('components.settings.settingsPanel.language.autoDescription') : lang.nativeLabel
})))

// 侧边栏折叠状态（展开时显示图标+文字，折叠时仅图标）
const sidebarCollapsed = ref(false)

// 页签列表（使用 computed 以便语言切换时自动更新）
const tabs = computed<TabItem[]>(() => [
  { id: 'channel', label: t('components.settings.tabs.channel'), icon: 'codicon-plug' },
  { id: 'tools', label: t('components.settings.tabs.tools'), icon: 'codicon-tools' },
  { id: 'autoExec', label: t('components.settings.tabs.autoExec'), icon: 'codicon-shield' },
  { id: 'mcp', label: t('components.settings.tabs.mcp'), icon: 'codicon-server' },
  { id: 'subagents', label: t('components.settings.tabs.subagents'), icon: 'codicon-hubot' },
  { id: 'checkpoint', label: t('components.settings.tabs.checkpoint'), icon: 'codicon-history' },
  { id: 'summarize', label: t('components.settings.tabs.summarize'), icon: 'codicon-fold' },
  { id: 'imageGen', label: t('components.settings.tabs.imageGen'), icon: 'codicon-symbol-color' },
  { id: 'dependencies', label: t('components.settings.tabs.dependencies'), icon: 'codicon-package' },
  { id: 'context', label: t('components.settings.tabs.context'), icon: 'codicon-symbol-namespace' },
  { id: 'prompt', label: t('components.settings.tabs.prompt'), icon: 'codicon-note' },
  { id: 'tokenCount', label: t('components.settings.tabs.tokenCount'), icon: 'codicon-symbol-numeric' },
  { id: 'sound', label: t('components.settings.tabs.sound'), icon: 'codicon-bell' },
  { id: 'appearance', label: t('components.settings.tabs.appearance'), icon: 'codicon-paintcan' },
  { id: 'memory', label: t('components.settings.tabs.memory'), icon: 'codicon-database' },
  { id: 'general', label: t('components.settings.tabs.general'), icon: 'codicon-settings-gear' },
])

// 代理设置
const proxySettings = reactive({
  enabled: false,
  url: ''
})

// 语言设置
const languageSetting = ref<string>('auto')

// 是否正在保存
const isSaving = ref(false)
// 保存状态消息
const saveMessage = ref('')

// 存储路径设置
const storageSettings = reactive({
  currentPath: '',
  defaultPath: '',
  customPath: '',
  isCustom: false
})
const isValidatingPath = ref(false)
const pathValidationResult = ref<{ valid: boolean; message?: string } | null>(null)
const isMigrating = ref(false)
const showMigrateDialog = ref(false)
const storageMessage = ref('')
const storageMessageType = ref<'success' | 'error' | 'info'>('success')
const needsReload = ref(false) // 迁移完成后需要重新加载
let pathValidationRequestId = 0

// 加载设置
async function loadSettings() {
  try {
    const response = await sendToExtension<any>('getSettings', {})
    if (response?.settings?.proxy) {
      proxySettings.enabled = response.settings.proxy.enabled || false
      proxySettings.url = response.settings.proxy.url || ''
    }
    // 加载语言设置
    if (response?.settings?.ui?.language) {
      languageSetting.value = response.settings.ui.language
      setLanguage(response.settings.ui.language)
    }
    
    // 加载存储路径配置
    await loadStorageConfig()
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
}

// 应用信息（名称/版本号来自扩展 package.json）
const appInfo = ref<{ name: string; displayName: string; version: string }>({
  name: '',
  displayName: '',
  version: ''
})

async function loadAppInfo() {
  try {
    const response = await sendToExtension<any>('getAppInfo', {})
    if (response) {
      appInfo.value = {
        name: response.name || '',
        displayName: response.displayName || '',
        version: response.version || ''
      }
    }
  } catch (error) {
    console.error('Failed to load app info:', error)
  }
}

// 加载存储路径配置
async function loadStorageConfig() {
  try {
    const response = await sendToExtension<any>('storagePath.getConfig', {})
    if (response) {
      storageSettings.currentPath = response.effectivePath || ''
      storageSettings.defaultPath = response.defaultPath || ''
      storageSettings.customPath = response.config?.customDataPath || ''
      storageSettings.isCustom = !!response.config?.customDataPath
    }
  } catch (error) {
    console.error('Failed to load storage config:', error)
  }
}

// 打开系统文件夹选择器
async function pickStoragePath() {
  try {
    const response = await sendToExtension<any>('storagePath.selectFolder', {}, { timeoutMs: 120000 })
    if (response?.path) {
      storageSettings.customPath = response.path
    }
  } catch (error: any) {
    storageMessage.value = error?.message || t('components.settings.storageSettings.notifications.validationFailed').replace('{error}', 'SELECT_FOLDER')
    storageMessageType.value = 'error'
  }
}

// 在文件资源管理器中打开存储目录
async function openStoragePathInExplorer() {
  try {
    await sendToExtension('storagePath.openInExplorer', {
      path: storageSettings.currentPath
    })
  } catch (error: any) {
    storageMessage.value = error?.message || t('components.settings.storageSettings.notifications.openInExplorerFailed').replace('{error}', '')
    storageMessageType.value = 'error'
  }
}

// 验证路径
async function validateStoragePath(path: string) {
  const normalizedPath = path.trim()
  const requestId = ++pathValidationRequestId

  if (!normalizedPath) {
    pathValidationResult.value = null
    isValidatingPath.value = false
    return
  }

  isValidatingPath.value = true
  pathValidationResult.value = null

  try {
    const response = await sendToExtension<any>('storagePath.validate', { path: normalizedPath })
    if (requestId === pathValidationRequestId && storageSettings.customPath.trim() === normalizedPath) {
      pathValidationResult.value = {
        valid: response?.valid ?? false,
        message: response?.error
      }
    }
  } catch (error: any) {
    if (requestId === pathValidationRequestId && storageSettings.customPath.trim() === normalizedPath) {
      pathValidationResult.value = {
        valid: false,
        message: error?.message || 'Validation failed'
      }
    }
  } finally {
    if (requestId === pathValidationRequestId) {
      isValidatingPath.value = false
    }
  }
}

// 防抖验证
let validateDebounceTimer: ReturnType<typeof setTimeout> | null = null
function debouncedValidatePath(path: string) {
  if (validateDebounceTimer) {
    clearTimeout(validateDebounceTimer)
  }
  pathValidationRequestId++
  isValidatingPath.value = path.trim() !== ''
  pathValidationResult.value = null
  validateDebounceTimer = setTimeout(() => {
    validateStoragePath(path)
  }, 500)
}

// 监听自定义路径变化
watch(() => storageSettings.customPath, (newPath) => {
  debouncedValidatePath(newPath)
})

// 应用存储路径（迁移数据到新路径）
async function applyStoragePath() {
  if (isMigrating.value) return

  const newPath = storageSettings.customPath.trim()

  if (!newPath) {
    storageMessage.value = t('components.settings.storageSettings.notifications.applyEmptyHint')
    storageMessageType.value = 'info'
    return
  }

  if (!pathValidationResult.value?.valid) {
    // 路径验证未通过
    storageMessage.value = pathValidationResult.value?.message || t('components.settings.storageSettings.notifications.validationFailed').replace('{error}', '')
    storageMessageType.value = 'error'
    return
  }
  
  // 使用迁移接口来应用新路径（迁移到新路径）
  confirmMigrate()
}

// 重置为默认路径
async function resetStoragePath() {
  if (isMigrating.value) return

  if (!storageSettings.isCustom) {
    // 已经是默认路径，无需重置
    storageMessage.value = t('components.settings.storageSettings.notifications.alreadyDefault')
    storageMessageType.value = 'info'
    return
  }
  
  isMigrating.value = true
  needsReload.value = false
  
  try {
    const response = await sendToExtension<any>('storagePath.reset', {})
    
    if (response?.success) {
      storageSettings.customPath = ''
      pathValidationResult.value = null
      storageMessage.value = t('components.settings.storageSettings.notifications.migrationSuccess')
      storageMessageType.value = 'success'
      needsReload.value = true  // 重置也需要重新加载窗口才能生效
      await loadStorageConfig()
    } else {
      storageMessage.value = response?.error || 'Failed to reset storage path'
      storageMessageType.value = 'error'
    }
  } catch (error: any) {
    storageMessage.value = error?.message || 'Failed to reset storage path'
    storageMessageType.value = 'error'
  } finally {
    isMigrating.value = false
  }
  
  // 只有非成功消息才自动消失
  if (!needsReload.value) {
    setTimeout(() => {
      storageMessage.value = ''
    }, 5000)
  }
}

// 打开迁移确认对话框
function confirmMigrate() {
  showMigrateDialog.value = true
}

// 执行数据迁移
async function executeMigration() {
  if (isMigrating.value) return

  showMigrateDialog.value = false
  isMigrating.value = true
  needsReload.value = false
  
  try {
    const response = await sendToExtension<any>('storagePath.migrate', {
      path: storageSettings.customPath.trim()
    })
    
    if (response?.success) {
      storageMessage.value = t('components.settings.storageSettings.notifications.migrationSuccess')
      storageMessageType.value = 'success'
      needsReload.value = true  // 迁移成功，需要重新加载
      await loadStorageConfig()
    } else {
      const errorMsg = response?.error || 'Migration failed'
      storageMessage.value = t('components.settings.storageSettings.notifications.migrationFailed').replace('{error}', errorMsg)
      storageMessageType.value = 'error'
    }
  } catch (error: any) {
    storageMessage.value = t('components.settings.storageSettings.notifications.migrationFailed').replace('{error}', error?.message || 'Unknown error')
    storageMessageType.value = 'error'
  } finally {
    isMigrating.value = false
  }
  
  // 只有非成功消息才自动消失
  if (!needsReload.value) {
    setTimeout(() => {
      storageMessage.value = ''
    }, 5000)
  }
}

// 重新加载窗口
async function reloadWindow() {
  try {
    await sendToExtension('reloadWindow', {})
  } catch (error) {
    console.error('Failed to reload window:', error)
  }
}

// 保存代理设置
async function saveProxySettings() {
  isSaving.value = true
  saveMessage.value = ''
  
  try {
    await sendToExtension('updateProxySettings', {
      proxySettings: {
        enabled: proxySettings.enabled,
        url: proxySettings.url.trim() || undefined
      }
    })
    saveMessage.value = t('components.settings.settingsPanel.proxy.saveSuccess')
    setTimeout(() => {
      saveMessage.value = ''
    }, 2000)
  } catch (error) {
    console.error('Failed to save proxy settings:', error)
    saveMessage.value = t('components.settings.settingsPanel.proxy.saveFailed')
  } finally {
    isSaving.value = false
  }
}

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

// 更新语言设置
async function updateLanguage(lang: string) {
  languageSetting.value = lang
  setLanguage(lang as any)
  
  try {
    await sendToExtension('updateUISettings', {
      ui: { language: lang }
    })
  } catch (error) {
    console.error('Failed to save language setting:', error)
  }
}

// ========== 设置导入/导出 ==========
const isExporting = ref(false)
const isImporting = ref(false)
const importExportMessage = ref('')
const importExportMessageType = ref<'success' | 'error'>('success')

async function handleExportSettings() {
  isExporting.value = true
  importExportMessage.value = ''
  
  try {
    const response = await sendToExtension<any>('settings.export', {})
    if (response?.success) {
      importExportMessage.value = t('components.settings.settingsPanel.exportImport.exportSuccess', { path: response.filePath })
      importExportMessageType.value = 'success'
    } else if (response?.cancelled) {
      // 用户取消了，不显示消息
    } else {
      importExportMessage.value = t('components.settings.settingsPanel.exportImport.exportFailed')
      importExportMessageType.value = 'error'
    }
  } catch (error: any) {
    importExportMessage.value = error?.message || t('components.settings.settingsPanel.exportImport.exportFailed')
    importExportMessageType.value = 'error'
  } finally {
    isExporting.value = false
    if (importExportMessage.value) {
      setTimeout(() => { importExportMessage.value = '' }, 5000)
    }
  }
}

async function handleImportSettings() {
  isImporting.value = true
  importExportMessage.value = ''
  
  try {
    // 先让用户选择导入方式（弹出确认对话框由扩展端处理）
    // 这里直接调用导入，扩展端会弹出文件选择器和覆盖确认
    const response = await sendToExtension<any>('settings.import', { overwrite: false })
    if (response?.success) {
      const parts: string[] = []
      if (response.imported?.vscodeSettings) parts.push(t('components.settings.settingsPanel.exportImport.vscodeSettings'))
      if (response.imported?.channelConfigs > 0) parts.push(`${response.imported.channelConfigs} ${t('components.settings.settingsPanel.exportImport.channelConfigs')}`)
      if (response.imported?.mcpServers > 0) parts.push(`${response.imported.mcpServers} ${t('components.settings.settingsPanel.exportImport.mcpServers')}`)
      if (response.imported?.skills > 0) parts.push(`${response.imported.skills} ${t('components.settings.settingsPanel.exportImport.skills')}`)
      importExportMessage.value = parts.length > 0
        ? t('components.settings.settingsPanel.exportImport.importSuccess', { items: parts.join('、') })
        : t('components.settings.settingsPanel.exportImport.importNoItems')
      importExportMessageType.value = 'success'
    } else if (response?.cancelled) {
      // 用户取消了
    } else {
      importExportMessage.value = response?.errors?.join('；') || t('components.settings.settingsPanel.exportImport.importFailed')
      importExportMessageType.value = 'error'
    }
  } catch (error: any) {
    importExportMessage.value = error?.message || t('components.settings.settingsPanel.exportImport.importFailed')
    importExportMessageType.value = 'error'
  } finally {
    isImporting.value = false
    if (importExportMessage.value) {
      setTimeout(() => { importExportMessage.value = '' }, 8000)
    }
  }
}

// 初始化
onMounted(() => {
  loadSettings()
  loadAppInfo()
})
</script>

<template>
  <div class="settings-panel">
    <div class="settings-header">
      <h3>{{ t('components.settings.settingsPanel.title') }}</h3>
      <button class="settings-close-btn" :title="t('components.settings.settingsPanel.backToChat')" @click="settingsStore.showChat">
        <i class="codicon codicon-close"></i>
      </button>
    </div>
    
    <div class="settings-content">
      <!-- 左侧页签（可折叠：展开显示图标+文字，折叠仅图标+tooltip；汉堡按钮在顶部） -->
      <div class="settings-sidebar" :class="{ collapsed: sidebarCollapsed }">
        <button
          class="settings-tab settings-sidebar-toggle"
          :data-tooltip="sidebarCollapsed ? t('components.settings.settingsPanel.sidebarExpand') : t('components.settings.settingsPanel.sidebarCollapse')"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          <i class="codicon codicon-menu"></i>
        </button>
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :class="['settings-tab', { active: settingsStore.activeTab === tab.id }]"
          :data-tooltip="tab.label"
          @click="settingsStore.setActiveTab(tab.id)"
        >
          <i :class="['codicon', tab.icon]"></i>
          <span v-if="!sidebarCollapsed" class="settings-tab-label">{{ tab.label }}</span>
        </button>
      </div>
      
      <!-- 右侧内容 -->
      <CustomScrollbar class="settings-main-scrollbar">
        <div class="settings-main">
          <!-- 渠道设置 -->
          <div v-if="settingsStore.activeTab === 'channel'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.channel.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.channel.description') }}</p>
            
            <ChannelSettings />
          </div>
          
          <!-- 工具设置 -->
          <div v-if="settingsStore.activeTab === 'tools'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.tools.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.tools.description') }}</p>
            
            <ToolsSettings />
          </div>
          
          <!-- 自动执行设置 -->
          <div v-if="settingsStore.activeTab === 'autoExec'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.autoExec.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.autoExec.description') }}</p>
            
            <AutoExecSettings />
          </div>
          
          <!-- MCP 设置 -->
          <div v-if="settingsStore.activeTab === 'mcp'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.mcp.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.mcp.description') }}</p>
            
            <McpSettings />
          </div>
          
          <!-- 存档点设置 -->
          <div v-if="settingsStore.activeTab === 'checkpoint'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.checkpoint.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.checkpoint.description') }}</p>
            
            <CheckpointSettings />
          </div>
          
          <!-- 总结设置 -->
          <div v-if="settingsStore.activeTab === 'summarize'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.summarize.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.summarize.description') }}</p>
            
            <SummarizeSettings />
          </div>
          
          <!-- 图像生成设置 -->
          <div v-if="settingsStore.activeTab === 'imageGen'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.imageGen.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.imageGen.description') }}</p>
            
            <GenerateImageSettings />
          </div>
          
          <!-- 扩展依赖设置 -->
          <div v-if="settingsStore.activeTab === 'dependencies'" class="settings-section">
            <DependencySettings />
          </div>
          
          <!-- 上下文感知设置 -->
          <div v-if="settingsStore.activeTab === 'context'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.context.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.context.description') }}</p>
            
            <ContextSettings />
          </div>
          
          <!-- 提示词设置 -->
          <div v-if="settingsStore.activeTab === 'prompt'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.prompt.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.prompt.description') }}</p>
            
            <PromptSettings />
          </div>
          
          <!-- Token 计数设置 -->
          <div v-if="settingsStore.activeTab === 'tokenCount'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.tokenCount.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.tokenCount.description') }}</p>
            
            <TokenCountSettings />
          </div>
          
          <!-- 子代理设置 -->
          <div v-if="settingsStore.activeTab === 'subagents'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.subagents.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.subagents.description') }}</p>
            
            <SubAgentsSettings />
          </div>

          <!-- 通知系统 -->
          <div v-if="settingsStore.activeTab === 'sound'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.sound.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.sound.description') }}</p>

            <SoundSettings />
          </div>

          <!-- 外观设置 -->
          <div v-if="settingsStore.activeTab === 'appearance'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.appearance.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.appearance.description') }}</p>

            <AppearanceSettings />
          </div>

          <!-- 记忆设置 -->
          <div v-if="settingsStore.activeTab === 'memory'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.memory.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.memory.description') }}</p>

            <MemorySettings />
          </div>
          
          <!-- 通用设置 -->
          <div v-if="settingsStore.activeTab === 'general'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.general.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.general.description') }}</p>
            
            <div class="settings-form">
              <!-- 代理设置 -->
              <div class="form-group">
                <label class="group-label">
                  <i class="codicon codicon-globe"></i>
                  {{ t('components.settings.settingsPanel.proxy.title') }}
                </label>
                <p class="field-description">{{ t('components.settings.settingsPanel.proxy.description') }}</p>
                
                <div class="proxy-settings">
                  <div class="proxy-enable">
                    <CustomCheckbox
                      v-model="proxySettings.enabled"
                      :label="t('components.settings.settingsPanel.proxy.enable')"
                    />
                  </div>
                  
                  <div class="proxy-url-group" :class="{ disabled: !proxySettings.enabled }">
                    <label>{{ t('components.settings.settingsPanel.proxy.url') }}</label>
                    <input
                      type="text"
                      v-model="proxySettings.url"
                      :placeholder="t('components.settings.settingsPanel.proxy.urlPlaceholder')"
                      :disabled="!proxySettings.enabled"
                      class="proxy-url-input"
                      :class="{ invalid: proxySettings.url && !isValidProxyUrl(proxySettings.url) }"
                    />
                    <p v-if="proxySettings.url && !isValidProxyUrl(proxySettings.url)" class="error-hint">
                      {{ t('components.settings.settingsPanel.proxy.urlError') }}
                    </p>
                  </div>
                  
                  <div class="proxy-actions">
                    <button
                      class="save-btn"
                      @click="saveProxySettings"
                      :disabled="isSaving || (!!proxySettings.url && !isValidProxyUrl(proxySettings.url))"
                    >
                      <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
                      <span v-else>{{ t('components.settings.settingsPanel.proxy.save') }}</span>
                    </button>
                    <span v-if="saveMessage" class="save-message" :class="{ success: saveMessage === t('components.settings.settingsPanel.proxy.saveSuccess') }">
                      {{ saveMessage }}
                    </span>
                  </div>
                </div>
              </div>
              
              <div class="divider"></div>
              
              <!-- 语言设置 -->
              <div class="form-group">
                <label class="group-label">
                  <i class="codicon codicon-globe"></i>
                  {{ t('components.settings.settingsPanel.language.title') }}
                </label>
                <p class="field-description">{{ t('components.settings.settingsPanel.language.description') }}</p>
                
                <div class="language-settings">
                  <CustomSelect
                    :model-value="languageSetting"
                    :options="languageOptions"
                    :placeholder="t('components.settings.settingsPanel.language.placeholder')"
                    @update:model-value="updateLanguage"
                  />
                </div>
              </div>
              
              <div class="divider"></div>
              
              <!-- 存储路径设置 -->
              <div class="form-group">
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
                        v-model="storageSettings.customPath"
                        :placeholder="storageSettings.currentPath || t('components.settings.storageSettings.customPathPlaceholder')"
                        class="path-input"
                        :class="{
                          valid: pathValidationResult?.valid === true,
                          invalid: pathValidationResult?.valid === false
                        }"
                      />
                      <button
                        class="path-picker-btn"
                        :title="t('components.settings.storageSettings.browse')"
                        :disabled="isMigrating"
                        @click="pickStoragePath"
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
                      @click="applyStoragePath"
                      :disabled="isMigrating || isValidatingPath || (storageSettings.customPath.trim() !== '' && !pathValidationResult?.valid)"
                    >
                      <i class="codicon codicon-check"></i>
                      {{ t('components.settings.storageSettings.apply') }}
                    </button>
                    <button
                      class="action-btn"
                      @click="resetStoragePath"
                      :disabled="isMigrating"
                      :title="!storageSettings.isCustom ? t('components.settings.storageSettings.notifications.alreadyDefaultTitle') : ''"
                    >
                      <i class="codicon codicon-discard"></i>
                      {{ t('components.settings.storageSettings.reset') }}
                    </button>
                    <button
                      class="action-btn"
                      @click="openStoragePathInExplorer"
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
                      @click="reloadWindow"
                    >
                      <i class="codicon codicon-refresh"></i>
                      {{ t('components.settings.storageSettings.reloadWindow') }}
                    </button>
                  </div>
                </div>
              </div>
              
              <div class="divider"></div>
              
              <!-- 设置导入/导出 -->
              <div class="form-group">
                <label class="group-label">
                  <i class="codicon codicon-export"></i>
                  {{ t('components.settings.settingsPanel.exportImport.title') }}
                </label>
                <p class="field-description">{{ t('components.settings.settingsPanel.exportImport.description') }}</p>
                
                <div class="import-export-actions">
                  <button
                    class="action-btn primary"
                    @click="handleExportSettings"
                    :disabled="isExporting"
                  >
                    <i v-if="isExporting" class="codicon codicon-loading codicon-modifier-spin"></i>
                    <i v-else class="codicon codicon-export"></i>
                    {{ isExporting ? t('components.settings.settingsPanel.exportImport.exporting') : t('components.settings.settingsPanel.exportImport.exportBtn') }}
                  </button>
                  <button
                    class="action-btn"
                    @click="handleImportSettings"
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
              
              <!-- 应用信息 -->
              <div class="form-group">
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
          </div>
        </div>
      </CustomScrollbar>
    </div>
    
    <!-- 迁移确认对话框 -->
    <Modal
      v-model="showMigrateDialog"
      :title="t('components.settings.storageSettings.dialog.migrateTitle')"
    >
      <div class="migrate-dialog-content">
        <p>{{ t('components.settings.storageSettings.dialog.migrateMessage') }}</p>
        <p class="migrate-warning">
          <i class="codicon codicon-warning"></i>
          {{ t('components.settings.storageSettings.dialog.migrateWarning') }}
        </p>
      </div>
      <template #footer>
        <button class="dialog-btn" :disabled="isMigrating" @click="showMigrateDialog = false">
          {{ t('components.settings.storageSettings.dialog.cancel') }}
        </button>
        <button class="dialog-btn primary" :disabled="isMigrating" @click="executeMigration">
          {{ t('components.settings.storageSettings.dialog.confirm') }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.settings-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--vscode-sideBar-background);
  z-index: 100;
  display: flex;
  flex-direction: column;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.settings-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.settings-close-btn {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.settings-close-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.settings-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

/* 左侧页签（可折叠：默认展开显示图标+文字，折叠仅图标） */
.settings-sidebar {
  width: 132px;
  border-right: 1px solid var(--vscode-panel-border);
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  transition: width 0.2s ease;
}

.settings-sidebar.collapsed {
  width: 48px;
}

/* 顶部汉堡按钮：与页签同款；margin 在展开/收起时保持一致，避免切换时列表整体跳动 */
.settings-sidebar-toggle {
  margin-bottom: 2px;
}

.settings-tab {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--vscode-foreground);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.settings-tab:hover {
  background: var(--vscode-list-hoverBackground);
}

.settings-tab-label {
  flex: 1;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 自定义 tooltip 显示在右侧 */
.settings-tab::after {
  content: attr(data-tooltip);
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-left: 8px;
  padding: 4px 8px;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 4px;
  font-size: 12px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s, visibility 0.15s;
  pointer-events: none;
  z-index: 1000;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.settings-sidebar.collapsed .settings-tab:hover::after {
  opacity: 1;
  visibility: visible;
}

/* 汉堡按钮在展开/收起状态下都显示 tooltip */
.settings-sidebar-toggle:hover::after {
  opacity: 1;
  visibility: visible;
}

.settings-tab.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.settings-tab .codicon {
  font-size: 18px;
}

/* 右侧内容 - 滚动条容器 */
.settings-main-scrollbar {
  flex: 1;
  min-height: 0;
  height: 100%;
  position: relative;
}

.settings-main {
  padding: 16px;
  min-height: min-content;
}

.settings-section h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 500;
}

.settings-description {
  margin: 0 0 16px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

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
  background: var(--vscode-editor-background);
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
  background: var(--vscode-editor-background);
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
  background: var(--vscode-editor-background);
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

/* 迁移对话框 */
.migrate-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.migrate-dialog-content p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.migrate-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(255, 200, 0, 0.1);
  border-radius: 4px;
  color: var(--vscode-editorWarning-foreground);
}

.migrate-warning .codicon {
  flex-shrink: 0;
  margin-top: 2px;
}

.dialog-btn {
  padding: 6px 14px;
  font-size: 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.dialog-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.dialog-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dialog-btn.primary:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>