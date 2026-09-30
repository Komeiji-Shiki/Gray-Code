import { beforeEach, describe, expect, test, vi } from 'vitest'
import { usePlanSourceStatus } from '../../composables/usePlanSourceStatus'
import type { TaskCardItem } from '../../components/message/messageTaskCards/taskCardTypes'

vi.mock('@/utils/vscode', () => ({ sendToExtension: vi.fn() }))
import { sendToExtension } from '@/utils/vscode'

const card = { key: 'plan', kind: 'plan', path: '.graycode/plans/a.md', content: '# Plan' } as TaskCardItem

beforeEach(() => vi.mocked(sendToExtension).mockReset())

describe('计划来源状态', () => {
  // 独立宿主按对话读取工作区；缺少 conversationId 时每次查询都会被拒绝，来源阻断永远不显示。
  test('查询携带对话并展示宿主返回的阻断状态', async () => {
    vi.mocked(sendToExtension).mockResolvedValue({ success: true, sourceStatus: 'missing_source', blocked: true })
    const status = usePlanSourceStatus()
    await status.refreshPlanSourceStatuses([card], 'conversation')
    expect(sendToExtension).toHaveBeenCalledWith('plan.getSourceStatus', { path: card.path, originalContent: card.content, conversationId: 'conversation' })
    expect(status.isPlanSourceBlocked(card)).toBe(true)
  })

  test('没有对话时不发送必然失败的查询', async () => {
    const status = usePlanSourceStatus()
    await status.refreshPlanSourceStatuses([card], null)
    expect(sendToExtension).not.toHaveBeenCalled()
    expect(status.getPlanSourceState(card)).toBeNull()
  })
})
