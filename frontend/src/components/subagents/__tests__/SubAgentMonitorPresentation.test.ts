import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent, onMounted } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MESSAGE_NAMES } from '@shared/protocol'
import { t } from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'
import { useLanguageSettings } from '@/composables/useLanguageSettings'
import SubAgentMonitor from '../SubAgentMonitor.vue'
import type { SubAgentRunContentWindowState } from '../monitorWindowState'

const bridge = vi.hoisted(() => ({ send: vi.fn(), listeners: new Set<(message: any) => void>() }))
vi.mock('@/utils/vscode', () => ({
  sendToExtension: bridge.send,
  onMessageFromExtension: (listener: (message: any) => void) => { bridge.listeners.add(listener); return () => bridge.listeners.delete(listener) },
  showNotification: vi.fn()
}))
vi.mock('@/stores/chatStore', () => ({ useChatStore: () => ({ checkpoints: [], allMessages: [], smoothTexts: new Map() }) }))
vi.mock('@/services/soundEventController', () => ({ setVscodeWindowFocused: vi.fn(), handleSoundEvent: vi.fn() }))
vi.mock('@/services/soundCues', () => ({ configureSoundSettings: vi.fn() }))
vi.mock('../../common', async () => ({ CustomScrollbar: (await import('../../common/CustomScrollbar.vue')).default, MarkdownRenderer: { template: '<div />' } }))

const Harness = defineComponent({
  components: { SubAgentMonitor },
  setup() {
    // App 的独立 Monitor 分支使用同一设置加载入口，不初始化主聊天。
    const { loadLanguageSettings } = useLanguageSettings(useSettingsStore())
    onMounted(loadLanguageSettings)
  },
  template: '<SubAgentMonitor />'
})
const stubs = {
  MessageActions: true, MessageAttachments: true, InlineContextMessage: true, MessageTaskCards: true,
  ResponseViewerDialog: true, MessageRenderBlock: true, MarkdownRenderer: true, RetryDialog: true, EditDialog: true
}
let wrapper: VueWrapper | undefined
let loadingText = '定制流式✨'
let currentWindow: SubAgentRunContentWindowState
function dispatch(message: any) { for (const listener of bridge.listeners) listener(message) }
function status(value: string, active = true) {
  dispatch({ type: 'subagentMonitor.event', data: { manifest: { runId: 'a', status: value }, activeRunIds: active ? ['a'] : [] } })
}

