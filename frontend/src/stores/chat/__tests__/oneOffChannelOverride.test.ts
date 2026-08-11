/**
 * 一次性渠道覆盖（configIdOverride）回归测试
 *
 * 问题背景：Plan 执行等「仅本次使用所选渠道」场景此前通过临时 setConfigId 实现，
 * 但 setConfigId 会写后端全局 activeChannelId（settings.setActiveChannelId）并改写
 * 对话元数据 inputModelConfig（persistConversationModelConfig），导致执行完 Plan 后
 * 渠道永久停留、全局与对话级配置一并被改（且 write_file.vue 还从未恢复原渠道）。
 *
 * 修复方案：sendMessage 新增 configIdOverride —— 只覆盖本次 chatStream 请求的
 * configId（后端 configId 本就是 per-request 纯值），并通过 pendingConfigIdOverride
 * 让同一回合内的 toolConfirmation 沿用同一渠道；全程不写全局设置、不写对话元数据。
 */
import { ref } from 'vue'
import { vi, describe, expect, beforeEach } from 'vitest'
import type { ChatStoreState, ChatStoreComputed } from '../types'

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

vi.mock('../conversationActions', () => ({
  createAndPersistConversation: vi.fn(),
  MESSAGES_PAGE_SIZE: 50,
  loadCheckpoints: vi.fn().mockResolvedValue(undefined),
  refreshCurrentConversationBuildSession: vi.fn().mockResolvedValue(undefined),
  syncConversationWorkspaceUri: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../tabActions', () => ({
  updateTabConversationId: vi.fn(),
  updateTabTitle: vi.fn()
}))

vi.mock('../checkpointActions', () => ({
  clearCheckpointsFromIndex: vi.fn()
}))

vi.mock('../parsers', () => ({
  contentToMessageEnhanced: vi.fn()
}))

vi.mock('../windowUtils', () => ({
  syncTotalMessagesFromWindow: vi.fn(),
  setTotalMessagesFromWindow: vi.fn(),
  trimWindowFromTop: vi.fn()
}))

vi.mock('../configActions', () => ({
  persistConversationModelConfig: vi.fn(),
  persistConversationPromptMode: vi.fn()
}))

vi.mock('../utils', () => ({
  validateSessionIdentity: vi.fn().mockReturnValue(true)
}))

vi.mock('../state', () => ({
  rebuildMessageIndexById: vi.fn(),
  appendMessage: vi.fn(),
  // sendMessage 失败路径（cleanupFailedSendPlaceholders）会调用 getMessageIndexById：
  // 测试中占位消息未真正写入数组（appendMessage 被 mock），返回 -1 与真实行为一致
  getMessageIndexById: vi.fn().mockReturnValue(-1)
}))

vi.mock('../streamChunkHandlers', () => ({
  finishSmoothStreamForState: vi.fn(),
  clearAllSmoothForState: vi.fn(),
  resetTurnBaseTokenEstimate: vi.fn()
}))

vi.mock('../../../composables/useI18n', () => ({
  translate: vi.fn(() => '')
}))

vi.mock('../settingsStore', () => ({
  useSettingsStore: vi.fn(() => ({ language: 'zh-CN' }))
}))

import { sendToExtension } from '../../../utils/vscode'
import { persistConversationModelConfig } from '../configActions'
import { createAndPersistConversation } from '../conversationActions'
import { sendMessage } from '../messageActions'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>
const persistConversationModelConfigMock = vi.mocked(persistConversationModelConfig)
const createAndPersistConversationMock = vi.mocked(createAndPersistConversation)

function createState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    currentConversationId: ref('conv_1'),
    allMessages: ref([]),
    messageIndexById: ref(new Map()),
    windowStartIndex: ref(0),
    totalMessages: ref(0),
    isLoading: ref(false),
    isStreaming: ref(false),
    isWaitingForResponse: ref(false),
    error: ref(null),
    streamingMessageId: ref<string | null>(null),
    activeStreamId: ref<string | null>(null),
    checkpoints: ref([]),
    mergeUnchangedCheckpoints: ref(true),
    retryStatus: ref(null),
    autoSummaryStatus: ref(null),
    configId: ref('global_a'),
    selectedModelId: ref(''),
    currentConfig: ref({ id: 'global_a', name: 'A', model: 'model-a', type: 'openai' }),
    currentPromptModeId: ref('code'),
    pendingModelOverride: ref<string | null>(null),
    pendingConfigIdOverride: ref<string | null>(null),
    _lastCancelledStreamId: ref<string | null>(null),
    _lastApprovalGatedStreamId: ref<string | null>(null),
    _failedStreamMessageId: ref<string | null>(null),
    _pendingBranchRefreshAfterStream: ref<string | null>(null),
    _pendingBranchReplayContext: ref(null),
    historyFolded: ref(false),
    foldedMessageCount: ref(0),
    toolResponseCache: ref(new Map()),
    conversations: ref([]),
    currentWorkspaceUri: ref(null),
    openTabs: ref([]),
    activeTabId: ref(null),
    ...overrides
  } as unknown as ChatStoreState
}

