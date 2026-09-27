import { shallowMount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Workbench from '../../../../apps/client/src/components/Workbench.vue';
import FileTree from '../../../../apps/client/src/components/FileTree.vue';
import WorkbenchTabs from '../../../../apps/client/src/components/WorkbenchTabs.vue';
import MobileCodeEditor from '../../../../apps/client/src/components/MobileCodeEditor.vue';
import { state } from '../../../../apps/client/src/state';

const mocks = vi.hoisted(() => ({ call: vi.fn(), report: vi.fn(), listeners: new Set<(event: any) => void>() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, rpc: mocks.call,
  subscribe: (listener: (event: any) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); } }));
vi.mock('../../../../apps/client/src/state', async () => {
  const { reactive } = await import('vue');
  return { state: reactive({ workspaceId: 'project', snapshot: { settings: { workspaces: [] } }, chatFocused: false }),
    report: mocks.report, guard: async (operation: () => Promise<unknown>) => { try { return await operation(); } catch (error) { mocks.report(error); } } };
});
vi.mock('../../../../apps/client/src/computer', () => ({ computerState: { openRequest: 0 } }));
vi.mock('../../../../apps/client/src/debugging', () => ({ connectDebugging() {}, debugControl: vi.fn(), toggleBreakpoint: vi.fn(),
  debugState: { activeId: undefined, sessions: [] } }));
// 子面板的渲染和宿主连接各有回归；这里保留工作台本身的 Vue 状态、事件与文档队列。
vi.mock('../../../../apps/client/src/components/CodeEditor.vue', () => ({ default: { name: 'CodeEditor', props: ['path', 'workspaceId', 'value', 'version'], emits: ['change'], template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/TerminalPanel.vue', () => ({ default: { name: 'TerminalPanel', template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/ComputerPane.vue', () => ({ default: { name: 'ComputerPane', template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/NodePane.vue', () => ({ default: { name: 'NodePane', template: '<div />' } }));
const wrappers: ReturnType<typeof shallowMount>[] = [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const document = (file: string) => ({ workspaceId: 'project', path: file, text: 'content:' + file, version: 1, baseHash: 'hash:' + file, dirty: false, clientId: 'fixture' });
beforeEach(() => {
  mocks.call.mockReset().mockImplementation(async (method, params) => {
    if (method === 'documents.open') return document(params.path);
    if (method === 'documents.update') return { ...document(params.path), text: params.text, version: params.version + 1, dirty: true };
  });
  mocks.report.mockReset(); mocks.listeners.clear();
  Object.assign(state, { workspaceId: 'project', snapshot: { settings: { workspaces: [] } }, chatFocused: false });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); mocks.listeners.clear(); });
function workbench(compact = false) {
  const wrapper = shallowMount(Workbench, { props: { compact } }); wrappers.push(wrapper);
  const tabs = () => wrapper.findComponent(WorkbenchTabs);
  tabs().vm.$emit('add', 'editor');
  const open = (file: string) => wrapper.findComponent(FileTree).vm.$emit('open', file, 'project');
  return { wrapper, tabs, open };
}

test('迟到的打开响应可以保留标签，但不能抢回较新文件的焦点', async () => {
  const slow = deferred<ReturnType<typeof document>>();
  mocks.call.mockImplementation(async (method, params) => method === 'documents.open' ? params.path === 'slow.ts' ? slow.promise : document(params.path) : undefined);
  const view = workbench();
  view.open('slow.ts'); view.open('latest.ts'); await flushPromises();
  expect(view.tabs().props('active')).toBe('file:project:latest.ts');
  slow.resolve(document('slow.ts')); await flushPromises();
  expect(view.tabs().props('active')).toBe('file:project:latest.ts');
  expect(view.tabs().props('tabs')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'file:project:slow.ts' })]));
});

test('用户选择其他面板后，旧打开失败不覆盖当前界面错误', async () => {
  const slow = deferred<ReturnType<typeof document>>();
  mocks.call.mockImplementation(async method => method === 'documents.open' ? slow.promise : undefined);
  const view = workbench(); view.open('slow.ts');
  view.tabs().vm.$emit('add', 'terminal'); await flushPromises();
  slow.reject(new Error('旧文件读取失败')); await flushPromises();
  expect(view.tabs().props('active')).toBe('panel:terminal');
  expect(mocks.report).not.toHaveBeenCalled();
});

test('切换项目会使原项目的待打开请求失去焦点优先权', async () => {
  const slow = deferred<ReturnType<typeof document>>();
  mocks.call.mockImplementation(async method => method === 'documents.open' ? slow.promise : undefined);
  const view = workbench(); view.open('slow.ts');
  state.workspaceId = 'second'; await flushPromises();
  slow.resolve(document('slow.ts')); await flushPromises();
  expect(view.tabs().props('active')).not.toBe('file:project:slow.ts');
});

test('关闭回执返回前文档已被移除，不会误删最后一个未保存标签', async () => {
  const view = workbench(true); view.open('closing.ts'); await flushPromises(); view.open('draft.ts'); await flushPromises();
  const editor = view.wrapper.findAllComponents(MobileCodeEditor).find(component => component.props('path') === 'draft.ts')!;
  editor.vm.$emit('change', '用户未保存的内容'); await flushPromises();
  const closing = deferred<void>();
  mocks.call.mockImplementation(async method => method === 'documents.close' ? closing.promise : undefined);
  view.tabs().vm.$emit('close', 'file:project:closing.ts'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'document.reset', workspaceId: 'project', path: 'closing.ts',
    previousText: 'content:closing.ts', previousVersion: 1, removed: true });
  closing.resolve(); await flushPromises();
  expect(view.tabs().props('tabs')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'file:project:draft.ts', dirty: true })]));
  expect(view.tabs().props('active')).toBe('file:project:draft.ts');
});

test('同一路径重新打开后，旧关闭回执不删除新标签或抑制新焦点', async () => {
  const view = workbench(true); view.open('same.ts'); await flushPromises();
  const closing = deferred<void>();
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'documents.close') return closing.promise;
    if (method === 'documents.open') return document(params.path);
    if (method === 'documents.update') return { ...document(params.path), text: params.text, version: params.version + 1, dirty: true };
  });
  view.tabs().vm.$emit('close', 'file:project:same.ts'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'document.reset', workspaceId: 'project', path: 'same.ts',
    previousText: 'content:same.ts', previousVersion: 1, removed: true });
  view.open('same.ts'); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method, params]) => method === 'documents.focus' && params.path === 'same.ts')).toHaveLength(2);
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', '重新打开后的新草稿'); await flushPromises();
  closing.resolve(); await flushPromises();
  expect(view.tabs().props('tabs')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'file:project:same.ts', dirty: true })]));
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('重新打开后的新草稿');
});
