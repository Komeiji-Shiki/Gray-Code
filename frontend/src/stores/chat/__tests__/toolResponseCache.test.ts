/**
 * toolResponseCache 容量上限回归测试（fix/bugfix-scan-round）。
 *
 * 背景：长会话内 toolResponseCache 随工具调用数线性增长无淘汰；每次 cache-miss
 * 回填都 set + triggerRef，级联触发 todoSnapshot 全量重放（O(M×N)）。
 *
 * 修复：state.ts 新增 TOOL_RESPONSE_CACHE_MAX_SIZE（500）上限，所有写入方经
 * setToolResponseCacheEntry / setToolResponseCacheEntries 统一淘汰最旧条目
 * （Map 迭代序 = 插入序）。
 */
import { describe, expect } from 'vitest'
import { ref } from 'vue'
import {
  TOOL_RESPONSE_CACHE_MAX_SIZE,
  rebuildMessageIndexById,
  setToolResponseCacheEntry,
  setToolResponseCacheEntries
} from '../state'
import { getToolResponseById } from '../toolActions'
import type { Message } from '../../../types'
import type { ChatStoreState } from '../types'

function makeFunctionResponseMessage(
  id: string,
  functionResponses: Array<{ id: string; name: string; response: Record<string, unknown> }>
): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    parts: functionResponses.map(fr => ({
      functionResponse: {
        id: fr.id,
        name: fr.name,
        response: fr.response
      }
    })),
    isFunctionResponse: true
  }
}

/** Creates a minimal mock state with enough fields for toolResponseCache writes */
function mockState(messages: Message[] = []): ChatStoreState {
  return {
    allMessages: ref(messages),
    messageIndexById: ref(new Map()),
    toolResponseIndex: ref(new Map()),
    toolResponseCache: ref(new Map()),
    // stubs for other required fields
    conversations: ref([]),
    persistedConversationIds: ref([]),
    persistedConversationsLoaded: ref(0),
    isLoadingMoreConversations: ref(false),
    currentConversationId: ref(null),
    windowStartIndex: ref(0),
    totalMessages: ref(0),
    isLoadingMoreMessages: ref(false),
    historyFolded: ref(false),
    foldedMessageCount: ref(0),
    configId: ref(''),
    selectedModelId: ref(''),
    currentConfig: ref(null),
    isLoading: ref(false),
    isStreaming: ref(false),
    isLoadingConversations: ref(false),
    error: ref(null),
    streamingMessageId: ref(null),
    activeStreamId: ref(null),
    isWaitingForResponse: ref(false),
    retryStatus: ref(null),
    autoSummaryStatus: ref(null),
    checkpoints: ref([]),
    mergeUnchangedCheckpoints: ref(true),
    deletingConversationIds: ref(new Set()),
    currentWorkspaceUri: ref(null),
    inputValue: ref(''),
    workspaceFilter: ref('current'),
    editorNodes: ref([]),
    attachments: ref([]),
    currentPromptModeId: ref('code'),
    activeBuild: ref(null),
    pendingModelOverride: ref(null),
    pendingConfigIdOverride: ref<string | null>(null),
    messageQueue: ref([]),
    _lastCancelledStreamId: ref(null),
    _lastApprovalGatedStreamId: ref(null),
    _pendingBranchRefreshAfterStream: ref<string | null>(null),
    _pendingBranchReplayContext: ref(null),
    openTabs: ref([]),
    activeTabId: ref(null),
    sessionSnapshots: ref(new Map()),
    backgroundStreamBuffers: ref(new Map())
  } as unknown as ChatStoreState
}

