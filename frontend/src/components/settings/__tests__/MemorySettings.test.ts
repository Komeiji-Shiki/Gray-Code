/**
 * MemorySettings 设置页测试（记忆隔离分区）
 *
 * 覆盖：
 * - 作用域切换即时渲染：切回已加载过的作用域时，条目立刻渲染（走缓存），
 *   不经过加载占位中间态——防止「工作区→全局」切换时列表高度塌陷造成一帧空白闪烁
 *   （回归：录屏不可见、肉眼可见的单帧闪烁）
 * - 未选择工作区时不发请求：工作区 tab 刚打开、scope 列表未就绪时不误拉全局数据
 * - 切换后请求带正确 workspaceUri；过期响应不覆盖新作用域（seq 竞态守卫）
 */
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import MemorySettings from '../MemorySettings.vue'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn()
}))

vi.mock('@/utils/vscode', () => ({
  sendToExtension: sendMock
}))

vi.mock('@/stores', () => ({
  useSettingsStore: () => ({ language: 'zh-CN' })
}))

import { sendToExtension } from '@/utils/vscode'
const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

// CustomCheckbox 桩：渲染按钮，点击时以取反值触发 update:modelValue
const CustomCheckboxStub = defineComponent({
  name: 'CustomCheckbox',
  props: {
    modelValue: { type: [Boolean, Array, String, Number], default: undefined },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  template: `<button class="cb-stub" :disabled="disabled" @click="$emit('update:modelValue', !modelValue)" />`
})

const GLOBAL_STUBS = {
  CustomCheckbox: CustomCheckboxStub,
  ConfirmDialog: true
}

const GLOBAL_ENTRIES = [
  { id: 0, date: '2026-08-01', text: 'global-memory-alpha' },
  { id: 1, date: '2026-08-02', text: 'global-memory-beta' }
]
const WS_ENTRIES = [
  { id: 0, date: '2026-08-03', text: 'workspace-memory-gamma' }
]
const WS_URI = 'file:///C:/projects/demo-project'
const BASE_CONFIG = {
  enabled: true,
  systemPrompt: '',
  wakeLines: 96,
  entryChars: 280,
  partChars: 20000,
  partLines: 500
}

/** 默认 IPC 路由：全局记忆（mount 时加载）+ 工作区记忆 */
function defaultSendImplementation(opts: { wsScopes?: any[]; listScopesDelay?: boolean } = {}) {
  const calls: Array<[string, any]> = []
  mockSend.mockImplementation((type: string, payload: any) => {
    calls.push([type, payload])
    switch (type) {
      case 'getMemoryConfig':
        return Promise.resolve({ ...BASE_CONFIG, ...payload })
      case 'getMemoryEntries':
        // 全局（无 workspaceUri）返回全局条目；工作区返回工作区条目
        return payload?.workspaceUri
          ? Promise.resolve({ entries: WS_ENTRIES, total: WS_ENTRIES.length, truncated: false })
          : Promise.resolve({ entries: GLOBAL_ENTRIES, total: GLOBAL_ENTRIES.length, truncated: false })
      case 'listMemoryScopes':
        if (opts.listScopesDelay) {
          // 挂起：模拟 scope 列表未就绪
          return new Promise(() => {})
        }
        return Promise.resolve({
          scopes: opts.wsScopes ?? [{ uri: WS_URI, name: 'demo-project', fsPath: 'C:/projects/demo-project', hasData: true }]
        })
      default:
        return Promise.resolve({})
    }
  })
  return calls
}

async function mountSettings() {
  const wrapper = mount(MemorySettings, {
    global: { stubs: GLOBAL_STUBS }
  })
  await flushPromises()
  return wrapper
}

function entryTexts(wrapper: any): string[] {
  return wrapper.findAll('.entry-text').map((n: any) => n.text())
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('记忆作用域切换（全局 / 工作区）', () => {
  it('切换到工作区：加载该工作区条目并带 workspaceUri 请求', async () => {
    defaultSendImplementation()
    const wrapper = await mountSettings()

    // 初始为全局记忆
    expect(entryTexts(wrapper)).toEqual(['global-memory-alpha', 'global-memory-beta'])

    // 切到工作区 tab：等待 scope 列表与条目加载
    await wrapper.findAll('.scope-tab')[1].trigger('click')
    await flushPromises()
    expect(entryTexts(wrapper)).toEqual(['workspace-memory-gamma'])

    // 工作区请求带 workspaceUri；全局请求不带
    const entryCalls = (mockSend.mock.calls as Array<[string, any]>).filter(c => c[0] === 'getMemoryEntries')
    expect(entryCalls.some(c => c[1]?.workspaceUri === WS_URI)).toBe(true)
    expect(entryCalls.some(c => !c[1]?.workspaceUri && c[1]?.limit)).toBe(true)
  })

  it('切回已加载过的作用域：条目立即渲染（缓存直出，无加载占位中间帧）', async () => {
    defaultSendImplementation()
    const wrapper = await mountSettings()

    // 先访问一次工作区（建立缓存）
    await wrapper.findAll('.scope-tab')[1].trigger('click')
    await flushPromises()
    expect(entryTexts(wrapper)).toEqual(['workspace-memory-gamma'])

    // 切回全局：点击后、任何异步响应到达前，全局条目必须已经渲染
    // （若走加载占位，会先塌陷成 .entries-loading 再回来——即肉眼可见的单帧闪烁）
    await wrapper.findAll('.scope-tab')[0].trigger('click')
    expect(wrapper.find('.entries-loading').exists()).toBe(false)
    expect(wrapper.find('.entries-list').exists()).toBe(true)
    expect(entryTexts(wrapper)).toEqual(['global-memory-alpha', 'global-memory-beta'])

    await flushPromises()
    expect(entryTexts(wrapper)).toEqual(['global-memory-alpha', 'global-memory-beta'])
  })

  it('工作区 tab 刚打开、scope 列表未就绪：不误拉全局数据，展示空态', async () => {
    const calls = defaultSendImplementation({ listScopesDelay: true })
    const wrapper = await mountSettings()
    // mount 时的合法全局加载（limit 不带 workspaceUri）
    const mountEntryCalls = calls.filter(c => c[0] === 'getMemoryEntries').length

    // scope 列表挂起 → 未选工作区 → 点击工作区 tab
    await wrapper.findAll('.scope-tab')[1].trigger('click')
    await flushPromises()

    // 空态而非全局条目，且无加载占位
    expect(entryTexts(wrapper)).toEqual([])
    expect(wrapper.find('.entries-loading').exists()).toBe(false)
    // 未选择工作区期间不得发出新的条目请求（防误显示全局数据）
    const entryCallsAfterClick = calls.filter(c => c[0] === 'getMemoryEntries').slice(mountEntryCalls)
    expect(entryCallsAfterClick.length).toBe(0)
  })

  it('快速切换作用域：过期响应不覆盖当前作用域（seq 竞态守卫）', async () => {
    // 全局条目响应慢：先发起的全局请求晚于后发起的工作区请求返回
    mockSend.mockImplementation((type: string, payload: any) => {
      switch (type) {
        case 'getMemoryConfig':
          return Promise.resolve({ ...BASE_CONFIG })
        case 'listMemoryScopes':
          return Promise.resolve({
            scopes: [{ uri: WS_URI, name: 'demo-project', fsPath: 'C:/projects/demo-project', hasData: true }]
          })
        case 'getMemoryEntries':
          if (payload?.workspaceUri) {
            return Promise.resolve({ entries: WS_ENTRIES, total: WS_ENTRIES.length, truncated: false })
          }
          // 全局：延迟到工作区响应之后才返回
          return new Promise((resolve) => {
            setTimeout(() => resolve({ entries: GLOBAL_ENTRIES, total: GLOBAL_ENTRIES.length, truncated: false }), 30)
          })
        default:
          return Promise.resolve({})
      }
    })
    const wrapper = await mountSettings()
    // 全局条目经 30ms 定时器返回：等待其落定并写入缓存
    await new Promise((r) => setTimeout(r, 40))
    await flushPromises()
    expect(entryTexts(wrapper)).toEqual(['global-memory-alpha', 'global-memory-beta'])

    // 切到工作区（先发请求），随后立刻切回全局（再发请求）
    await wrapper.findAll('.scope-tab')[1].trigger('click')
    await wrapper.findAll('.scope-tab')[0].trigger('click')
    await new Promise((r) => setTimeout(r, 60))
    await flushPromises()

    // 慢响应（工作区的）若被应用会把全局条目冲掉；seq 守卫应丢弃它
    expect(entryTexts(wrapper)).toEqual(['global-memory-alpha', 'global-memory-beta'])
  })
})
