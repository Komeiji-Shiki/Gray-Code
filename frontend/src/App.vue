<script setup lang="ts">
/**
 * App.vue - 主应用组件
 * 使用Pinia store管理状态
 */

import { onMounted, onBeforeUnmount, ref, watch, reactive, computed, defineAsyncComponent } from 'vue'
import { storeToRefs } from 'pinia'
import { MessageList } from './components/message'
import { InputArea } from './components/input'
import BackgroundTaskBar from './components/backgroundTasks/BackgroundTaskBar.vue'
import { WelcomePanel } from './components/home'
import { ConversationTabs } from './components/tabs'
import { CustomScrollbar } from './components/common'
import Splash from './components/Splash.vue'
import StartupBackdrop from './components/StartupBackdrop.vue'
import { useChatStore, useDiffStore, useSettingsStore, useTerminalStore, useCodeViewStore } from './stores'
import { useAttachments } from './composables'
import { useI18n, setLanguage, setDetectedLanguage } from './i18n'
import { copyToClipboard } from './utils'
import { sendToExtension, onMessageFromExtension } from './utils/vscode'
import type { Attachment, Message, StreamChunk } from './types'
import { configureSoundSettings } from './services/soundCues'
import type { SoundAgentRole } from './services/soundCues'
import { handleSoundEvent, registerGlobalAudioUnlockHooks, registerVisibilityChangeHooks, setVscodeWindowFocused } from './services/soundEventController'
import { createAgentStopNotificationController, type AgentStopNotificationController } from './services/agentStopNotificationController'
import { disposeAllSmoothStreams } from './stores/chat/smoothStreamManager'

// 大面板懒加载：历史/用量/设置/Monitor/Diff/代码查看/更新弹窗都改为异步组件，
// 保留既有 visitedViews + v-show 惰性挂载逻辑不变，仅把代码拆到独立 chunk、首次使用时才解析执行。
// 失败兜底：便携版/防病毒/临时目录清理可能让 chunk 加载偶发失败——onError 自动重试（最多 3 次，
// 指数退避），仍失败则渲染降级占位而非静默空白，避免"UI 丢失"。
const lazyRetryCounts = new Map<string, number>()
const MAX_LAZY_RETRIES = 3

function withLazyFallback(name: string, loader: () => Promise<{ default: unknown }>) {
  return defineAsyncComponent({
    loader,
    delay: 0,
    onError(_error, retry, fail) {
      const count = (lazyRetryCounts.get(name) || 0) + 1
      lazyRetryCounts.set(name, count)
      if (count <= MAX_LAZY_RETRIES) {
        setTimeout(retry, count * 400 + Math.random() * 200)
      } else {
        lazyRetryCounts.delete(name)
        fail()
      }
    }
  })
}

const HistoryPage = withLazyFallback('HistoryPage', () => import('./components/history/HistoryPage.vue'))
const UsagePage = withLazyFallback('UsagePage', () => import('./components/usage/UsagePage.vue'))
const SettingsPanel = withLazyFallback('SettingsPanel', () => import('./components/settings/SettingsPanel.vue'))
const SubAgentMonitor = withLazyFallback('SubAgentMonitor', () => import('./components/subagents/SubAgentMonitor.vue'))
const DiffViewerPanel = withLazyFallback('DiffViewerPanel', () => import('./components/diff/DiffViewerPanel.vue'))
const CodeViewPanel = withLazyFallback('CodeViewPanel', () => import('./components/codeView/CodeViewPanel.vue'))
const UpdateModal = withLazyFallback('UpdateModal', () => import('./components/common/UpdateModal.vue'))

// i18n
const { t, actualLanguage } = useI18n()

// SubAgent Monitor 复用同一个前端入口，但不应初始化主聊天时间线。
const isSubAgentMonitor = window.__GRAYCODE_VIEW_MODE === 'subagentMonitor'