function createComputed(overrides: Partial<ChatStoreComputed> = {}): ChatStoreComputed {
  return {
    currentModelName: { value: 'model-a' },
    ...overrides
  } as unknown as ChatStoreComputed
}

function findChatStreamCall() {
  const calls = mockSend.mock.calls as Array<[string, Record<string, unknown>]>
  return calls.find(([type]) => type === 'chatStream')?.[1]
}

describe('sendMessage 一次性渠道覆盖（configIdOverride）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('指定 configIdOverride 时 chatStream 使用覆盖渠道，且不写全局设置与对话元数据', async () => {
    const state = createState()
    mockSend.mockResolvedValue(undefined)

    const ok = await sendMessage(state, createComputed(), 'hello', undefined, {
      configIdOverride: 'oneoff_b',
      modelOverride: 'model-b'
    })

    expect(ok).toBe(true)

    const payload = findChatStreamCall()
    expect(payload).toBeDefined()
    expect(payload!.configId).toBe('oneoff_b')
    expect(payload!.modelOverride).toBe('model-b')

    // 修复核心：不得触碰后端全局渠道与对话元数据
    expect(mockSend).not.toHaveBeenCalledWith('settings.setActiveChannelId', expect.anything())
    expect(persistConversationModelConfigMock).not.toHaveBeenCalled()

    // 全局渠道未被改动，仅回合级覆盖生效
    expect(state.configId.value).toBe('global_a')
    expect(state.pendingConfigIdOverride.value).toBe('oneoff_b')
  })

  test('未指定 configIdOverride 时保持原行为（全局渠道 + 不设回合覆盖）', async () => {
    const state = createState()
    mockSend.mockResolvedValue(undefined)

    await sendMessage(state, createComputed(), 'hello')

    const payload = findChatStreamCall()
    expect(payload).toBeDefined()
    expect(payload!.configId).toBe('global_a')
    expect(state.pendingConfigIdOverride.value).toBeNull()
  })

  test('空白 configIdOverride 视为未提供', async () => {
    const state = createState()
    mockSend.mockResolvedValue(undefined)

    await sendMessage(state, createComputed(), 'hello', undefined, {
      configIdOverride: '   '
    })

    expect(findChatStreamCall()!.configId).toBe('global_a')
    expect(state.pendingConfigIdOverride.value).toBeNull()
  })

  test('发送失败（IPC 抛异常）不改变全局渠道，且回合覆盖被清除', async () => {
    const state = createState()
    mockSend.mockRejectedValue(new Error('ipc down'))

    await sendMessage(state, createComputed(), 'hello', undefined, {
      configIdOverride: 'oneoff_b'
    })

    expect(state.configId.value).toBe('global_a')
    expect(state.pendingConfigIdOverride.value).toBeNull()
    expect(state.pendingModelOverride.value).toBeNull()
  })

  test('新建对话 + 一次性渠道：chatStream 用覆盖渠道，但全局渠道不变（新对话元数据只记全局渠道）', async () => {
    const state = createState({
      currentConversationId: ref(null),
      conversations: ref([])
    })
    createAndPersistConversationMock.mockImplementation(async (state: any) => {
      state.currentConversationId.value = 'conv_new'
      return 'conv_new'
    })
    mockSend.mockResolvedValue(undefined)

    const ok = await sendMessage(state, createComputed(), 'hello', undefined, {
      configIdOverride: 'oneoff_b',
      modelOverride: 'model-b'
    })
    expect(ok).toBe(true)

    const payload = findChatStreamCall()
    expect(payload).toBeDefined()
    expect(payload!.configId).toBe('oneoff_b')

    // one-off 渠道不得写入新对话的 inputModelConfig：persist 读取的是全局 configId
    expect(state.configId.value).toBe('global_a')
    expect(persistConversationModelConfigMock).toHaveBeenCalledTimes(1)
    expect(mockSend).not.toHaveBeenCalledWith('settings.setActiveChannelId', expect.anything())
  })
})