beforeEach(() => {
  vi.clearAllMocks()
  bridge.listeners.clear()
  loadingText = '定制流式✨'
  currentWindow = { runId: 'a', startIndex: 6, endIndex: 8, totalCount: 8, contentRevision: 1, eventSequence: 1,
    floorIndices: [1, 2, 4, 6, 7], hasMoreBefore: true, hasMoreAfter: false,
    contents: [6, 7].map(index => ({ role: 'model', index, parts: [{ text: `reply ${index}` }] })) }
  bridge.send.mockImplementation((type: string) => {
    if (type === MESSAGE_NAMES.getSettings) return Promise.resolve({ settings: { ui: { appearance: { loadingText } } } })
    if (type === MESSAGE_NAMES['subagents.monitorReady']) return Promise.resolve({ manifests: [{ runId: 'a', status: 'running', streamingContentIndex: 7, createdAt: 1, updatedAt: 2, contentCount: currentWindow.totalCount, contentRevision: 1, eventCount: 0 }], focusRunId: 'a', activeRunIds: ['a'] })
    if (type === MESSAGE_NAMES['subagents.monitor.getRunWindow']) return Promise.resolve({ window: currentWindow, activeRunIds: ['a'] })
    return Promise.resolve({})
  })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

async function mountMonitor() {
  wrapper = mount(Harness, { global: { plugins: [createPinia()], stubs } })
  await flushPromises()
  return wrapper
}

describe('Monitor 复用真实 MessageItem / StreamingIndicator', () => {
  test('独立入口加载已保存文案；设置保存和清空实时响应，不重拉历史', async () => {
    const view = await mountMonitor()
    expect(view.findAll('.message-floor').map(floor => floor.text())).toEqual(['#4', '#5'])
    expect(view.findAll('.streaming-indicator')).toHaveLength(1)
    expect(view.get('.streaming-indicator').attributes('aria-label')).toBe('定制流式✨')
    expect(view.get('.streaming-indicator').findAll('.streaming-indicator__char')).toHaveLength(Array.from(loadingText).length)
    const historyCalls = bridge.send.mock.calls.filter(([type]) => type === MESSAGE_NAMES['subagents.monitor.getRunWindow']).length
    loadingText = '新的文案'
    dispatch({ type: 'settingsChanged' })
    await flushPromises()
    expect(view.get('.streaming-indicator').attributes('aria-label')).toBe('新的文案')
    loadingText = ''
    dispatch({ type: 'settingsChanged' })
    await flushPromises()
    expect(view.get('.streaming-indicator').attributes('aria-label')).toBe(t('common.loading'))
    expect(bridge.send.mock.calls.filter(([type]) => type === MESSAGE_NAMES['subagents.monitor.getRunWindow'])).toHaveLength(historyCalls)
  })

  test('暂停、等待处理、完成和历史不会残留Loading，恢复实际运行才重新显示', async () => {
    const view = await mountMonitor()
    for (const state of ['paused', 'awaiting_monitor_action', 'queued', 'completed', 'failed', 'cancelled', 'interrupted']) {
      status(state)
      await flushPromises()
      expect(view.find('.streaming-indicator').exists()).toBe(false)
    }
    status('running')
    await flushPromises()
    expect(view.findAll('.streaming-indicator')).toHaveLength(1)
    status('running', false)
    await flushPromises()
    expect(view.find('.streaming-indicator').exists()).toBe(false)
  })

  test('首delta前复用Loading占位，流式接入同楼层；模型落盘后running工具阶段也不继续Loading', async () => {
    currentWindow = { ...currentWindow, totalCount: 7, endIndex: 7, floorIndices: [1, 2, 4, 6], contents: [{ role: 'user', index: 6, parts: [{ text: 'task' }] }] }
    const view = await mountMonitor()
    expect(view.findAll('.message-item')).toHaveLength(2)
    expect(view.findAll('.message-floor').map(floor => floor.text())).toEqual(['#4', '#5'])
    expect(view.get('[data-message-id="a_7"] .streaming-indicator').attributes('aria-label')).toBe(loadingText)
    dispatch({ type: 'subagentMonitor.event', data: { manifest: { runId: 'a', status: 'running', streamingContentIndex: 7 }, activeRunIds: ['a'],
      event: { runId: 'a', type: 'llm_delta', timestamp: 1000, contentRevision: 1, eventSequence: 2, payload: { delta: [{ text: 'first output' }] } } } })
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(view.findAll('[data-message-id="a_7"]')).toHaveLength(1)
    expect(view.findAll('.message-floor').map(floor => floor.text())).toEqual(['#4', '#5'])
    expect(view.get('[data-message-id="a_7"] .streaming-indicator').attributes('aria-label')).toBe(loadingText)
    dispatch({ type: 'subagentMonitor.event', data: { manifest: { runId: 'a', status: 'running', streamingContentIndex: null }, activeRunIds: ['a'] } })
    await flushPromises()
    expect(view.find('.streaming-indicator').exists()).toBe(false)
  })

  test('设置读取乱序不覆盖新文案，卸载移除监听', async () => {
    const view = await mountMonitor()
    let resolveOld!: (value: unknown) => void
    bridge.send.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    dispatch({ type: 'settingsChanged' })
    loadingText = 'latest'
    dispatch({ type: 'settingsChanged' })
    await flushPromises()
    resolveOld({ settings: { ui: { appearance: { loadingText: 'stale' } } } })
    await flushPromises()
    expect(view.get('.streaming-indicator').attributes('aria-label')).toBe('latest')
    view.unmount()
    expect(bridge.listeners.size).toBe(0)
    wrapper = undefined
  })
})
