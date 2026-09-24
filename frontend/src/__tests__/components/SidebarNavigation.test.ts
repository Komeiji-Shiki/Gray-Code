import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ConversationSidebar from '../../../../apps/client/src/components/ConversationSidebar.vue';
import FileTree from '../../../../apps/client/src/components/FileTree.vue';
const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn(() => () => {}), state: {
  conversationId: 'a1', conversationViews: [] as any[], workspaceId: 'project-a', chatFocused: false, settingsOpen: false, navigationDialogOpen: false, fileDialogOpen: false,
} }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, rpc: mocks.call, subscribe: mocks.subscribe }));
vi.mock('../../../../apps/client/src/state', () => ({ state: mocks.state, guard: (action: () => unknown) => action() }));
vi.mock('../../../../apps/client/src/workspaceRoots', async () => {
  const { computed } = await import('vue'); return { useWorkspaceRoots: () => ({ roots: computed(() => [{ name: '项目 A', directory: 'C:/A' }]) }) };
});
const wrappers: ReturnType<typeof mount>[] = [];
let backend: any;
beforeEach(() => {
  document.body.innerHTML = '<div class="application"></div>';
  mocks.call.mockReset(); mocks.state.workspaceId = 'project-a';
  mocks.state.conversationViews = ['d1', 'd2'].map(id => ({ id, conversationId: null, title: id, hasDraft: true, active: false, isStreaming: false }));
  window.graycode = { kind: 'desktop', call: mocks.call, subscribe: mocks.subscribe };
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const item = (id: string, workspaceId?: string) => ({ id, title: id, createdAt: 1, updatedAt: 1, workspaceId, automaticWorkspace: !workspaceId });
  backend = { items: [item('a1', 'project-a'), item('a2', 'project-a'), item('b1', 'project-b'), item('g1'), item('g2')],
    pinned: [{ ...item('p1'), pinnedAt: 1 }, { ...item('p2'), pinnedAt: 2 }], runs: [],
    workspaces: [{ id: 'project-a', name: '项目 A', directory: 'C:/A', uri: 'file:///C:/A' }, { id: 'project-b', name: '项目 B', directory: 'C:/B', uri: 'file:///C:/B' }],
    ordering: { revision: 0, groups: [], pinnedGroups: [], conversations: [], pinned: [], drafts: [] } };
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'ui.request' && params.type === 'conversation.navigation') return structuredClone(backend);
    if (method === 'ui.request' && params.type === 'conversation.navigation.pinGroup') {
      backend.ordering.pinnedGroups = params.data.pinned
        ? [...backend.ordering.pinnedGroups, params.data.key] : backend.ordering.pinnedGroups.filter((key: string) => key !== params.data.key);
      backend.ordering.revision++;
      return structuredClone(backend.ordering);
    }
    if (method === 'ui.request' && params.type === 'ui.mode.new') return { conversationId: 'created-chat' };
    if (method === 'ui.request' && params.type === 'conversation.navigation.reorder') {
      const ids = params.data.ids as string[];
      backend.ordering = { ...backend.ordering, [params.data.kind]: [...backend.ordering[params.data.kind].filter((id: string) => !ids.includes(id)), ...ids], revision: backend.ordering.revision + 1 };
      return structuredClone(backend.ordering);
    }
    if (method === 'files.list') return [{ path: 'note.ts', name: 'note.ts', kind: 'file' }, { path: 'folder', name: 'folder', kind: 'directory' }];
    return { success: true };
  });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
async function openSidebar() {
  const wrapper = mount(ConversationSidebar, { props: { collapsed: false }, attachTo: '.application', global: { stubs: { Teleport: true } } });
  wrappers.push(wrapper); await flushPromises(); return wrapper;
}

test('正文命中结果显示消息摘要与搜索提示', async () => {
  backend.items[0].searchHit = { messageIndex: 42, messageId: 'message-42', excerpt: '找到这条消息的正文' };
  const wrapper = await openSidebar();
  expect(wrapper.get('.navigation-search input').attributes('placeholder')).toBe('搜索对话标题和内容');
  expect(wrapper.get('[data-conversation-id="a1"] .navigation-excerpt').text()).toBe('找到这条消息的正文');
  await wrapper.get('[data-conversation-id="a1"] .navigation-select').trigger('click');
  await flushPromises();
  expect(wrapper.emitted('jumpToMessage')).toEqual([[{ conversationId: 'a1', messageIndex: 42, messageId: 'message-42' }]]);
});
async function dragBefore(source: Element, target: Element) {
  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  for (const [element, type] of [[source, 'dragstart'], [target, 'dragover'], [target, 'drop'], [source, 'dragend']] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: -1 } });
    element.dispatchEvent(event); await flushPromises();
  }
}
const row = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.get(`[data-conversation-id="${id}"]`).element;

