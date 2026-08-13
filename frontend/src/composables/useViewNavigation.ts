/**
 * useViewNavigation - 视图导航与子页面惰性挂载 Composable
 *
 * 从 App.vue 拆分（F-06）：
 * - 新建对话 / 新建标签页
 * - 显示聊天 / 历史 / 用量 / 设置视图
 * - 子页面（history/usage/settings）惰性挂载标记：首次访问后保持挂载（v-show 切换）
 */

import { reactive, watch } from 'vue'
import { useChatStore, useSettingsStore } from '../stores'

type ChatStore = ReturnType<typeof useChatStore>
type SettingsStore = ReturnType<typeof useSettingsStore>

export function useViewNavigation(chatStore: ChatStore, settingsStore: SettingsStore) {
  // 子页面惰性挂载标记：首次访问后保持挂载（v-show 切换），保留滚动位置与表单状态
  const visitedViews = reactive({ history: false, usage: false, settings: false })
  watch(() => settingsStore.currentView, (view) => {
    if (view === 'history') visitedViews.history = true
    else if (view === 'usage') visitedViews.usage = true
    else if (view === 'settings') visitedViews.settings = true
  }, { immediate: true })

  // 处理新建对话
  function handleNewChat() {
    chatStore.createNewConversation()
    settingsStore.showChat()
  }

  // 处理新建标签页
  function handleNewTab() {
    chatStore.createNewTab()
    settingsStore.showChat()
  }

  // 显示设置
  function handleShowSettings() {
    settingsStore.showSettings()
  }

  // 显示历史
  function handleShowHistory() {
    settingsStore.showHistory()
  }

  // 显示用量统计
  function handleShowUsage() {
    settingsStore.showUsage()
  }

  return {
    visitedViews,
    handleNewChat,
    handleNewTab,
    handleShowSettings,
    handleShowHistory,
    handleShowUsage
  }
}
