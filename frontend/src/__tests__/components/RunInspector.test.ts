import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import RunInspector from '../../../../apps/client/src/components/RunInspector.vue';
import JsonDetails from '../../../../apps/client/src/components/JsonDetails.vue';
import { state } from '../../../../apps/client/src/state';
import { mergeRunEvents, runActivity } from '../../../../apps/client/src/runInspector';
import type { RunEvent, RunRecord } from '@graycode/contracts';
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
test('默认预览最近请求事件的轮次，手动选择后不被后续请求覆盖', async () => {
  const history: RunEvent[] = [
    { runId: 'run', sequence: 1, type: 'model.request', timestamp: 1, payload: { iteration: 1 } },
    { runId: 'run', sequence: 2, type: 'model.request', timestamp: 2, payload: { iteration: 2 } },
    { runId: 'run', sequence: 3, type: 'model.preparing', timestamp: 3, payload: { iteration: 8 } },
  ];
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'runs.list') return [{ id: 'run', status: 'running', createdAt: 1, iteration: 8 }];
    if (method === 'runs.events') return history;
    if (method === 'runs.request') return {
      runId: 'run', iteration: params.iteration, capturedAt: 1, protocol: 'openai', model: `模型-${params.iteration}`, body: {},
    };
    return null;
  });
  const wrapper = open(); await flushPromises();
  await wrapper.get('.run-status-strip button').trigger('click'); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'runs.request')).toEqual([
    ['runs.request', { id: 'run', iteration: 2 }],
  ]);
  expect(wrapper.get('.request-preview').text()).toContain('模型-2');

  await wrapper.findAll('.timeline-event > button')[0].trigger('click'); await flushPromises();
  mocks.notify?.({ type: 'event', event: {
    runId: 'run', sequence: 4, type: 'model.request', timestamp: 4, payload: { iteration: 3 },
  } });
  await flushPromises();
  expect(wrapper.get('.request-preview').text()).toContain('模型-1');
  expect(mocks.call.mock.calls.filter(([method]) => method === 'runs.request').map(([, params]) => params.iteration)).toEqual([2, 1]);
});

test('没有请求事件时不猜测轮次，记录正文缺失时也不回退重试', async () => {
  mocks.call.mockImplementation(async method => {
    if (method === 'runs.list') return [{ id: 'run', status: 'running', createdAt: 1, iteration: 8 }];
    if (method === 'runs.events') return [];
    return null;
  });
  const wrapper = open(); await flushPromises();
  await wrapper.get('.run-status-strip button').trigger('click'); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'runs.request')).toHaveLength(0);

  mocks.notify?.({ type: 'event', event: {
    runId: 'run', sequence: 1, type: 'model.request', timestamp: 1, payload: { iteration: 3 },
  } });
  await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'runs.request')).toEqual([
    ['runs.request', { id: 'run', iteration: 3 }],
  ]);
  expect(wrapper.get('.request-preview').text()).toContain('这次任务尚无请求记录');
});

test('实时追加只访问历史末尾，补读与重复事件仍按序合并', () => {
  const record = (sequence: number, type = 'tool.completed') => ({ runId: 'run', sequence, type, timestamp: sequence, payload: {} }) as RunEvent;
  const history = Array.from({ length: 5000 }, (_, index) => record(index));
  let sequenceReads = 0;
  for (const event of history) { const sequence = event.sequence; Object.defineProperty(event, 'sequence', { get: () => { sequenceReads++; return sequence; } }); }
  expect(mergeRunEvents(history, [record(5000)])).toBe(history);
  expect(sequenceReads).toBeLessThan(5);
  expect(history).toHaveLength(5001);
  const merged = mergeRunEvents([record(3), record(5)], [record(1), record(3, 'model.started'), record(4)]);
  expect(merged.map(event => event.sequence)).toEqual([1, 3, 4, 5]);
  expect(merged[1].type).toBe('model.started');
  expect(runActivity({ status: 'running' } as RunRecord, [record(1, 'model.streaming'), record(2, 'model.request')])).toBe('正在生成回复');
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
