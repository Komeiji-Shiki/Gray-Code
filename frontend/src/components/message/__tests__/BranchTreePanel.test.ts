import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import BranchTreePanel from '../BranchTreePanel.vue'
import type { BranchGraphData, BranchNodeData } from '../../../stores/chat/types'

const chatStoreMock = {
  currentConversationId: 'c1' as string | null,
  branchGraph: null as BranchGraphData | null,
  isSwitchingBranch: false,
  switchBranchCandidate: vi.fn().mockResolvedValue(true),
  deleteBranchCandidate: vi.fn().mockResolvedValue(true),
  restoreBranchCandidate: vi.fn().mockResolvedValue(true),
  renameBranchCandidate: vi.fn().mockResolvedValue(true)
}

vi.mock('@/stores/chatStore', () => ({ useChatStore: () => chatStoreMock }))

function makeNode(id: string, parentId: string | null, overrides: Partial<BranchNodeData> = {}): BranchNodeData {
  return { id, parentId, role: 'model', createdAt: 0, ...overrides }
}

function makeFixtureGraph(): BranchGraphData {
  return {
    version: 1,
    rootNodeId: 'u1',
    activeTailNodeId: 'tail',
    nodes: {
      u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1', parts: [{ text: '起点' }] }),
      a1: makeNode('a1', 'u1', { createdAt: 100, activeChildId: 'middle', parts: [{ text: '回答一' }] }),
      middle: makeNode('middle', 'a1', { createdAt: 110, activeChildId: 'tail', parts: [{ text: '线性中段' }] }),
      tail: makeNode('tail', 'middle', { createdAt: 120, parts: [{ text: '当前尾部' }] }),
      a2: makeNode('a2', 'u1', { createdAt: 200, parts: [{ text: '回答二' }] }),
      aDel: makeNode('aDel', 'u1', { createdAt: 300, deleted: true, parts: [{ text: '已删分支' }] })
    }
  }
}

function resetMock(): void {
  chatStoreMock.currentConversationId = 'c1'
  chatStoreMock.branchGraph = null
  chatStoreMock.isSwitchingBranch = false
  chatStoreMock.switchBranchCandidate.mockClear()
  chatStoreMock.deleteBranchCandidate.mockClear()
  chatStoreMock.restoreBranchCandidate.mockClear()
  chatStoreMock.renameBranchCandidate.mockClear()
}

async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(BranchTreePanel)
  await wrapper.find('.branch-tree-trigger').trigger('click')
  return wrapper
}

describe('BranchTreePanel 入口与双模式', () => {
  beforeEach(resetMock)

  it('无分支或线性图时隐藏入口', () => {
    expect(mount(BranchTreePanel).find('.branch-tree-trigger').exists()).toBe(false)
    chatStoreMock.branchGraph = {
      rootNodeId: 'u1',
      activeTailNodeId: 'a1',
      nodes: {
        u1: makeNode('u1', null, { activeChildId: 'a1' }),
        a1: makeNode('a1', 'u1')
      }
    }
    expect(mount(BranchTreePanel).find('.branch-tree-trigger').exists()).toBe(false)
  })

  it('有候选时显示入口，默认使用分支导航并可由背板关闭', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    expect(wrapper.find('.branch-tree-title').text()).toContain('分支历史')
    expect(wrapper.find('.branch-tree-view-tab.selected').text()).toContain('分支导航')
    expect(wrapper.findAll('.branch-tree-collapsed-row')).toHaveLength(1)
    expect(wrapper.find('.branch-tree-collapsed-row').text()).toContain('已折叠 1 条连续消息')
    expect(wrapper.findAll('.branch-tree-row')).toHaveLength(5)

    await wrapper.find('.branch-tree-backdrop').trigger('click')
    expect(wrapper.find('.branch-tree-panel-box').exists()).toBe(false)
  })

  it('切换完整消息模式后显示所有节点，线性后代保持同一轨道', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()
    await wrapper.findAll('.branch-tree-view-tab')[1].trigger('click')

    expect(wrapper.find('.branch-tree-view-tab.selected').text()).toContain('完整消息')
    expect(wrapper.findAll('.branch-tree-collapsed-row')).toHaveLength(0)
    const rows = wrapper.findAll('.branch-tree-row')
    expect(rows).toHaveLength(6)
    expect(rows[0].attributes('style')).toContain('--lane: 0')
    expect(rows[1].attributes('style')).toContain('--lane: 0')
    expect(rows[2].attributes('style')).toContain('--lane: 0')
    expect(rows[3].attributes('style')).toContain('--lane: 0')
    expect(rows[4].attributes('style')).toContain('--lane: 1')
  })
})

describe('BranchTreePanel 分支管理操作', () => {
  beforeEach(resetMock)

  it('点击非活跃候选切换，活跃节点与软删节点不响应', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()
    const rows = wrapper.findAll('.branch-tree-row')

    const candidate = rows.find(row => row.find('.branch-tree-preview').text() === '回答二')!
    await candidate.find('.branch-tree-row-main').trigger('click')
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('a2')

    const active = rows.find(row => row.find('.branch-tree-preview').text() === '回答一')!
    const deleted = rows.find(row => row.find('.branch-tree-preview').text() === '已删分支')!
    await active.find('.branch-tree-row-main').trigger('click')
    await deleted.find('.branch-tree-row-main').trigger('click')
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)
  })

  it('保留删除二次确认与软删恢复', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()
    const rows = wrapper.findAll('.branch-tree-row')
    const candidate = rows.find(row => row.find('.branch-tree-preview').text() === '回答二')!
    const deleteButton = candidate.findAll('.branch-tree-action')[1]

    await deleteButton.trigger('click')
    expect(chatStoreMock.deleteBranchCandidate).not.toHaveBeenCalled()
    expect(deleteButton.classes()).toContain('confirming')
    await deleteButton.trigger('click')
    expect(chatStoreMock.deleteBranchCandidate).toHaveBeenCalledWith('a2')

    const deleted = rows.find(row => row.find('.branch-tree-preview').text() === '已删分支')!
    await deleted.find('.branch-tree-action').trigger('click')
    expect(chatStoreMock.restoreBranchCandidate).toHaveBeenCalledWith('aDel')
  })

  it('支持行内重命名并在忙碌时禁用动作', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    let wrapper = await mountOpen()
    let candidate = wrapper.findAll('.branch-tree-row').find(row => row.find('.branch-tree-preview').text() === '回答二')!
    await candidate.findAll('.branch-tree-action')[0].trigger('click')
    const input = wrapper.find('.branch-tree-rename-input')
    await input.setValue('候选标签')
    await input.trigger('keydown', { key: 'Enter' })
    expect(chatStoreMock.renameBranchCandidate).toHaveBeenCalledWith('a2', '候选标签')
    wrapper.unmount()

    chatStoreMock.isSwitchingBranch = true
    wrapper = await mountOpen()
    candidate = wrapper.findAll('.branch-tree-row').find(row => row.find('.branch-tree-preview').text() === '回答二')!
    expect(candidate.find('.branch-tree-action').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.branch-tree-busy').exists()).toBe(true)
  })
})
