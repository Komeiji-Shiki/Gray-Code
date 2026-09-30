import { flushPromises, mount, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import DiffPanel from '../../../../apps/client/src/components/DiffPanel.vue';
import Workbench from '../../../../apps/client/src/components/Workbench.vue';
import { state } from '../../../../apps/client/src/state';
import { setShellLanguage } from '../../../../apps/client/src/i18n';

const mocks = vi.hoisted(() => ({ call: vi.fn(), report: vi.fn(), createModel: vi.fn(),
  listeners: new Set<(event: any) => void>(), editors: [] as { setModel: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[],
  observers: [] as { resize(width: number): void; disconnect: ReturnType<typeof vi.fn> }[] }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, rpc: mocks.call,
  subscribe: (listener: (event: any) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); } }));
vi.mock('../../../../apps/client/src/state', async () => {
  const { reactive, ref } = await import('vue');
  return { state: reactive({ workspaceId: 'first', snapshot: { settings: { workspaces: [] } }, chatFocused: false, workbenchExpanded: false }),
    appearance: ref({}), report: mocks.report,
    guard: async (operation: () => Promise<unknown>) => { try { return await operation(); } catch (cause) { mocks.report(cause); } } };
});
vi.mock('../../../../apps/client/src/monaco', () => ({ Uri: { from: (value: unknown) => value }, editor: {
  createModel: mocks.createModel, setTheme: vi.fn(), createDiffEditor: () => {
    const editor = { setModel: vi.fn(), dispose: vi.fn() }; mocks.editors.push(editor); return editor;
  },
} }));
vi.mock('../../../../apps/client/src/editorAppearance', () => ({ installWorkbenchTheme() {}, workbenchEditorTheme: () => 'test' }));
vi.mock('../../../../apps/client/src/editorWorkspaceEdits', () => ({ workspaceEditorServices: {} }));
vi.mock('../../../../apps/client/src/editorLanguages', () => ({ ensureEditorLanguage: async () => {} }));
vi.mock('../../../../apps/client/src/computer', () => ({ computerState: { openRequest: 0 } }));
vi.mock('../../../../apps/client/src/debugging', () => ({ connectDebugging() {}, debugControl: vi.fn(), toggleBreakpoint: vi.fn(),
  debugState: { activeId: undefined, sessions: [] } }));
