import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const runtime = vi.hoisted(() => ({
  chatStore: undefined as any,
  settingsStore: undefined as any,
  terminalStore: undefined as any,
  preloadChannelConfigs: vi.fn().mockResolvedValue(undefined),
  sendToExtension: vi.fn(),
  onMessageFromExtension: vi.fn(),
  messageHandler: undefined as ((message: any) => void) | undefined,
  configureSoundSettings: vi.fn(),
  setLanguage: vi.fn(),
  cleanupAudioHooks: vi.fn(),
  cleanupVisibilityHooks: vi.fn(),
  disposeAgentStopController: vi.fn()
}))

vi.mock('pinia', () => ({
  storeToRefs: (store: any) => ({
    storeAttachments: store.__storeAttachments,
    error: store.__error
  })
}))

vi.mock('../../stores', () => ({
  useChatStore: () => runtime.chatStore,
  useSettingsStore: () => runtime.settingsStore,
  useTerminalStore: () => runtime.terminalStore
}))

vi.mock('../../components/message', () => ({
  MessageList: { name: 'MessageList', template: '<div />' }
}))
vi.mock('../../components/input', () => ({
  InputArea: { name: 'InputArea', template: '<div />' }
}))
vi.mock('../../components/home', () => ({
  WelcomePanel: { name: 'WelcomePanel', template: '<div />' }
}))
vi.mock('../../components/history', () => ({
  HistoryPage: { name: 'HistoryPage', template: '<div />' }
}))
vi.mock('../../components/usage', () => ({
  UsagePage: { name: 'UsagePage', template: '<div />' }
}))
vi.mock('../../components/settings', () => ({
  SettingsPanel: { name: 'SettingsPanel', template: '<div />' }
}))
vi.mock('../../components/tabs', () => ({
  ConversationTabs: { name: 'ConversationTabs', template: '<div />' }
}))
vi.mock('../../components/common', () => ({
  CustomScrollbar: { name: 'CustomScrollbar', template: '<div><slot /></div>' }
}))
vi.mock('../../components/backgroundTasks/BackgroundTaskBar.vue', () => ({
  default: { name: 'BackgroundTaskBar', template: '<div />' }
}))
vi.mock('../../components/common/UpdateModal.vue', () => ({
  default: { name: 'UpdateModal', template: '<div />' }
}))
vi.mock('../../components/subagents/SubAgentMonitor.vue', () => ({
  default: { name: 'SubAgentMonitor', template: '<div />' }
}))
vi.mock('../../components/Splash.vue', () => ({
  default: {
    name: 'Splash',
    props: { ready: Boolean },
    emits: ['done'],
    template: '<div data-testid="splash-stub" />'
  }
}))

// 启动预加载渠道配置：测试环境不真实发起 IPC，mock 掉避免请求噪音
vi.mock('../../services/channelConfigCache', () => ({
  preloadChannelConfigs: runtime.preloadChannelConfigs
}))

vi.mock('../../composables', () => ({
  useAttachments: () => ({
    attachments: [],
    uploading: false,
    addAttachments: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn()
  })
}))

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  setLanguage: runtime.setLanguage,
  SUPPORTED_LANGUAGES: [
    { value: 'auto', labelKey: 'components.settings.settingsPanel.language.followSystem', label: 'Auto', nativeLabel: 'Auto' },
    { value: 'zh-CN', label: '简体中文', nativeLabel: '简体中文' },
    { value: 'en', label: 'English', nativeLabel: 'English' },
    { value: 'ja', label: '日本語', nativeLabel: '日本語' }
  ]
}))

vi.mock('../../utils', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true)
}))

vi.mock('../../utils/vscode', () => ({
  sendToExtension: runtime.sendToExtension,
  onMessageFromExtension: runtime.onMessageFromExtension
}))

vi.mock('../../services/soundCues', () => ({
  configureSoundSettings: runtime.configureSoundSettings
}))

vi.mock('../../services/soundEventController', () => ({
  handleSoundEvent: vi.fn().mockResolvedValue(undefined),
  registerGlobalAudioUnlockHooks: vi.fn(() => runtime.cleanupAudioHooks),
  registerVisibilityChangeHooks: vi.fn(() => runtime.cleanupVisibilityHooks),
  setVscodeWindowFocused: vi.fn()
}))

vi.mock('../../services/agentStopNotificationController', () => ({
  createAgentStopNotificationController: vi.fn(() => ({
    markUserCancelled: vi.fn(),
    clearUserCancelled: vi.fn(),
    dispose: runtime.disposeAgentStopController
  }))
}))

vi.mock('../../stores/chat/smoothStreamManager', () => ({
  disposeAllSmoothStreams: vi.fn()
}))

import App from '../../App.vue'

