<script setup lang="ts">
/**
 * SettingsPanel - 设置面板主容器
 *
 * 模板拆分说明（T12 批次，纯结构性拆分，行为零变化）：
 * - SettingsSidebar：左侧页签栏（折叠/搜索高亮）
 * - SettingsSearchBox：设置项搜索框 + 结果下拉
 * - GeneralSettingsSection：通用页签（代理/语言/更新/存储路径/导入导出/应用信息）
 * - UsageSummaryCard：用量统计 Token 摘要卡片
 * - StorageMigrateDialog：存储路径迁移确认对话框
 * 设置表单状态仍由本组件持有，搜索状态由 useSettingsSearch 管理，子组件仅通过 props/emits 通信。
 * 搜索索引与锚点一致性测试共用 panel/settingsSearchIndex.ts，分类调整时同步维护入口。
 */
import { defineAsyncComponent, ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import { useSettingsStore, type SettingsTab } from '@/stores/settingsStore'
import { MESSAGE_NAMES, PUSH_MESSAGE_NAMES } from '@shared/protocol'
import { CustomScrollbar } from '../common'
import { sendToExtension, onExtensionCommand } from '@/utils/vscode'
import { useI18n, SUPPORTED_LANGUAGES } from '@/i18n'
import type { SupportedLanguage } from '@/i18n/types'
import SettingsSidebar from './panel/SettingsSidebar.vue'
import SettingsSearchBox from './panel/SettingsSearchBox.vue'
import StorageMigrateDialog from './panel/StorageMigrateDialog.vue'
import type { TabItem } from './panel/types'
import { settingsSearchIndex } from './panel/settingsSearchIndex'
import { useSettingsSearch } from './panel/useSettingsSearch'
import { useStoragePathSettings } from '@/composables/useStoragePathSettings'
import { useUpdateSettings } from '@/composables/useUpdateSettings'
import { useSettingsImportExport } from '@/composables/useSettingsImportExport'
import { useUsageStats } from '@/composables/useUsageStats'
import { useOneShotTimer } from '@/composables/useOneShotTimer'
import PlatformSettingsFooter from './PlatformSettingsFooter.vue'
import { desktopSettingsDraft, markDesktopSettingsDirty, useDesktopSettingsDraft } from '@/platform/settingsDraft'
const isDesktopHost = Boolean(window.__GRAYCODE_HOST)
const platformFooter = ref<InstanceType<typeof PlatformSettingsFooter>>()
function closeSettings() {
  if (isDesktopHost) void platformFooter.value?.requestClose()
  else settingsStore.showChat()
}

// 设置外壳保持同步；每个页签在首次进入时单独加载，避免主聊天与设置首页携带全部配置 UI。
const ChannelSettings = defineAsyncComponent(() => import('./ChannelSettings.vue'))
const ToolsSettings = defineAsyncComponent(() => import('./ToolsSettings.vue'))
const AutoExecSettings = defineAsyncComponent(() => import('./AutoExecSettings.vue'))
const McpSettings = defineAsyncComponent(() => import('./McpSettings.vue'))
const CheckpointSettings = defineAsyncComponent(() => import('./CheckpointSettings.vue'))
const SummarizeSettings = defineAsyncComponent(() => import('./SummarizeSettings.vue'))
const GenerateImageSettings = defineAsyncComponent(() => import('./GenerateImageSettings.vue'))
const DependencySettings = defineAsyncComponent(() => import('./DependencySettings.vue'))
const ContextSettings = defineAsyncComponent(() => import('./ContextSettings.vue'))
const PromptSettings = defineAsyncComponent(() => import('./PromptSettings.vue'))
const TokenCountSettings = defineAsyncComponent(() => import('./TokenCountSettings.vue'))
const SubAgentsSettings = defineAsyncComponent(() => import('./SubAgentsSettings.vue'))
const MemorySettings = defineAsyncComponent(() => import('./MemorySettings.vue'))
const PlatformDevelopmentSettings = defineAsyncComponent(() => import('./PlatformDevelopmentSettings.vue'))
const PlatformModeSettings = defineAsyncComponent(() => import('./PlatformModeSettings.vue'))
const PlatformReviewSettings = defineAsyncComponent(() => import('./PlatformReviewSettings.vue'))
const PlatformIntegrationSettings = defineAsyncComponent(() => import('./PlatformIntegrationSettings.vue'))
const PlatformMigrationSettings = defineAsyncComponent(() => import('./PlatformMigrationSettings.vue'))
const DiscordSettings = defineAsyncComponent(() => import('./DiscordSettings.vue'))
const PlatformRemoteSettings = defineAsyncComponent(() => import('./PlatformRemoteSettings.vue'))
const AppearanceSettings = defineAsyncComponent(() => import('./AppearanceSettings.vue'))
const SoundSettings = defineAsyncComponent(() => import('./SoundSettings.vue'))
const GeneralSettingsSection = defineAsyncComponent(() => import('./panel/GeneralSettingsSection.vue'))
const UsageTimeSection = defineAsyncComponent(() => import('../usage/UsageTimeSection.vue'))
const UsageSummaryCard = defineAsyncComponent(() => import('./panel/UsageSummaryCard.vue'))

const settingsStore = useSettingsStore()
const { t, setLanguage } = useI18n()

// 侧边栏折叠状态（展开时显示图标+文字，折叠时仅图标）
const sidebarCollapsed = ref(false)

// 页签列表（使用 computed 以便语言切换时自动更新）
const tabs = computed<TabItem[]>(() => [
  { id: 'channel', label: t('components.settings.tabs.channel'), icon: 'codicon-plug' },
  ...(isDesktopHost ? [{ id: 'development' as const, label: t('components.settings.tabs.development'), icon: 'codicon-code' }] : []),
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
  { id: 'usage', label: t('components.settings.tabs.usage'), icon: 'codicon-graph' },
  ...(isDesktopHost ? [
    { id: 'discord' as const, label: 'Discord Bot', icon: 'codicon-comment-discussion' },
    { id: 'onebot' as const, label: 'NapCat / OneBot', icon: 'codicon-radio-tower' },
    { id: 'accounts' as const, label: '账号与授权', icon: 'codicon-account' },
    { id: 'workspaces' as const, label: '工作区', icon: 'codicon-folder' },
    { id: 'remote' as const, label: '远程连接', icon: 'codicon-remote' },
  ] : []),
])

// ========== 设置项搜索 ==========

// 静态搜索索引：设置项为硬编码组件，无统一注册表，用关键词索引覆盖各页签主要设置项。
// 每个页签级条目作为兜底；每个设置块都有 data-search-anchor 锚点条目。
// 关键词同时包含中/英/日，任意界面语言下都能搜到（匹配时统一去空白）。
const SEARCH_INDEX = settingsSearchIndex(isDesktopHost, isDesktopHost && window.__GRAYCODE_HOST?.kind !== 'web')

const scrollbarRef = ref<InstanceType<typeof CustomScrollbar>>()
const { searchQuery, searchFocused, activeSearchIndex, searchActive, searchResults, tabsWithMatches,
  tabIcon, moveSearchSelection, openSearchResult } = useSettingsSearch({
  index: SEARCH_INDEX, tabs, activeTab: () => settingsStore.activeTab,
  selectTab: tab => settingsStore.setActiveTab(tab), container: () => scrollbarRef.value?.getContainer(),
})

// 代理设置
const proxySettings = reactive({
  enabled: false,
  url: ''
})

// 语言设置（'auto' = 跟随系统）
const languageSetting = ref<SupportedLanguage>('auto')

// 是否正在保存
const isSaving = ref(false)
// 保存状态消息
const saveMessage = ref('')
// 保存消息类型（避免用文案字符串比较判断样式）
const saveMessageType = ref<'success' | 'error'>('success')

// 保存消息自动消失定时器（组件卸载时由 useOneShotTimer 统一清理）
const proxySaveMessageTimer = useOneShotTimer()
// ========== 区块级 composable（状态与动作下放，本组件只保留编排） ==========
const {
  storageSettings,
  isValidatingPath,
  pathValidationResult,
  isMigrating,
  showMigrateDialog,
  storageMessage,
  storageMessageType,
  needsReload,
  loadStorageConfig,
  pickStoragePath,
  openStoragePathInExplorer,
  applyStoragePath,
  resetStoragePath,
  executeMigration,
  reloadWindow
} = useStoragePathSettings()

const {
  checkUpdatesEnabled,
  updateChannel,
  isUpdateChecking,
  isUpdating,
  updateCheckResult,
  saveCheckUpdates,
  saveUpdateChannel,
  checkUpdateNow,
  updateNow
} = useUpdateSettings()

const {
  isExporting,
  isImporting,
  importExportMessage,
  importExportMessageType,
  handleExportSettings,
  handleImportSettings
} = useSettingsImportExport()

const {
  usageStats,
  usageRange,
  usageLoading,
  usageLoadError,
  loadUsageStats
} = useUsageStats()

// 加载设置
async function loadSettings() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getSettings, {})
    if (response?.settings?.proxy) {
      proxySettings.enabled = response.settings.proxy.enabled || false
      proxySettings.url = response.settings.proxy.url || ''
    }
    // 加载语言设置（运行时守卫：仅接受 SUPPORTED_LANGUAGES 中的合法值）
    const language = response?.settings?.ui?.language
    if (language && isSupportedLanguage(language)) {
      languageSetting.value = language
      setLanguage(language)
    }
    // 加载自动更新检查开关（默认开启）
    checkUpdatesEnabled.value = response?.settings?.checkForUpdates !== false
    // 加载更新渠道（stable 正式版 / nightly 每日构建）
    updateChannel.value = response?.settings?.updateChannel === 'nightly' ? 'nightly' : 'stable'
    
    // 加载存储路径配置
    await loadStorageConfig()
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
}

