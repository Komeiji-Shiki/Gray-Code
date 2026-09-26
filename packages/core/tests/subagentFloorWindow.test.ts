import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PlatformStorage } from '@graycode/core';
import type { PlatformMessage } from '@graycode/contracts';
import { SubagentExecutionService } from '../../../apps/server/src/subagents/service';
import type { PlatformSubagent } from '../../../apps/server/src/subagents/types';
import type { SubAgentRunContentWindowOptions } from '../../../backend/tools/subagents/eventBus/types';
import { fixture, metadata } from './fixtures';

const messages = (): PlatformMessage[] => [
  { id: 'input', role: 'user', parts: [{ text: 'Real task' }] },
  { id: 'call', role: 'model', parts: [{ functionCall: { id: 'read', name: 'read_file', args: {} } }] },
  { id: 'result', role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'read', name: 'read_file', response: { result: 'Tool body' } } }] },
  { id: 'follow-up', role: 'user', parts: [{ text: 'Follow-up' }] },
  { id: 'answer', role: 'model', parts: [{ text: 'Answer' }] },
];

function monitor(f: Awaited<ReturnType<typeof fixture>>) {
  const record = { id: 'child', conversationId: 'history', eventSequence: 7,
    invocation: { id: 'invocation-child', role: 'user', parts: [{ text: 'Persisted full invocation' }] },
    profile: { systemPrompt: 'System' } } as unknown as PlatformSubagent;
  const service = { get: async () => record, app: { storage: f.store }, activeIds: () => [], manifest: () => ({ runId: record.id }) };
  return { record, window: async (options: SubAgentRunContentWindowOptions = {}) =>
    (await SubagentExecutionService.prototype.window.call(service, 'owner', record.id, options))!.window };
}

describe('native Monitor floor snapshot', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); await f.store.createConversation(metadata('history')); await f.store.appendHistory('history', messages()); });
  afterEach(async () => { jest.restoreAllMocks(); await f.cleanup(); });

  test('尾窗、上翻与系统配置单独页都有同一全局楼层且仅读取窗口正文', async () => {
    const m = monitor(f); const full = jest.spyOn(f.store, 'readFullHistory'); const state = jest.spyOn(f.store, 'readConversationState');
    const read = jest.spyOn(f.store, 'readHistoryWithFloors'); const invocation = structuredClone(m.record.invocation);
    const tail = await m.window({ limit: 2 });
    expect(tail).toMatchObject({ startIndex: 4, endIndex: 6, totalCount: 6, floorIndices: [1, 2, 4, 5], contentRevision: 1 });
    expect(tail.contents.map(content => [content.id, content.index])).toEqual([['follow-up', 4], ['answer', 5]]);
    const older = await m.window({ endIndex: 4, limit: 2 });
    expect(older.floorIndices).toEqual(tail.floorIndices);
    expect(older.contents.map(content => [content.id, content.index])).toEqual([['call', 2], ['result', 3]]);
    const system = await m.window({ startIndex: 0, endIndex: 1, limit: 1 });
    expect(system.floorIndices).toEqual(tail.floorIndices);
    expect(system.contents).toHaveLength(1); expect(system.contents[0].index).toBe(0);
    expect(read.mock.calls.map(call => call[1])).toEqual([{ offset: 3, limit: 2 }, { offset: 1, limit: 2 }, undefined]);
    expect(full).not.toHaveBeenCalled(); expect(state).not.toHaveBeenCalled();
    expect(m.record.invocation).toEqual(invocation);
  });

  test('删除与重试的历史替换不会沿用旧全局楼层或修改旧快照', async () => {
    const m = monitor(f); const before = await m.window({ limit: 1 });
    const deleted = await f.store.replaceHistory('history', messages().filter(message => message.id !== 'follow-up'));
    const afterDelete = await m.window({ limit: 1 });
    expect(afterDelete).toMatchObject({ startIndex: 4, endIndex: 5, totalCount: 5, floorIndices: [1, 2, 4], contentRevision: deleted.revision });
    const retry = await f.store.replaceHistory('history', [messages()[0], { id: 'retried-answer', role: 'model', parts: [{ text: 'Retry' }] }]);
    const afterRetry = await m.window({ limit: 1 });
    expect(afterRetry).toMatchObject({ startIndex: 2, endIndex: 3, totalCount: 3, floorIndices: [1, 2], contentRevision: retry.revision });
    expect(afterRetry.contents[0]).toMatchObject({ id: 'retried-answer', index: 2 });
    expect(before.floorIndices).toEqual([1, 2, 4, 5]);
  });

  test('边界读取后追加/删除时，正文索引、楼层和revision仍属于同一快照', async () => {
    const info = f.store.historyInfo.bind(f.store);
    jest.spyOn(f.store, 'historyInfo').mockImplementationOnce(async id => {
      const old = await info(id);
      await f.store.appendHistory(id, [{ id: 'later', role: 'user', parts: [{ text: 'Appended' }] }]);
      return old;
    });
    const m = monitor(f); const tail = await m.window({ limit: 2 });
    expect(tail).toMatchObject({ startIndex: 5, endIndex: 7, totalCount: 7, floorIndices: [1, 2, 4, 5, 6], contentRevision: 2 });
    expect(tail.contents.map(content => [content.id, content.index])).toEqual([['answer', 5], ['later', 6]]);
    jest.spyOn(f.store, 'historyInfo').mockImplementationOnce(async id => {
      const old = await info(id); await f.store.replaceHistory(id, []); return old;
    });
    const empty = await m.window({ limit: 2 });
    expect(empty).toMatchObject({ startIndex: 0, endIndex: 1, totalCount: 1, floorIndices: [], contentRevision: 3 });
    expect(empty.contents[0].id).toBe('invocation-child');
  });
});