// 语言是否已加载
const languageLoaded = ref(false)
// 扩展在生成 Webview HTML 时同步注入本次启动偏好；模块执行与 Vue 挂载无需等待 IPC。
// 浏览器预览等非扩展环境没有注入值时，沿用后端默认的“开启”。
const startupSplashInjected = window.__GRAYCODE_STARTUP_SPLASH_ENABLED !== undefined
// 桌面主窗口直接加载 frontend/dist/index.html、不存在同步注入（Webview 面板/开发模式才注入）。
// 该场景下沿用本地 1.7.6 的响应式门控：设置里关闭开屏动画则完全不渲染 Splash（配合
// gc-splash-disabled 首帧标记），开关即时生效；注入场景则遵循上游语义——
// 本次启动首帧定死、异步配置不中途切换。
const splashActive = computed(() =>
  startupSplashInjected
    ? window.__GRAYCODE_STARTUP_SPLASH_ENABLED !== false
    : settingsStore.splashEnabled
)
// 主界面启动数据是否已完成初始化；关闭开屏动画时据此结束专属占位画面。
const mainViewInitialized = ref(false)
// 开始动画是否已完成（Splash 淡出后置 true，移除组件）
const splashDone = ref(false)

// 使用 Pinia Store
const chatStore = useChatStore()
const settingsStore = useSettingsStore()

// 桌面端远程控制：当前激活会话上报给主进程（移动端 UI 默认跟随电脑正在看的会话）。
// fire-and-forget；VS Code 宿主/远程控制关闭时该消息被忽略或返回 unknown 错误，均无副作用。
watch(
  () => chatStore.currentConversationId,
  (id) => {
    if (id) {
      void sendToExtension('remoteControl.reportActiveConversation', { conversationId: id }).catch(() => {})
    }
  }
)
const terminalStore = useTerminalStore()
const diffStore = useDiffStore()
const codeViewStore = useCodeViewStore()

// 播放错误提示音：同一错误去重，避免重复触发
const lastErrorKey = ref('')
// 从 store 获取原始 Ref（Pinia 会自动解包 ref，storeToRefs 保持 Ref 不被解包）
const { storeAttachments: storeAttachmentsRef, error: errorRef } = storeToRefs(chatStore)
watch(errorRef, (err) => {
  // 仅在错误消息变化时触发一次声音，具体播放由统一控制器处理
  // 这里不再直接调用 playCue，避免绕过过期丢弃与隐藏态折叠逻辑
  // createdAt 使用前端接收到错误变化的当前时间即可

  if (!err) {
    lastErrorKey.value = ''
    return
  }
  const key = `${err.code}:${err.message}`
  if (key === lastErrorKey.value) return
  lastErrorKey.value = key
  void handleSoundEvent({ cue: 'error', source: 'chatError', createdAt: Date.now() })
})

// ============ 声音事件：去重状态 & 辅助函数 ============

/** 已触发过 taskComplete 音效的 toolStatus id 集合（避免同一工具重复播放；有界防泄漏） */
const soundPlayedToolIds = reactive(new Set<string>())
/** 去重集合容量上限：超出后整体清空，防止随会话运行无限增长 */
const SOUND_PLAYED_TOOL_IDS_LIMIT = 500

/** 记录已播放音效的工具 id（带容量上限，防止无限增长） */
function addSoundPlayedToolId(toolId: string): void {
  soundPlayedToolIds.add(toolId)
  if (soundPlayedToolIds.size > SOUND_PLAYED_TOOL_IDS_LIMIT) {
    soundPlayedToolIds.clear()
  }
}

/** 上一次各对话的 TODO 全部完成状态（false→true 时触发音效） */
const todoAllDoneByConv = reactive(new Map<string, boolean>())

/** 上一次重试 attempt 编号（同一 attempt 不重复播放） */
const lastRetryAttempt = ref(-1)

let disposeMessageListener: (() => void) | null = null
let disposeAudioUnlockHooks: (() => void) | null = null
let disposeVisibilityHooks: (() => void) | null = null
let agentStopNotificationController: AgentStopNotificationController | null = null

/**
 * 从 toolStatus chunk 中检测特定工具完成并播放音效：
 * - create_plan 成功 → taskComplete
 * - todo_write / todo_update 导致 TODO 全部完成 → taskComplete
 * - subagents 工具成功/失败 → 子代理独立 taskComplete/taskError（role: subagent）
 */
