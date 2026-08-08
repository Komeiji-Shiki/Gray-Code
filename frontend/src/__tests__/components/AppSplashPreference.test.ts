import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  setLanguage: runtime.setLanguage
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
      rejectPendingToolsWithAnnotation: vi.fn(),
      sendMessage: vi.fn(),
      cancelStream: vi.fn(),
      editAndRetry: vi.fn(),
      cancelSummarizeRequest: vi.fn(),
      deleteMessage: vi.fn(),
      retryFromMessage: vi.fn()
    }
    runtime.terminalStore = { initialize: vi.fn() }

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
  })

  it('配置请求未返回时不挂载任何偏好专属启动画面', async () => {
    wrapper = mount(App)
    await nextTick()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
  })

  it('配置明确关闭时只在主界面初始化期间显示关闭态占位，从始至终不挂载 Splash', async () => {
    const chatInitialization = deferred<void>()
    runtime.chatStore.initialize.mockReturnValueOnce(chatInitialization.promise)

    wrapper = mount(App)
    await nextTick()
    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)

    settingsRequest.resolve(makeSettingsResponse(false))
    await flushPromises()

    const backdrop = wrapper.get('.startup-backdrop')
    expect(backdrop.attributes('aria-hidden')).toBe('true')
    expect(backdrop.text()).toBe('')
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
    expect(runtime.settingsStore.splashEnabled).toBe(false)

    chatInitialization.resolve()
    await flushPromises()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
  })

  it('配置明确开启时只挂载 Splash，启动全程不显示关闭态占位', async () => {
    wrapper = mount(App)
    await nextTick()
    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)

    settingsRequest.resolve(makeSettingsResponse(true))
    await flushPromises()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(true)

    wrapper.getComponent({ name: 'Splash' }).vm.$emit('done')
    await nextTick()

    expect(wrapper.find('.startup-backdrop').exists()).toBe(false)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
  })

  it('本次启动关闭后，运行中重新开启只影响下次启动，不会突然补播', async () => {
    wrapper = mount(App)
    settingsRequest.resolve(makeSettingsResponse(false))
    await flushPromises()

    runtime.settingsStore.setSplashEnabled(true)
    await nextTick()

    expect(runtime.settingsStore.splashEnabled).toBe(true)
    expect(wrapper.find('[data-testid="splash-stub"]').exists()).toBe(false)
  })
})
