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
  diffStore: undefined as any,
  codeViewStore: undefined as any,
  sendToExtension: vi.fn(),
  onMessageFromExtension: vi.fn(() => vi.fn()),
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
  useTerminalStore: () => runtime.terminalStore,
  useDiffStore: () => runtime.diffStore,
  useCodeViewStore: () => runtime.codeViewStore
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
vi.mock('../../components/common/UpdateModal.vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/common/UpdateModal.vue')>()
  return {
    ...actual,
    default: { name: 'UpdateModal', template: '<div />' }
  }
})
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
  setDetectedLanguage: vi.fn()
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
      setWallpaperPath: vi.fn(),
      setWallpaperOpacity: vi.fn(),
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
    runtime.diffStore = { open: ref(false), openPanel: vi.fn(), close: vi.fn(), push: vi.fn(), syncStatuses: vi.fn() }
    runtime.codeViewStore = { open: ref(false), openEmpty: vi.fn(), close: vi.fn() }

    runtime.preloadChannelConfigs.mockClear()

    runtime.sendToExtension.mockReset()
    runtime.sendToExtension.mockImplementation((type: string) => {
      if (type === 'getSettings') return settingsRequest.promise
      return Promise.resolve({ success: true })
    })
    runtime.onMessageFromExtension.mockClear()
    runtime.configureSoundSettings.mockClear()
    runtime.setLanguage.mockClear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete window.__GRAYCODE_STARTUP_SPLASH_ENABLED
  })

  test('同步偏好开启时首帧立即挂载 Splash，不等待配置请求返回', async () => {
    wrapper = mount(App)
    await nextTick()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(true)
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