function dispatchConversationCue(
  cue: 'warning' | 'error' | 'taskComplete' | 'taskError',
  source: 'taskEvent' | 'retryStatus' | 'streamChunk' | 'chatError',
  conversationId?: string,
  createdAt?: number,
  role?: SoundAgentRole
): void {
  void handleSoundEvent({
    cue,
    source,
    conversationId,
    createdAt,
    role
  })
}

function handleSoundForToolStatus(chunk: StreamChunk): void {
  if (!chunk.toolStatus || !chunk.tool) return
  const tool = chunk.tool

  // 去重：同一个 tool id 只播放一次
  if (soundPlayedToolIds.has(tool.id)) return

  // 子代理工具：成功 → 子代理任务完成音；失败 → 子代理任务失败音。
  // 与主聊天工具的提示音开关分开控制（cues.subagent.*）。
  if (tool.name === 'subagents') {
    // 后台模式：工具在启动瞬间即返回 { success: true, data: { background: true } } stub，
    // 真实完成/失败由 taskEvent（background_subagent）送达——若在这里播会「开始就响一次、
    // 完成再响一次」。跳过 stub，交给 taskEvent 路径统一播报。
    const resultData = tool.result?.data as Record<string, unknown> | undefined
    if (tool.status === 'success' && resultData?.background === true) return
    if (tool.status === 'success' || tool.status === 'error') {
      addSoundPlayedToolId(tool.id)
      dispatchConversationCue(
        tool.status === 'error' ? 'taskError' : 'taskComplete',
        'streamChunk',
        chunk.conversationId,
        chunk.createdAt,
        'subagent'
      )
    }
    return
  }

  if (tool.status !== 'success') return

  // create_plan 成功
  if (tool.name === 'create_plan') {
    addSoundPlayedToolId(tool.id)
    dispatchConversationCue('taskComplete', 'streamChunk', chunk.conversationId, chunk.createdAt)
    return
  }

  // todo_write / todo_update 全部完成检测
  if (tool.name === 'todo_write' || tool.name === 'todo_update') {
    const result = tool.result as Record<string, unknown> | undefined
    if (!result) return
    const data = (result.data ?? result) as Record<string, unknown>
    const total = typeof data.total === 'number' ? data.total : -1
    const counts = data.counts as Record<string, number> | undefined
    if (!counts || total <= 0) return

    const pending = typeof counts.pending === 'number' ? counts.pending : -1
    const inProgress = typeof counts.in_progress === 'number' ? counts.in_progress : -1
    const isAllDone = pending === 0 && inProgress === 0

    // 获取对话 id（从 chunk 或当前对话）
    const convId = chunk.conversationId || chatStore.currentConversationId || '__default'
    const wasAllDone = todoAllDoneByConv.get(convId) ?? false

    todoAllDoneByConv.set(convId, isAllDone)

    // 容量上限：防止 Map 随会话运行无限增长；清空时保留当前会话条目，避免当前会话重复播放
    if (todoAllDoneByConv.size > SOUND_PLAYED_TOOL_IDS_LIMIT) {
      const currentValue = todoAllDoneByConv.get(convId)
      todoAllDoneByConv.clear()
      if (currentValue !== undefined) {
        todoAllDoneByConv.set(convId, currentValue)
      }
    }

    // 仅在 false→true 时播放
    if (isAllDone && !wasAllDone) {
      addSoundPlayedToolId(tool.id)
      dispatchConversationCue('taskComplete', 'streamChunk', convId, chunk.createdAt)
    }
  }
}

/**
 * 处理流式 chunk 中的声音事件
 */
function handleSoundForStreamChunk(chunk: StreamChunk): void {
  if (chunk.type === 'complete') {
    dispatchConversationCue('taskComplete', 'streamChunk', chunk.conversationId, chunk.createdAt)
  } else if (chunk.type === 'toolStatus') {
    handleSoundForToolStatus(chunk)
  }
}

