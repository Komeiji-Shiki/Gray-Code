/**
 * 设置 Store
 * 管理应用设置、配置和页面视图
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SmoothMode } from '../utils/smoothStream'

export type SettingsTab = 'channel' | 'tools' | 'autoExec' | 'mcp' | 'checkpoint' | 'summarize' | 'imageGen' | 'dependencies' | 'context' | 'prompt' | 'tokenCount' | 'subagents' | 'sound' | 'appearance' | 'general' | 'memory'

/** 应用页面视图类型 */
export type AppView = 'chat' | 'history' | 'settings' | 'usage'

/** 支持的语言 */
export type Language = 'zh-CN' | 'en' | 'ja'

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
    refreshPromptModes
  }
})