vi.mock('../../../../apps/client/src/components/CodeEditor.vue', () => ({ default: { name: 'CodeEditor', template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/TerminalPanel.vue', () => ({ default: { name: 'TerminalPanel', template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/ComputerPane.vue', () => ({ default: { name: 'ComputerPane', template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/NodePane.vue', () => ({ default: { name: 'NodePane', template: '<div />' } }));

type Diff = { id: string; workspaceId: string; conversationId: string; path: string; toolCallId: string;
  originalText: string; proposedText: string; status: 'pending' | 'accepted' | 'rejected' | 'cancelled' };
const diff = (id: string, workspaceId = 'first', status: Diff['status'] = 'pending', path = id + '.ts'): Diff => ({
  id, workspaceId, conversationId: 'conversation-' + workspaceId, path, toolCallId: 'tool-' + id,
  originalText: 'before:' + id, proposedText: 'after:' + id, status,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const wrappers: { unmount(): void }[] = [];
function panel(target?: { workspaceId: string; id?: string; path?: string; toolCallId?: string }) {
  const wrapper = mount(DiffPanel, { props: { workspaceId: 'first', target } }); wrappers.push(wrapper); return wrapper;
}
function publish(event: Record<string, unknown>) { for (const listener of mocks.listeners) listener(event); }
function actions() { return mocks.call.mock.calls.filter(([method]) => method === 'workspace.diffs.resolve'); }

beforeEach(() => {
  mocks.call.mockReset().mockImplementation(async (method, params) => method === 'workspace.diffs.list' ? [diff(params.workspaceId, params.workspaceId)] : undefined);
  mocks.report.mockReset(); mocks.listeners.clear(); mocks.editors.length = 0; mocks.observers.length = 0;
  mocks.createModel.mockReset().mockImplementation((text: string) => ({ text, dispose: vi.fn() }));
  Object.assign(state, { workspaceId: 'first', snapshot: { settings: { workspaces: [] } }, chatFocused: false });
  setShellLanguage('zh-CN');
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn();
    constructor(callback: ResizeObserverCallback) {
      mocks.observers.push({ resize: width => callback([{ contentRect: { width } }] as ResizeObserverEntry[], this as unknown as ResizeObserver), disconnect: this.disconnect });
    }
    observe() {}
  });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); mocks.listeners.clear(); vi.unstubAllGlobals(); });

test('切换工作区后，迟到列表不会回填原工作区记录，也不会接受混入的新工作区列表记录', async () => {
  const old = deferred<Diff[]>();
  mocks.call.mockImplementation(async (method, params) => method === 'workspace.diffs.list'
    ? params.workspaceId === 'first' ? old.promise : [diff('second', 'second'), diff('foreign', 'first')] : undefined);
  const wrapper = panel(); await wrapper.setProps({ workspaceId: 'second' }); await flushPromises();
  old.resolve([diff('late')]); await flushPromises();
  expect(wrapper.get('.review-breadcrumb').text()).toContain('second.ts');
  expect(wrapper.text()).not.toContain('foreign.ts'); expect(wrapper.text()).not.toContain('late.ts');
  await wrapper.get('.accept-change').trigger('click'); await flushPromises();
  expect(actions()).toEqual([['workspace.diffs.resolve', { id: 'second', accepted: true }]]);
});

test('同工作区并发刷新按最新请求提交，旧响应不能恢复过期的待处理内容', async () => {
  const wrapper = panel(); await flushPromises();
  const old = deferred<Diff[]>(), latest = deferred<Diff[]>(); let count = 0;
  mocks.call.mockImplementation(async method => method === 'workspace.diffs.list' ? ++count === 1 ? old.promise : latest.promise : undefined);
  await wrapper.get('.review-refresh').trigger('click'); await wrapper.get('.review-refresh').trigger('click');
  latest.resolve([diff('latest')]); await flushPromises(); old.resolve([diff('old')]); await flushPromises();
  expect(wrapper.get('.review-breadcrumb').text()).toContain('latest.ts');
  expect(mocks.editors[0].setModel.mock.calls.at(-1)?.[0]?.modified.text).toBe('after:latest');
});

test('离开后又回到同一工作区，旧请求仍不能覆盖新代次', async () => {
  const old = deferred<Diff[]>(); let count = 0;
  mocks.call.mockImplementation(async (method, params) => method === 'workspace.diffs.list'
    ? params.workspaceId === 'first' && ++count === 1 ? old.promise : [diff('new', params.workspaceId)] : undefined);
  const wrapper = panel(); await wrapper.setProps({ workspaceId: 'second' }); await flushPromises();
  await wrapper.setProps({ workspaceId: 'first' }); await flushPromises(); old.resolve([diff('old')]); await flushPromises();
  expect(wrapper.get('.review-breadcrumb').text()).toContain('new.ts');
});

test('旧工作区读取失败不会污染新工作区错误或提前结束新列表的加载状态', async () => {
  const old = deferred<Diff[]>(), next = deferred<Diff[]>();
  mocks.call.mockImplementation(async (method, params) => method === 'workspace.diffs.list' ? params.workspaceId === 'first' ? old.promise : next.promise : undefined);
  const wrapper = panel(); await wrapper.setProps({ workspaceId: 'second' }); old.reject(new Error('旧工作区失败')); await flushPromises();
  expect(wrapper.text()).toContain('正在加载修改'); expect(wrapper.text()).not.toContain('旧工作区失败');
  next.resolve([]); await flushPromises(); expect(wrapper.find('.review-empty').exists()).toBe(true);
  expect(wrapper.find('.accept-change').exists()).toBe(false);
});

test('面板已打开时按记录、工具调用与路径定位新预览，目标缺失不会留下旧接受按钮', async () => {
  mocks.call.mockImplementation(async method => method === 'workspace.diffs.list' ? [diff('one'), diff('two')] : undefined);
  const wrapper = panel(); await flushPromises();
  await wrapper.setProps({ target: { workspaceId: 'first', id: 'two', toolCallId: 'tool-two', path: 'two.ts' } }); await flushPromises();
  expect(wrapper.get('.review-breadcrumb').text()).toContain('two.ts');
  expect(mocks.editors[0].setModel.mock.calls.at(-1)?.[0]?.modified.text).toBe('after:two');
  await wrapper.setProps({ target: { workspaceId: 'first', id: 'one', toolCallId: 'tool-two', path: 'one.ts' } }); await flushPromises();
  expect(wrapper.text()).toContain('目标修改未出现在当前列表中');
  expect(wrapper.find('.review-footer').exists()).toBe(false); expect(actions()).toHaveLength(0);
  await wrapper.get('.diff-row[title="one.ts"]').trigger('click');
  expect(wrapper.get('.review-breadcrumb').text()).toContain('one.ts');
});

test('历史预览携带includeId，目标后来不在响应中也不会自动接受其他记录', async () => {
  const history = diff('history'), recent = diff('recent');
  mocks.call.mockImplementation(async (method, params) => method === 'workspace.diffs.list'
    ? params.includeId === history.id ? [recent, history] : [recent] : undefined);
  const wrapper = panel(); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('workspace.diffs.list', { workspaceId: 'first' });
  await wrapper.setProps({ target: { workspaceId: 'first', id: history.id, toolCallId: history.toolCallId, path: history.path } }); await flushPromises();
  expect(mocks.call).toHaveBeenLastCalledWith('workspace.diffs.list', { workspaceId: 'first', includeId: history.id });
  expect(wrapper.get('.review-breadcrumb').text()).toContain('history.ts');
  await wrapper.get('.accept-change').trigger('click'); await flushPromises();
  expect(actions()).toEqual([['workspace.diffs.resolve', { id: history.id, accepted: true }]]);
  mocks.call.mockImplementation(async method => method === 'workspace.diffs.list' ? [recent] : undefined);
  await wrapper.get('.review-refresh').trigger('click'); await flushPromises();
  expect(wrapper.find('.review-footer').exists()).toBe(false); expect(wrapper.text()).toContain('目标修改未出现在当前列表中');
});

test('重复点击只提交一次，切换工作区后的旧操作回执不清除新操作锁或回填错误', async () => {
  const old = deferred<void>(), next = deferred<void>();
  mocks.call.mockImplementation(async (method, params) => method === 'workspace.diffs.list' ? [diff(params.workspaceId, params.workspaceId)]
    : method === 'workspace.diffs.resolve' ? params.id === 'first' ? old.promise : next.promise : undefined);
  const wrapper = panel(); await flushPromises();
  const button = wrapper.get('.accept-change').element as HTMLButtonElement; button.click(); button.click();
  expect(actions()).toHaveLength(1);
  await wrapper.setProps({ workspaceId: 'second' }); await flushPromises();
  await wrapper.get('.accept-change').trigger('click'); old.reject(new Error('旧接受失败')); await flushPromises();
  expect(wrapper.text()).not.toContain('旧接受失败'); expect(wrapper.get('.accept-change').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.accept-change').text()).toBe('正在处理…');
  expect(actions()).toEqual([['workspace.diffs.resolve', { id: 'first', accepted: true }], ['workspace.diffs.resolve', { id: 'second', accepted: true }]]);
  next.resolve(); await flushPromises(); expect(wrapper.get('.accept-change').attributes('disabled')).toBeUndefined();
});

test('同路径多次修改计为记录，待处理分组与默认选择优先于已处理记录', async () => {
  mocks.call.mockImplementation(async method => method === 'workspace.diffs.list' ? [diff('done', 'first', 'accepted', 'same.ts'), diff('pending', 'first', 'pending', 'same.ts')] : undefined);
  const wrapper = panel(); await flushPromises();
  expect(wrapper.get('.panel-heading').text()).toContain('2 条修改记录'); expect(wrapper.text()).not.toContain('个文件');
  expect(wrapper.findAll('.review-group-heading').map(heading => heading.text())).toEqual(['待处理1', '已处理1']);
  expect(mocks.editors[0].setModel.mock.calls.at(-1)?.[0]?.modified.text).toBe('after:pending');
});

test('重连要求快照时刷新处理状态，丢失期间已接受的记录不再显示写入操作', async () => {
  const wrapper = panel(); await flushPromises(); expect(wrapper.find('.accept-change').exists()).toBe(true);
  mocks.call.mockImplementation(async method => method === 'workspace.diffs.list' ? [diff('first', 'first', 'accepted')] : undefined);
  publish({ type: 'transport.resumed', snapshotRequired: true }); await flushPromises();
  expect(wrapper.get('.review-footer').text()).toContain('已接受'); expect(wrapper.find('.accept-change').exists()).toBe(false);
  expect(actions()).toHaveLength(0);
});

test('按面板自身203px宽度收起列表，打开和选择列表后操作区保持独立', async () => {
  mocks.call.mockImplementation(async method => method === 'workspace.diffs.list' ? [diff('one'), diff('two')] : undefined);
  const wrapper = panel(); await flushPromises(); mocks.observers[0].resize(203); await flushPromises();
  expect(wrapper.classes()).toContain('narrow-review'); expect(wrapper.classes()).toContain('very-narrow-review');
  expect(wrapper.find('.diff-list').exists()).toBe(false);
  expect(wrapper.get('.review-footer').findAll('button')).toHaveLength(2);
  await wrapper.get('.review-list-toggle').trigger('click'); expect(wrapper.find('.review-list-backdrop').exists()).toBe(true);
  await wrapper.get('.diff-row[title="two.ts"]').trigger('click');
  expect(wrapper.find('.diff-list').exists()).toBe(false); expect(wrapper.get('.review-breadcrumb').text()).toContain('two.ts');
  mocks.observers[0].resize(800); await flushPromises(); expect(wrapper.classes()).not.toContain('narrow-review');
  expect(wrapper.find('.diff-list').exists()).toBe(true);
});

test('卸载后不再创建迟到列表的编辑模型并断开尺寸监听', async () => {
  const old = deferred<Diff[]>(); mocks.call.mockReturnValue(old.promise);
  const wrapper = panel(); wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
  old.resolve([diff('late')]); await flushPromises();
  expect(mocks.createModel).not.toHaveBeenCalled(); expect(mocks.observers[0].disconnect).toHaveBeenCalledOnce();
  expect(mocks.editors[0].dispose).toHaveBeenCalledOnce(); expect(mocks.listeners.size).toBe(0);
});

test('Workbench传递明确的预览工作区与目标，项目切换清除旧目标，重复预览可重新定位', async () => {
  const wrapper = shallowMount(Workbench, { global: { stubs: {
    DiffPanel: { name: 'DiffPanel', props: ['workspaceId', 'target'], template: '<div />' },
  } } }); wrappers.push(wrapper);
  const event = { type: 'workspace.diff.open', workspaceId: 'second', id: 'review-two', path: 'two.ts', toolCallId: 'tool-two' };
  publish(event); await flushPromises();
  const view = () => wrapper.findComponent({ name: 'DiffPanel' });
  expect(state.workspaceId).toBe('second'); expect(view().props('workspaceId')).toBe('second');
  expect(view().props('target')).toEqual({ workspaceId: 'second', id: 'review-two', path: 'two.ts', toolCallId: 'tool-two' });
  state.workspaceId = 'third'; await flushPromises(); expect(view().props('target')).toBeUndefined();
  publish({ type: 'workspace.diff.open', toolCallId: 'current-tool' }); await flushPromises();
  expect(view().props('target')).toEqual({ workspaceId: 'third', toolCallId: 'current-tool', id: undefined, path: undefined });
  const target = view().props('target'); publish({ type: 'workspace.diff.open', toolCallId: 'current-tool' }); await flushPromises();
  expect(view().props('target')).not.toBe(target);
});