test('楼层投影不恢复历史正文、工具载荷或附件；完整解码限定在请求页', async () => {
  const f = await fixture();
  try {
    const oldText = 'OLD_BODY'.repeat(10000); const toolText = 'TOOL_PAYLOAD'.repeat(10000); const attachment = Buffer.alloc(65536, 7);
    const source = messages();
    source[0].parts = [{ text: oldText }, { inlineData: { mimeType: 'image/png', data: attachment.toString('base64') } }];
    source[2].parts = [{ functionResponse: { name: 'read_file', response: { result: toolText } } }];
    await f.store.createConversation(metadata('projection'));
    await f.store.appendHistory('projection', source);
    await f.store.close();
    // Only this disposable fixture's old text/tool/attachment chunks are damaged. Any full-body restoration must fail.
    const db = new Database(path.join(f.data, 'platform.sqlite'));
    try {
      for (const value of [Buffer.from(oldText), Buffer.from(toolText), attachment]) {
        const hash = createHash('sha256').update(value).digest();
        expect(db.prepare('UPDATE chunks SET codec=0,data=?,file_id=NULL WHERE hash=?').run(Buffer.from('damaged'), hash).changes).toBe(1);
      }
    } finally { db.close(); }
    f.store = await PlatformStorage.open(f.data);
    const meta = await f.store.readHistoryWithFloors('projection');
    expect(meta).toMatchObject({ total: 5, revision: 1, messages: [], floorIndices: [0, 1, 3, 4] });
    const tail = await f.store.readHistoryWithFloors('projection', { limit: 2 });
    expect(tail.messages).toEqual(source.slice(3)); expect(tail.floorIndices).toEqual(meta.floorIndices);
    expect(JSON.stringify(meta)).not.toContain('OLD_BODY'); expect(JSON.stringify(tail)).not.toContain('TOOL_PAYLOAD');
    await expect(f.store.readFullHistory('projection')).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
  } finally { await f.cleanup(); }
});
