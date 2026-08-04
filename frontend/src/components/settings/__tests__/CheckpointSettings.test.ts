/**
 * CheckpointSettings 设置页测试（B6 批次）
 *
 * 覆盖：
 * - H-1: updateConfigField 保存失败回滚该字段；后续成功保存不携带“失败的改动”
 * - H-2: loadConfig 失败展示错误横幅并禁用表单，重试成功后恢复
 * - M-7: toggleMergeUnchangedCheckpoints 仅保存成功时同步 chatStore
 * - M-6: confirmDelete 后端失败/部分失败时对话保留在列表（不无条件移除）
 * - M-4: 进度轮询瞬时错误不停止（重试数次后才停）、updatedAt 陈旧停止
 */
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import CheckpointSettings from '../CheckpointSettings.vue'
import { useCheckpointConfig } from '@/composables/useCheckpointConfig'
import { useCheckpointOperationProgress } from '@/composables/useCheckpointOperationProgress'

// 假 chatStore：仅暴露设置页用到的成员（vi.hoisted：mock 工厂引用安全）
const { chatStoreMock } = vi.hoisted(() => ({
  chatStoreMock: {
    currentConversationId: null,
    checkpoints: { value: [] },
    setMergeUnchangedCheckpoints: vi.fn(),
    loadCheckpoints: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

vi.mock('@/stores/chat/checkpointActions', () => ({
  previewExclusions: vi.fn(),
  pollOperationProgress: vi.fn(),
  cancelCheckpointOperation: vi.fn()
}))

vi.mock('@/stores', () => ({
  useChatStore: () => chatStoreMock
}))

import { sendToExtension } from '@/utils/vscode'
import { pollOperationProgress } from '@/stores/chat/checkpointActions'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>
const pollProgressMock = vi.mocked(pollOperationProgress)

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

// CustomScrollbar 桩：必须渲染 slot（列表内容在 scrollbar 内）
const CustomScrollbarStub = defineComponent({
  name: 'CustomScrollbar',
  template: '<div class="scrollbar-stub"><slot /></div>'
})

const GLOBAL_STUBS = {
  CustomCheckbox: CustomCheckboxStub,
  CustomScrollbar: CustomScrollbarStub,
  PatternListEditor: true
}

const BASE_CONFIG = {
  enabled: true,
  beforeTools: [],
  afterTools: [],
  messageCheckpoint: {
    beforeMessages: [],
    afterMessages: [],
    modelOuterLayerOnly: true,
    mergeUnchangedCheckpoints: true
  },
  maxCheckpoints: -1,
  customIgnorePatterns: [],
  exclusion: {
    enabledProfiles: { logs: true },
    maxFileSizeBytes: 50 * 1024 * 1024,
    customPatterns: []
  }
}

/** 默认 IPC 路由：配置/元数据/列表/进度全部成功返回 */
function defaultSendImplementation(updateConfigQueue: Array<() => Promise<any>> = []) {
  const updateConfigCalls: any[] = []
  mockSend.mockImplementation((type: string, payload: any) => {
    switch (type) {
      case 'checkpoint.getConfig':
        return Promise.resolve({ config: JSON.parse(JSON.stringify(BASE_CONFIG)) })
      case 'checkpoint.getExclusionProfiles':
        return Promise.resolve({ profiles: [] })
      case 'tools.getTools':
        return Promise.resolve({ tools: [] })
      case 'checkpoint.getAllConversationsWithCheckpoints':
        return Promise.resolve({ conversations: [] })
      case 'checkpoint.updateConfig': {
        updateConfigCalls.push(payload?.config)
        const next = updateConfigQueue.shift()
        return next ? next() : Promise.resolve({})
      }
      default:
        return Promise.resolve({})
    }
  })
  return { updateConfigCalls }
}

async function mountSettings() {
  const wrapper = mount(CheckpointSettings, {
    global: { stubs: GLOBAL_STUBS }
  })
  await flushPromises()
  return wrapper
}

/** 读取某个作用域内第一个 CustomCheckbox 桩的 modelValue prop */
function checkboxValue(wrapper: any, scopeSelector?: string): any {
  const scope = scopeSelector ? wrapper.find(scopeSelector) : wrapper
  return scope.findComponent(CustomCheckboxStub).props('modelValue')
}

beforeEach(() => {
  vi.clearAllMocks()
  chatStoreMock.currentConversationId = null
  chatStoreMock.checkpoints.value = []
  pollProgressMock.mockResolvedValue(null) // 无进行中操作：首次轮询即停止
})

afterEach(() => {
  vi.useRealTimers()
})

describe('H-1: updateConfigField 保存失败回滚', () => {
  it('保存失败回滚该字段并展示错误；后续成功保存不携带失败改动', async () => {
    defaultSendImplementation([
      () => Promise.reject(new Error('backend rejected')),
      () => Promise.resolve({})
    ])
    const wrapper = await mountSettings()

    // 启用开关初始为 true
    expect(checkboxValue(wrapper, '.setting-header')).toBe(true)

    // 第一次点击：尝试改为 false → 保存失败 → 回滚为 true + 错误横幅
    await wrapper.find('.setting-header .cb-stub').trigger('click')
    await flushPromises()
    expect(checkboxValue(wrapper, '.setting-header')).toBe(true)
    expect(wrapper.find('.exclusion-error').exists()).toBe(true)

    // 第二次点击（换到合并开关）：保存成功，但整包 payload 中 enabled 仍是 true（失败改动未被顺带持久化）
    const mergeScope = wrapper.find('.advanced-option')
    expect(mergeScope.exists()).toBe(true)
    await mergeScope.find('.cb-stub').trigger('click')
    await flushPromises()

    const updateConfigCalls = mockSend.mock.calls
      .filter(c => c[0] === 'checkpoint.updateConfig')
      .map(c => c[1].config)
    expect(updateConfigCalls).toHaveLength(2)
    expect(updateConfigCalls[1].enabled).toBe(true)
    expect(updateConfigCalls[1].messageCheckpoint.mergeUnchangedCheckpoints).toBe(false)
  })

  it('同一字段在失败后被再次编辑时，不回滚掉更新值', async () => {
    const { updateConfigCalls } = defaultSendImplementation([
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve({})
    ])
    const wrapper = await mountSettings()

    const enableScope = wrapper.find('.setting-header')
    await enableScope.find('.cb-stub').trigger('click') // 失败
    await flushPromises()
    // 失败后回滚为 true
    expect(checkboxValue(wrapper, '.setting-header')).toBe(true)

    await enableScope.find('.cb-stub').trigger('click') // 第二次尝试
    await flushPromises()
    expect(updateConfigCalls[1].enabled).toBe(false)
    expect(checkboxValue(wrapper, '.setting-header')).toBe(false)
  })
})

describe('H-2: loadConfig 失败禁用表单', () => {
  it('getConfig 失败时展示错误横幅并隐藏表单，重试成功后恢复', async () => {
    let configFails = true
    mockSend.mockImplementation((type: string) => {
      if (type === 'checkpoint.getConfig') {
        return configFails
          ? Promise.reject(new Error('config ipc down'))
          : Promise.resolve({ config: JSON.parse(JSON.stringify(BASE_CONFIG)) })
      }
      if (type === 'checkpoint.getExclusionProfiles') return Promise.resolve({ profiles: [] })
      if (type === 'tools.getTools') return Promise.resolve({ tools: [] })
      if (type === 'checkpoint.getAllConversationsWithCheckpoints') return Promise.resolve({ conversations: [] })
      return Promise.resolve({})
    })

    const wrapper = await mountSettings()

    // 失败：错误横幅可见，表单（设置组）不可见
    expect(wrapper.find('.load-error-state').exists()).toBe(true)
    expect(wrapper.find('.setting-group').exists()).toBe(false)

    // 点击重试：后端恢复 → 表单出现
    configFails = false
    await wrapper.find('.load-retry-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.load-error-state').exists()).toBe(false)
    expect(wrapper.find('.setting-group').exists()).toBe(true)
    expect(checkboxValue(wrapper, '.setting-header')).toBe(true)
  })
})

describe('M-7: mergeUnchanged 保存失败不同步 chatStore', () => {
  it('保存失败时不调用 setMergeUnchangedCheckpoints 且回滚', async () => {
    defaultSendImplementation([() => Promise.reject(new Error('boom'))])
    const wrapper = await mountSettings()

    const mergeScope = wrapper.find('.advanced-option')
    await mergeScope.find('.cb-stub').trigger('click')
    await flushPromises()

    expect(chatStoreMock.setMergeUnchangedCheckpoints).not.toHaveBeenCalled()
    expect(checkboxValue(wrapper, '.advanced-option')).toBe(true) // 回滚
  })

  it('保存成功时同步 chatStore', async () => {
    defaultSendImplementation([() => Promise.resolve({})])
    const wrapper = await mountSettings()

    const mergeScope = wrapper.find('.advanced-option')
    await mergeScope.find('.cb-stub').trigger('click')
    await flushPromises()

    expect(chatStoreMock.setMergeUnchangedCheckpoints).toHaveBeenCalledWith(false)
    expect(checkboxValue(wrapper, '.advanced-option')).toBe(false)
  })
})

describe('M-6: confirmDelete 失败保留列表', () => {
  it('部分失败时仅移除成功对话，失败对话保留（随后刷新权威计数）', async () => {
    const conversations = [
      { conversationId: 'convA', title: 'Alpha', checkpointCount: 2, totalSize: 100 },
      { conversationId: 'convB', title: 'Beta', checkpointCount: 1, totalSize: 50 }
    ]
    let listCalls = 0
    mockSend.mockImplementation((type: string) => {
      switch (type) {
        case 'checkpoint.getConfig':
          return Promise.resolve({ config: JSON.parse(JSON.stringify(BASE_CONFIG)) })
        case 'checkpoint.getExclusionProfiles':
          return Promise.resolve({ profiles: [] })
        case 'tools.getTools':
          return Promise.resolve({ tools: [] })
        case 'checkpoint.getAllConversationsWithCheckpoints':
          listCalls += 1
          // 首次加载完整列表；删除后刷新只返回仍存在的（失败）对话
          return Promise.resolve({ conversations: listCalls === 1 ? conversations : [conversations[1]] })
        case 'checkpoint.deleteBatch':
          return Promise.resolve({
            results: [
              { conversationId: 'convA', deletedIds: ['a-1'], rejectedIds: [], success: true },
              { conversationId: 'convB', deletedIds: [], rejectedIds: [], success: false }
            ]
          })
        default:
          return Promise.resolve({})
      }
    })

    const wrapper = await mountSettings()
    expect(wrapper.findAll('.conversation-item')).toHaveLength(2)

    // 选中两个对话 → 批量删除
    const convCheckboxes = wrapper.findAll('.conversation-item .cb-stub')
    await convCheckboxes[0].trigger('click')
    await convCheckboxes[1].trigger('click')
    await wrapper.find('.batch-delete-btn').trigger('click')
    expect(wrapper.find('.delete-confirm-dialog').exists()).toBe(true)

    await wrapper.find('.btn-delete').trigger('click')
    await flushPromises()

    // convA 被移除；convB（失败）保留
    const remaining = wrapper.findAll('.conversation-item')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].text()).toContain('Beta')
    expect(remaining[0].text()).not.toContain('Alpha')
    // 删除反馈展示失败项
    expect(wrapper.find('.delete-feedback').exists()).toBe(true)
    // deleteBatch 只发送一次（防重入 + 对话框已关闭）
    expect(mockSend.mock.calls.filter(c => c[0] === 'checkpoint.deleteBatch')).toHaveLength(1)
  })

  it('后端未返回 results 时不删除任何对话（保守处理）', async () => {
    const conversations = [
      { conversationId: 'convA', title: 'Alpha', checkpointCount: 1, totalSize: 10 }
    ]
    mockSend.mockImplementation((type: string) => {
      switch (type) {
        case 'checkpoint.getConfig':
          return Promise.resolve({ config: JSON.parse(JSON.stringify(BASE_CONFIG)) })
        case 'checkpoint.getExclusionProfiles':
          return Promise.resolve({ profiles: [] })
        case 'tools.getTools':
          return Promise.resolve({ tools: [] })
        case 'checkpoint.getAllConversationsWithCheckpoints':
          return Promise.resolve({ conversations })
        case 'checkpoint.deleteBatch':
          return Promise.resolve({}) // 异常响应：无 results
        default:
          return Promise.resolve({})
      }
    })

    const wrapper = await mountSettings()
    await wrapper.find('.conversation-item .cb-stub').trigger('click')
    await wrapper.find('.batch-delete-btn').trigger('click')
    await wrapper.find('.btn-delete').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.conversation-item')).toHaveLength(1)
    expect(wrapper.find('.delete-feedback').exists()).toBe(true)
  })
})

describe('M-4: 进度轮询容错', () => {
  it('瞬时错误不停止轮询；连续多次失败后才停止', async () => {
    vi.useFakeTimers()
    pollProgressMock.mockRejectedValue(new Error('ipc down'))

    const wrapper = mount(CheckpointSettings, {
      global: { stubs: GLOBAL_STUBS }
    })
    await vi.advanceTimersByTimeAsync(0) // 首次立即轮询

    // 800ms 间隔推进 4 次：共 5 次失败（达到上限）→ 停止
    await vi.advanceTimersByTimeAsync(800 * 4)
    expect(pollProgressMock).toHaveBeenCalledTimes(5)

    // 继续推进：不再轮询
    await vi.advanceTimersByTimeAsync(800 * 10)
    expect(pollProgressMock).toHaveBeenCalledTimes(5)

    wrapper.unmount()
  })

  it('updatedAt 陈旧时停止轮询并标记 stale', async () => {
    vi.useFakeTimers()
    pollProgressMock.mockResolvedValue({
      operationId: 'op_1',
      kind: 'delete',
      phase: 'deleting',
      processed: 1,
      total: 10,
      cancelled: false,
      startedAt: Date.now() - 200_000,
      updatedAt: Date.now() - 200_000 // 陈旧
    })

    const wrapper = mount(CheckpointSettings, {
      global: { stubs: GLOBAL_STUBS }
    })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    // 首次轮询即判定陈旧：停止轮询 + 展示 stale 提示
    expect(pollProgressMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.op-stale').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(800 * 5)
    expect(pollProgressMock).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('连续失败放弃轮询时若进度非终态则标记 stale（R3-#10）', async () => {
    vi.useFakeTimers()
    const running = {
      operationId: 'op_1',
      kind: 'delete',
      phase: 'deleting',
      processed: 1,
      total: 10,
      cancelled: false,
      startedAt: Date.now(),
      updatedAt: Date.now()
    }
    pollProgressMock
      .mockResolvedValueOnce(running)           // 首次轮询成功：展示进度
      .mockRejectedValue(new Error('ipc down')) // 之后连续失败

    const wrapper = mount(CheckpointSettings, {
      global: { stubs: GLOBAL_STUBS }
    })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    // 首次成功：进度可见、无 stale
    expect(wrapper.find('.operation-progress').exists()).toBe(true)
    expect(wrapper.find('.op-stale').exists()).toBe(false)

    // 连续 5 次失败达到上限：停止轮询，且进度非终态 → 标记 stale（进度条不再卡死无提示）
    await vi.advanceTimersByTimeAsync(800 * 5)
    await flushPromises()
    expect(wrapper.find('.op-stale').exists()).toBe(true)
    const callsAtStop = pollProgressMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(800 * 5)
    expect(pollProgressMock.mock.calls.length).toBe(callsAtStop)

    wrapper.unmount()
  })
})

describe('R3-#10: 轮询恢复时 stale 复位（composable 级）', () => {
  it('startProgressPolling 复位 stale；后端无进行中操作时停止轮询', async () => {
    vi.useFakeTimers()
    const { operationProgress, operationStale, startProgressPolling, stopProgressPolling } =
      useCheckpointOperationProgress()

    const running = {
      operationId: 'op_1',
      kind: 'delete',
      phase: 'deleting',
      processed: 1,
      total: 10,
      cancelled: false,
      startedAt: Date.now(),
      updatedAt: Date.now()
    }
    pollProgressMock
      .mockResolvedValueOnce(running)           // 首次成功：展示进度
      .mockRejectedValue(new Error('ipc down')) // 之后连续失败

    startProgressPolling()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(operationProgress.value).toEqual(running)
    expect(operationStale.value).toBe(false)

    // 连续 5 次失败达到上限：停止轮询并标记 stale
    await vi.advanceTimersByTimeAsync(800 * 5)
    await flushPromises()
    expect(operationStale.value).toBe(true)
    const callsAtStop = pollProgressMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(800 * 5)
    expect(pollProgressMock.mock.calls.length).toBe(callsAtStop)

    // 恢复轮询：stale 复位；后端已无进行中操作（返回 null）→ 停止轮询
    pollProgressMock.mockResolvedValueOnce(null)
    startProgressPolling()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(operationStale.value).toBe(false)
    expect(operationProgress.value).toBeNull()

    stopProgressPolling()
  })
})

describe('R3-#9: updateConfigField 采纳后端归一化返回值', () => {
  it('保存成功时用后端返回的 config 回填本地并更新快照', async () => {
    const { config, loadConfig, updateConfigField } = useCheckpointConfig()
    mockSend.mockImplementation((type: string) => {
      if (type === 'checkpoint.getConfig') {
        return Promise.resolve({ config: JSON.parse(JSON.stringify(BASE_CONFIG)) })
      }
      if (type === 'checkpoint.updateConfig') {
        return Promise.resolve({ config: { ...JSON.parse(JSON.stringify(BASE_CONFIG)), maxCheckpoints: 42 } })
      }
      return Promise.resolve({})
    })
    await loadConfig()
    await updateConfigField('maxCheckpoints', 100)
    // 乐观值 100 被后端归一化值 42 覆盖
    expect(config.maxCheckpoints).toBe(42)
  })

  it('后端未返回 config（null）时保留乐观值', async () => {
    const { config, loadConfig, updateConfigField } = useCheckpointConfig()
    mockSend.mockImplementation((type: string) => {
      if (type === 'checkpoint.getConfig') {
        return Promise.resolve({ config: JSON.parse(JSON.stringify(BASE_CONFIG)) })
      }
      if (type === 'checkpoint.updateConfig') {
        return Promise.resolve({ config: null })
      }
      return Promise.resolve({})
    })
    await loadConfig()
    await updateConfigField('maxCheckpoints', 100)
    expect(config.maxCheckpoints).toBe(100)
  })
})

describe('R3-#11: loadConfig 防重入', () => {
  it('加载进行中时再次调用直接返回，不发起并发请求', async () => {
    const { loadConfig, isLoading } = useCheckpointConfig()
    let resolveGet: ((value: any) => void) | undefined
    mockSend.mockImplementation((type: string) => {
      if (type === 'checkpoint.getConfig') {
        return new Promise(res => { resolveGet = res })
      }
      return Promise.resolve({})
    })

    const p1 = loadConfig()
    const p2 = loadConfig()
    expect(isLoading.value).toBe(true)
    resolveGet!({ config: JSON.parse(JSON.stringify(BASE_CONFIG)) })
    await Promise.all([p1, p2])
    expect(isLoading.value).toBe(false)
    // getConfig 只被调用一次
    expect(mockSend.mock.calls.filter(c => c[0] === 'checkpoint.getConfig')).toHaveLength(1)
  })
})