/**
 * 仅处理“当前已打开标签页”的有效 chunk，支持多标签页并发提示音。
 *
 * 规则：
 * - 对于当前激活会话：使用 chatStore.activeStreamId 过滤迟到 chunk
 * - 对于后台标签页会话：使用会话快照中的 activeStreamId 过滤迟到 chunk
 */
function shouldHandleSoundForStreamChunk(chunk: StreamChunk): boolean {
  const convId = chunk.conversationId
  if (!convId) return false

  const currentConversationId = chatStore.currentConversationId || null
  const tab = chatStore.openTabs.find(t => t.conversationId === convId)

  // 仅处理“当前会话”或“已打开标签页中的会话”
  if (!tab && convId !== currentConversationId) return false

  const isCurrentConversation = convId === currentConversationId
  const snapshotStreamId = tab ? (chatStore.sessionSnapshots.get(tab.id)?.activeStreamId || null) : null
  // 后台标签页：快照可能因标签页刚打开/流刚启动尚未绑定 streamId 而过期缺失。
  // 快照缺失时回退到与 store 最新 activeStreamId 宽松匹配，避免漏掉后台标签页的声音提示。
  const expectedStreamId = isCurrentConversation
    ? (chatStore.activeStreamId || null)
    : (snapshotStreamId || chatStore.activeStreamId || null)

  // 没有预期 streamId 时，不接收带 streamId 的 chunk（通常是迟到包）
  if (chunk.streamId && !expectedStreamId) return false

  // 预期 streamId 不匹配，丢弃
  if (expectedStreamId && chunk.streamId && chunk.streamId !== expectedStreamId) return false

  return true
}

// 附件管理（传入 store 驱动的 Ref<Attachment[]>，实现对话级隔离）
const {
  attachments,
  uploading,
  addAttachments,
  removeAttachment,
  clearAttachments
} = useAttachments(storeAttachmentsRef)

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

// 处理发送消息
async function handleSend(content: string, messageAttachments: Attachment[], options?: { dynamicContextStrategyOverride?: 'single' | 'preserve' }) {
  if (!content.trim() && messageAttachments.length === 0) return

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

// 处理附件上传
async function handleAttachFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.txt'
  
  input.onchange = async (e) => {
    try {
      const files = Array.from((e.target as HTMLInputElement).files || [])
      if (files.length > 0) {
        try {
          await addAttachments(files)
        } catch (err) {
          console.error('上传附件失败:', err)
        }
      }
    } finally {
      input.remove()
      // 清空闭包引用，避免动态 input 与 FileList 被长期保留
      input.onchange = null
    }
  }

  document.body.appendChild(input)
  input.click()
}

// 处理移除附件
function handleRemoveAttachment(id: string) {
  removeAttachment(id)
}

