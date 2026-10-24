import type { RunRecord } from '@graycode/contracts';
import { readRepairedHistory } from '../../../apps/server/src/conversations/historyView';
import { fixture, metadata } from './fixtures';

describe('SQLite 历史读取修复与运行器写入的事务边界', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
    await f.store.createConversation(metadata('repair'));
    await f.store.appendHistory('repair', [{ id: 'old-call', role: 'model', parts: [
      { functionCall: { id: 'old', name: 'read_file', args: {} } },
    ] }]);
  });
  afterEach(async () => { await f.cleanup(); });

  test('扫描后开始的新任务不会被补写拒绝；结束后只补齐真正遗留的调用', async () => {
    const run: RunRecord = { id: 'new-run', conversationId: 'repair', requestKey: 'new-run', actorId: 'owner', agentId: 'default',
      status: 'queued', createdAt: 1, updatedAt: 1, iteration: 0, catalogVersion: 'fixture' };
    const read = f.store.readFullHistory.bind(f.store);
    // 扫描判定需要修复之后、读取完整历史之前开始新任务。
    jest.spyOn(f.store, 'readFullHistory').mockImplementationOnce(async (id, ...rest) => {
      await f.store.createRun(run, { id: 'new-user', role: 'user', parts: [{ text: '开始新回合' }] });
      await f.store.appendHistory('repair', [{ id: 'new-call', role: 'model', runId: run.id, parts: [
        { functionCall: { id: 'live', name: 'read_file', args: {} } },
      ] }]);
      return read(id, ...rest);
    });
    const live = (await readRepairedHistory(f.store, 'repair'))!;
    expect(live.map(message => message.id)).toEqual(['old-call', 'new-user', 'new-call']);
    expect(live.flatMap(message => message.parts).filter(part => part.functionResponse)).toHaveLength(0);
    expect(live.at(-1)!.parts[0].functionCall?.rejected).toBeUndefined();
    await f.store.appendHistory('repair', [{ id: 'real-result', role: 'user', runId: run.id, isFunctionResponse: true, parts: [
      { functionResponse: { id: 'live', name: 'read_file', response: { success: true, data: '真实结果' } } },
    ] }]);
    await f.store.appendRunEvent({ runId: run.id, type: 'run.started', payload: {}, update: { status: 'running' } });
    await f.store.appendRunEvent({ runId: run.id, type: 'run.completed', payload: {}, update: { status: 'completed' } });
    const settled = (await readRepairedHistory(f.store, 'repair'))!;
    const responses = settled.flatMap(message => message.parts).flatMap(part => part.functionResponse ? [part.functionResponse] : []);
    expect(responses).toEqual([
      expect.objectContaining({ id: 'old', response: expect.objectContaining({ rejected: true }) }),
      expect.objectContaining({ id: 'live', response: { success: true, data: '真实结果' } }),
    ]);
    expect((await f.store.readFullHistory('repair')).messages.map(message => message.id)).toEqual(settled.map(message => message.id));
  });

  test('修复快照读取后追加的真实结果不会被覆盖，版本冲突返回最新历史', async () => {
    const commit = f.store.commitConversation.bind(f.store);
    jest.spyOn(f.store, 'commitConversation').mockImplementationOnce(async value => {
      await f.store.appendHistory('repair', [{ id: 'late-result', role: 'user', isFunctionResponse: true, parts: [
        { functionResponse: { id: 'old', name: 'read_file', response: { success: true, data: '稍后完成' } } },
      ] }]);
      return commit(value);
    });
    const messages = (await readRepairedHistory(f.store, 'repair'))!;
    expect(messages.map(message => message.id)).toEqual(['old-call', 'late-result']);
    expect(messages[0].parts[0].functionCall?.rejected).toBeUndefined();
    expect(messages[1].parts[0].functionResponse?.response).toEqual({ success: true, data: '稍后完成' });
    expect((await f.store.readFullHistory('repair')).messages.map(message => message.id)).toEqual(['old-call', 'late-result']);
  });

  test('真实结果取代占位拒绝时删除占位响应并清除调用上的拒绝标记', async () => {
    await f.store.replaceHistory('repair', [
      { id: 'call', role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read_file', args: {}, rejected: true } }] },
      { id: 'placeholder', role: 'user', isFunctionResponse: true, parts: [
        { functionResponse: { id: 'c1', name: 'read_file', response: { success: false, rejected: true } } },
      ] },
      { id: 'real', role: 'user', isFunctionResponse: true, parts: [
        { functionResponse: { id: 'c1', name: 'read_file', response: { success: true, data: '真实结果' } } },
      ] },
    ]);
    const messages = (await readRepairedHistory(f.store, 'repair'))!;
    expect(messages.map(message => message.id)).toEqual(['call', 'real']);
    expect(messages[0].parts[0].functionCall?.rejected).toBe(false);
    expect((await f.store.readFullHistory('repair')).messages.map(message => message.id)).toEqual(['call', 'real']);
    expect(await readRepairedHistory(f.store, 'missing')).toBeNull();
  });
});