test('普通分组、项目、各类对话与草稿都能拖动排序，重新挂载后保留顺序', async () => {
  let wrapper = await openSidebar();
  await dragBefore(wrapper.get('[data-navigation-group="general"] .navigation-group-heading').element, wrapper.get('[data-navigation-group="project-a"] .navigation-group-heading').element);
  expect(backend.ordering.groups).toEqual(['general', 'project-a', 'project-b']);
  await dragBefore(row(wrapper, 'g2'), row(wrapper, 'g1')); expect(backend.ordering.conversations).toEqual(['g2', 'g1']);
  await dragBefore(row(wrapper, 'a2'), row(wrapper, 'a1')); expect(backend.ordering.conversations).toEqual(['g2', 'g1', 'a2', 'a1']);
  await dragBefore(row(wrapper, 'p2'), row(wrapper, 'p1')); expect(backend.ordering.pinned).toEqual(['p2', 'p1']);
  const drafts = wrapper.findAll('.navigation-draft'); await dragBefore(drafts[1].element, drafts[0].element);
  expect(backend.ordering.drafts).toEqual(['d2', 'd1']);
  const calls = mocks.call.mock.calls.filter(([method, params]) => method === 'ui.request' && params.type === 'conversation.navigation.reorder').length;
  await dragBefore(row(wrapper, 'a1'), row(wrapper, 'b1'));
  expect(mocks.call.mock.calls.filter(([method, params]) => method === 'ui.request' && params.type === 'conversation.navigation.reorder')).toHaveLength(calls);
  wrappers.splice(wrappers.indexOf(wrapper), 1); wrapper.unmount(); wrapper = await openSidebar();
  expect(wrapper.findAll('[data-navigation-group]').map(group => group.attributes('data-navigation-group'))).toEqual(['general', 'project-a', 'project-b']);
  expect(wrapper.get('[data-navigation-group="project-a"]').findAll('[data-conversation-id]').map(item => item.attributes('data-conversation-id'))).toEqual(['a2', 'a1']);
});

test('工作区和普通对话分类置顶后靠前，取消置顶还原原有顺序', async () => {
  backend.ordering.groups = ['project-a', 'general', 'project-b'];
  const wrapper = await openSidebar();
  await wrapper.get('[data-navigation-group="general"] .navigation-project-more').trigger('click');
  await wrapper.findAll('[role="menuitem"]').find(button => button.text() === '置顶分组')!.trigger('click');
  await flushPromises();
  expect(wrapper.findAll('[data-navigation-group]').map(group => group.attributes('data-navigation-group'))).toEqual(['general', 'project-a', 'project-b']);
  await wrapper.get('[data-navigation-group="general"] .navigation-project-more').trigger('click');
  await wrapper.findAll('[role="menuitem"]').find(button => button.text() === '取消置顶分组')!.trigger('click');
  await flushPromises();
  expect(wrapper.findAll('[data-navigation-group]').map(group => group.attributes('data-navigation-group'))).toEqual(['project-a', 'general', 'project-b']);
  expect(backend.ordering.groups).toEqual(['project-a', 'general', 'project-b']);
});

test('普通对话加号明确选择自动工作区或不绑定工作区并立即打开', async () => {
  const wrapper = await openSidebar();
  await wrapper.get('[data-navigation-group="general"] .navigation-project-add').trigger('click');
  expect(wrapper.findAll('[aria-label="新建普通对话"] [role="menuitem"]')).toHaveLength(2);
  await wrapper.findAll('[aria-label="新建普通对话"] [role="menuitem"]')[0].trigger('click');
  await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('ui.request', { type: 'ui.mode.new', data: { mode: 'chat', automaticWorkspace: true } });
  expect(mocks.call).toHaveBeenCalledWith('ui.command', { command: 'platform.openModeConversation', data: { conversationId: 'created-chat' } });
  await wrapper.get('[data-navigation-group="general"] .navigation-project-add').trigger('click');
  await wrapper.findAll('[aria-label="新建普通对话"] [role="menuitem"]')[1].trigger('click');
  await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('ui.request', { type: 'ui.mode.new', data: { mode: 'chat', automaticWorkspace: false } });
});

test('文件树和侧边栏菜单提供资源管理器入口并传递实际目标', async () => {
  const sidebar = await openSidebar();
  await sidebar.get('[data-navigation-group="project-a"] .navigation-project-more').trigger('click');
  await sidebar.findAll('[role="menuitem"]').find(button => button.text().includes('资源管理器'))!.trigger('click');
  expect(mocks.call).toHaveBeenCalledWith('workspace.openInExplorer', { workspaceId: 'project-a', workspaceUri: 'file:///C:/A' });
  const tree = mount(FileTree, { attachTo: '.application', global: { stubs: { Teleport: true } } }); wrappers.push(tree); await flushPromises();
  await tree.get('[aria-label="在资源管理器中打开工作区"]').trigger('click');
  expect(mocks.call).toHaveBeenCalledWith('workspace.openInExplorer', { workspaceId: 'project-a' });
  await tree.get('[data-path="note.ts"]').trigger('contextmenu', { clientX: 30, clientY: 50 });
  await tree.findAll('[role="menuitem"]').find(button => button.text() === '在资源管理器中显示')!.trigger('click');
  expect(mocks.call).toHaveBeenCalledWith('files.reveal', { workspaceId: 'project-a', path: 'note.ts' });
});