// 应用信息来自当前宿主，独立桌面同时提供构建来源与程序位置。
const appInfo = ref<{ name: string; displayName: string; version: string; buildCommit?: string; buildDirty?: boolean; buildTime?: string; executablePath?: string }>({
  name: '',
  displayName: '',
  version: ''
})

async function loadAppInfo() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getAppInfo, {})
    if (response) {
      appInfo.value = {
        name: response.name || '',
        displayName: response.displayName || '',
        version: response.version || '',
        buildCommit: response.buildCommit,
        buildDirty: response.buildDirty,
        buildTime: response.buildTime,
        executablePath: response.executablePath
      }
    }
  } catch (error) {
    console.error('Failed to load app info:', error)
  }
}


// 保存代理设置
async function saveProxySettings() {
  isSaving.value = true
  saveMessage.value = ''
  
  try {
    await sendToExtension(MESSAGE_NAMES.updateProxySettings, {
      proxySettings: {
        enabled: proxySettings.enabled,
        url: proxySettings.url.trim() || undefined
      }
    })
    saveMessage.value = t('components.settings.settingsPanel.proxy.saveSuccess')
    saveMessageType.value = 'success'
    proxySaveMessageTimer.schedule(2000, () => {
      saveMessage.value = ''
    })
  } catch (error) {
    console.error('Failed to save proxy settings:', error)
    saveMessage.value = t('components.settings.settingsPanel.proxy.saveFailed')
    saveMessageType.value = 'error'
  } finally {
    isSaving.value = false
  }
}