function makeSettingsResponse(splashEnabled: boolean) {
  return {
    settings: {
      ui: {
        language: 'zh-CN',
        appearance: {
          splashEnabled,
          tpsBarEnabled: true
        }
      }
    }
  }
}

describe('App 开屏动画启动偏好', () => {
  let settingsRequest: Deferred<any>
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    settingsRequest = deferred<any>()
    window.__GRAYCODE_STARTUP_SPLASH_ENABLED = true

    const settingsStore = reactive({
      currentView: 'chat',
      splashEnabled: true,
      setLanguage: vi.fn(),
      setAppearanceLoadingText: vi.fn(),
      setSelectionContextEnabled: vi.fn(),
      setTpsBarEnabled: vi.fn(),
      setSplashEnabled: vi.fn((enabled: boolean) => {
        settingsStore.splashEnabled = enabled
      }),
      showChat: vi.fn(),
      showHistory: vi.fn(),
      showUsage: vi.fn(),
      showSettings: vi.fn()
    })

    runtime.settingsStore = settingsStore
    runtime.chatStore = {
      __storeAttachments: ref([]),
      __error: ref(null),
      currentConversationId: null,
      activeStreamId: null,
      openTabs: [],
      activeTabId: null,
      sessionSnapshots: new Map(),
      showEmptyState: true,
      messages: [],
      allMessages: [],
      autoSummaryStatus: null,
      retryStatus: null,
      hasPendingToolConfirmation: false,
      initialize: vi.fn().mockResolvedValue(undefined),
      createNewConversation: vi.fn(),
      createNewTab: vi.fn(),
      switchTab: vi.fn(),
      closeTab: vi.fn(),
      reorderTab: vi.fn(),
      sendMessage: vi.fn(),
      cancelStream: vi.fn(),
      cancelStreamAndRejectTools: vi.fn(),
      editAndRetry: vi.fn(),
      cancelSummarizeRequest: vi.fn(),
      deleteMessage: vi.fn(),
      retryFromMessage: vi.fn()
    }
    runtime.terminalStore = { initialize: vi.fn() }

    runtime.preloadChannelConfigs.mockClear()

    runtime.sendToExtension.mockReset()
    runtime.sendToExtension.mockImplementation((type: string) => {
      if (type === 'getSettings') return settingsRequest.promise
      return Promise.resolve({ success: true })
    })
    runtime.onMessageFromExtension.mockReset()
    runtime.messageHandler = undefined
    runtime.onMessageFromExtension.mockImplementation((handler: (message: any) => void) => {
      runtime.messageHandler = handler
      return vi.fn()
    })
    runtime.configureSoundSettings.mockClear()
    runtime.setLanguage.mockClear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete window.__GRAYCODE_STARTUP_SPLASH_ENABLED
  })

  test('发送失败的附件只恢复到原标签快照', async () => {
    const send = deferred<boolean>()
    runtime.chatStore.activeTabId = 'tab-a'
    runtime.chatStore.sendMessage.mockReturnValue(send.promise)
    const snapshot = { attachments: [] }
    runtime.chatStore.sessionSnapshots.set('tab-a', snapshot)
    wrapper = mount(App)
    settingsRequest.resolve(makeSettingsResponse(true))
    await flushPromises()
    const attachment = { id: 'attachment-a', name: 'a.png', type: 'image', mimeType: 'image/png', size: 1 }
    const onResult = vi.fn()
    wrapper.getComponent({ name: 'InputArea' }).vm.$emit('send', 'A', [attachment], undefined, onResult)
    runtime.chatStore.activeTabId = 'tab-b'
    runtime.chatStore.__storeAttachments.value = []
    send.resolve(false)
    await flushPromises()
    expect(runtime.chatStore.__storeAttachments.value).toEqual([])
    expect(snapshot.attachments).toEqual([attachment])
    expect(onResult).toHaveBeenCalledWith(false)
  })

  test('等待拒绝工具期间切换标签，不向新标签发送旧正文', async () => {
    const cancel = deferred<void>()
    runtime.chatStore.activeTabId = 'tab-a'
    runtime.chatStore.hasPendingToolConfirmation = true
    runtime.chatStore.cancelStreamAndRejectTools.mockReturnValue(cancel.promise)
    wrapper = mount(App)
    settingsRequest.resolve(makeSettingsResponse(true))
    await flushPromises()
    const onResult = vi.fn()
    wrapper.getComponent({ name: 'InputArea' }).vm.$emit('send', 'A', [], undefined, onResult)
    runtime.chatStore.activeTabId = 'tab-b'
    cancel.resolve()
    await flushPromises()
    expect(runtime.chatStore.sendMessage).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith(false)
  })

  test('同步偏好开启时首帧立即挂载 Splash，不等待配置请求返回', async () => {
    wrapper = mount(App)
    await nextTick()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(true)
  })

  test('先注册扩展命令监听器，再发送 webviewReady 握手', async () => {
    wrapper = mount(App)
    await nextTick()

    const readyCallIndex = runtime.sendToExtension.mock.calls.findIndex(call => call[0] === 'webviewReady')
    expect(readyCallIndex).toBeGreaterThanOrEqual(0)
    expect(runtime.onMessageFromExtension.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.sendToExtension.mock.invocationCallOrder[readyCallIndex]
    )
  })

  test('BackendHost 初始化未完成时收到 newChat 命令也立即创建，不挂起等待初始化 Promise', async () => {
    const chatInitialization = deferred<void>()
    runtime.chatStore.initialize.mockReturnValueOnce(chatInitialization.promise)

    wrapper = mount(App)
    await nextTick()

    // getSettings 仍在途时就必须启动 initialize 的同步准备段；不能等语言请求返回后才建空白标签页。
    expect(runtime.chatStore.initialize).toHaveBeenCalledTimes(1)
    expect(runtime.messageHandler).toBeTypeOf('function')

    runtime.messageHandler!({ type: 'command', command: 'newChat' })
    await nextTick()

    expect(runtime.chatStore.createNewConversation).toHaveBeenCalledTimes(1)
    expect(runtime.settingsStore.showChat).toHaveBeenCalledTimes(1)

    // 两条启动请求随后完成，也不能把同一条命令重复执行。
    settingsRequest.resolve(makeSettingsResponse(true))
    chatInitialization.resolve()
    await flushPromises()
    expect(runtime.chatStore.createNewConversation).toHaveBeenCalledTimes(1)
  })

  test('语言已加载但聊天初始化仍在途时结束 Splash 并挂载输入区', async () => {
    const chatInitialization = deferred<void>()
    runtime.chatStore.initialize.mockReturnValueOnce(chatInitialization.promise)

    wrapper = mount(App)
    settingsRequest.resolve(makeSettingsResponse(true))
    await flushPromises()

    // 启动即触发渠道配置预加载（开屏动画期间完成，首次打开渠道页命中缓存）。
    expect(runtime.preloadChannelConfigs).toHaveBeenCalled()

    // initialize() 的首个 await 前已完成本地空白标签页准备；后端加载不能继续锁住主界面。
    expect(wrapper.getComponent({ name: 'Splash' }).props('ready')).toBe(true)
    expect(wrapper.findComponent({ name: 'InputArea' }).exists()).toBe(true)
    // 预加载走 channelConfigCache 模块（幂等、静默失败），App 不直接发 config.listConfigs IPC。
    expect(runtime.sendToExtension.mock.calls.some(call => call[0] === 'config.listConfigs')).toBe(false)

    // 完整聊天初始化随后落定，界面保持可用且预加载不随初始化重复触发。
    chatInitialization.resolve()
    await flushPromises()

    expect(runtime.preloadChannelConfigs).toHaveBeenCalledTimes(1)
    expect(runtime.sendToExtension.mock.calls.some(call => call[0] === 'config.listConfigs')).toBe(false)
  })

  test('同步偏好关闭时首帧立即显示关闭态占位，从始至终不挂载 Splash', async () => {
    window.__GRAYCODE_STARTUP_SPLASH_ENABLED = false
    const chatInitialization = deferred<void>()
    runtime.chatStore.initialize.mockReturnValueOnce(chatInitialization.promise)

    wrapper = mount(App)
    await nextTick()

    const initialBackdrop = wrapper.get('.startup-backdrop')
    expect(initialBackdrop.attributes('aria-hidden')).toBe('true')
    expect(initialBackdrop.text()).toBe('')
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)

    settingsRequest.resolve(makeSettingsResponse(false))
    await flushPromises()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(true)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
    expect(runtime.settingsStore.splashEnabled).toBe(false)

    chatInitialization.resolve()
    await flushPromises()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
  })

  test('同步偏好开启时启动全程只显示 Splash，异步配置不会切入关闭态占位', async () => {
    wrapper = mount(App)
    await nextTick()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(true)

    // 模拟 HTML 生成后设置被外部改动：本次启动仍使用生成 HTML 时冻结的快照。
    settingsRequest.resolve(makeSettingsResponse(false))
    await flushPromises()

    expect(runtime.settingsStore.splashEnabled).toBe(false)
    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(true)

    wrapper.getComponent({ name: 'Splash' }).vm.$emit('done')
    await nextTick()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
  })

  test('本次启动关闭后，运行中重新开启只影响下次启动，不会突然补播', async () => {
    window.__GRAYCODE_STARTUP_SPLASH_ENABLED = false
    wrapper = mount(App)
    settingsRequest.resolve(makeSettingsResponse(false))
    await flushPromises()

    runtime.settingsStore.setSplashEnabled(true)
    await nextTick()

    expect(runtime.settingsStore.splashEnabled).toBe(true)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
  })
})
