/**
 * BranchSwitcherBar 组件测试（TREE-10 消息内联候选切换器）
 *
 * 覆盖：
 * - 显隐：无分支图 / 单候选 / 未知父节点 / 无当前对话 → 隐藏；≥2 候选 → 显示「2 / 3」
 * - 切换交互：‹ / › 循环切换；候选列表点击切换
 * - 删除交互：两步确认（第一次进入确认态，第二次才调用 deleteBranchCandidate）
 * - 忙碌态：isSwitchingBranch 时按钮禁用
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import BranchSwitcherBar from '../BranchSwitcherBar.vue'
import type { BranchGraphData, BranchNodeData } from '../../../stores/chat/types'

// 假 chatStore：组件仅使用 branchGraph / currentConversationId / isSwitchingBranch 与两个动作
const chatStoreMock = {
  currentConversationId: 'c1' as string | null,
  branchGraph: null as BranchGraphData | null,
  isSwitchingBranch: false,
  switchBranchCandidate: vi.fn().mockResolvedValue(true),
  deleteBranchCandidate: vi.fn().mockResolvedValue(true)
}

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => chatStoreMock
}))

function makeNode(id: string, parentId: string | null, overrides: Partial<BranchNodeData> = {}): BranchNodeData {
  return { id, parentId, role: 'model', createdAt: 0, ...overrides }
}

function makeGraph(nodes: Record<string, BranchNodeData>, activeTailNodeId: string): BranchGraphData {
  return { version: 1, rootNodeId: 'u1', activeTailNodeId, nodes }
}

/** 三候选图：u1 → [a1, a2, a3]，u1.activeChildId 指向当前活跃候选 */
function makeThreeCandidateGraph(activeTailNodeId: string): BranchGraphData {
  return makeGraph(
    {
      u1: makeNode('u1', null, { role: 'user', activeChildId: activeTailNodeId }),
      a1: makeNode('a1', 'u1', { createdAt: 100, parts: [{ text: '回答一' }] }),
      a2: makeNode('a2', 'u1', { createdAt: 200, parts: [{ text: '回答二' }] }),
      a3: makeNode('a3', 'u1', { createdAt: 300, parts: [{ text: '回答三' }] })
    },
    activeTailNodeId
  )
}

function mountBar(nodeId = 'a2'): ReturnType<typeof mount> {
  return mount(BranchSwitcherBar, {
    props: { nodeId },
    // 交互测试关注候选行为；定位回归测试单独使用真实 Teleport。
    global: { stubs: { teleport: true } }
  })
}

function mountTeleportedBar(): ReturnType<typeof mount> {
  return mount(BranchSwitcherBar, { props: { nodeId: 'a2' } })
}

