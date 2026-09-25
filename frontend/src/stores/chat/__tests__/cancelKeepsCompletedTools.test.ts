/**
 * 回归测试：取消回合时不得把已有结果的工具改写成「已取消」
 *
 * 背景（用户报告）：模型在一轮里发起两个 execute_command，第一个执行完毕，
 * 第二个执行期间用户点了停止，结果两条工具卡片都显示 Cancelled by user。
 *
 * 根因：工具执行结束时后端发 toolStatus（携带 result 与最终状态），但含这些响应的
 * functionResponse 消息要等整批工具结束的 toolIteration 才写入。取消路径原先只按
 * 「历史里有没有 functionResponse」判断工具是否未完成，于是同一批里已经成功、
 * 只是尚未落 functionResponse 的工具也被归入未完成，卡片状态被改写成取消，
 * 并被补写一条并不存在的取消响应。
 *
 * 修复：缺少响应的判定同时看工具自身已回传的业务结果（success/error/warning/
 * awaiting_apply 且带 result）；已结算的工具保持原状态与结果，只有真正未完成的
 * 工具才被标记取消、才补写取消响应、才进入 rejectToolCalls 的目标列表。
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
  appendMessage: vi.fn((state: any, message: any) => {
    state.allMessages.value.push(message)
  }),
  // 拒绝工具路径通过 insertMessageAt 补写 functionResponse：必须真实插入数组，
  // 否则后续断言「补写的响应只覆盖未完成工具」失去意义。
  insertMessageAt: vi.fn((state: any, index: number, message: any) => {
    state.allMessages.value.splice(index, 0, message)
  }),
  removeMessageAt: vi.fn((state: any, index: number) => {
    if (index < 0 || index >= state.allMessages.value.length) return
    state.allMessages.value.splice(index, 1)
  }),
  getMessageIndexById: vi.fn().mockReturnValue(-1),
  setToolResponseCacheEntry: vi.fn(),
  setToolResponseCacheEntries: vi.fn()
}))

vi.mock('../streamChunkHandlers', () => ({
  finishSmoothStreamForState: vi.fn(),
  clearAllSmoothForState: vi.fn(),
  resetTurnBaseEstimate: vi.fn(),
  resetTurnBaseTokenEstimate: vi.fn()
}))

vi.mock('../../../composables/useI18n', () => ({
  translate: vi.fn(() => '')
}))

vi.mock('../settingsStore', () => ({
  useSettingsStore: vi.fn(() => ({ language: 'zh-CN' }))
}))

import { sendToExtension } from '../../../utils/vscode'
import { cancelStream, cancelStreamAndRejectTools } from '../toolActions'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

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
    selectedReasoningEffort: ref(''),
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

/**
 * 一轮里两个 execute_command：t1 已成功（toolStatus 已回传 result），
 * t2 仍在执行（尚无结果，也没有 functionResponse）。
 */
function twoCommandsState() {
  return createState({
    isStreaming: ref(true),
    isWaitingForResponse: ref(true),
    streamingMessageId: ref('asm-1'),
    activeStreamId: ref('stream-1'),
    allMessages: ref([
      {
        id: 'usr-1',
        role: 'user',
        content: '跑两条命令',
        timestamp: 1,
        backendIndex: 0,
        parts: [{ text: '跑两条命令' }]
      },
      {
        id: 'asm-1',
        role: 'assistant',
        content: '',
        timestamp: 2,
        backendIndex: 1,
        streaming: true,
        tools: [
          {
            id: 't1',
            name: 'execute_command',
            status: 'success',
            args: { command: 'echo first' },
            result: { success: true, data: { output: 'first' } }
          },
          {
            id: 't2',
            name: 'execute_command',
            status: 'executing',
            args: { command: 'sleep 60' }
          }
        ]
      }
    ])
  })
}

function toolsOf(state: ChatStoreState) {
  return state.allMessages.value.find(m => m.id === 'asm-1')!.tools!
}

function responseIdsOf(state: ChatStoreState): string[] {
  return state.allMessages.value
    .filter(m => m.isFunctionResponse)
    .flatMap(m => m.parts ?? [])
    .map(part => part.functionResponse?.id)
    .filter((id): id is string => typeof id === 'string')
}

describe('取消回合时保留已完成工具的结果', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSend.mockResolvedValue(undefined)
  })

  test('只标记仍在执行的工具，已完成工具保持成功状态与结果', async () => {
    const state = twoCommandsState()

    await cancelStream(state, createComputed())

    const tools = toolsOf(state)
    expect(tools.find(t => t.id === 't1')).toMatchObject({
      status: 'success',
      result: { success: true, data: { output: 'first' } }
    })
    expect(tools.find(t => t.id === 't2')).toMatchObject({ status: 'error' })
  })

  test('只为未完成工具补写取消响应，不伪造已完成工具的响应', async () => {
    const state = twoCommandsState()

    await cancelStream(state, createComputed())

    expect(responseIdsOf(state)).toEqual(['t2'])
    const inserted = state.allMessages.value.filter(m => m.isFunctionResponse)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].parts?.[0].functionResponse?.response).toMatchObject({
      success: false,
      error: 'Cancelled by user',
      rejected: true
    })
  })

  test('rejectToolCalls 只提交未完成工具的 ID', async () => {
    const state = twoCommandsState()

    await cancelStreamAndRejectTools(state, createComputed())

    const rejectCall = mockSend.mock.calls.find(([type]) => type === 'conversation.rejectToolCalls')
    expect(rejectCall).toBeDefined()
    expect(rejectCall![1]).toMatchObject({ toolCallIds: ['t2'] })
  })

  test('整批工具都已回传结果时不补写任何取消响应', async () => {
    const state = twoCommandsState()
    const assistant = state.allMessages.value.find(m => m.id === 'asm-1')!
    assistant.tools = [
      assistant.tools![0],
      { id: 't2', name: 'execute_command', status: 'success', args: { command: 'echo second' },
        result: { success: true, data: { output: 'second' } } }
    ]

    await cancelStream(state, createComputed())

    expect(responseIdsOf(state)).toEqual([])
    expect(toolsOf(state).every(tool => tool.status === 'success')).toBe(true)
  })

  test('没有结果的等待确认工具仍按取消处理', async () => {
    const state = twoCommandsState()
    const assistant = state.allMessages.value.find(m => m.id === 'asm-1')!
    assistant.tools = [
      { id: 't1', name: 'execute_command', status: 'awaiting_approval', args: { command: 'echo first' } }
    ]

    await cancelStream(state, createComputed())

    expect(toolsOf(state)[0].status).toBe('error')
    expect(responseIdsOf(state)).toEqual(['t1'])
  })
})
