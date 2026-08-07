/**
 * WorkspaceSelector 组件测试（1.7.3「对话绑定工作区锁定 + 下拉切换」）
 *
 * 覆盖：
 * - 触发按钮文案：打开的工作区名 / 绑定但未打开的工作区名（含 URI 兜底解析）/ auto / 无工作区
 * - 下拉菜单：打开列表、绑定未打开锁定条目（.ws-locked-item）、收藏列表
 * - 交互：点击打开的工作区 → setActiveWorkspace(uri)；点击 auto → setActiveWorkspace(null)；
 *   点击已打开（大小写漂移）的收藏 → setActiveWorkspace；点击未打开的收藏 → openSavedWorkspace
 * - 大小写不敏感：同目录大小写漂移 URI 仍正确命中选中态
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import WorkspaceSelector from '../WorkspaceSelector.vue'
import type { WorkspaceFolderInfo } from '../../../stores/chat/types'

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

const chatStoreMock = {
  workspaceList: [] as WorkspaceFolderInfo[],
  currentWorkspaceUri: null as string | null,
  savedWorkspaces: [] as WorkspaceFolderInfo[],
  setActiveWorkspace: vi.fn().mockResolvedValue(undefined),
  removeSavedWorkspace: vi.fn().mockResolvedValue(undefined),
  openSavedWorkspace: vi.fn().mockResolvedValue(undefined),
  openWorkspaceFolder: vi.fn().mockResolvedValue(undefined),
  saveCurrentWorkspace: vi.fn().mockResolvedValue(undefined)
}

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => chatStoreMock
}))

const URI_A = 'file:///c%3A/Users/foo/ProjectA'
const URI_A_DRIFT = 'file:///C%3A/Users/FOO/ProjectA'
const URI_B = 'file:///c%3A/Users/foo/ProjectB'

function makeWs(uri: string, name: string, fsPath: string): WorkspaceFolderInfo {
  return { uri, name, fsPath, index: 0 }
}

function mountSelector() {
  return mount(WorkspaceSelector, {
    global: { stubs: { teleport: true } }
  })
}

async function openMenu(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.find('.ws-selector').trigger('click')
  // Transition 进入动画会把菜单 DOM 插入推迟一个 tick
  await nextTick()
}

beforeEach(() => {
  chatStoreMock.workspaceList = []
  chatStoreMock.currentWorkspaceUri = null
  chatStoreMock.savedWorkspaces = []
  chatStoreMock.setActiveWorkspace.mockClear()
  chatStoreMock.removeSavedWorkspace.mockClear()
  chatStoreMock.openSavedWorkspace.mockClear()
  chatStoreMock.openWorkspaceFolder.mockClear()
  chatStoreMock.saveCurrentWorkspace.mockClear()
})

describe('触发按钮文案', () => {
  it('打开的工作区 → 显示工作区名', () => {
    chatStoreMock.workspaceList = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    expect(wrapper.find('.ws-label').text()).toBe('ProjectA')
    wrapper.unmount()
  })

  it('绑定但未打开（收藏里能找到）→ 显示收藏名', () => {
    chatStoreMock.workspaceList = [makeWs(URI_B, 'ProjectB', 'c:\\Users\\foo\\ProjectB')]
    chatStoreMock.savedWorkspaces = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    expect(wrapper.find('.ws-label').text()).toBe('ProjectA')
    wrapper.unmount()
  })

  it('绑定但未打开（收藏也没有）→ 按 URI 兜底解析目录名', () => {
    chatStoreMock.workspaceList = [makeWs(URI_B, 'ProjectB', 'c:\\Users\\foo\\ProjectB')]
    chatStoreMock.currentWorkspaceUri = 'file:///c%3A/Users/foo/ClosedProj'
    const wrapper = mountSelector()
    expect(wrapper.find('.ws-label').text()).toBe('ClosedProj')
    wrapper.unmount()
  })

  it('无当前工作区 → auto 文案', () => {
    chatStoreMock.workspaceList = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    const wrapper = mountSelector()
    expect(wrapper.find('.ws-label').text()).toBe('components.tabs.workspaceSelector.auto')
    wrapper.unmount()
  })

  it('无任何工作区打开 → noWorkspace 文案', () => {
    const wrapper = mountSelector()
    expect(wrapper.find('.ws-label').text()).toBe('components.tabs.workspaceSelector.noWorkspace')
    wrapper.unmount()
  })
})

describe('下拉菜单内容', () => {
  it('绑定但未打开时显示锁定条目（未打开标签）', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_B, 'ProjectB', 'c:\\Users\\foo\\ProjectB')]
    chatStoreMock.savedWorkspaces = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    await openMenu(wrapper)
    const locked = wrapper.find('.ws-locked-item')
    expect(locked.exists()).toBe(true)
    expect(locked.text()).toContain('ProjectA')
    expect(locked.text()).toContain('components.tabs.workspaceSelector.notOpen')
    wrapper.unmount()
  })

  it('打开的工作区条目带选中标记', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    await openMenu(wrapper)
    const items = wrapper.findAll('.ws-menu-item')
    const checked = items.filter(i => i.find('.codicon-check').exists())
    expect(checked.length).toBe(1)
    expect(checked[0].text()).toContain('ProjectA')
    wrapper.unmount()
  })

  it('大小写漂移 URI 仍命中选中标记', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_A_DRIFT, 'ProjectA', 'C:\\Users\\FOO\\ProjectA')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    await openMenu(wrapper)
    const items = wrapper.findAll('.ws-menu-item')
    const checked = items.filter(i => i.find('.codicon-check').exists())
    expect(checked.length).toBe(1)
    expect(checked[0].text()).toContain('ProjectA')
    wrapper.unmount()
  })

  it('绑定未打开时不显示「保存当前工作区」入口', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_B, 'ProjectB', 'c:\\Users\\foo\\ProjectB')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    await openMenu(wrapper)
    expect(wrapper.text()).not.toContain('components.tabs.workspaceSelector.saveWorkspace')
    wrapper.unmount()
  })
})

describe('交互：切换工作区', () => {
  it('点击打开的工作区 → setActiveWorkspace(uri) 且菜单关闭', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    await openMenu(wrapper)
    await wrapper.findAll('.ws-menu-item').find(i => i.text().includes('ProjectA'))!.trigger('click')
    expect(chatStoreMock.setActiveWorkspace).toHaveBeenCalledWith(URI_A)
    expect(wrapper.find('.ws-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击 auto → setActiveWorkspace(null)', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    await openMenu(wrapper)
    await wrapper.findAll('.ws-menu-item').find(i => i.text().includes('components.tabs.workspaceSelector.auto'))!.trigger('click')
    expect(chatStoreMock.setActiveWorkspace).toHaveBeenCalledWith(null)
    wrapper.unmount()
  })

  it('点击已打开的收藏（大小写漂移）→ setActiveWorkspace(收藏 uri)', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_A_DRIFT, 'ProjectA', 'C:\\Users\\FOO\\ProjectA')]
    chatStoreMock.savedWorkspaces = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.currentWorkspaceUri = URI_A_DRIFT
    const wrapper = mountSelector()
    await openMenu(wrapper)
    const savedItem = wrapper.findAll('.ws-menu-item').find(i => i.text().includes('ProjectA') && i.find('.ws-item-remove').exists())!
    await savedItem.trigger('click')
    expect(chatStoreMock.setActiveWorkspace).toHaveBeenCalledWith(URI_A)
    expect(chatStoreMock.openSavedWorkspace).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('点击未打开的收藏 → openSavedWorkspace(entry)', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.savedWorkspaces = [makeWs(URI_B, 'ProjectB', 'c:\\Users\\foo\\ProjectB')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    await openMenu(wrapper)
    const savedItem = wrapper.findAll('.ws-menu-item').find(i => i.text().includes('ProjectB'))!
    await savedItem.trigger('click')
    expect(chatStoreMock.openSavedWorkspace).toHaveBeenCalledTimes(1)
    const entry = chatStoreMock.openSavedWorkspace.mock.calls[0][0] as WorkspaceFolderInfo
    expect(entry.uri).toBe(URI_B)
    wrapper.unmount()
  })

  it('点击收藏条目的 × 只移除收藏，不触发切换', async () => {
    chatStoreMock.workspaceList = [makeWs(URI_A, 'ProjectA', 'c:\\Users\\foo\\ProjectA')]
    chatStoreMock.savedWorkspaces = [makeWs(URI_B, 'ProjectB', 'c:\\Users\\foo\\ProjectB')]
    chatStoreMock.currentWorkspaceUri = URI_A
    const wrapper = mountSelector()
    await openMenu(wrapper)
    await wrapper.find('.ws-item-remove').trigger('click')
    expect(chatStoreMock.removeSavedWorkspace.mock.calls[0][0]).toBe('c:\\Users\\foo\\ProjectB')
    expect(chatStoreMock.openSavedWorkspace).not.toHaveBeenCalled()
    expect(chatStoreMock.setActiveWorkspace).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
