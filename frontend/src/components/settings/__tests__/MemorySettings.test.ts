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
import { describe, expect, vi, beforeEach } from 'vitest'
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

// ConfirmDialog 桩：渲染确认按钮，点击触发 confirm——便于测试删除流程走完整请求路由
const ConfirmDialogStub = defineComponent({
  name: 'ConfirmDialog',
  props: {
    modelValue: { type: Boolean, default: false },
    title: String,
    message: String,
    confirmText: String,
    isDanger: Boolean
  },
  emits: ['confirm', 'cancel', 'update:modelValue'],
  template: `<div class="cd-stub"><button class="cd-confirm" @click="$emit('confirm')">ok</button></div>`
})

const GLOBAL_STUBS = {
  CustomCheckbox: CustomCheckboxStub,
  ConfirmDialog: ConfirmDialogStub
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
  entryChars: 280
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
  test('切换到工作区：加载该工作区条目并带 workspaceUri 请求', async () => {
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

  test('切回已加载过的作用域：条目立即渲染（缓存直出，无加载占位中间帧）', async () => {
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

  test('工作区 tab 刚打开、scope 列表未就绪：不误拉全局数据，展示空态', async () => {
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

  test('快速切换作用域：过期响应不覆盖当前作用域（seq 竞态守卫）', async () => {
    // 真正构造乱序：工作区条目响应慢（30ms），后发起的工作区请求晚于全局请求返回
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
            // 工作区：延迟返回，模拟慢响应
            return new Promise((resolve) => {
              setTimeout(() => resolve({ entries: WS_ENTRIES, total: WS_ENTRIES.length, truncated: false }), 30)
            })
          }
          // 全局：立即返回
          return Promise.resolve({ entries: GLOBAL_ENTRIES, total: GLOBAL_ENTRIES.length, truncated: false })
        default:
          return Promise.resolve({})
      }
    })
    const wrapper = await mountSettings()
    // 全局条目已就绪（立即返回）
    expect(entryTexts(wrapper)).toEqual(['global-memory-alpha', 'global-memory-beta'])

    // 切到工作区（发出工作区请求，30ms 后返回），随后立刻切回全局（再发全局请求）
    await wrapper.findAll('.scope-tab')[1].trigger('click')
    await wrapper.findAll('.scope-tab')[0].trigger('click')
    await new Promise((r) => setTimeout(r, 60))
    await flushPromises()

    // 慢响应（工作区的，seq 已过期）若被应用会把全局条目冲掉；seq 守卫应丢弃它
    expect(entryTexts(wrapper)).toEqual(['global-memory-alpha', 'global-memory-beta'])
  })

  test('工作区 tab 未选工作区：在途全局条目响应被丢弃（loadEntries 空 key 早退递增序号）', async () => {
    // 全局条目响应延迟：mount 时的全局请求在用户切到工作区 tab（无选中）之后才返回
    mockSend.mockImplementation((type: string) => {
      switch (type) {
        case 'getMemoryConfig':
          return Promise.resolve({ ...BASE_CONFIG })
        case 'listMemoryScopes':
          // scope 列表挂起 → selectedWorkspaceUri 保持 '' → 工作区 tab 无选中
          return new Promise(() => {})
        case 'getMemoryEntries':
          return new Promise((resolve) => {
            setTimeout(() => resolve({ entries: GLOBAL_ENTRIES, total: GLOBAL_ENTRIES.length, truncated: false }), 30)
          })
        default:
          return Promise.resolve({})
      }
    })
    const wrapper = await mountSettings()
    // mount 时全局条目请求已发出（30ms 后返回，此刻仍在途）

    // 切到工作区 tab：scope 列表未就绪 → 未选工作区 → loadEntries 空 key 早退（递增 entryLoadSeq）
    await wrapper.findAll('.scope-tab')[1].trigger('click')
    await new Promise((r) => setTimeout(r, 60))
    await flushPromises()

    // 在途全局响应（旧 seq）已过期被丢弃：工作区 tab 下保持空态而非全局条目
    expect(entryTexts(wrapper)).toEqual([])
    expect(wrapper.find('.entries-loading').exists()).toBe(false)
  })

  test('工作区作用域：新增 / 删除记忆请求携带正确的 workspaceUri（作用域路由）', async () => {
    defaultSendImplementation()
    const wrapper = await mountSettings()

    // 切到工作区 tab（scope 列表已就绪 → 默认选中 WS_URI）
    await wrapper.findAll('.scope-tab')[1].trigger('click')
    await flushPromises()
    expect(entryTexts(wrapper)).toEqual(['workspace-memory-gamma'])

    // 新增：请求必须带 workspaceUri
    await wrapper.find('.add-entry-textarea').setValue('new-workspace-entry')
    await wrapper.find('.add-entry-actions .btn-primary').trigger('click')
    await flushPromises()
    const addCalls = (mockSend.mock.calls as Array<[string, any]>).filter(c => c[0] === 'addMemoryEntry')
    expect(addCalls.length).toBe(1)
    expect(addCalls[0][1]?.workspaceUri).toBe(WS_URI)
    expect(addCalls[0][1]?.text).toBe('new-workspace-entry')

    // 删除：点击删除按钮 → 确认框确认 → 请求带 workspaceUri
    await wrapper.find('.entry-row .btn-icon.danger').trigger('click')
    await flushPromises()
    await wrapper.find('.cd-confirm').trigger('click')
    await flushPromises()
    const deleteCalls = (mockSend.mock.calls as Array<[string, any]>).filter(c => c[0] === 'deleteMemoryEntry')
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0][1]?.id).toBe(0)
    expect(deleteCalls[0][1]?.workspaceUri).toBe(WS_URI)
  })
})