// 语言值运行时守卫：只接受 SUPPORTED_LANGUAGES 中的合法值，类型系统据此收窄到 SupportedLanguage
function isSupportedLanguage(value: string): value is SupportedLanguage {
  return SUPPORTED_LANGUAGES.some(l => l.value === value)
}

// 更新语言设置
async function updateLanguage(lang: string) {
  // 非法语言值（越出 SUPPORTED_LANGUAGES）直接忽略，不再用 as any 把运行时风险带进 i18n
  if (!isSupportedLanguage(lang)) return
  const previous = languageSetting.value
  languageSetting.value = lang
  setLanguage(lang)

  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.updateUISettings, {
      ui: { language: lang }
    })
    // 失败时 resolve { success: false }（不抛错）：回滚语言选择与运行时语言，
    // 否则界面显示已切换而实际未保存
    if (response?.success === false) {
      languageSetting.value = previous
      setLanguage(previous)
      console.error('Failed to save language setting:', response?.error?.message || response?.error)
    }
  } catch (error) {
    languageSetting.value = previous
    setLanguage(previous)
    console.error('Failed to save language setting:', error)
  }
}



// 设置导入完成后重新拉取表单值：面板常驻挂载，不监听则刚导入的 VSCode 设置要重启插件才显示。
let unsubscribeSettingsImported: (() => void) | null = null