// 格式化错误详情
function formatErrorDetails(details: any): string {
  const maxLength = 2000
  let result: string
  try {
    if (typeof details === 'string') {
      const parsed = JSON.parse(details)
      result = JSON.stringify(parsed, null, 2)
    } else {
      result = JSON.stringify(details, null, 2)
    }
  } catch {
    result = typeof details === 'string' ? details : String(details)
  }
  return result.length > maxLength ? `${result.slice(0, maxLength)}...` : result
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

// 子页面惰性挂载标记：首次访问后保持挂载（v-show 切换），保留滚动位置与表单状态
const visitedViews = reactive({ history: false, usage: false, settings: false })
watch(() => settingsStore.currentView, (view) => {
  if (view === 'history') visitedViews.history = true
  else if (view === 'usage') visitedViews.usage = true
  else if (view === 'settings') visitedViews.settings = true
}, { immediate: true })

// 子代理 Monitor 内嵌面板：首次打开后保持挂载（v-show），避免流式订阅丢失
const visitedMonitor = ref(false)
watch(() => settingsStore.subAgentMonitorOpen, (open) => {
  if (open) visitedMonitor.value = true
}, { immediate: true })

// Monitor 面板是否可见（聊天视图内且开关打开）——用于向后端通知事件推送开关
const monitorPanelVisible = computed(() =>
  settingsStore.subAgentMonitorOpen && settingsStore.currentView === 'chat'
)

// 变更查看面板：首次打开后保持挂载（v-show），避免重复计算 diff 的代价
const visitedDiff = ref(false)
watch(() => diffStore.open, (open) => {
  if (open) visitedDiff.value = true
}, { immediate: true })

// 变更查看面板是否可见（聊天视图内且面板打开）
const diffPanelVisible = computed(() =>
  diffStore.open && settingsStore.currentView === 'chat'
)

// 代码查看面板：首次打开后保持挂载（v-show），保留滚动位置与已加载内容
const visitedCodeView = ref(false)
watch(() => codeViewStore.open, (open) => {
  if (open) visitedCodeView.value = true
}, { immediate: true })

// 代码查看面板是否可见（聊天视图内且面板打开）
const codePanelVisible = computed(() =>
  codeViewStore.open && settingsStore.currentView === 'chat'
)

// 加载语言设置
function resolveSelectionContextEnabled(appearance: any): boolean {
  if (!appearance) return true
  if (typeof appearance.selectionContextEnabled === 'boolean') {
    return appearance.selectionContextEnabled
  }

  const hasLegacy =
    typeof appearance.selectionContextHoverEnabled === 'boolean' ||
    typeof appearance.selectionContextCodeActionEnabled === 'boolean'

  if (!hasLegacy) return true

  return (appearance.selectionContextHoverEnabled ?? true) ||
    (appearance.selectionContextCodeActionEnabled ?? true)
}

// ============ 桌面端自定义背景图（外观设置） ============
// 背景图内容以 data URL 保存在 settingsStore（不持久化，仅存路径），
// 启动时/设置变更后按 wallpaperPath 经 IPC 读取；文件丢失时静默回退为纯色背景。
async function loadWallpaperImage(filePath: string): Promise<void> {
  if (!filePath) {
    settingsStore.setWallpaperImage('')
    return
  }
  try {
    const result = await sendToExtension<any>('getWallpaperImage', { path: filePath })
    const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl : ''
    settingsStore.setWallpaperImage(dataUrl)
  } catch {
    settingsStore.setWallpaperImage('')
  }
}

// 背景图层样式：覆盖铺满 + 按不透明度渲染（透明度作用于图片层本身，文字层不受影响）
const wallpaperStyle = computed(() => {
  if (!settingsStore.wallpaperImage) return null
  return {
    backgroundImage: `url("${settingsStore.wallpaperImage}")`,
    opacity: settingsStore.wallpaperOpacity / 100
  }
})

// ============ 桌面版主题：仅 Electron 宿主生效 ============
// VS Code 宿主的 vscode-dark/vscode-light class 由 VS Code 自行维护，
// 这里只在独立桌面版按 ui.theme 设置（light/dark/auto）切换 body class。
const isElectronHost = (window as any).__GRAYCODE_HOST === 'electron'

// ============ 开场动画完成信号 + 菜单语言同步（仅 Electron 宿主） ============
// 主进程据此延迟「未打开工作区」等启动提示（弹窗不盖在开场动画上）；
// 语言切换时（含 auto 解析）重建原生菜单文案。VS Code 版无这些宿主能力，跳过。
let splashNotified = false
function notifySplashDone(): void {
  if (splashNotified) return
  splashNotified = true
  if (!isElectronHost) return
  sendToExtension('splashDone', {}).catch(() => { /* 主进程无需应答，失败无害 */ })
}
watch(splashDone, (done) => { if (done) notifySplashDone() })
watch(actualLanguage, (lang) => {
  if (!isElectronHost) return
  sendToExtension('app.setMenuLanguage', { lang }).catch(() => { /* 同上 */ })
})

function resolveDesktopThemeLight(theme?: string): boolean {
  if (theme === 'light') return true
  if (theme === 'dark') return false
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false
}

function applyDesktopTheme(theme?: string): void {
  if (!isElectronHost) return
  const isLight = resolveDesktopThemeLight(theme)
  document.body.classList.toggle('graycode-desktop-theme-light', isLight)
  document.body.classList.toggle('vscode-light', isLight)
  document.body.classList.toggle('vscode-dark', !isLight)
}

let mediaQueryDispose: (() => void) | null = null

function watchDesktopThemeMedia(theme?: string): void {
  mediaQueryDispose?.()
  mediaQueryDispose = null
  if (!isElectronHost || theme !== 'auto') return
  if (typeof window.matchMedia !== 'function') return
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const onChange = () => applyDesktopTheme('auto')
  mq.addEventListener?.('change', onChange)
  mediaQueryDispose = () => mq.removeEventListener?.('change', onChange)
}

async function loadLanguageSettings() {
  try {
    // 「跟随系统（auto）」依赖检测到的系统语言；Electron 版由 preload 注入，
    // 网页版回退 navigator.language。必须在解析 auto 之前设置。
    setDetectedLanguage(
      (window as any).__GRAYCODE_DETECTED_LANG || navigator.language || 'zh-CN'
    )

    const response = await sendToExtension<any>('getSettings', {})
    if (response?.settings?.ui?.language) {
      const lang = response.settings.ui.language
      settingsStore.setLanguage(lang)
      setLanguage(lang)
    } else {
      // 未显式配置过语言时保持默认「跟随系统」
      settingsStore.setLanguage('auto')
      setLanguage('auto')
    }

    // 加载外观设置
    if (response?.settings?.ui?.appearance) {
      const appearance = response.settings.ui.appearance
      settingsStore.setAppearanceLoadingText(appearance.loadingText || '')
      settingsStore.setSelectionContextEnabled(resolveSelectionContextEnabled(appearance))
      settingsStore.setTpsBarEnabled(appearance.tpsBarEnabled !== false)
      settingsStore.setSplashEnabled(appearance.splashEnabled !== false)
      settingsStore.setWallpaperPath(typeof appearance.wallpaperPath === 'string' ? appearance.wallpaperPath : '')
      settingsStore.setWallpaperOpacity(
        typeof appearance.wallpaperOpacity === 'number' ? appearance.wallpaperOpacity : 30
      )
      if (settingsStore.wallpaperPath) {
        loadWallpaperImage(settingsStore.wallpaperPath)
      }
    }

    // 应用桌面版主题（light / dark / auto）
    applyDesktopTheme(response?.settings?.ui?.theme)
    watchDesktopThemeMedia(response?.settings?.ui?.theme)

    // 加载声音提醒设置（不依赖 store，直接配置运行时服务）
    configureSoundSettings(response?.settings?.ui?.sound)
  } catch (error) {
    console.error('Failed to load language settings:', error)
  } finally {
    languageLoaded.value = true
    // 启动里程碑：UI 可用（Splash ready 信号）时刻（配合 GRAYCODE_DIAG 主进程计时定位热点）
    console.info(`[startup] renderer languageLoaded at ${Date.now()}`)
    // 开场动画已关闭（设置里关闭开屏动画）：没有动画可等，立即通知主进程，
    // 「未打开工作区」等提示不必等动画时长；动画开启时由 Splash done 事件上报。
    if (!settingsStore.splashEnabled) notifySplashDone()
  }
}

// 组件挂载
onMounted(async () => {
  // 移除首帧静态启动画面（#gc-boot）：Vue 已接管渲染（splash 关闭/监视窗等
  // 不渲染 Splash 组件的场景也在此兜底移除；Splash.vue 挂载时同样会移除）
  document.querySelector('#gc-boot')?.remove()

  if (isSubAgentMonitor) {
    // 修改原因：Monitor 复用同一前端入口但过去直接 return，从不加载语言设置；
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

  // Notify the extension that the webview is ready to receive command messages.
  sendToExtension('webviewReady', {}).catch(error => {
    console.error('[App] Failed to notify extension that webview is ready:', error)
  })
  
  // 初始化终端 store（监听终端输出事件）
  terminalStore.initialize()

  disposeAudioUnlockHooks = registerGlobalAudioUnlockHooks()
  disposeVisibilityHooks = registerVisibilityChangeHooks()
  
  // 异步初始化 chatStore（加载历史对话等）。关闭开屏动画时，专属占位持续到这一步结束。
  // 与语言/设置加载无数据依赖（各写独立 store），并行启动缩短开屏/占位时长：
  // initialize 内部的 streamChunk/workspace 监听在调用瞬间同步注册，IPC 应答经
  // sendToExtension 的 per-request 处理器送达，不受下方命令监听器注册顺序影响。
  const chatInit = chatStore.initialize().catch((err) => {
    console.error('[App] chatStore.initialize failed', err)
  })

  // 先加载语言设置，确保 UI 语言正确
  await loadLanguageSettings()

  agentStopNotificationController = createAgentStopNotificationController({
    chatStore,
    sendToExtension
  })
  
  // 立即注册命令监听器，确保在初始化期间也能响应用户操作
  disposeMessageListener = onMessageFromExtension((message: any) => {
    if (message.type === 'command') {
      switch (message.command) {
        case 'newChat':
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
        case 'host.openSubAgentMonitor':
          settingsStore.openSubAgentMonitor(message.data?.runId)
          break
        case 'host.openDiffPreview':
          // 变更查看：vscode.diff 拦截 → 内嵌面板（非独立窗口）
          diffStore.push({
            previewId: message.data?.previewId || '',
            sessionId: message.data?.sessionId,
            title: message.data?.title || '',
            filePath: message.data?.filePath || '',
            originalContent: message.data?.originalContent ?? '',
            newContent: message.data?.newContent ?? ''
          })
          break
        case 'windowFocusChanged':
          // 窗口焦点状态：音效控制器据此决定是否播放提示音（聚焦时不播放）
          setVscodeWindowFocused(message.data?.focused === true)
          break
      }
    }

    // 后端 diff 状态推送 → 同步变更面板内的条目状态与删除警戒
    // 注意：后端经 sendCommand 发送，type 为 'command'
    if (message.type === 'command' && message.command === 'diff.statusChanged') {
      diffStore.syncStatuses(message.data)
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
      const status = message.data
      if (status?.type === 'retrying') {
        const attempt = typeof status.attempt === 'number' ? status.attempt : -1
        if (attempt !== lastRetryAttempt.value) {
          lastRetryAttempt.value = attempt
          const convId = typeof status.conversationId === 'string' ? status.conversationId : undefined
          dispatchConversationCue('warning', 'retryStatus', convId, status?.createdAt)
        }
      } else {
        // retrySuccess / retryFailed -> 重置 attempt 去重计数
        lastRetryAttempt.value = -1
      }
    }
  })
  
  // 并行初始化完成（含失败兜底）后结束关闭态占位
  await chatInit
  mainViewInitialized.value = true
})

onBeforeUnmount(() => {
  disposeMessageListener?.()
  disposeMessageListener = null

  disposeAudioUnlockHooks?.()
  disposeAudioUnlockHooks = null

  disposeVisibilityHooks?.()
  disposeVisibilityHooks = null

  mediaQueryDispose?.()
  mediaQueryDispose = null

  agentStopNotificationController?.dispose()
  agentStopNotificationController = null

  // M-7：注销 terminalStore 的扩展消息监听（onMessageFromExtension 取消函数）
  terminalStore.dispose?.()

  // H1：webview 卸载兜底——销毁所有平滑流式实例（防泄漏；显示文本随 webview 一起销毁）
  disposeAllSmoothStreams()
})
</script>

<template>
  <SubAgentMonitor v-if="isSubAgentMonitor" />
  <div v-else class="app-container">
    <!-- 桌面端自定义背景图（外观设置；透明度作用于图片层本身，内容层不受影响） -->
    <div
      v-if="settingsStore.wallpaperImage && settingsStore.wallpaperPath"
      class="app-wallpaper"
      :style="wallpaperStyle"
    ></div>

    <!-- 关闭态占位与 Splash 从 HTML 首帧起就依据同一个同步快照严格互斥（桌面主窗口无注入快照时仅用响应式门控） -->
    <StartupBackdrop v-if="startupSplashInjected && !splashActive && !mainViewInitialized" />

    <Splash
      v-if="!splashDone && splashActive"
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

      <!-- 主聊天区域：左侧聊天 + 右侧子代理 Monitor 内嵌面板 -->
      <div class="chat-body">
        <div class="chat-main">
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

          <!-- 后台任务状态条（有任务时显示） -->
          <BackgroundTaskBar />

          <!-- 输入区域（始终显示） -->
          <InputArea
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

        <!-- 子代理 Monitor 内嵌面板（惰性挂载 + v-show 保活） -->
        <aside
          v-if="languageLoaded && visitedMonitor"
          v-show="monitorPanelVisible"
          class="monitor-panel"
        >
          <SubAgentMonitor
            :visible="monitorPanelVisible"
            :focus-run-id="settingsStore.monitorFocusRunId"
            :embedded="true"
            @close="settingsStore.closeSubAgentMonitor()"
          />
        </aside>

        <!-- 变更查看面板（内嵌 GitHub 风格抽屉，覆盖主聊天区域，非独立窗口） -->
        <DiffViewerPanel
          v-if="languageLoaded && visitedDiff"
          :visible="diffPanelVisible"
          @close="diffStore.close()"
        />

        <!-- 代码查看面板（内嵌抽屉，支持基础语法报错检查） -->
        <CodeViewPanel
          v-if="languageLoaded && visitedCodeView"
          :visible="codePanelVisible"
          @close="codeViewStore.close()"
        />

        <!-- 面板快捷入口 dock（右下角，不遮挡输入区） -->
        <div v-if="languageLoaded" class="view-dock">
          <button
            class="view-dock-btn"
            :class="{ active: diffPanelVisible }"
            type="button"
            :title="t('components.diff.title')"
            @click="diffPanelVisible ? diffStore.close() : diffStore.openPanel()"
          >
            <span class="codicon codicon-diff"></span>
          </button>
          <button
            class="view-dock-btn"
            :class="{ active: codePanelVisible }"
            type="button"
            :title="t('components.codeView.title')"
            @click="codePanelVisible ? codeViewStore.close() : codeViewStore.openEmpty()"
          >
            <span class="codicon codicon-code"></span>
          </button>
        </div>
      </div>
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
  /* 建立层叠上下文：背景图层（z-index:-1）渲染在容器纯色背景之上、全部内容之下 */
  isolation: isolate;
}

/* 桌面端自定义背景图图层：覆盖铺满整窗，不响应鼠标事件 */
.app-wallpaper {
  position: fixed;
  inset: 0;
  z-index: -1;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  pointer-events: none;
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

/* 聊天主体：左侧聊天 + 右侧 Monitor 面板（flex 行布局）；变更面板为绝对定位抽屉 */
.chat-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.chat-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
}

/* 子代理 Monitor 内嵌面板（右侧分区） */
.monitor-panel {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 400px;
  max-width: 60%;
  min-width: 260px;
  min-height: 0;
  border-left: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  background: var(--vscode-editor-background);
  overflow: hidden;
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

/* 重试状态面板（黑白灰配色，只有图标用黄色）
   修改原因：旧背景 rgba(127,127,127,0.1) 透明度太高，面板叠加在聊天区上近乎透明，
   错误信息与重试进度几乎不可读；header 与错误块同样用低透明度叠加。
   修改方式：全部换成不透明背景（editorWidget/tabsBackground/codeBlock），
   仅在主题变量缺失时回退到深色实体色。 */
.retry-panel {
  position: absolute;
  bottom: 12px;
  left: 12px;
  right: 12px;
  z-index: 100;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border, #454545);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  max-height: 200px;
}

.retry-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorGroupHeader-tabsBackground, #2d2d30);
  border-bottom: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.3));
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
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
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

/* 面板快捷入口 dock（右下角浮动，位于输入区上方） */
.view-dock {
  position: absolute;
  right: 16px;
  bottom: 68px;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.view-dock-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.15));
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  font-size: 15px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  transition: color 0.15s, background 0.15s;
}

.view-dock-btn:hover {
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.25));
}

.view-dock-btn.active {
  color: var(--vscode-textLink-foreground, #3794ff);
  border-color: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 50%, transparent);
}

</style>