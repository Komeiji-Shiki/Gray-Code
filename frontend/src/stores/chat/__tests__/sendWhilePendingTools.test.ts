/**
 * 回归测试：待确认工具时发送消息 =「中断当前回合」语义
 *
 * 背景：用户报告「执行命令时输入栏有文字，点击执行，文字自动被发出」，以及后续
 * 「并行工具调用 + 用户中途插话」竞态（API 400 + 删除消息 MESSAGE_CHANGED）。
 * 根因之一是「批注」功能：用户发送被路由为 toolConfirmation 的批注路径，本地乐观
 * 插入 user 消息（backendIndex 猜测），与后端真实索引错位。
 *
 * 修复：批注功能整体移除。App.vue handleSend 在有待确认工具时先
 * cancelStreamAndRejectTools()（拒绝待确认工具、结束当前回合），再走正常
 * sendMessage 把消息作为新回合发出。本测试在 store 层验证该编排的等价行为：
 * 1. 拒绝后忙碌状态被复位，sendMessage 能走正常路径（不会静默入 inbox/丢弃）；
 * 2. 不发送任何 toolConfirmation（批注通道已删除）；
 * 3. 输入文字作为可见 user 消息发出，且本地插入的 functionResponse 位于其之前
 *    （与后端 rejectToolCalls 的插入位置一致，不再索引错位）。
 */
import { ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
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
  // appendMessage 必须真实写入 allMessages：本测试断言发送后的 user 消息在窗口中可见、
  // 且位于本地 functionResponse 之后（oneOffChannelOverride 只断言 mock 调用与状态 ref，
  // 无需数组内容，故那边可以用空 mock）。
  appendMessage: vi.fn((state: any, message: any) => {
    state.allMessages.value.push(message)
  }),
  // toolActions 取消/拒绝工具路径（ensureFunctionResponseMessageForRejectedTools）
  // 通过 insertMessageAt 插入本地 functionResponse：
  // 1) mock 缺该导出会直接 TypeError（insertMessageAt is not a function），
  //    中断 cancelStreamAndRejectTools（调用点不在 try/catch 内）；
  // 2) 必须真实插入数组，否则「本地已插入 functionResponse」断言（toHaveLength(1)）失败。
  insertMessageAt: vi.fn((state: any, index: number, message: any) => {
    state.allMessages.value.splice(index, 0, message)
  }),
  // 空 assistant 占位删除路径（removeEmptyAssistantPlaceholder）同用 removeMessageAt：
  // 本测试 asm-1 含待确认工具不会被删除，补真实 splice 与 insertMessageAt 保持同语义。
  removeMessageAt: vi.fn((state: any, index: number) => {
    if (index < 0 || index >= state.allMessages.value.length) return
    state.allMessages.value.splice(index, 1)
  }),
  // sendMessage 失败路径（cleanupFailedSendPlaceholders）会调用 getMessageIndexById：
  // 与 oneOffChannelOverride.test.ts 同款 mock（占位未入数组 → -1）
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
import { sendMessage } from '../messageActions'
import { cancelStreamAndRejectTools } from '../toolActions'

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

function pendingState() {
  return createState({
    isWaitingForResponse: ref(true),
    isStreaming: ref(false),
    streamingMessageId: ref('asm-1'),
    activeStreamId: ref(null),
    allMessages: ref([
      {
        id: 'usr-1',
        role: 'user',
        content: '执行命令',
        timestamp: 1,
        backendIndex: 0,
        parts: [{ text: '执行命令' }]
      },
      {
        id: 'asm-1',
        role: 'assistant',
        content: '',
        timestamp: 2,
        backendIndex: 1,
        tools: [{
          id: 't1',
          name: 'execute_command',
          status: 'awaiting_approval',
          args: { command: 'echo hi' }
        }]
      }
    ])
  })
}

describe('待确认工具时发送消息 = 中断当前回合', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSend.mockResolvedValue(undefined)
  })

  it('先拒绝待确认工具并复位忙碌状态，再正常发送新消息', async () => {
    const state = pendingState()

    // App.vue handleSend 编排：有待确认工具 → cancelStreamAndRejectTools
    await cancelStreamAndRejectTools(state, createComputed())

    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.isStreaming.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()

    // 拒绝通道已发出（rejectToolCalls + cancelStream），且不含任何批注载荷
    const rejectCalls = mockSend.mock.calls.filter(([type]) => type === 'conversation.rejectToolCalls')
    expect(rejectCalls.length).toBeGreaterThan(0)
    const cancelCalls = mockSend.mock.calls.filter(([type]) => type === 'cancelStream')
    expect(cancelCalls.length).toBeGreaterThan(0)
    const toolConfirmationCalls = mockSend.mock.calls.filter(([type]) => type === 'toolConfirmation')
    expect(toolConfirmationCalls).toHaveLength(0)

    // 本地已为被拒工具插入 functionResponse（与后端 rejectToolCalls 位置对齐）
    const localFr = state.allMessages.value.filter(m => m.isFunctionResponse)
    expect(localFr).toHaveLength(1)
    expect((localFr[0] as any).parts[0].functionResponse.id).toBe('t1')

    // 随后正常发送：chatStream 携带用户文字
    const ok = await sendMessage(state, createComputed(), '三个子agent检查影响面')
    expect(ok).toBe(true)

    const chatStreamCalls = mockSend.mock.calls.filter(([type]) => type === 'chatStream')
    expect(chatStreamCalls).toHaveLength(1)
    expect(chatStreamCalls[0][1]).toMatchObject({
      conversationId: 'conv_1',
      message: '三个子agent检查影响面'
    })

    // 用户文字是可见 user 消息；functionResponse 必须在其之前（索引对齐，不再错位）
    const visibleUsers = state.allMessages.value.filter(m => m.role === 'user' && !m.isFunctionResponse)
    const lastVisibleUser = visibleUsers[visibleUsers.length - 1]
    expect(lastVisibleUser.content).toBe('三个子agent检查影响面')
    const lastVisibleUserIdx = state.allMessages.value.findIndex(m => m.id === lastVisibleUser.id)
    const frIdx = state.allMessages.value.findIndex(m => m.isFunctionResponse)
    expect(frIdx).toBeLessThan(lastVisibleUserIdx)
  })

  it('拒绝待确认工具失败时仍继续发送（消息不丢）', async () => {
    const state = pendingState()
    mockSend.mockImplementation((type: string) => {
      if (type === 'conversation.rejectToolCalls' || type === 'cancelStream') {
        return Promise.reject(new Error('ipc down'))
      }
      return Promise.resolve(undefined)
    })

    // App.vue 编排：拒绝抛错被 catch，不阻断发送
    await cancelStreamAndRejectTools(state, createComputed()).catch(() => undefined)

    const ok = await sendMessage(state, createComputed(), '继续')
    expect(ok).toBe(true)
    const chatStreamCalls = mockSend.mock.calls.filter(([type]) => type === 'chatStream')
    expect(chatStreamCalls).toHaveLength(1)
  })
})