// 初始化
onMounted(() => {
  loadSettings()
  loadAppInfo()
  loadUsageStats()
  unsubscribeSettingsImported = onExtensionCommand(PUSH_MESSAGE_NAMES['settings.imported'], () => {
    void loadSettings()
  })
})

onUnmounted(() => {
  if (unsubscribeSettingsImported) {
    unsubscribeSettingsImported()
    unsubscribeSettingsImported = null
  }
})
useDesktopSettingsDraft(saveProxySettings, () => settingsStore.activeTab === 'general')
</script>

<template>
  <section class="settings-panel" aria-labelledby="settings-panel-title">
    <div class="settings-header">
      <h3 id="settings-panel-title">{{ t('components.settings.settingsPanel.title') }}</h3>
      <!-- T12：拆至 SettingsSearchBox（搜索框 + 结果下拉） -->
      <SettingsSearchBox
        v-model:query="searchQuery"
        v-model:focused="searchFocused"
        v-model:active-index="activeSearchIndex"
        :search-active="searchActive"
        :results="searchResults"
        :tab-icon="tabIcon"
        @open="openSearchResult"
        @move="moveSearchSelection"
      />
      <button
        type="button"
        class="settings-close-btn"
        :title="t('components.settings.settingsPanel.backToChat')"
        :aria-label="t('components.settings.settingsPanel.backToChat')"
        @click="closeSettings"
      >
        <i class="codicon codicon-close" aria-hidden="true"></i>
      </button>
    </div>
    
    <div class="settings-content">
      <label v-if="isDesktopHost" class="mobile-settings-category">设置分类<select :value="settingsStore.activeTab" aria-label="设置分类" @change="settingsStore.setActiveTab(($event.target as HTMLSelectElement).value as SettingsTab)"><option v-for="tab in tabs" :key="tab.id" :value="tab.id">{{ tab.label }}</option></select></label>
      <!-- 左侧页签（T12：拆至 SettingsSidebar；可折叠：展开显示图标+文字，折叠仅图标+tooltip） -->
      <SettingsSidebar
        :tabs="tabs"
        :active-tab="settingsStore.activeTab"
        v-model:collapsed="sidebarCollapsed"
        :search-active="searchActive"
        :tabs-with-matches="tabsWithMatches"
        @select="settingsStore.setActiveTab"
      />
      
      <!-- 右侧内容 -->
      <CustomScrollbar ref="scrollbarRef" class="settings-main-scrollbar">
        <div :key="desktopSettingsDraft.generation" class="settings-main" role="region" :aria-label="tabs.find(tab => tab.id === settingsStore.activeTab)?.label" @input.capture="markDesktopSettingsDirty" @change.capture="markDesktopSettingsDirty">
          <DiscordSettings v-if="isDesktopHost && settingsStore.activeTab === 'discord'" />
          <PlatformRemoteSettings v-if="isDesktopHost && settingsStore.activeTab === 'remote'" />
          <PlatformIntegrationSettings v-if="isDesktopHost && ['onebot', 'accounts', 'workspaces'].includes(settingsStore.activeTab)" :key="settingsStore.activeTab" :section="settingsStore.activeTab as 'onebot' | 'accounts' | 'workspaces'" />
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
            <PlatformReviewSettings v-if="isDesktopHost" />
          </div>

          <div v-if="isDesktopHost && settingsStore.activeTab === 'development'" class="settings-section">
            <h4>{{ t('components.settings.tabs.development') }}</h4>
            <PlatformDevelopmentSettings />
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
            
            <PlatformModeSettings v-if="isDesktopHost" />
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
          
          <!-- 通用设置（T12：拆至 GeneralSettingsSection） -->
          <div v-if="settingsStore.activeTab === 'general'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.general.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.general.description') }}</p>

            <PlatformMigrationSettings v-if="isDesktopHost" class="platform-migration-section" />
            <GeneralSettingsSection
              v-model:proxy-enabled="proxySettings.enabled"
              v-model:proxy-url="proxySettings.url"
              :is-saving="isSaving"
              :save-message="saveMessage"
              :save-message-type="saveMessageType"
              @save-proxy="saveProxySettings"
              :language="languageSetting"
              @update:language="updateLanguage"
              v-model:check-updates-enabled="checkUpdatesEnabled"
              @update:check-updates-enabled="saveCheckUpdates"
              :update-channel="updateChannel"
              @update:update-channel="saveUpdateChannel"
              :is-update-checking="isUpdateChecking"
              :is-updating="isUpdating"
              :update-check-result="updateCheckResult"
              @check-update-now="checkUpdateNow"
              @update-now="updateNow"
              :storage-settings="storageSettings"
              v-model:custom-path="storageSettings.customPath"
              :is-validating-path="isValidatingPath"
              :path-validation-result="pathValidationResult"
              :is-migrating="isMigrating"
              :storage-message="storageMessage"
              :storage-message-type="storageMessageType"
              :needs-reload="needsReload"
              @pick-storage-path="pickStoragePath"
              @apply-storage-path="applyStoragePath"
              @reset-storage-path="resetStoragePath"
              @open-in-explorer="openStoragePathInExplorer"
              @reload-window="reloadWindow"
              :is-exporting="isExporting"
              :is-importing="isImporting"
              :import-export-message="importExportMessage"
              :import-export-message-type="importExportMessageType"
              @export-settings="handleExportSettings"
              @import-settings="handleImportSettings"
              :app-info="appInfo"
            />
          </div>

          <!-- 用量统计（T12：Token 摘要拆至 UsageSummaryCard） -->
          <div v-if="settingsStore.activeTab === 'usage'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.usage.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.usage.description') }}</p>

            <!-- 使用时间（活动统计，独立于 token 用量） -->
            <UsageTimeSection />

            <!-- Token 用量摘要 -->
            <UsageSummaryCard
              :stats="usageStats"
              v-model:range="usageRange"
              :loading="usageLoading"
              :load-error="usageLoadError"
              @refresh="loadUsageStats()"
              @retry="loadUsageStats()"
              @open-full="settingsStore.showUsage"
            />
          </div>
        </div>
      </CustomScrollbar>
    </div>
    
    <PlatformSettingsFooter v-if="isDesktopHost" ref="platformFooter" @close="settingsStore.showChat" />
    <!-- 迁移确认对话框（T12：拆至 StorageMigrateDialog） -->
    <StorageMigrateDialog
      v-model:show="showMigrateDialog"
      :is-migrating="isMigrating"
      @confirm="executeMigration"
    />
  </section>
