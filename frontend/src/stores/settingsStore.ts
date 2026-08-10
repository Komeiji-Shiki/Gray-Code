/**
 * 设置 Store
 * 管理应用设置、配置和页面视图
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SmoothMode } from '../utils/smoothStream'

export type SettingsTab = 'channel' | 'tools' | 'autoExec' | 'mcp' | 'checkpoint' | 'summarize' | 'imageGen' | 'dependencies' | 'context' | 'prompt' | 'tokenCount' | 'subagents' | 'sound' | 'appearance' | 'memory' | 'sandbox' | 'remoteControl' | 'general' | 'usage'

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
  // 初始值同步首帧静态启动画面的 localStorage 标记（boot-splash.js 读同一个 key）：
  // 桌面主窗口无 HTML 同步注入（__GRAYCODE_STARTUP_SPLASH_ENABLED），App.vue 首帧即读
  // 本 store——若默认 true，关闭开屏动画的用户会在 getSettings 往返完成前闪现 1-2 帧
  // Splash（首帧 #gc-boot 已被 gc-no-splash 抑制，Vue 端却还在播动画）。从标记初始化后
  // 首帧决定与静态画面一致：关闭动画的用户从第一帧就完全不渲染 Splash。
  function readInitialSplashEnabled(): boolean {
    try {
      return localStorage.getItem('gc-splash-disabled') !== '1'
    } catch {
      // localStorage 不可用（隐私模式等）：沿用默认开启
      return true
    }
  }
  const splashEnabled = ref(readInitialSplashEnabled())
  // 模式刷新计数器（用于通知组件刷新模式列表）
  const promptModesVersion = ref(0)
  // 渠道配置刷新计数器（聊天输入区快捷控件写渠道配置后，通知设置页重载最新数据）
  const configsVersion = ref(0)

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
    // 同步首帧静态启动画面开关标记：boot-splash.js 在 <head> 读取 localStorage
    // 决定是否渲染 #gc-boot（关闭动画后窗口第一帧直接进主界面，不再闪现启动画面）。
    // localStorage 不可用（隐私模式等）时忽略，仅影响下一次启动的首帧表现。
    try {
      if (enabled) {
        localStorage.removeItem('gc-splash-disabled')
      } else {
        localStorage.setItem('gc-splash-disabled', '1')
      }
    } catch {
      // ignore
    }
  }
  
  // 通知模式列表刷新
  function refreshPromptModes() {
    promptModesVersion.value++
  }

  // 通知渠道配置刷新（外部写入渠道配置后调用，如输入区思考强度快捷选择）
  function refreshConfigs() {
    configsVersion.value++
  }

  return {
    // 状态
    currentView,
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
    configsVersion,

    // 方法
    showChat,
    showHistory,
    showUsage,
    showSettings,
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
    refreshPromptModes,
    refreshConfigs
  }
})