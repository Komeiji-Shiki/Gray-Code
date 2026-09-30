import { shallowMount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Workbench from '../../../../apps/client/src/components/Workbench.vue';
import FileTree from '../../../../apps/client/src/components/FileTree.vue';
import WorkbenchTabs from '../../../../apps/client/src/components/WorkbenchTabs.vue';
import MobileCodeEditor from '../../../../apps/client/src/components/MobileCodeEditor.vue';
import { state } from '../../../../apps/client/src/state';
import { effectScope } from 'vue';
import { useNavigationIntent } from '../../../../apps/client/src/navigationIntent';

const mocks = vi.hoisted(() => ({ call: vi.fn(), report: vi.fn(), listeners: new Set<(event: any) => void>() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, rpc: mocks.call,
  subscribe: (listener: (event: any) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); } }));
vi.mock('../../../../apps/client/src/state', async () => {
  const { reactive } = await import('vue');
  return { state: reactive({ workspaceId: 'project', snapshot: { settings: { workspaces: [] } }, chatFocused: false, sideExpanded: true }),
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

test('侧栏产生新意图后，同工作区中迟到的文件打开也不能抢回焦点', async () => {
  const slow = deferred<ReturnType<typeof document>>();
  mocks.call.mockImplementation(async method => method === 'documents.open' ? slow.promise : undefined);
  const view = workbench(); view.open('slow.ts');
  const scope = effectScope(); scope.run(() => useNavigationIntent()({ workspaceId: 'project', tabId: 'conversation' }));
  slow.resolve(document('slow.ts')); await flushPromises();
  expect(view.tabs().props('active')).not.toBe('file:project:slow.ts'); scope.stop();
});

test('退出保存收集文件失败并保留草稿，仍尝试保存其他文件并回报错误', async () => {
  const view = workbench(true); view.open('conflict.ts'); view.open('other.ts'); await flushPromises();
  for (const editor of view.wrapper.findAllComponents(MobileCodeEditor)) editor.vm.$emit('change', 'new draft');
  await flushPromises();
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'documents.save') {
      if (params.path === 'conflict.ts') throw new Error('DOCUMENT_CONFLICT');
      return { ...document(params.path), text: 'new draft', dirty: false };
    }
  });
  for (const listener of mocks.listeners) listener({ type: 'desktop.saveAll', requestId: 'quit-fixture' });
  await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.save')).toHaveLength(2);
  expect(mocks.call).toHaveBeenCalledWith('desktop.saveResult', expect.objectContaining({ requestId: 'quit-fixture', participant: 'documents', error: expect.stringContaining('conflict.ts') }));
  expect(view.tabs().props('active')).toBe('file:project:conflict.ts');
  expect(view.tabs().props('tabs')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'file:project:conflict.ts', dirty: true })]));
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

test('外部文件刷新与后续输入共用文档队列，新文本使用刷新后的版本且不覆盖', async () => {
  const view = workbench(true); view.open('refresh.ts'); await flushPromises();
  const slow = deferred<ReturnType<typeof document>>();
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'documents.open' && params.reload) return slow.promise;
    if (method === 'documents.update') return { ...document(params.path), text: params.text, version: params.version + 1, dirty: true };
  });
  for (const listener of mocks.listeners) listener({ type: 'file.changed', workspaceId: 'project', path: 'refresh.ts' });
  await flushPromises();
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'new local draft'); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.update')).toHaveLength(0);
  slow.resolve({ ...document('refresh.ts'), text: 'external text', version: 4, baseHash: 'external-hash' }); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('documents.update', expect.objectContaining({ text: 'new local draft', version: 4 }));
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('new local draft');
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.close')).toHaveLength(0);
  expect(mocks.report).not.toHaveBeenCalled();
});

test('重建快照刷新打开的干净文档并恢复焦点，完整补发的重连不额外读取', async () => {
  const view = workbench(true); view.open('resumed.ts'); await flushPromises();
  mocks.call.mockClear();
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: false });
  await flushPromises(); expect(mocks.call).not.toHaveBeenCalled();
  mocks.call.mockImplementation(async (method, params) => method === 'documents.open' ? { ...document(params.path), text: 'latest disk text', version: 4, baseHash: 'latest-hash' } : undefined);
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: true });
  await flushPromises();
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('latest disk text');
  expect(mocks.call).toHaveBeenCalledWith('documents.focus', { workspaceId: 'project', path: 'resumed.ts' });
  expect(mocks.report).not.toHaveBeenCalled();
});

test('离线输入等核对原基线后再同步，重连不会丢文本或重复更新', async () => {
  const view = workbench(true); view.open('offline.ts'); await flushPromises(); mocks.call.mockClear();
  for (const listener of mocks.listeners) listener({ type: 'transport.disconnected' });
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'offline input'); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.update')).toHaveLength(0);
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: false });
  await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('documents.open', { workspaceId: 'project', path: 'offline.ts', reload: true });
  expect(mocks.call).toHaveBeenCalledWith('documents.update', expect.objectContaining({ text: 'offline input', version: 1 }));
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.update')).toHaveLength(1);
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('offline input');
});

