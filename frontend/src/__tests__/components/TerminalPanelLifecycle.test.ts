import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import TerminalPanel from '../../../../apps/client/src/components/TerminalPanel.vue';

const mocks = vi.hoisted(() => ({
  call: vi.fn(), errors: vi.fn(), data: undefined as ((data: string) => void) | undefined,
  event: undefined as ((event: any) => void) | undefined, writes: [] as string[],
}));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options = {}; cols = 80; rows = 24;
  loadAddon() {} open() {} reset() { mocks.writes.push('[reset]'); } dispose() {} focus() {}
  onData(listener: typeof mocks.data) { mocks.data = listener; }
  write(text: string, done?: () => void) { mocks.writes.push(text); done?.(); }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, subscribe: (listener: typeof mocks.event) => { mocks.event = listener; return () => { mocks.event = undefined; }; } }));
vi.mock('../../../../apps/client/src/state', () => ({ appearance: ref(undefined), state: { workspaceId: 'workspace' }, guard: (action: () => Promise<unknown>) => action().catch(mocks.errors) }));
vi.mock('../../../../apps/client/src/appearance', () => ({ appearancePalette: ref({}), resolvedTheme: ref('dark') }));
vi.mock('../../../../apps/client/src/workspaceRoots', () => ({ useWorkspaceRoots: () => ({ roots: ref([]), directory: ref('') }) }));
const sessions = ['a', 'b'].map(id => ({ id, title: id, workspaceId: 'workspace', status: 'running', pid: 1 }));
let wrapper: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  mocks.call.mockReset(); mocks.errors.mockReset(); mocks.writes.length = 0; sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.call.mockImplementation(async (method, params) => method === 'terminal.list' ? sessions
    : method === 'terminal.snapshot' ? { ...sessions.find(item => item.id === params.id), output: params.id, offset: 1 } : {});
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); });

test('快照失败后不会把旧终端画面的输入发送到新终端，重试后恢复输入', async () => {
  wrapper = mount(TerminalPanel, { props: { compact: true } }); await flushPromises();
  mocks.data?.('first'); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('terminal.input', { id: 'a', data: 'first' });
  mocks.call.mockImplementation(async method => {
    if (method === 'terminal.snapshot') throw new Error('connection lost');
    if (method === 'terminal.list') return sessions;
    return {};
  });
  await wrapper.get('select[aria-label="当前终端"]').setValue('b'); await flushPromises();
  mocks.data?.('unsafe'); mocks.event?.({ type: 'terminal.data', id: 'b', data: 'late', offset: 5 }); await flushPromises();
  expect(mocks.call).not.toHaveBeenCalledWith('terminal.input', expect.objectContaining({ data: 'unsafe' }));
  expect(mocks.writes).not.toContain('late');
  expect(wrapper.get('input[aria-label="终端命令"]').attributes('disabled')).toBeDefined();
  mocks.call.mockImplementation(async method => method === 'terminal.list' ? sessions : { ...sessions[1], output: 'b', offset: 1 });
  mocks.event?.({ type: 'transport.connected' }); await flushPromises();
  mocks.data?.('safe'); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('terminal.input', { id: 'b', data: 'safe' });
});

test('创建终端过程中卸载，不再发送补读或访问已释放的终端', async () => {
  let resolve!: (value: unknown) => void;
  wrapper = mount(TerminalPanel); await flushPromises();
  mocks.call.mockImplementation(method => method === 'terminal.create' ? new Promise(done => { resolve = done; }) : Promise.resolve(sessions));
  await wrapper.findAll('button').find(button => button.text() === '新建终端')!.trigger('click');
  const count = mocks.call.mock.calls.length;
  wrapper.unmount(); wrapper = undefined; resolve({ id: 'created' }); await flushPromises();
  expect(mocks.call).toHaveBeenCalledTimes(count);
  expect(mocks.errors).not.toHaveBeenCalled();
});

test('切换期间旧会话快照失败不会覆盖当前会话或通知过期错误', async () => {
  wrapper = mount(TerminalPanel); await flushPromises();
  let fail!: (error: Error) => void;
  mocks.call.mockImplementation((method, params) => method === 'terminal.snapshot' && params.id === 'b'
    ? new Promise((_resolve, reject) => { fail = reject; }) : Promise.resolve({ ...sessions[0], output: 'a', offset: 1 }));
  mocks.event?.({ type: 'workspace.terminal.open', id: 'b' });
  mocks.event?.({ type: 'workspace.terminal.open', id: 'a' }); await flushPromises();
  fail(new Error('stale')); await flushPromises();
  mocks.data?.('a-only'); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('terminal.input', { id: 'a', data: 'a-only' });
  expect(mocks.errors).not.toHaveBeenCalled();
});


test('重连可以替换同一会话中仍未返回的旧快照，父组件同步目标不重复读取', async () => {
  wrapper = mount(TerminalPanel, { props: { sessionId: 'a' } }); await flushPromises();
  let finish!: (value: unknown) => void;
  mocks.call.mockImplementation(async method => method === 'terminal.list' ? sessions : new Promise(resolve => { finish = resolve; }));
  mocks.event?.({ type: 'workspace.terminal.open', id: 'b' });
  await wrapper.setProps({ sessionId: 'b' }); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method, params]) => method === 'terminal.snapshot' && params.id === 'b')).toHaveLength(1);
  mocks.call.mockImplementation(async method => method === 'terminal.list' ? sessions : { ...sessions[1], output: 'fresh', offset: 5 });
  mocks.event?.({ type: 'transport.connected' }); await flushPromises();
  finish({ ...sessions[1], output: 'outdated', offset: 8 }); await flushPromises();
  mocks.data?.('reconnected'); await flushPromises();
  expect(mocks.writes).toContain('fresh'); expect(mocks.writes).not.toContain('outdated');
  expect(mocks.call).toHaveBeenCalledWith('terminal.input', { id: 'b', data: 'reconnected' });
});
