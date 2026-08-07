/**
 * syncConversationWorkspaceUri（对话绑定工作区）回归测试 —— 1.7.3 锁定修复批次。
 *
 * 覆盖：
 * - 已绑定对话：不发起任何 IPC（fetch 也不发），锁定展示不被扩展端旧激活值覆盖；
 * - 未绑定对话：按扩展端激活工作区补绑并同步 store；
 * - getWorkspaceUri 失败时回退 store 当前值；
 * - await 期间目标会话已被绑定：不重复绑定、不同步 store（TOCTOU）。
 */
import { ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { ChatStoreState } from '../types'
import { syncConversationWorkspaceUri } from '../conversationActions'

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '../../../utils/vscode'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

function createState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    currentConversationId: ref(null),
    conversations: ref([]),
    currentWorkspaceUri: ref(null),
    ...overrides
  } as unknown as ChatStoreState
}

const WS_A = 'file:///c%3A/Users/foo/ProjectA'
const WS_B = 'file:///c%3A/Users/foo/ProjectB'

function makeConv(id: string, workspaceUri?: string) {
  return {
    id,
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isPersisted: true,
    workspaceUri
  } as NonNullable<ChatStoreState['conversations']['value']>[number]
}

describe('syncConversationWorkspaceUri（绑定锁定修复）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('已绑定对话：不发起任何 IPC，锁定展示不被扩展端旧激活值覆盖', async () => {
    const state = createState({
      currentConversationId: ref('conv-locked'),
      conversations: ref([makeConv('conv-locked', WS_B)]),
      currentWorkspaceUri: ref(WS_B)
    })
    mockSend.mockResolvedValue(WS_A)

    await syncConversationWorkspaceUri(state, 'conv-locked')

    expect(mockSend).not.toHaveBeenCalled()
    expect(state.currentWorkspaceUri.value).toBe(WS_B)
  })

  it('未绑定对话：按扩展端激活工作区补绑并同步 store', async () => {
    const state = createState({
      currentConversationId: ref('conv-free'),
      conversations: ref([makeConv('conv-free')]),
      currentWorkspaceUri: ref(WS_B)
    })
    mockSend.mockImplementation((command: string) => {
      if (command === 'getWorkspaceUri') return Promise.resolve(WS_A)
      if (command === 'conversation.setWorkspaceUri') return Promise.resolve({ success: true })
      return Promise.resolve(null)
    })

    await syncConversationWorkspaceUri(state, 'conv-free')

    expect(mockSend).toHaveBeenCalledWith('conversation.setWorkspaceUri', {
      conversationId: 'conv-free',
      workspaceUri: WS_A
    })
    expect(state.conversations.value[0].workspaceUri).toBe(WS_A)
    expect(state.currentWorkspaceUri.value).toBe(WS_A)
  })

  it('getWorkspaceUri 失败时回退 store 当前值绑定', async () => {
    const state = createState({
      currentConversationId: ref('conv-free2'),
      conversations: ref([makeConv('conv-free2')]),
      currentWorkspaceUri: ref(WS_B)
    })
    mockSend.mockImplementation((command: string) => {
      if (command === 'getWorkspaceUri') return Promise.reject(new Error('boom'))
      if (command === 'conversation.setWorkspaceUri') return Promise.resolve({ success: true })
      return Promise.resolve(null)
    })

    await syncConversationWorkspaceUri(state, 'conv-free2')

    expect(mockSend).toHaveBeenCalledWith('conversation.setWorkspaceUri', {
      conversationId: 'conv-free2',
      workspaceUri: WS_B
    })
    expect(state.conversations.value[0].workspaceUri).toBe(WS_B)
  })

  it('await 期间目标会话已被绑定：不重复绑定、不同步 store（TOCTOU）', async () => {
    const state = createState({
      currentConversationId: ref('conv-race'),
      conversations: ref([makeConv('conv-race')]),
      currentWorkspaceUri: ref(null)
    })
    let resolveFetch!: (v: string | null) => void
    mockSend.mockImplementation((command: string) => {
      if (command === 'getWorkspaceUri') {
        return new Promise<string | null>((res) => {
          resolveFetch = res
        })
      }
      if (command === 'conversation.setWorkspaceUri') return Promise.resolve({ success: true })
      return Promise.resolve(null)
    })

    const pending = syncConversationWorkspaceUri(state, 'conv-race')
    // await 期间会话被其他路径绑定
    state.conversations.value[0].workspaceUri = WS_B
    resolveFetch(WS_A)
    await pending

    const setCalls = mockSend.mock.calls.filter(c => c[0] === 'conversation.setWorkspaceUri')
    expect(setCalls).toHaveLength(0)
    expect(state.conversations.value[0].workspaceUri).toBe(WS_B)
    expect(state.currentWorkspaceUri.value).toBeNull()
  })
})