</template>

<style scoped>
.settings-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--gc-surface-panel);
  z-index: var(--gc-layer-sticky);
  display: flex;
  flex-direction: column;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--gc-space-3) var(--gc-space-4);
  border-bottom: 1px solid var(--gc-border-subtle);
}

.settings-header h3 {
  margin: 0;
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
}

.settings-close-btn {
  background: transparent;
  border: none;
  color: var(--gc-text-primary);
  padding: var(--gc-space-1);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--gc-radius-sm);
}

.settings-close-btn:hover {
  background: var(--gc-surface-hover);
}

.settings-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

/* 右侧内容 - 滚动条容器 */
.settings-main-scrollbar {
  flex: 1;
  min-height: 0;
  height: 100%;
  position: relative;
}

.settings-main {
  padding: var(--gc-space-4);
  min-height: min-content;
}

.settings-section h4 {
  margin: 0 0 4px 0;
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
}

.settings-description {
  margin: 0 0 16px 0;
  font-size: var(--gc-font-size-body);
  color: var(--gc-text-muted);
}

/* 搜索结果跳转后的临时闪烁高亮 */
.search-flash {
  animation: settings-search-flash 1.6s ease;
}

@keyframes settings-search-flash {
  0%, 60% {
    background-color: var(--vscode-editor-findMatchHighlightBackground, color-mix(in srgb, var(--gc-warning) 28%, transparent));
  }
  100% {
    background-color: transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .search-flash {
    animation: none;
    outline: 1px solid var(--gc-focus-border);
  }
}
</style>
