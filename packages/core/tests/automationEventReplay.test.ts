import type { AutomationEventOccurrence, AutomationRecord, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { AutomationEventSources, type EventSourceChange } from '../../../apps/server/src/automations/events';

const run = (id: string, updatedAt = 100): RunRecord => ({ id, requestKey: 'request-' + id, actorId: 'owner',
  conversationId: 'source', agentId: 'default', status: 'completed', createdAt: 1, updatedAt, iteration: 0, catalogVersion: 'fixture' });
function eventFixture() {
  const record = { id: 'event', actorId: 'owner', kind: 'event', status: 'active', createdAt: 1, eventSourceState: '100', event: {
    trigger: { type: 'run_completed', conversationId: 'source' }, busyPolicy: 'latest', restartPolicy: 'resume',
  } } as AutomationRecord;
  const values = [run('a'), run('b')];
  const storage = { getRun: jest.fn(async (id: string) => values.find(run => run.id === id) ?? null),
    getRecord: jest.fn(async () => null), listRuns: jest.fn(async (options: { completedAfter: { timestamp: number; runId: string }; limit: number }) =>
      values.filter(run => run.updatedAt > options.completedAfter.timestamp || run.updatedAt === options.completedAfter.timestamp && run.id > options.completedAfter.runId).slice(0, options.limit)) };
  const receive = jest.fn(async (_id: string, _event: AutomationEventOccurrence) => {});
  const baseline = jest.fn(async (_id: string, change: EventSourceChange & { next: string }) => { record.eventSourceState = change.next; });
  const source = new AutomationEventSources({ storage } as unknown as PlatformApplication,
    { records: () => [record], receive, baseline, fail: async () => {} });
  return { source, record, values, storage, receive, baseline };
}

test('没有运行完成监听时不读取运行及来源记录', async () => {
  const f = eventFixture(); f.record.status = 'paused';
  try {
    await f.source.completed('a');
    expect(f.storage.getRun).not.toHaveBeenCalled();
    expect(f.storage.getRecord).not.toHaveBeenCalled();
  } finally { await f.source.close(); }
});

test('补发复用列表中的运行记录，相同毫秒仍交给收据去重且不重复保存游标', async () => {
  const f = eventFixture();
  try {
    await f.source.replayCompleted();
    expect(f.receive.mock.calls.map(call => call[1].sourceRunId)).toEqual(['a', 'b']);
    expect(f.storage.getRun).not.toHaveBeenCalled();
    expect(f.baseline).not.toHaveBeenCalled();
    await f.source.replayCompleted();
    expect(f.receive).toHaveBeenCalledTimes(4);
    expect(f.baseline).not.toHaveBeenCalled();
  } finally { await f.source.close(); }
});

test('同毫秒超过一页的完成事件全部交付，后到的小编号事件不会遗漏', async () => {
  const f = eventFixture(); f.record.eventSourceState = '1';
  f.values.splice(0, f.values.length, ...Array.from({ length: 101 }, (_, index) => run('item-' + String(index).padStart(3, '0'))));
  try {
    await f.source.replayCompleted();
    expect(f.receive.mock.calls.map(call => call[1].sourceRunId)).toEqual(f.values.map(run => run.id));
    expect(f.baseline).toHaveBeenCalledTimes(1); expect(f.storage.getRun).not.toHaveBeenCalled();
    f.values.unshift(run('a-late'));
    await f.source.replayCompleted();
    expect(f.receive.mock.calls.slice(101).map(call => call[1].sourceRunId)).toContain('a-late');
    expect(f.baseline).toHaveBeenCalledTimes(1);
  } finally { await f.source.close(); }
});
