/**
 * 设置 Store
 * 管理应用设置、配置和页面视图
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SmoothMode } from '../utils/smoothStream'

export type SettingsTab = 'channel' | 'tools' | 'autoExec' | 'mcp' | 'checkpoint' | 'summarize' | 'imageGen' | 'dependencies' | 'context' | 'prompt' | 'tokenCount' | 'subagents' | 'sound' | 'appearance' | 'memory' | 'sandbox' | 'general' | 'usage'

/** 应用页面视图类型 */
export type AppView = 'chat' | 'history' | 'settings' | 'usage'

/** 支持的语言（'auto' = 跟随系统，由 preload 注入的 __GRAYCODE_DETECTED_LANG 解析） */
export type Language = 'auto' | 'zh-CN' | 'en' | 'ja'

export const useSettingsStore = defineStore('settings', () => {
  // 当前视图（默认为聊天）
  const currentView = ref<AppView>('chat')
  
  // 设置面板的标签页
  const activeTab = ref<SettingsTab>('channel')
  
  // 当前语言（默认中文）
  const language = ref<Language>('zh-CN')

  // 外观设置：流式 Loading 文本（为空表示使用默认值）
  const appearanceLoadingText = ref<string>('')

  // 外观设置：流式平滑输出档位（off=直通 / smooth=灵敏 / balanced=标准 / silky=丝滑）
  const smoothStreaming = ref<SmoothMode>('balanced')

  // 外观设置：选中内容入口开关
  const selectionContextEnabled = ref(true)

  // 子代理 Monitor 内嵌面板开关（仅会话内状态，不持久化）
  const subAgentMonitorOpen = ref(false)

  // 子代理 Monitor 面板打开时携带的导航目标（runId）
  const monitorFocusRunId = ref<string | undefined>(undefined)

  // 外观设置：TPS 实时可视化条开关（隐藏后仍继续采样，重新开启立即恢复）
  const tpsBarEnabled = ref(true)

  // 外观设置：开屏动画开关（关闭后启动直接进入主界面）
  const splashEnabled = ref(true)
  // 模式刷新计数器（用于通知组件刷新模式列表）
  const promptModesVersion = ref(0)

  // 计算属性：是否显示设置面板（向后兼容）
  const isVisible = computed(() => currentView.value === 'settings')

  // 切换到聊天视图
  function showChat() {
    currentView.value = 'chat'
  }
  
  // 切换到历史视图
  function showHistory() {
    currentView.value = 'history'
  }

  // 切换到用量统计视图
  function showUsage() {
    currentView.value = 'usage'
  }

  // 显示设置面板
  function showSettings(tab?: SettingsTab) {
    currentView.value = 'settings'
    if (tab) {
      activeTab.value = tab
    }
  }

  // 隐藏设置面板（回到聊天）
  function hideSettings() {
    currentView.value = 'chat'
  }

  // 设置当前标签
  function setActiveTab(tab: SettingsTab) {
    activeTab.value = tab
  }
  
  // 设置语言
  function setLanguage(lang: Language) {
    language.value = lang
  }

  // 设置外观：流式 Loading 文本
  function setAppearanceLoadingText(text: string) {
    appearanceLoadingText.value = text
  }

  // 设置外观：流式平滑输出档位
  function setSmoothStreaming(mode: SmoothMode) {
    smoothStreaming.value = mode
  }

  function setSelectionContextEnabled(enabled: boolean) {
    selectionContextEnabled.value = enabled
  }

  // 打开子代理 Monitor 内嵌面板（可携带要聚焦的 runId）
  function openSubAgentMonitor(runId?: string) {
    if (runId) {
      monitorFocusRunId.value = runId
    }
    subAgentMonitorOpen.value = true
  }

  // 关闭子代理 Monitor 面板
  function closeSubAgentMonitor() {
    subAgentMonitorOpen.value = false
    monitorFocusRunId.value = undefined
  }

  // 切换面板开关
  function toggleSubAgentMonitor() {
    if (subAgentMonitorOpen.value) {
      closeSubAgentMonitor()
    } else {
      openSubAgentMonitor()
    }
  }

  function setTpsBarEnabled(enabled: boolean) {
    tpsBarEnabled.value = enabled
  }

  function setSplashEnabled(enabled: boolean) {
    splashEnabled.value = enabled
  }
  
  // 通知模式列表刷新
  function refreshPromptModes() {
    promptModesVersion.value++
  }

  return {
    // 状态
    currentView,
    isVisible,
    activeTab,
    language,
    appearanceLoadingText,
    smoothStreaming,
    selectionContextEnabled,
    subAgentMonitorOpen,
    monitorFocusRunId,
    tpsBarEnabled,
    splashEnabled,
    promptModesVersion,

    // 方法
    showChat,
    showHistory,
    showUsage,
    showSettings,
    hideSettings,
    setActiveTab,
    setLanguage,
    setAppearanceLoadingText,
    setSmoothStreaming,
    setSelectionContextEnabled,
    openSubAgentMonitor,
    closeSubAgentMonitor,
    toggleSubAgentMonitor,
    setTpsBarEnabled,
    setSplashEnabled,
    refreshPromptModes
  }
})