describe('BranchSwitcherBar 显隐', () => {
  beforeEach(() => {
    chatStoreMock.currentConversationId = 'c1'
    chatStoreMock.branchGraph = null
    chatStoreMock.isSwitchingBranch = false
    chatStoreMock.switchBranchCandidate.mockClear()
    chatStoreMock.deleteBranchCandidate.mockClear()
  })

  it('无分支图 → 隐藏', () => {
    const wrapper = mountBar()
    expect(wrapper.find('.branch-switcher-bar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('单候选（即使消息在图中）→ 隐藏', () => {
    chatStoreMock.branchGraph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1' }), a1: makeNode('a1', 'u1') },
      'a1'
    )
    const wrapper = mount(BranchSwitcherBar, { props: { nodeId: 'a1' } })
    expect(wrapper.find('.branch-switcher-bar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('未知节点（消息不在图中）→ 隐藏', () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mount(BranchSwitcherBar, { props: { nodeId: 'not_in_graph' } })
    expect(wrapper.find('.branch-switcher-bar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('候选组的父节点（自己不是候选成员）→ 隐藏', () => {
    // 切换器跟随活跃候选（a2），而不是挂在父节点 u1 上
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mount(BranchSwitcherBar, { props: { nodeId: 'u1' } })
    expect(wrapper.find('.branch-switcher-bar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('非活跃候选 → 隐藏（旧候选不在主历史 UI，不渲染切换器）', () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mount(BranchSwitcherBar, { props: { nodeId: 'a1' } })
    expect(wrapper.find('.branch-switcher-bar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('无当前对话 → 隐藏', () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    chatStoreMock.currentConversationId = null
    const wrapper = mountBar()
    expect(wrapper.find('.branch-switcher-bar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('compact 模式用于消息操作栏：保留候选切换器但使用紧凑类', () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mount(BranchSwitcherBar, { props: { nodeId: 'a2', compact: true } })
    expect(wrapper.find('.branch-switcher-bar').classes()).toContain('compact')
    expect(wrapper.find('.branch-switcher-position-text').text()).toBe('2 / 3')
    wrapper.unmount()
  })
})

describe('BranchSwitcherBar 切换交互', () => {
  beforeEach(() => {
    chatStoreMock.currentConversationId = 'c1'
    chatStoreMock.branchGraph = null
    chatStoreMock.isSwitchingBranch = false
    chatStoreMock.switchBranchCandidate.mockClear()
    chatStoreMock.deleteBranchCandidate.mockClear()
  })

  it('左箭头：从候选 2 切到候选 1', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mountBar()

    await wrapper.findAll('.branch-switcher-btn')[0].trigger('click')

    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('a1')
    wrapper.unmount()
  })

  it('右箭头：从候选 3 循环到候选 1', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a3')
    const wrapper = mountBar('a3')

    await wrapper.findAll('.branch-switcher-btn')[1].trigger('click')

    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('a1')
    wrapper.unmount()
  })

  it('点击中间位置按钮展开候选列表，点击候选行切换', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mountBar()

    // 默认收起
    expect(wrapper.find('.branch-candidate-list').exists()).toBe(false)

    await wrapper.find('.branch-switcher-position').trigger('click')
    expect(wrapper.find('.branch-candidate-list').exists()).toBe(true)

    const rows = wrapper.findAll('.branch-candidate-row')
    expect(rows).toHaveLength(3)

    // 点击第 3 个候选（a3）
    await rows[2].find('.branch-candidate-main').trigger('click')

    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('a3')
    // 切换后列表收起
    expect(wrapper.find('.branch-candidate-list').exists()).toBe(false)
    wrapper.unmount()
  })

  it('活跃候选行标注「当前」且不显示删除按钮', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mountBar()

    await wrapper.find('.branch-switcher-position').trigger('click')

    const rows = wrapper.findAll('.branch-candidate-row')
    const activeRow = rows[1]
    expect(activeRow.classes()).toContain('active')
    expect(activeRow.find('.branch-candidate-active').exists()).toBe(true)
    expect(activeRow.find('.branch-candidate-delete').exists()).toBe(false)
    // 非活跃行有删除按钮
    expect(rows[0].find('.branch-candidate-delete').exists()).toBe(true)
    expect(rows[2].find('.branch-candidate-delete').exists()).toBe(true)
    wrapper.unmount()
  })

  it('候选列表挂载到 body，并在靠近视口右侧时向左回退', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const originalWidth = window.innerWidth
    const originalHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })

    const wrapper = mountTeleportedBar()
    const anchor = wrapper.find('.branch-switcher-center').element as HTMLElement
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      x: 350,
      y: 40,
      left: 350,
      right: 390,
      top: 40,
      bottom: 64,
      width: 40,
      height: 24,
      toJSON: () => ({})
    } as DOMRect)

    await wrapper.find('.branch-switcher-position').trigger('click')

    const list = document.body.querySelector('.branch-candidate-list') as HTMLElement | null
    expect(list).not.toBeNull()
    expect(list?.parentElement).toBe(document.body)
    expect(list?.style.width).toBe('260px')
    expect(list?.style.left).toBe('132px')
    expect(list?.style.top).toBe('68px')

    wrapper.unmount()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
  })
})

describe('BranchSwitcherBar 删除交互（两步确认）', () => {
  beforeEach(() => {
    chatStoreMock.currentConversationId = 'c1'
    chatStoreMock.branchGraph = null
    chatStoreMock.isSwitchingBranch = false
    chatStoreMock.switchBranchCandidate.mockClear()
    chatStoreMock.deleteBranchCandidate.mockClear()
  })

  it('第一次点击进入确认态（不删除），第二次点击才删除', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mountBar()

    await wrapper.find('.branch-switcher-position').trigger('click')

    const deleteButtons = wrapper.findAll('.branch-candidate-delete')
    // 非活跃候选 a3 的删除按钮（第 2 个）
    await deleteButtons[1].trigger('click')
    expect(chatStoreMock.deleteBranchCandidate).not.toHaveBeenCalled()
    expect(wrapper.findAll('.branch-candidate-delete')[1].classes()).toContain('confirming')

    await wrapper.findAll('.branch-candidate-delete')[1].trigger('click')
    expect(chatStoreMock.deleteBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.deleteBranchCandidate).toHaveBeenCalledWith('a3')
    wrapper.unmount()
  })

  it('确认态点击其他候选的删除按钮会转移确认目标（防误删）', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mountBar()

    await wrapper.find('.branch-switcher-position').trigger('click')

    let deleteButtons = wrapper.findAll('.branch-candidate-delete')
    await deleteButtons[0].trigger('click')
    deleteButtons = wrapper.findAll('.branch-candidate-delete')
    expect(deleteButtons[0].classes()).toContain('confirming')

    // 点击另一个候选的删除：确认目标转移，第一个恢复
    await deleteButtons[1].trigger('click')
    deleteButtons = wrapper.findAll('.branch-candidate-delete')
    expect(deleteButtons[1].classes()).toContain('confirming')
    expect(deleteButtons[0].classes()).not.toContain('confirming')
    expect(chatStoreMock.deleteBranchCandidate).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})


describe('BranchSwitcherBar BCP-04 工作区联动确认框', () => {
  beforeEach(() => {
    chatStoreMock.currentConversationId = 'c1'
    chatStoreMock.branchGraph = null
    chatStoreMock.isSwitchingBranch = false
    chatStoreMock.switchBranchCandidate.mockClear()
    chatStoreMock.deleteBranchCandidate.mockClear()
    // ConfirmDialog 使用 Teleport to body：清掉上次残留
    document.body.innerHTML = ''
  })

  it('目标候选写过工具（wroteToWorkspace）→ 点击先弹确认框，不直接切换', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    // a3 标记为写过写工具
    chatStoreMock.branchGraph.nodes.a3.wroteToWorkspace = true
    const wrapper = mountBar()

    await wrapper.find('.branch-switcher-position').trigger('click')
    const rows = wrapper.findAll('.branch-candidate-row')
    await rows[2].find('.branch-candidate-main').trigger('click')

    expect(chatStoreMock.switchBranchCandidate).not.toHaveBeenCalled()
    expect(wrapper.find('.dialog').exists()).toBe(true)
    wrapper.unmount()
  })

  it('确认框点「切换并恢复工作区」→ switchBranchCandidate(nodeId, { mode: chat-and-workspace })', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    chatStoreMock.branchGraph.nodes.a3.wroteToWorkspace = true
    const wrapper = mountBar()

    await wrapper.find('.branch-switcher-position').trigger('click')
    const rows = wrapper.findAll('.branch-candidate-row')
    await rows[2].find('.branch-candidate-main').trigger('click')

    const secondary = wrapper.find('.workspace-confirm-secondary')
    expect(secondary.exists()).toBe(true)
    await secondary.trigger('click')

    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('a3', { mode: 'chat-and-workspace' })
    wrapper.unmount()
  })

  it('确认框点「仅切换聊天」（confirm）→ switchBranchCandidate(nodeId, { mode: chat-only })', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    chatStoreMock.branchGraph.nodes.a3.hasWorkspaceState = true
    const wrapper = mountBar()

    await wrapper.find('.branch-switcher-position').trigger('click')
    const rows = wrapper.findAll('.branch-candidate-row')
    await rows[2].find('.branch-candidate-main').trigger('click')

    const confirmBtn = wrapper.find('.dialog-btn.confirm')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')

    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('a3', { mode: 'chat-only' })
    wrapper.unmount()
  })

  it('无写工具 / 无存档的候选不弹确认框，直接切换', async () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    const wrapper = mountBar()

    await wrapper.find('.branch-switcher-position').trigger('click')
    const rows = wrapper.findAll('.branch-candidate-row')
    await rows[2].find('.branch-candidate-main').trigger('click')

    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('a3')
    expect(wrapper.find('.dialog').exists()).toBe(false)
    wrapper.unmount()
  })
})
describe('BranchSwitcherBar 忙碌态', () => {
  beforeEach(() => {
    chatStoreMock.currentConversationId = 'c1'
    chatStoreMock.branchGraph = null
    chatStoreMock.isSwitchingBranch = false
    chatStoreMock.switchBranchCandidate.mockClear()
    chatStoreMock.deleteBranchCandidate.mockClear()
  })

  it('isSwitchingBranch 时 ‹ / › 按钮禁用并显示加载图标', () => {
    chatStoreMock.branchGraph = makeThreeCandidateGraph('a2')
    chatStoreMock.isSwitchingBranch = true
    const wrapper = mountBar()

    const buttons = wrapper.findAll('.branch-switcher-btn')
    expect(buttons[0].attributes('disabled')).toBeDefined()
    expect(buttons[1].attributes('disabled')).toBeDefined()
    expect(wrapper.find('.branch-switcher-loading').exists()).toBe(true)
    wrapper.unmount()
  })
})
