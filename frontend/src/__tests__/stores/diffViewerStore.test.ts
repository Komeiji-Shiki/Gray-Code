/**
 * 变更查看面板 Store 单元测试
 *
 * 覆盖：
 * - push 创建条目（pending + 轮次分组）
 * - 关闭面板后条目保留（上一轮变更可继续查看与比对）
 * - 已处理条目被再次推送时保持已解决状态（不再回退成待处理）
 * - 轮次分组：时间间隔超过阈值视为新一轮
 * - clearHistory 清空历史
 * - acceptAll/rejectAll 只作用于待处理条目
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDiffStore, type DiffViewerEntryInput } from '../../stores/diffStore'
import { sendToExtension } from '../../utils/vscode'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ status: 'accepted' })
}))

const mockSend = vi.mocked(sendToExtension)

function makeInput(overrides: Partial<DiffViewerEntryInput> = {}): DiffViewerEntryInput {
  return {
    previewId: 'preview-1',
    sessionId: 'diff-1',
    title: 'test',
    filePath: 'src/a.ts',
    originalContent: 'old',
    newContent: 'new',
    ...overrides
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(Date.now())
  mockSend.mockReset()
  mockSend.mockResolvedValue({ status: 'accepted' } as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('diffViewer store', () => {
  it('push 创建待处理条目并自动打开面板', () => {
    const store = useDiffStore()
    store.push(makeInput())

    expect(store.open).toBe(true)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].status).toBe('pending')
    expect(store.entries[0].round).toBe(1)
    expect(store.pendingCount).toBe(1)
  })

  it('关闭面板后条目保留，重新打开仍可查看上一轮变更', () => {
    const store = useDiffStore()
    store.push(makeInput())
    store.close()

    expect(store.open).toBe(false)
    expect(store.entries).toHaveLength(1)

    store.openPanel()
    expect(store.open).toBe(true)
    expect(store.selectedEntry?.filePath).toBe('src/a.ts')
  })

  it('已接受的条目被再次推送时保持已接受状态（不出现接受/拒绝按钮的前提）', async () => {
    const store = useDiffStore()
    store.push(makeInput())
    await store.accept(0)
    expect(store.entries[0].status).toBe('accepted')

    // 模拟工具卡「查看差异」再次推送同一 diff
    store.push(makeInput({ previewId: 'preview-1', sessionId: 'diff-1' }))

    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].status).toBe('accepted')
    expect(store.entries[0].round).toBe(1)
  })

  it('已拒绝的条目被再次推送时保持已拒绝状态', async () => {
    const store = useDiffStore()
    store.push(makeInput())
    mockSend.mockResolvedValueOnce({ status: 'rejected' } as never)
    await store.reject(0)
    expect(store.entries[0].status).toBe('rejected')

    store.push(makeInput({ previewId: 'preview-1', sessionId: 'diff-1' }))
    expect(store.entries[0].status).toBe('rejected')
  })

  it('同一批推送归为同一轮，间隔超过阈值视为新一轮', () => {
    const store = useDiffStore()
    store.push(makeInput({ previewId: 'p1', sessionId: 'd1', filePath: 'src/a.ts' }))
    store.push(makeInput({ previewId: 'p2', sessionId: 'd2', filePath: 'src/b.ts' }))
    expect(store.entries[0].round).toBe(1)
    expect(store.entries[1].round).toBe(1)

    vi.advanceTimersByTime(3000)
    store.push(makeInput({ previewId: 'p3', sessionId: 'd3', filePath: 'src/c.ts' }))
    expect(store.entries[2].round).toBe(2)
  })

  it('clearHistory 清空全部条目并重置轮次', () => {
    const store = useDiffStore()
    store.push(makeInput())
    store.clearHistory()

    expect(store.entries).toHaveLength(0)
    expect(store.selectedEntry).toBeNull()

    store.push(makeInput())
    expect(store.entries[0].round).toBe(1)
  })

  it('acceptAll 只接受待处理条目，不影响已处理条目', async () => {
    const store = useDiffStore()
    store.push(makeInput({ previewId: 'p1', sessionId: 'd1' }))
    await store.accept(0)
    store.push(makeInput({ previewId: 'p2', sessionId: 'd2', filePath: 'src/b.ts' }))
    expect(store.pendingCount).toBe(1)

    await store.acceptAll()
    expect(store.entries[0].status).toBe('accepted')
    expect(store.entries[1].status).toBe('accepted')
    expect(store.pendingCount).toBe(0)
  })

  it('DIFF_NOT_PENDING（自动应用后竞态）不残留错误提示：条目由广播结算', async () => {
    const store = useDiffStore()
    store.push(makeInput())
    const err = new Error('The diff is no longer pending (it may have been auto-applied or cancelled).') as Error & { code?: string }
    err.code = 'DIFF_NOT_PENDING'
    mockSend.mockRejectedValueOnce(err)

    const result = await store.accept(0)

    expect(result).toBe(false)
    expect(store.entries[0].error).toBeUndefined()
    expect(store.entries[0].status).toBe('pending')
    expect(store.entries[0].busy).toBe(false)

    // 后端 finalized 广播随后把条目结算为已接受（自动应用路径）
    store.syncStatuses({
      pendingDiffs: [],
      finalized: [{ id: 'diff-1', status: 'accepted' }]
    })
    expect(store.entries[0].status).toBe('accepted')
    expect(store.entries[0].error).toBeUndefined()
  })

  it('非 DIFF_NOT_PENDING 错误仍保留行内错误提示', async () => {
    const store = useDiffStore()
    store.push(makeInput())
    mockSend.mockRejectedValueOnce(new Error('DIFF_ACCEPT_FAILED: write failed'))

    await store.accept(0)

    expect(store.entries[0].error).toBe('DIFF_ACCEPT_FAILED: write failed')
    expect(store.entries[0].busy).toBe(false)
  })
})
