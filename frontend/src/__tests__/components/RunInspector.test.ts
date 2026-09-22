import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import RunInspector from '../../../../apps/client/src/components/RunInspector.vue';
import JsonDetails from '../../../../apps/client/src/components/JsonDetails.vue';
import { state } from '../../../../apps/client/src/state';
const mocks = vi.hoisted(() => ({ call: vi.fn(), notify: undefined as ((event: Record<string, unknown>) => void) | undefined }));
vi.mock('../../../../apps/client/src/api', () => ({ rpc: mocks.call, subscribe: (listener: typeof mocks.notify) => { mocks.notify = listener; return () => { mocks.notify = undefined; }; } }));
vi.mock('../../../../apps/client/src/state', async () => {
  const { reactive } = await import('vue');
  return { state: reactive({ conversationId: 'chat', snapshot: { settings: { providers: [] } }, inspectorOpen: false }) };
});
vi.mock('../../../../apps/client/src/webBridge', () => ({ webUi: { connection: 'connected' } }));
const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] }); mocks.call.mockReset(); state.conversationId = 'chat';
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers(); });
function open() { const wrapper = mount(RunInspector); wrappers.push(wrapper); return wrapper; }
function event(sequence: number) { mocks.notify?.({ type: 'event', event: { runId: 'run', type: 'run.created', sequence, timestamp: Date.now(), payload: {} } }); }

test('密集刷新在慢请求期间合并，完成后补读最新任务列表', async () => {
  const pending: ((runs: object[]) => void)[] = [];
  mocks.call.mockImplementation(async method => method === 'runs.list' ? new Promise(resolve => pending.push(resolve)) : method === 'runs.events' ? [] : null);
  const wrapper = open(); await flushPromises();
  for (let i = 0; i < 3; i++) { event(i + 1); await vi.advanceTimersByTimeAsync(120); }
  expect(pending).toHaveLength(1);
  const previous = { id: 'old', status: 'running', createdAt: 1 };
  pending[0]([previous]); await flushPromises(); expect(pending).toHaveLength(2);
  pending[1]([{ id: 'new', status: 'running', createdAt: 2 }, previous]); await flushPromises();
  await wrapper.get('button').trigger('click'); await flushPromises();
  expect((wrapper.get('select[aria-label="选择运行任务"]').element as HTMLSelectElement).value).toBe('new');
  expect(mocks.call.mock.calls.filter(([method]) => method === 'runs.list')).toHaveLength(2);
});
test('卸载后不会继续已经合并的补读', async () => {
  let finish!: (runs: object[]) => void;
  mocks.call.mockImplementation(async method => method === 'runs.list' ? new Promise(resolve => { finish = resolve; }) : []);
  const wrapper = open(); await flushPromises(); event(1); await vi.advanceTimersByTimeAsync(120);
  wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1); finish([]); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'runs.list')).toHaveLength(1);
});
test('收起详情不序列化大正文，展开后显示完整内容并随值更新', async () => {
  const serialize = vi.fn(() => ({ text: '完整正文'.repeat(10000) }));
  const wrapper = mount(JsonDetails, { props: { label: '详情', value: { toJSON: serialize } } }); wrappers.push(wrapper);
  expect(serialize).not.toHaveBeenCalled(); expect(wrapper.find('pre').exists()).toBe(false);
  const details = wrapper.get('details'); details.element.open = true; await details.trigger('toggle');
  expect(serialize).toHaveBeenCalledOnce(); expect(wrapper.get('pre').text()).toContain('完整正文'.repeat(10000));
  details.element.open = false; await details.trigger('toggle');
  await wrapper.setProps({ value: { updated: '新的记录' } }); expect(wrapper.find('pre').exists()).toBe(false);
  details.element.open = true; await details.trigger('toggle'); expect(wrapper.get('pre').text()).toContain('新的记录');
});
