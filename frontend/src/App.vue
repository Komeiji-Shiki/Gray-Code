<script setup lang="ts">
/**
 * App.vue - 主应用组件
 * 使用Pinia store管理状态
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { MessageList } from './components/message'
import { InputArea } from './components/input'
import BackgroundTaskBar from './components/backgroundTasks/BackgroundTaskBar.vue'
import { WelcomePanel } from './components/home'
import { HistoryPage } from './components/history'
import { UsagePage } from './components/usage'
import { SettingsPanel } from './components/settings'
import { ConversationTabs } from './components/tabs'
import { CustomScrollbar } from './components/common'
import UpdateModal from './components/common/UpdateModal.vue'
import SubAgentMonitor from './components/subagents/SubAgentMonitor.vue'
import Splash from './components/Splash.vue'
import StartupBackdrop from './components/StartupBackdrop.vue'
import { useChatStore, useSettingsStore, useTerminalStore } from './stores'
import { useAttachments } from './composables'
import { useSoundCueDispatcher } from './composables/useSoundCueDispatcher'
import { useFilePickerDialog } from './composables/useFilePickerDialog'
import { useViewNavigation } from './composables/useViewNavigation'
import { useLanguageSettings } from './composables/useLanguageSettings'
import { useI18n } from './i18n'
import type { Attachment, Message, StreamChunk, VSCodeMessage } from './types'
import { copyToClipboard } from './utils'
import { sendToExtension, onMessageFromExtension } from './utils/vscode'
import { registerGlobalAudioUnlockHooks, registerVisibilityChangeHooks, setVscodeWindowFocused } from './services/soundEventController'
import { createAgentStopNotificationController, type AgentStopNotificationController } from './services/agentStopNotificationController'
import { disposeAllSmoothStreams } from './stores/chat/smoothStreamManager'
import { preloadChannelConfigs } from './services/channelConfigCache'

// i18n
const { t } = useI18n()

// SubAgent Monitor 复用同一个前端入口，但不应初始化主聊天时间线。
const isSubAgentMonitor = window.__GRAYCODE_VIEW_MODE === 'subagentMonitor'

// 扩展在生成 Webview HTML 时同步注入本次启动偏好；模块执行与 Vue 挂载无需等待 IPC。
// 浏览器预览等非扩展环境没有注入值时，沿用后端默认的“开启”。
const startupSplashEnabled = window.__GRAYCODE_STARTUP_SPLASH_ENABLED !== false
// 主界面启动数据是否已完成初始化；关闭开屏动画时据此结束专属占位画面。
const mainViewInitialized = ref(false)
// 开始动画是否已完成（Splash 淡出后置 true，移除组件）
const splashDone = ref(false)

// 使用 Pinia Store
const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const terminalStore = useTerminalStore()

// 从 store 获取原始 Ref（Pinia 会自动解包 ref，storeToRefs 保持 Ref 不被解包）
const { storeAttachments: storeAttachmentsRef } = storeToRefs(chatStore)

// ============ 声音事件编排 ============
const {
  dispatchConversationCue,
  handleSoundForStreamChunk,
  shouldHandleSoundForStreamChunk,
  handleRetryStatus
} = useSoundCueDispatcher(chatStore)

// 附件管理（传入 store 驱动的 Ref<Attachment[]>，实现对话级隔离）
const {
  attachments,
  uploading,
  addAttachments,
  removeAttachment,
  clearAttachments
} = useAttachments(storeAttachmentsRef)

// 文件选择器（动态 input 生命周期管理；选中后走附件上传）
const { openFilePicker } = useFilePickerDialog({
  onFiles: async (files) => {
    try {
      await addAttachments(files)
    } catch (err) {
      console.error('上传附件失败:', err)
    }
  }
})

// 视图导航与子页面惰性挂载
const {
  visitedViews,
  handleNewChat,
  handleNewTab,
  handleShowSettings,
  handleShowHistory,
  handleShowUsage
} = useViewNavigation(chatStore, settingsStore)

// 语言 / 外观 / 声音设置加载
const { languageLoaded, loadLanguageSettings } = useLanguageSettings(settingsStore)

// 保持模板绑定名不变：模板仍通过 handleAttachFile 触发文件选择
const handleAttachFile = openFilePicker

// 处理发送消息
async function handleSend(content: string, messageAttachments: Attachment[], options?: { dynamicContextStrategyOverride?: 'single' | 'preserve' }, onSendResult?: (ok: boolean) => void) {
  if (!content.trim() && messageAttachments.length === 0) {
    onSendResult?.(false)
    return
  }

  // 有待确认工具时：发送即中断——先拒绝待确认工具并结束当前回合，
  // 再走正常发送路径把消息作为新回合发出。此前的"批注+批量拒绝"语义
  // （把输入栏文字当作批注随 toolConfirmation 发送）已移除。
  if (chatStore.hasPendingToolConfirmation) {
    try {
      await chatStore.cancelStreamAndRejectTools()
    } catch (err) {
      console.error('拒绝待确认工具失败:', err)
    }
    // 拒绝失败也继续发送（消息不丢，后端 prepareConversationForRequest 会兜底拒绝）
  }

  // 正常发送消息：先立即清除附件（发送失败时恢复，避免已上传附件丢失）
  clearAttachments()

  let sent = false
  try {
    sent = await chatStore.sendMessage(content, messageAttachments, options)
  } catch (err) {
    console.error('发送失败:', err)
  }
  // sendMessage 的失败路径不抛异常而是返回 false（见 messageActions.sendMessage 内部 catch），
  // 这里依据返回值恢复附件：发送失败时把刚清除的附件放回输入区，避免用户已上传内容丢失
  if (!sent && messageAttachments.length > 0) {
    storeAttachmentsRef.value.push(...messageAttachments)
  }
  // 把发送结果回报给 InputArea：失败时由 InputArea 恢复正文（editorNodes + inputValue），
  // 与附件恢复一起保证“发送失败不丢用户输入”
  onSendResult?.(sent)
}

// 处理取消请求
async function handleCancel() {
  agentStopNotificationController?.markUserCancelled()
  try {
    await chatStore.cancelStream()
  } catch (err) {
    agentStopNotificationController?.clearUserCancelled()
    console.error('取消失败:', err)
  }
}

// 处理编辑消息 - 使用 allMessages 索引（mode：'branch' 新建分支（默认）；'keep' 原地改写保持当前分支）
async function handleEdit(messageId: string, newContent: string, editAttachments: Attachment[], mode: 'branch' | 'keep' = 'branch') {
  const index = chatStore.allMessages.findIndex((m: Message) => m.id === messageId)
  if (index !== -1) {
    try {
      await chatStore.editAndRetry(index, newContent, editAttachments, mode)
    } catch (err) {
      console.error('编辑失败:', err)
    }
  }
}

// 处理取消总结请求（仅取消总结 API，不中断主对话请求）
async function handleCancelSummarize() {
  try {
    await chatStore.cancelSummarizeRequest()
  } catch (err) {
    console.error('取消总结失败:', err)
  }
}

// 处理删除消息 - 使用 allMessages 索引（由 MessageList 直接调用 store）
async function handleDelete(messageId: string) {
  const index = chatStore.allMessages.findIndex((m: Message) => m.id === messageId)
  if (index !== -1) {
    try {
      await chatStore.deleteMessage(index)
    } catch (err) {
      console.error('删除失败:', err)
    }
  }
}

// 处理重试 - 使用 allMessages 索引（由 MessageList 直接调用 store）
async function handleRetry(messageId: string) {
  const index = chatStore.allMessages.findIndex((m: Message) => m.id === messageId)
  if (index !== -1) {
    try {
      await chatStore.retryFromMessage(index)
    } catch (err) {
      console.error('重试失败:', err)
    }
  }
}

// 处理复制
async function handleCopy(content: string) {
  await copyToClipboard(content)
}

// 处理移除附件
function handleRemoveAttachment(id: string) {
  removeAttachment(id)
}

// 格式化错误详情
function formatErrorDetails(details: unknown): string {
  if (typeof details === 'string') {
    // 如果是字符串，尝试解析为 JSON
    try {
      const parsed = JSON.parse(details)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return details
    }
  }
  return JSON.stringify(details, null, 2)
}

// 处理粘贴文件
async function handlePasteFiles(files: File[]) {
  if (files.length > 0) {
    try {
      await addAttachments(files)
    } catch (err) {
      console.error('粘贴附件失败:', err)
    }
  }
}

let disposeMessageListener: (() => void) | null = null
let disposeAudioUnlockHooks: (() => void) | null = null
let disposeVisibilityHooks: (() => void) | null = null
let agentStopNotificationController: AgentStopNotificationController | null = null

// 组件挂载
onMounted(async () => {
  if (isSubAgentMonitor) {
    console.debug('GrayCode SubAgent Monitor 已加载')
    // 修改原因：Monitor 复用同一前端入口但过去从不加载语言设置；
    //          导致面板内已国际化的 MessageItem / ToolMessage / 各工具卡全部回退到默认中文，
    //          英文和日文用户看到的子代理详情是混合语言。
    // 修改方式：Monitor 模式同样加载语言设置，只是继续跳过主聊天时间线的初始化。
    // 修改目的：主窗口与 Monitor 面板共享同一套语言配置。
    await loadLanguageSettings()

    // 子代理面板同样启用提示音（run 完成/失败/重试事件走子代理独立开关）：
    // 注册音频解锁与可见性 hooks，面板内首个用户手势后即可按主窗口同一套焦点规则播放。
    disposeAudioUnlockHooks = registerGlobalAudioUnlockHooks()
    disposeVisibilityHooks = registerVisibilityChangeHooks()
    return
  }

  console.debug('GrayCode Chat 已加载')

  // 初始化终端 store（监听终端输出事件）
  terminalStore.initialize()

  // 启动即预加载渠道配置列表（幂等、静默失败、30s 超时）：开屏动画期间完成，
  // 首次打开「设置 → 渠道」页直接命中缓存，无需现场串行请求。
  // 安全性：listConfigs/getConfig 仅本地文件读取、不依赖 BackendHost，不会挂起消息队列；
  // webviewReady 握手已由 messageHandlingQueue 绕过串行队列；initialize 首个 await 前
  // 已同步建立空白标签页，newChat 可立即执行——均不受预加载影响。
  void preloadChannelConfigs()

  disposeAudioUnlockHooks = registerGlobalAudioUnlockHooks()
  disposeVisibilityHooks = registerVisibilityChangeHooks()
  
  // 立即注册命令监听器，确保在初始化期间也能响应用户操作。
  // 注册必须早于 loadLanguageSettings() 的 await：语言设置加载的 IPC 往返窗口内，
  // 扩展下发的 command / taskEvent / streamChunk / retryStatus 消息不会因监听器未注册而丢失。
  disposeMessageListener = onMessageFromExtension((message: VSCodeMessage) => {
    if (message.type === 'command') {
      switch (message.command) {
        case 'newChat':
          // initialize() 已在首个 await 前同步建立空白标签页，初始化期间可立即执行。
          // 不得挂起到 initialize 完成：BackendHost 尚未就绪时初始化可能长期等待，
          // 挂起会让用户点击新建后永远没有任何动作。
          handleNewChat()
          break
        case 'showHistory':
          handleShowHistory()
          break
        case 'showUsage':
          handleShowUsage()
          break
        case 'showSettings':
          handleShowSettings()
          break
        case 'windowFocusChanged':
          // VSCode 窗口焦点状态：音效控制器据此决定是否播放提示音（聚焦时不播）
          setVscodeWindowFocused(message.data?.focused === true)
          break
      }
    }

    // 任务事件声音提醒（TaskManager 异步任务：终端执行、图片生成、后台子代理等）。
    // 后台子代理（background_subagent）事件走子代理独立提示音开关。
    if (message.type === 'taskEvent') {
      const event = message.data
      const eventRole = event?.taskType === 'background_subagent' ? 'subagent' : undefined
      if (event?.type === 'complete') {
        dispatchConversationCue('taskComplete', 'taskEvent', undefined, event?.createdAt, eventRole)
      } else if (event?.type === 'error') {
        dispatchConversationCue('taskError', 'taskEvent', undefined, event?.createdAt, eventRole)
      }
    }

    // 流式 chunk 声音提醒（LLM 完成、工具完成等）
    if (message.type === 'streamChunk') {
      const chunk = message.data as StreamChunk
      if (chunk && shouldHandleSoundForStreamChunk(chunk)) {
        handleSoundForStreamChunk(chunk)
      }
    } else if (message.type === 'streamChunkBatch') {
      const chunks = message.data as StreamChunk[]
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (shouldHandleSoundForStreamChunk(chunk)) {
            handleSoundForStreamChunk(chunk)
          }
        }
      }
    }

    // 重试警告声音提醒
    if (message.type === 'retryStatus') {
      handleRetryStatus(message.data)
    }
  })

  // 语言与聊天初始化并行启动，但保持 getSettings 先入队：
  // - loadLanguageSettings() 先调用，延续既有设置加载顺序；
  // - initialize() 随即执行其首个 await 前的同步准备段，立即建立空白标签页；
  // - 因此 BackendHost 尚未就绪、任一请求仍在途时，newChat 也有可操作的本地状态，
  //   无需也不得挂起到完整初始化结束。
  const languageSettingsPromise = loadLanguageSettings()
  const chatInitializationPromise = chatStore.initialize().then(
    () => ({ ok: true as const }),
    error => ({ ok: false as const, error })
  )

  // command 订阅与 initialize 同步准备都已完成后再发送 ready 握手。扩展端会在握手中
  // 立即 flush pendingCommands；此顺序保证积压的 newChat 既不会丢，也不会命中未准备的 store。
  sendToExtension(MESSAGE_NAMES.webviewReady, {}).catch(error => {
    console.error('[App] Failed to notify extension that webview is ready:', error)
  })

  await languageSettingsPromise

  agentStopNotificationController = createAgentStopNotificationController({
    chatStore,
    sendToExtension
  })

  // 关闭开屏动画时，专属占位持续到聊天初始化结束。
  const chatInitialization = await chatInitializationPromise
  if (!chatInitialization.ok) {
    console.error('[App] chatStore.initialize failed', chatInitialization.error)
  }

  mainViewInitialized.value = true
})

onBeforeUnmount(() => {
  disposeMessageListener?.()
  disposeMessageListener = null

  disposeAudioUnlockHooks?.()
  disposeAudioUnlockHooks = null

  disposeVisibilityHooks?.()
  disposeVisibilityHooks = null

  agentStopNotificationController?.dispose()
  agentStopNotificationController = null

  // H1：webview 卸载兜底——销毁所有平滑流式实例（防泄漏；显示文本随 webview 一起销毁）
  disposeAllSmoothStreams()
})
</script>

<template>
  <SubAgentMonitor v-if="isSubAgentMonitor" />
  <div v-else class="app-container">
    <!-- 关闭态占位与 Splash 从 HTML 首帧起就依据同一个同步快照严格互斥 -->
    <StartupBackdrop v-if="!startupSplashEnabled && !mainViewInitialized" />

    <Splash
      v-if="!splashDone && startupSplashEnabled"
      :ready="languageLoaded"
      @done="splashDone = true"
    />
    
    <!-- 聊天视图 - 使用 v-show 避免销毁组件，保持滚动位置 -->
    <div v-show="languageLoaded && settingsStore.currentView === 'chat'" class="chat-view">
      <!-- 多对话标签页栏 -->
      <ConversationTabs
        :tabs="chatStore.openTabs"
        :active-tab-id="chatStore.activeTabId"
        @switch-tab="chatStore.switchTab"
        @close-tab="chatStore.closeTab"
        @new-tab="handleNewTab"
        @reorder-tab="chatStore.reorderTab"
      />

      <!-- 主聊天区域 -->
      <div class="chat-area">
        <!-- 初始状态：显示欢迎面板+历史对话列表 -->
        <WelcomePanel
          v-if="chatStore.showEmptyState"
        />

        <!-- 单实例消息列表：仅渲染当前活跃标签页，减少隐藏实例的重算成本 -->
        <MessageList
          v-if="chatStore.activeTabId && !chatStore.showEmptyState"
          :messages="chatStore.messages"
          :tab-id="chatStore.activeTabId"
          @edit="handleEdit"
          @delete="handleDelete"
          @retry="handleRetry"
          @copy="handleCopy"
        />

        <!-- 自动总结进行中提示 -->
        <div
          v-if="chatStore.autoSummaryStatus && chatStore.autoSummaryStatus.isSummarizing"
          class="auto-summary-panel"
          :class="{ 'with-retry': chatStore.retryStatus && chatStore.retryStatus.isRetrying }"
        >
          <i class="codicon codicon-loading spin auto-summary-icon"></i>
          <span>
            {{
              chatStore.autoSummaryStatus.message ||
              (chatStore.autoSummaryStatus.mode === 'manual'
                ? t('app.autoSummaryPanel.manualSummarizing')
                : t('app.autoSummaryPanel.summarizing'))
            }}
          </span>
          <button
            class="auto-summary-cancel-btn"
            :title="t('app.autoSummaryPanel.cancelTooltip')"
            @click="handleCancelSummarize"
          ><i class="codicon codicon-close"></i>
          </button>
        </div>
        
        <!-- 重试状态提示面板 -->
        <div
          v-if="chatStore.retryStatus && chatStore.retryStatus.isRetrying"
          class="retry-panel"
        >
          <div class="retry-header">
            <i class="codicon codicon-warning warning-icon"></i>
            <span class="retry-title">{{ t('app.retryPanel.title') }}</span>
            <div class="retry-progress-inline">
              <i class="codicon codicon-sync spin"></i>
              <span>{{ chatStore.retryStatus.attempt }}/{{ chatStore.retryStatus.maxAttempts }}</span>
              <span v-if="chatStore.retryStatus.nextRetryIn" class="retry-countdown">
                ({{ Math.ceil((chatStore.retryStatus.nextRetryIn || 0) / 1000) }}s)
              </span>
            </div>
            <button class="retry-cancel-btn" @click="handleCancel" :title="t('app.retryPanel.cancelTooltip')">
              <i class="codicon codicon-close"></i>
            </button>
          </div>
          <div class="retry-body">
            <!-- 错误信息显示在内容开头 -->
            <CustomScrollbar :max-height="120" :width="4">
              <pre class="retry-error-json">{{ chatStore.retryStatus.error || t('app.retryPanel.defaultError') }}{{ chatStore.retryStatus.errorDetails ? '\n\n' + formatErrorDetails(chatStore.retryStatus.errorDetails) : '' }}</pre>
            </CustomScrollbar>
          </div>
        </div>
      </div>

      <!-- 后台任务状态条（有任务时显示） -->
      <BackgroundTaskBar />

      <!-- 输入区域：语言就绪后按需加载渠道；不等待完整聊天/历史初始化 -->
      <InputArea
        v-if="languageLoaded"
        :attachments="attachments"
        :uploading="uploading"
        @send="handleSend"
        @cancel="handleCancel"
        @clear-attachments="clearAttachments"
        @attach-file="handleAttachFile"
        @remove-attachment="handleRemoveAttachment"
        @paste-files="handlePasteFiles"
      />
    </div>

    <!-- 历史页面（惰性挂载 + v-show 保活，保留滚动位置） -->
    <HistoryPage v-if="languageLoaded && visitedViews.history" v-show="settingsStore.currentView === 'history'" />

    <!-- 用量统计页面（惰性挂载 + v-show 保活） -->
    <UsagePage v-if="languageLoaded && visitedViews.usage" v-show="settingsStore.currentView === 'usage'" />

    <!-- 设置面板（惰性挂载 + v-show 保活，保留表单状态） -->
    <SettingsPanel v-if="languageLoaded && visitedViews.settings" v-show="settingsStore.currentView === 'settings'" />

    <!-- 更新弹窗（发现新版本时提示，全局挂载） -->
    <UpdateModal />
  </div>
</template>

<style scoped>
/* 主容器 - 扁平化设计 */
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
}

