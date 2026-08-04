/**
 * 重试状态 UI 生命周期测试
 *
 * 验证「超时/网络错误 → 重试页面显示 → 重试成功/失败 → 重试页面消失」的完整链路：
 * - retrying：设置 retryStatus（isRetrying=true）→ 面板显示
 * - retrySuccess：清空 retryStatus → 面板消失
 * - retryFailed：清空 retryStatus → 面板消失（错误由消息区错误态呈现）
 * - 非当前对话的重试状态写入对应标签页快照，不污染当前面板
 */
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { handleRetryStatus } from '../configActions'
import type { ChatStoreState } from '../types'

/** Creates a minimal mock state with all fields used by handleRetryStatus */
function mockState(): ChatStoreState {
  return {
    currentConversationId: ref('conv-current'),
    retryStatus: ref(null),
    openTabs: ref([]),
    sessionSnapshots: ref(new Map()),
    ...({} as Partial<ChatStoreState>)
  } as unknown as ChatStoreState
}

function makeStatus(type: 'retrying' | 'retrySuccess' | 'retryFailed', overrides: Record<string, unknown> = {}) {
  return {
    type,
    attempt: 1,
    maxAttempts: 3,
    createdAt: 1,
    conversationId: 'conv-current',
    ...overrides
  } as Parameters<typeof handleRetryStatus>[1]
}

describe('handleRetryStatus 重试页面生命周期', () => {
  it('retrying 设置重试状态（面板显示）', () => {
    const state = mockState()
    handleRetryStatus(state, makeStatus('retrying', { attempt: 2, nextRetryIn: 3000 }))

    expect(state.retryStatus.value).toMatchObject({
      isRetrying: true,
      attempt: 2,
      maxAttempts: 3,
      nextRetryIn: 3000
    })
  })

  it('retrySuccess 清空重试状态（面板消失）', () => {
    const state = mockState()
    handleRetryStatus(state, makeStatus('retrying'))
    expect(state.retryStatus.value?.isRetrying).toBe(true)

    handleRetryStatus(state, makeStatus('retrySuccess'))
    expect(state.retryStatus.value).toBeNull()
  })

  it('retryFailed 清空重试状态（面板消失，错误由消息区呈现）', () => {
    const state = mockState()
    handleRetryStatus(state, makeStatus('retrying'))
    expect(state.retryStatus.value?.isRetrying).toBe(true)

    handleRetryStatus(state, makeStatus('retryFailed', { error: 'boom' }))
    expect(state.retryStatus.value).toBeNull()
  })

  it('重试失败后再次 retrying 可重新显示面板（多次重试不卡死）', () => {
    const state = mockState()
    handleRetryStatus(state, makeStatus('retrying', { attempt: 1 }))
    handleRetryStatus(state, makeStatus('retryFailed'))
    handleRetryStatus(state, makeStatus('retrying', { attempt: 2 }))

    expect(state.retryStatus.value).toMatchObject({ isRetrying: true, attempt: 2 })
  })

  it('非当前对话的重试状态写入对应标签页快照，不污染当前面板', () => {
    const state = mockState()
    state.openTabs.value = [
      { id: 'tab-other', conversationId: 'conv-other', title: 'Other', isStreaming: false }
    ]
    state.sessionSnapshots.value.set('tab-other', {
      conversationId: 'conv-other',
      retryStatus: null
    } as any)

    handleRetryStatus(state, makeStatus('retrying', { conversationId: 'conv-other' }))

    // 当前面板不受影响
    expect(state.retryStatus.value).toBeNull()
    // 快照记录了重试状态
    expect((state.sessionSnapshots.value.get('tab-other') as any).retryStatus).toMatchObject({
      isRetrying: true
    })

    handleRetryStatus(state, makeStatus('retrySuccess', { conversationId: 'conv-other' }))
    expect((state.sessionSnapshots.value.get('tab-other') as any).retryStatus).toBeNull()
  })
})
