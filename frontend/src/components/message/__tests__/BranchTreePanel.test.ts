/**
 * BranchTreePanel 组件测试（TREE-11 完整分支树查看面板）
 *
 * 覆盖：
 * - 入口显隐：无分支图 / 无当前对话 → 隐藏；有分支图 → 显示
 * - 树形渲染：DFS 展平顺序 + 深度缩进
 * - 活跃路径高亮「当前」、软删节点灰显「已删除」
 * - 切换交互：点击非活跃非软删行切换；活跃行不响应
 * - 删除交互：两步确认（第一次进入确认态，第二次才调用 deleteBranchCandidate）
 * - 恢复交互：软删节点恢复按钮调用 restoreBranchCandidate
 * - 重命名交互：行内输入，Enter 提交 renameBranchCandidate
 * - 忙碌态：isSwitchingBranch 时操作按钮禁用
 * - 背板点击关闭面板
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import BranchTreePanel from '../BranchTreePanel.vue'
import type { BranchGraphData, BranchNodeData } from '../../../stores/chat/types'

// 假 chatStore：组件仅使用 branchGraph / currentConversationId / isSwitchingBranch 与四个动作
const chatStoreMock = {
  currentConversationId: 'c1' as string | null,
  branchGraph: null as BranchGraphData | null,
  isSwitchingBranch: false,
  switchBranchCandidate: vi.fn().mockResolvedValue(true),
  deleteBranchCandidate: vi.fn().mockResolvedValue(true),
  restoreBranchCandidate: vi.fn().mockResolvedValue(true),
  renameBranchCandidate: vi.fn().mockResolvedValue(true)
}

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => chatStoreMock
}))

function makeNode(id: string, parentId: string | null, overrides: Partial<BranchNodeData> = {}): BranchNodeData {
  return { id, parentId, role: 'model', createdAt: 0, ...overrides }
}

/**
 * 分支图夹具：
 *   u1 (root, user) ── a1 (active, createdAt 100) ── a1c (active tail, createdAt 10)
 *                    ├─ a2 (候选, createdAt 200)
 *                    └─ aDel (软删, createdAt 300)
 * 活跃路径：u1 → a1 → a1c
 */