/* 聊天视图容器 */
.chat-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  /* 承接 Splash 消散：主界面淡入（v-show 每次显示时播放） */
  animation: view-reveal 0.3s ease-out both;
}

@keyframes view-reveal {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.chat-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

/* 自动总结提示（显示在聊天区域底部） */
.auto-summary-panel {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  z-index: 99;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--vscode-foreground);
  background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.12));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.auto-summary-icon {
  color: var(--vscode-descriptionForeground);
}

.auto-summary-panel > span {
  flex: 1;
  min-width: 0;
}

.auto-summary-cancel-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  opacity: 0.75;
  cursor: pointer;
  border-radius: 4px;
}

.auto-summary-cancel-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.auto-summary-panel.with-retry {
  /* 避开重试面板 */
  bottom: 220px;
}

/* 重试状态面板（黑白灰配色，只有图标用黄色） */
.retry-panel {
  position: absolute;
  bottom: 12px;
  left: 12px;
  right: 12px;
  z-index: 100;
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  max-height: 200px;
}

.retry-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.1);
  border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.2));
}

.warning-icon {
  font-size: 16px;
  color: var(--vscode-charts-yellow, #f0c674);
}

.retry-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.retry-progress-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
  margin-right: 8px;
}

.retry-progress-inline .codicon {
  font-size: 12px;
  color: var(--vscode-charts-yellow, #f0c674);
}

.retry-cancel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s, background 0.15s;
}

.retry-cancel-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.retry-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.retry-error-json {
  font-size: 11px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(0, 0, 0, 0.15);
  padding: 8px;
  border-radius: 4px;
  margin: 0;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.retry-countdown {
  color: var(--vscode-descriptionForeground);
}

/* prefers-reduced-motion：系统级减少动态效果时禁用旋转/淡入动画 */
@media (prefers-reduced-motion: reduce) {
  .spin,
  .chat-view {
    animation: none;
  }
}
</style>