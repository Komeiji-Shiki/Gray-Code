/**
 * 回归测试：handleToolsExecuting 终结平滑显示层
 *
 * 问题背景：toolsExecuting 阶段消息置 streaming=false、正文输出结束（后续为工具执行），
 * 但此前未清理平滑显示层条目（smoothTexts + manager entry）。若流在 toolsExecuting 后
 * 异常终止（无 toolIteration/complete/cancelled 终结事件且未走 cancelStream），
 * 平滑条目残留；消息已切回真实 content，残留显示层不再被消费，占位/显示错乱。
 *
 * 修复（合入上游 67d7fb6 后统一）：handleToolsExecuting 在函数末尾无条件调用
 * finishSmoothStreamForState —— toolsExecuting 即当前模型文本段的终点，即使无 content
 * 增量同样终结当前流消息的平滑条目；放完积压、销毁实例、删除显示文本，消息正文切回
 * 后端持久化的真实 parts。工具返回后模型若续写正文，pushSmoothText 以当前 part 真实
 * 文本为基线重建实例（与段落切换语义一致）。
 */
import { ref } from 'vue'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message, StreamChunk } from '../../types'
import type { ChatStoreState } from '../../stores/chat/types'
import { handleToolsExecuting } from '../../stores/chat/streamChunkHandlers'
import { pushSmoothText, hasSmoothStream, disposeAllSmoothStreams } from '../../stores/chat/smoothStreamManager'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ success: true })
}))

function createState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    currentConversationId: ref('conv_1'),
    allMessages: ref<Message[]>([]),
    messageIndexById: ref(new Map<string, number>()) as unknown as ChatStoreState['messageIndexById'],
    toolResponseIndex: ref(new Map<string, number>()) as unknown as ChatStoreState['toolResponseIndex'],
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
    configId: ref('cfg_1'),
    selectedModelId: ref(''),
    currentConfig: ref(null),
    currentPromptModeId: ref('code'),
    pendingModelOverride: ref<string | null>(null),
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
    sessionSnapshots: ref(new Map()),
    smoothTexts: new Map(),
    smoothMode: ref('balanced'),
    ...overrides
  } as unknown as ChatStoreState
}

function indexMap(messages: Message[]): Map<string, number> {
  const m = new Map<string, number>()
  messages.forEach((msg, i) => m.set(msg.id, i))
  return m
}

describe('handleToolsExecuting 平滑条目清理', () => {
  beforeEach(() => {
    disposeAllSmoothStreams()
  })

  it('toolsExecuting 携带 content（消息置非流式）时终结平滑条目：实例销毁 + 显示文本删除', () => {
    const streaming = {
      id: 'msg_placeholder',
      role: 'assistant',
      content: '',
      timestamp: 1000,
      streaming: true,
      localOnly: true,
      parts: [{ text: 'hello' }]
    } as Message
    const state = createState({
      allMessages: ref<Message[]>([streaming]),
      messageIndexById: ref(indexMap([streaming])) as unknown as ChatStoreState['messageIndexById'],
      streamingMessageId: ref('msg_placeholder'),
      isStreaming: ref(true),
      smoothTexts: new Map([['msg_placeholder', { partKey: 'text:0', text: 'hello' }]])
    })
    // 模拟平滑层已建实例（流式正文输入后）
    pushSmoothText('msg_placeholder', 'text:0', 'hello', 'balanced', '', () => {})
    expect(hasSmoothStream('msg_placeholder')).toBe(true)

    const chunk = {
      type: 'toolsExecuting',
      content: {
        id: 'msg_placeholder',
        role: 'model',
        parts: [{ text: 'hello' }],
        timestamp: 1000
      },
      pendingToolCalls: []
    } as unknown as StreamChunk

    handleToolsExecuting(chunk, state)

    // 消息切回真实 content、置非流式
    const updated = state.allMessages.value[0]
    expect(updated.streaming).toBe(false)
    // 平滑实例已销毁、显示文本已删除
    expect(hasSmoothStream('msg_placeholder')).toBe(false)
    expect(state.smoothTexts.has('msg_placeholder')).toBe(false)
  })

  it('toolsExecuting 无 content（无正文增量）时同样终结当前流消息的平滑条目（模型文本段终点）', () => {
    const streaming = {
      id: 'msg_keep',
      role: 'assistant',
      content: '',
      timestamp: 1000,
      streaming: true,
      localOnly: true,
      parts: [{ text: 'hello' }]
    } as Message
    const state = createState({
      allMessages: ref<Message[]>([streaming]),
      messageIndexById: ref(indexMap([streaming])) as unknown as ChatStoreState['messageIndexById'],
      streamingMessageId: ref('msg_keep'),
      isStreaming: ref(true),
      smoothTexts: new Map()
    })
    pushSmoothText('msg_keep', 'text:0', 'hello', 'balanced', '', () => {})

    handleToolsExecuting({ type: 'toolsExecuting' } as unknown as StreamChunk, state)

    // toolsExecuting 即当前模型文本段终点：无 content 增量也放完积压并删除显示文本，
    // 消息正文切回后端持久化的真实 parts，不再残留平滑条目（防异常终止泄漏）
    expect(hasSmoothStream('msg_keep')).toBe(false)
    expect(state.smoothTexts.has('msg_keep')).toBe(false)
  })
})