function makeFixtureGraph(): BranchGraphData {
  return {
    version: 1,
    rootNodeId: 'u1',
    activeTailNodeId: 'a1c',
    nodes: {
      u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1' }),
      a1: makeNode('a1', 'u1', { createdAt: 100, activeChildId: 'a1c', parts: [{ text: '回答一' }] }),
      a1c: makeNode('a1c', 'a1', { createdAt: 10, parts: [{ text: '继续分支' }] }),
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

/** 挂载并打开面板，返回 wrapper */
async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(BranchTreePanel)
  await wrapper.find('.branch-tree-trigger').trigger('click')
  return wrapper
}

describe('BranchTreePanel 入口显隐', () => {
  beforeEach(resetMock)

  it('无分支图 → 入口隐藏', () => {
    const wrapper = mount(BranchTreePanel)
    expect(wrapper.find('.branch-tree-trigger').exists()).toBe(false)
    wrapper.unmount()
  })

  it('无当前对话 → 入口隐藏', () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    chatStoreMock.currentConversationId = null
    const wrapper = mount(BranchTreePanel)
    expect(wrapper.find('.branch-tree-trigger').exists()).toBe(false)
    wrapper.unmount()
  })

  it('有分支图 → 入口显示；点击打开面板，背板点击关闭', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = mount(BranchTreePanel)

    expect(wrapper.find('.branch-tree-trigger').exists()).toBe(true)
    expect(wrapper.find('.branch-tree-panel-box').exists()).toBe(false)

    await wrapper.find('.branch-tree-trigger').trigger('click')
    expect(wrapper.find('.branch-tree-panel-box').exists()).toBe(true)
    // 标题
    expect(wrapper.find('.branch-tree-title').text()).toContain('分支树')

    await wrapper.find('.branch-tree-backdrop').trigger('click')
    expect(wrapper.find('.branch-tree-panel-box').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('BranchTreePanel 树形渲染', () => {
  beforeEach(resetMock)

  it('DFS 展平行顺序 + 深度缩进（paddingLeft）', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    expect(rows).toHaveLength(5)
    // 顺序：u1 → a1 → a1c → a2 → aDel
    const previews = rows.map(r => r.find('.branch-tree-preview').text())
    expect(previews[0]).toBe('（无预览）') // u1 无 parts / label
    expect(previews[1]).toBe('回答一')
    expect(previews[2]).toBe('继续分支')
    expect(previews[3]).toBe('回答二')
    expect(previews[4]).toBe('已删分支')
    // 深度缩进：u1=8px, a1/a2/aDel=24px, a1c=40px
    expect(rows[0].attributes('style')).toContain('padding-left: 8px')
    expect(rows[1].attributes('style')).toContain('padding-left: 24px')
    expect(rows[2].attributes('style')).toContain('padding-left: 40px')
    expect(rows[3].attributes('style')).toContain('padding-left: 24px')
    expect(rows[4].attributes('style')).toContain('padding-left: 24px')
    wrapper.unmount()
  })

  it('活跃路径高亮 + 软删节点灰显', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    // 活跃：u1 / a1 / a1c
    expect(rows[0].classes()).toContain('active')
    expect(rows[1].classes()).toContain('active')
    expect(rows[2].classes()).toContain('active')
    expect(rows[0].find('.branch-tree-badge-active').text()).toBe('当前')
    // 非活跃：a2
    expect(rows[3].classes()).not.toContain('active')
    // 软删：aDel
    expect(rows[4].classes()).toContain('deleted')
    expect(rows[4].find('.branch-tree-badge-deleted').text()).toBe('已删除')
    wrapper.unmount()
  })
})

describe('BranchTreePanel 切换 / 删除 / 恢复 / 重命名', () => {
  beforeEach(resetMock)

  it('点击非活跃非软删行 → switchBranchCandidate；活跃行不响应', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    // 点击候选 a2
    await rows[3].find('.branch-tree-row-main').trigger('click')
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('a2')

    // 点击活跃行 a1（a1c 活跃尾）不触发
    await rows[1].find('.branch-tree-row-main').trigger('click')
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)

    // 点击软删行不触发
    await rows[4].find('.branch-tree-row-main').trigger('click')
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('删除两步确认：第一次进入确认态，第二次才调用 deleteBranchCandidate', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    // a2 行有删除按钮（非活跃非软删；第二个 action，第一个是重命名）
    const deleteBtn = rows[3].findAll('.branch-tree-action')[1]
    expect(deleteBtn.exists()).toBe(true)

    await deleteBtn.trigger('click')
    expect(chatStoreMock.deleteBranchCandidate).not.toHaveBeenCalled()
    expect(deleteBtn.classes()).toContain('confirming')

    await deleteBtn.trigger('click')
    expect(chatStoreMock.deleteBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.deleteBranchCandidate).toHaveBeenCalledWith('a2')
    wrapper.unmount()
  })

  it('活跃行 / 软删行不显示删除按钮', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    // 活跃行（u1 / a1 / a1c）只有重命名按钮，无删除
    for (const idx of [0, 1, 2]) {
      const actions = rows[idx].findAll('.branch-tree-action')
      expect(actions).toHaveLength(1) // 仅重命名
    }
    // 软删行只有恢复按钮
    const deletedActions = rows[4].findAll('.branch-tree-action')
    expect(deletedActions).toHaveLength(1)
    wrapper.unmount()
  })

  it('软删节点恢复按钮 → restoreBranchCandidate', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    await rows[4].find('.branch-tree-action').trigger('click')
    expect(chatStoreMock.restoreBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.restoreBranchCandidate).toHaveBeenCalledWith('aDel')
    wrapper.unmount()
  })

  it('重命名：行内输入，Enter 提交 renameBranchCandidate', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    // a2 行的重命名按钮（第一个 action 是删除？—— 顺序：重命名在前、删除在后）
    const renameBtn = rows[3].findAll('.branch-tree-action')[0]
    expect(renameBtn.exists()).toBe(true)
    await renameBtn.trigger('click')

    const input = wrapper.find('.branch-tree-rename-input')
    expect(input.exists()).toBe(true)
    await input.setValue('我的候选')
    await input.trigger('keydown', { key: 'Enter' })

    expect(chatStoreMock.renameBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.renameBranchCandidate).toHaveBeenCalledWith('a2', '我的候选')
    // 提交后退出编辑态
    expect(wrapper.find('.branch-tree-rename-input').exists()).toBe(false)
    wrapper.unmount()
  })

  it('重命名：Esc 取消不提交', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    await rows[3].findAll('.branch-tree-action')[0].trigger('click')
    const input = wrapper.find('.branch-tree-rename-input')
    await input.setValue('不应保存')
    await input.trigger('keydown', { key: 'Escape' })

    expect(chatStoreMock.renameBranchCandidate).not.toHaveBeenCalled()
    expect(wrapper.find('.branch-tree-rename-input').exists()).toBe(false)
    wrapper.unmount()
  })

  it('忙碌态：isSwitchingBranch 时操作按钮禁用', async () => {
    chatStoreMock.branchGraph = makeFixtureGraph()
    chatStoreMock.isSwitchingBranch = true
    const wrapper = await mountOpen()

    const rows = wrapper.findAll('.branch-tree-row')
    // 软删行恢复按钮禁用
    expect(rows[4].find('.branch-tree-action').attributes('disabled')).toBeDefined()
    // a2 行重命名按钮禁用
    expect(rows[3].findAll('.branch-tree-action')[0].attributes('disabled')).toBeDefined()
    // 面板头显示忙碌图标
    expect(wrapper.find('.branch-tree-busy').exists()).toBe(true)
    wrapper.unmount()
  })
})
