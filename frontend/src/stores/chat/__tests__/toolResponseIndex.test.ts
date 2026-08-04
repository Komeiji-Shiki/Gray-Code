import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import {
  buildToolResponseIndex,
  rebuildMessageIndexById,
  appendMessage
} from '../state'
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

function makeNormalMessage(id: string): Message {
  return {
    id,
    role: 'user',
    content: 'hello',
    timestamp: Date.now(),
    parts: [{ text: 'hello' }]
  }
}

/** Creates a minimal mock state with enough fields for MessageIndexState */
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
    messageQueue: ref([]),
    _lastCancelledStreamId: ref(null),
    _lastApprovalGatedStreamId: ref(null),
    _pendingBranchRefreshAfterStream: ref<string | null>(null),
    openTabs: ref([]),
    activeTabId: ref(null),
    sessionSnapshots: ref(new Map()),
    backgroundStreamBuffers: ref(new Map())
  } as unknown as ChatStoreState
}

describe('buildToolResponseIndex', () => {
  it('returns empty map for empty messages', () => {
    expect(buildToolResponseIndex([]).size).toBe(0)
  })

  it('ignores non-functionResponse messages', () => {
    const messages = [makeNormalMessage('msg-1'), makeNormalMessage('msg-2')]
    expect(buildToolResponseIndex(messages).size).toBe(0)
  })

  it('indexes functionResponse ids to message positions', () => {
    const messages = [
      makeNormalMessage('msg-0'),
      makeFunctionResponseMessage('fr-msg', [
        { id: 'tool-a', name: 'read_file', response: { success: true } }
      ])
    ]
    const index = buildToolResponseIndex(messages)
    expect(index.get('tool-a')).toBe(1)
  })

  it('maps first occurrence only (duplicate functionResponse ids)', () => {
    const messages = [
      makeFunctionResponseMessage('fr-1', [
        { id: 'dup', name: 'tool', response: { first: true } }
      ]),
      makeFunctionResponseMessage('fr-2', [
        { id: 'dup', name: 'tool', response: { second: true } }
      ])
    ]
    const index = buildToolResponseIndex(messages)
    expect(index.get('dup')).toBe(0)
  })

  it('indexes multiple functionResponse parts in a single message', () => {
    const messages = [
      makeFunctionResponseMessage('multi-fr', [
        { id: 'tool-1', name: 'a', response: {} },
        { id: 'tool-2', name: 'b', response: {} }
      ])
    ]
    const index = buildToolResponseIndex(messages)
    expect(index.get('tool-1')).toBe(0)
    expect(index.get('tool-2')).toBe(0)
  })

  it('ignores functionResponse parts without id', () => {
    const messages = [
      makeFunctionResponseMessage('fr-msg', [
        { id: '', name: 'bad', response: {} }
      ])
    ]
    // Override the id to empty string
    messages[0].parts![0].functionResponse!.id = ''
    const index = buildToolResponseIndex(messages)
    expect(index.size).toBe(0)
  })
})

describe('rebuildMessageIndexById with toolResponseIndex', () => {
  it('rebuilds toolResponseIndex alongside messageIndexById', () => {
    const messages = [
      makeNormalMessage('msg-1'),
      makeFunctionResponseMessage('fr-1', [
        { id: 'tool-x', name: 'x', response: { ok: true } }
      ])
    ]
    const state = mockState(messages)
    rebuildMessageIndexById(state)

    expect(state.toolResponseIndex.value.get('tool-x')).toBe(1)
  })
})

describe('appendMessage with toolResponseIndex', () => {
  let state: ChatStoreState

  beforeEach(() => {
    state = mockState([])
    rebuildMessageIndexById(state)
  })

  it('updates toolResponseIndex when appending a functionResponse message', () => {
    appendMessage(state, makeNormalMessage('msg-1'))
    appendMessage(state, makeFunctionResponseMessage('fr-1', [
      { id: 'tool-y', name: 'y', response: { done: true } }
    ]))

    expect(state.toolResponseIndex.value.get('tool-y')).toBe(1)
  })

  it('does not register duplicate functionResponse ids', () => {
    appendMessage(state, makeFunctionResponseMessage('fr-1', [
      { id: 'dup', name: 'a', response: {} }
    ]))
    appendMessage(state, makeFunctionResponseMessage('fr-2', [
      { id: 'dup', name: 'a', response: {} }
    ]))

    expect(state.toolResponseIndex.value.get('dup')).toBe(0)
  })
})