test.each([1, 4])('重连时服务器版本为 %s 但磁盘基线已变化，保留离线正文且阻止自动覆盖与保存', async version => {
  const view = workbench(true); view.open('conflict.ts'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'transport.disconnected' });
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'retained local text'); await flushPromises();
  mocks.call.mockClear().mockImplementation(async (method, params) => method === 'documents.open' ? { ...document(params.path), version, text: 'new server text', baseHash: 'new-hash' } : undefined);
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: true });
  await flushPromises();
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('retained local text');
  expect(view.tabs().props('tabs')).toEqual(expect.arrayContaining([expect.objectContaining({ dirty: true })]));
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('save'); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.update' || method === 'documents.save')).toHaveLength(0);
  expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('conflict.ts') }));
});

test('更新回执丢失后服务器正文已等于离线输入，恢复版本而不重复发送', async () => {
  const view = workbench(true); view.open('ack.ts'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'transport.disconnected' });
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'already accepted'); await flushPromises();
  mocks.call.mockClear().mockImplementation(async (method, params) => method === 'documents.open' ? { ...document(params.path), version: 2, text: 'already accepted', dirty: true } : undefined);
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: true });
  await flushPromises();
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('already accepted');
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.update')).toHaveLength(0);
  expect(mocks.report).not.toHaveBeenCalled();
});

test.each([1, 2])('已同步但未保存的草稿遇到重启版本 %s，磁盘未变时恢复正文并使用新版本保存', async version => {
  const view = workbench(true); view.open('accepted.ts'); await flushPromises();
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'accepted unsaved text'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'transport.disconnected' });
  mocks.call.mockClear().mockImplementation(async (method, params) => {
    if (method === 'documents.open') return { ...document(params.path), version };
    if (method === 'documents.update') return { ...document(params.path), text: params.text, version: params.version + 1, dirty: true };
    if (method === 'documents.save') return { ...document(params.path), text: 'accepted unsaved text', version: params.version, dirty: false };
  });
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: true });
  await flushPromises();
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('accepted unsaved text');
  expect(mocks.call).toHaveBeenCalledWith('documents.update', expect.objectContaining({ text: 'accepted unsaved text', version }));
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('save'); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('documents.save', expect.objectContaining({ version: version + 1 }));
  expect(mocks.report).not.toHaveBeenCalled();
});

test.each([1, 2])('已同步但未保存的草稿遇到重启版本 %s，磁盘变化时保留正文并阻止覆盖', async version => {
  const view = workbench(true); view.open('accepted.ts'); await flushPromises();
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'accepted unsaved text'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'transport.disconnected' });
  mocks.call.mockClear().mockImplementation(async (method, params) => method === 'documents.open'
    ? { ...document(params.path), text: 'changed disk text', baseHash: 'changed-disk-hash', version } : undefined);
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: true });
  await flushPromises();
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('accepted unsaved text');
  expect(view.tabs().props('tabs')).toEqual(expect.arrayContaining([expect.objectContaining({ dirty: true })]));
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('save'); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.update' || method === 'documents.save')).toHaveLength(0);
  expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('accepted.ts') }));
});

test('已同步草稿遇到同磁盘基线的较新远端脏版本，保留本地正文并要求处理冲突', async () => {
  const view = workbench(true); view.open('accepted.ts'); await flushPromises();
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'accepted unsaved text'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'transport.disconnected' });
  mocks.call.mockClear().mockImplementation(async (method, params) => method === 'documents.open'
    ? { ...document(params.path), text: 'newer remote draft', version: 3, dirty: true } : undefined);
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: true });
  await flushPromises();
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('accepted unsaved text');
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.update')).toHaveLength(0);
  expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('accepted.ts') }));
});

test('重连读取失败保持输入暂停，用户重试保存先恢复版本后才写入', async () => {
  const view = workbench(true); view.open('retry.ts'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'transport.disconnected' });
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'retry input'); await flushPromises();
  let reads = 0;
  mocks.call.mockClear().mockImplementation(async (method, params) => {
    if (method === 'documents.open') { if (!reads++) throw new Error('network unavailable'); return document(params.path); }
    if (method === 'documents.update') return { ...document(params.path), text: params.text, version: params.version + 1, dirty: true };
    if (method === 'documents.save') return { ...document(params.path), text: 'retry input', dirty: false };
  });
  for (const listener of mocks.listeners) listener({ type: 'transport.resumed', snapshotRequired: true });
  await flushPromises();
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('change', 'retry input'); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'documents.update')).toHaveLength(0);
  view.wrapper.findComponent(MobileCodeEditor).vm.$emit('save'); await flushPromises();
  expect(reads).toBe(2);
  expect(mocks.call).toHaveBeenCalledWith('documents.update', expect.objectContaining({ text: 'retry input', version: 1 }));
  expect(mocks.call).toHaveBeenCalledWith('documents.save', expect.objectContaining({ version: 2 }));
  expect(view.wrapper.findComponent(MobileCodeEditor).props('value')).toBe('retry input');
});