describe('toolResponseCache 容量上限', () => {
  test('单条写入超过上限后淘汰最旧条目（Map 插入序）', () => {
    const state = mockState([])
    for (let i = 0; i < TOOL_RESPONSE_CACHE_MAX_SIZE + 20; i++) {
      setToolResponseCacheEntry(state, `tool-${i}`, { seq: i })
    }
    // 容量有界
    expect(state.toolResponseCache.value.size).toBe(TOOL_RESPONSE_CACHE_MAX_SIZE)
    // 最旧的 20 条被淘汰
    expect(state.toolResponseCache.value.has('tool-0')).toBe(false)
    expect(state.toolResponseCache.value.has('tool-19')).toBe(false)
    // 最近写入的仍保留
    expect(state.toolResponseCache.value.has(`tool-${TOOL_RESPONSE_CACHE_MAX_SIZE + 19}`)).toBe(true)
    // 迭代序即插入序：第一个 key 是淘汰后最旧的保留条目
    const firstKey = state.toolResponseCache.value.keys().next().value
    expect(firstKey).toBe('tool-20')
  })

  test('批量写入同样受容量上限约束', () => {
    const state = mockState([])
    const entries: Array<[string, Record<string, unknown>]> = []
    for (let i = 0; i < TOOL_RESPONSE_CACHE_MAX_SIZE + 5; i++) {
      entries.push([`tool-${i}`, { seq: i }])
    }
    setToolResponseCacheEntries(state, entries)
    expect(state.toolResponseCache.value.size).toBe(TOOL_RESPONSE_CACHE_MAX_SIZE)
    expect(state.toolResponseCache.value.has('tool-0')).toBe(false)
    expect(state.toolResponseCache.value.has(`tool-${TOOL_RESPONSE_CACHE_MAX_SIZE + 4}`)).toBe(true)
  })

  test('getToolResponseById 回填受容量上限约束（长会话缓存有界）', () => {
    const messages: Message[] = []
    for (let i = 0; i < TOOL_RESPONSE_CACHE_MAX_SIZE + 10; i++) {
      messages.push(makeFunctionResponseMessage(`fr-${i}`, [
        { id: `tool-${i}`, name: 'read_file', response: { seq: i } }
      ]))
    }
    const state = mockState(messages)
    rebuildMessageIndexById(state)

    // 依次查询全部工具响应（每次 cache miss 都触发回填）
    for (let i = 0; i < messages.length; i++) {
      expect(getToolResponseById(state, `tool-${i}`)).toEqual({ seq: i })
    }

    // 缓存有界：只保留最近 TOOL_RESPONSE_CACHE_MAX_SIZE 条
    expect(state.toolResponseCache.value.size).toBe(TOOL_RESPONSE_CACHE_MAX_SIZE)
    expect(state.toolResponseCache.value.has('tool-0')).toBe(false)
    expect(state.toolResponseCache.value.has(`tool-${TOOL_RESPONSE_CACHE_MAX_SIZE + 9}`)).toBe(true)

    // 已淘汰的最旧条目仍可经权威索引（toolResponseIndex）重新定位，查询结果不受缓存淘汰影响
    expect(getToolResponseById(state, 'tool-0')).toEqual({ seq: 0 })
    expect(state.toolResponseCache.value.size).toBe(TOOL_RESPONSE_CACHE_MAX_SIZE)
  })

  test('写入已有 key 不增加容量（覆盖更新）', () => {
    const state = mockState([])
    setToolResponseCacheEntry(state, 'tool-x', { v: 1 })
    setToolResponseCacheEntry(state, 'tool-x', { v: 2 })
    expect(state.toolResponseCache.value.size).toBe(1)
    expect(state.toolResponseCache.value.get('tool-x')).toEqual({ v: 2 })
  })

  test('满员时覆盖更新已有 key 不触发淘汰（容量保持，FIFO 队首仍是最旧）', () => {
    const state = mockState([])
    for (let i = 0; i < TOOL_RESPONSE_CACHE_MAX_SIZE; i++) {
      setToolResponseCacheEntry(state, `tool-${i}`, { seq: i })
    }
    // 满员后覆盖更新最旧 key：不应触发淘汰，其他条目完整保留
    setToolResponseCacheEntry(state, 'tool-0', { seq: 'updated' })
    expect(state.toolResponseCache.value.size).toBe(TOOL_RESPONSE_CACHE_MAX_SIZE)
    expect(state.toolResponseCache.value.has('tool-1')).toBe(true)
    expect(state.toolResponseCache.value.get('tool-0')).toEqual({ seq: 'updated' })

    // 继续写入新 key：FIFO 淘汰最旧条目（Map.set 更新已有 key 不改变迭代顺序，
    // tool-0 仍是最旧；修复点在于「更新本身不再误淘汰其他条目」）
    setToolResponseCacheEntry(state, 'tool-new', { seq: 'new' })
    expect(state.toolResponseCache.value.size).toBe(TOOL_RESPONSE_CACHE_MAX_SIZE)
    expect(state.toolResponseCache.value.has('tool-0')).toBe(false)
    expect(state.toolResponseCache.value.has('tool-1')).toBe(true)
    expect(state.toolResponseCache.value.get('tool-new')).toEqual({ seq: 'new' })
  })

  test('批量写入满员时更新已有 key 不触发淘汰（仅新增触发）', () => {
    const state = mockState([])
    const entries: Array<[string, Record<string, unknown>]> = []
    for (let i = 0; i < TOOL_RESPONSE_CACHE_MAX_SIZE; i++) {
      entries.push([`tool-${i}`, { seq: i }])
    }
    setToolResponseCacheEntries(state, entries)

    // 批量仅覆盖更新已有 key：不触发淘汰
    setToolResponseCacheEntries(state, [['tool-0', { seq: 'updated' }]])
    expect(state.toolResponseCache.value.size).toBe(TOOL_RESPONSE_CACHE_MAX_SIZE)
    expect(state.toolResponseCache.value.get('tool-0')).toEqual({ seq: 'updated' })
    expect(state.toolResponseCache.value.has('tool-1')).toBe(true)

    // 批量更新 + 新增：只有新增触发 FIFO 淘汰（tool-0 仍是最旧，被淘汰）
    setToolResponseCacheEntries(state, [
      ['tool-1', { seq: 'updated-2' }],
      ['tool-new', { seq: 'new' }]
    ])
    expect(state.toolResponseCache.value.size).toBe(TOOL_RESPONSE_CACHE_MAX_SIZE)
    expect(state.toolResponseCache.value.has('tool-0')).toBe(false)
    expect(state.toolResponseCache.value.get('tool-1')).toEqual({ seq: 'updated-2' })
    expect(state.toolResponseCache.value.get('tool-new')).toEqual({ seq: 'new' })
  })
})
