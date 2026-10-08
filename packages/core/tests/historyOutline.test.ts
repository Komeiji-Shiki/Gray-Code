import { ConversationManager, MemoryStorageAdapter } from '../../../backend/modules/conversation';
import type { ConversationHistory } from '../../../backend/modules/conversation';
import { SqliteStorageAdapter } from '../../../backend/modules/conversation/SqliteStorageAdapter';
import type { PlatformMessage } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

const longText = `  第一条\n\n  用户   消息 ${'很长的正文 '.repeat(40)}`;
const source: PlatformMessage[] = [
  { id: 'u-0', parentId: null, role: 'user', parts: [{ text: longText }, { text: '补充' }] },
  { id: 'm-1', parentId: 'u-0', role: 'model', runId: 'done-run', parts: [
    { text: '读取' }, { functionCall: { id: 'call-1', name: 'read_file', args: { path: 'TOOL_ARGUMENT' } } },
  ] },
  { id: 'r-2', parentId: 'm-1', role: 'user', isFunctionResponse: true, parts: [
    { functionResponse: { id: 'call-1', name: 'read_file', response: { success: true, data: 'TOOL_PAYLOAD' } } },
  ] },
  { id: 'm-3', parentId: 'r-2', role: 'model', parts: [{ text: '完成' }] },
  { id: 'u-4', parentId: 'm-3', role: 'user', parts: [{ text: '继续' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
];

describe('历史导航摘要', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); await f.store.createConversation(metadata('outline')); await f.store.appendHistory('outline', source); });
  afterEach(async () => { await f.cleanup(); });

  test('只返回配对标记与用户预览，不复制正文、工具载荷和附件', async () => {
    const outline = await f.store.readHistoryOutline('outline');
    expect(outline).toMatchObject({ conversationId: 'outline', total: 5, revision: 1 });
    expect(outline.entries).toEqual([
      { role: 'user', id: 'u-0', hasParentId: true, preview: longText.concat(' 补充').replace(/\s+/g, ' ').trim().slice(0, 80) },
      { role: 'model', id: 'm-1', hasParentId: true, runId: 'done-run', calls: [{ id: 'call-1' }] },
      { role: 'user', id: 'r-2', hasParentId: true, isFunctionResponse: true, responses: [{ id: 'call-1' }] },
      { role: 'model', id: 'm-3', hasParentId: true },
      { role: 'user', id: 'u-4', hasParentId: true, preview: '继续' },
    ]);
    expect(JSON.stringify(outline)).not.toMatch(/TOOL_ARGUMENT|TOOL_PAYLOAD|aGVsbG8/);
  });

  test('中断结算只返回指定运行中尚未配对的工具身份', async () => {
    await f.store.appendHistory('outline', [
      { id: 'current-calls', role: 'model', runId: 'current', parts: [
        { functionCall: { id: 'finished', name: 'read_file', args: { path: 'TOOL_ARGUMENT' } } },
        { functionCall: { id: 'waiting', name: 'execute_command', args: { command: 'TOOL_ARGUMENT' } } },
      ] },
      { id: 'current-result', role: 'user', runId: 'current', isFunctionResponse: true, parts: [
        { functionResponse: { id: 'finished', name: 'read_file', response: { success: true, data: 'TOOL_PAYLOAD' } } },
      ] },
      { id: 'other-call', role: 'model', runId: 'other', parts: [
        { functionCall: { id: 'other-pending', name: 'write_file', args: {} } },
      ] },
      { id: 'other-result', role: 'user', runId: 'other', isFunctionResponse: true, parts: [
        { functionResponse: { id: 'waiting', name: 'execute_command', response: { success: true } } },
      ] },
    ]);
    expect(await f.store.readPendingToolCalls('outline', 'current')).toEqual([{ id: 'waiting', name: 'execute_command' }]);
    await f.store.appendHistory('outline', [{ role: 'user', runId: 'current', isFunctionResponse: true, parts: [
      { functionResponse: { id: 'waiting', name: 'execute_command', response: { success: false, code: 'CANCELLED' } } },
    ] }]);
    expect(await f.store.readPendingToolCalls('outline', 'current')).toEqual([]);
    expect(await f.store.readPendingToolCalls('outline', 'other')).toEqual([{ id: 'other-pending', name: 'write_file' }]);
  });

  test('运行历史只读取选中轮次并保留消息顺序、正文和附件', async () => {
    const current: PlatformMessage[] = [
      { id: 'current-input', role: 'user', runId: 'current', parts: [{ text: '本次任务' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
      { id: 'other-output', role: 'model', runId: 'other', parts: [{ text: '另一个运行的报告' }] },
      { id: 'current-output', role: 'model', runId: 'current', parts: [{ text: '本次完成' }] },
    ];
    await f.store.appendHistory('outline', current);
    expect((await f.store.readHistorySelection('outline', { runIds: ['current', 'done-run', 'current'] })).messages).toEqual([source[1], current[0], current[2]]);
    expect((await f.store.readHistorySelection('outline', { runIds: [] })).messages).toEqual([]);
    expect((await f.store.readHistorySelection('outline', { runIds: ['missing-run'] })).messages).toEqual([]);
    const selected = await f.store.readHistorySelection('outline', { indices: [7, 5, 5], projection: { fields: ['runId'] } });
    expect(selected.messages).toEqual([{ id: 'current-input', role: 'user', runId: 'current' }, { id: 'current-output', role: 'model', runId: 'current' }]);
    await f.store.appendHistory('outline', [{ role: 'user', parts: [{ text: '读取途中变化' }] }]);
    await expect(f.store.readHistorySelection('outline', { indices: [5], expectedRevision: selected.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  test('追加、截断替换与分叉后结果与完整读取一致', async () => {
    await f.store.readHistoryOutline('outline');
    await f.store.appendHistory('outline', [{ id: 'm-5', parentId: 'u-4', role: 'model', parts: [
      { functionCall: { id: 'call-2', name: 'x', args: {}, rejected: true } },
    ] }]);
    await f.store.appendHistory('outline', [{ id: 'r-6', parentId: 'm-5', role: 'user', isFunctionResponse: true, parts: [
      { functionResponse: { id: 'call-2', name: 'x', response: { rejected: true, code: 'INTERRUPTED', cancelled: true, error: '拒绝' } } },
    ] }]);
    const appended = await f.store.readHistoryOutline('outline');
    expect(appended.entries.map(entry => entry.id)).toEqual(['u-0', 'm-1', 'r-2', 'm-3', 'u-4', 'm-5', 'r-6']);
    expect(appended.entries.slice(5)).toEqual([
      { role: 'model', id: 'm-5', hasParentId: true, calls: [{ id: 'call-2', rejected: true }] },
      { role: 'user', id: 'r-6', hasParentId: true, isFunctionResponse: true, responses: [{ id: 'call-2', rejected: true, cancelled: true, code: 'INTERRUPTED' }] },
    ]);

    // 同一版本重复读取返回独立数组，调用方修改不影响缓存。
    appended.entries.length = 0;
    expect((await f.store.readHistoryOutline('outline')).entries).toHaveLength(7);

    const full = (await f.store.readFullHistory('outline')).messages;
    await f.store.replaceHistory('outline', [...full.slice(0, 3), { id: 'u-new', role: 'user', parts: [{ text: '改写后的问题' }] }]);
    expect((await f.store.readHistoryOutline('outline')).entries.map(entry => [entry.id, entry.hasParentId, entry.preview]))
      .toEqual([['u-0', true, expect.any(String)], ['m-1', true, undefined], ['r-2', true, undefined], ['u-new', false, '改写后的问题']]);

    await f.store.forkConversation('outline', metadata('fork'), { beforeIndex: 2 });
    expect((await f.store.readHistoryOutline('fork')).entries.map(entry => entry.id)).toEqual(['u-0', 'm-1']);
    await expect(f.store.readHistoryOutline('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('导航标记、楼层与定位不完整读取历史，结果与内存存储一致', async () => {
    const storage = new SqliteStorageAdapter(f.store);
    const manager = new ConversationManager(storage);
    const reference = new MemoryStorageAdapter();
    await reference.saveHistory('outline', source as ConversationHistory);
    const expected = await new ConversationManager(reference).getMessageMarkers('outline');

    const fullReads = jest.spyOn(storage, 'loadHistoryWithStatus');
    expect(await manager.getMessageMarkers('outline')).toEqual(expected);
    expect(await manager.getMessagePosition('outline', 'm-3')).toEqual({ index: 3 });
    expect(await manager.getMessagePosition('outline', 'missing')).toEqual({});
    const page = await manager.getMessagesPaged('outline', { limit: 2 });
    expect(page.messages.map(message => message.id)).toEqual(['m-3', 'u-4']);
    expect(fullReads).not.toHaveBeenCalled();
  });

  test('悬空调用仍走读取修复，标记索引包含补齐的拒绝响应', async () => {
    await f.store.appendHistory('outline', [{ id: 'm-5', parentId: 'u-4', role: 'model', parts: [
      { functionCall: { id: 'dangling', name: 'read_file', args: {} } },
    ] }, { id: 'u-6', parentId: 'm-5', role: 'user', parts: [{ text: '之后的问题' }] }]);
    const manager = new ConversationManager(new SqliteStorageAdapter(f.store));
    const result = await manager.getMessageMarkers('outline');
    expect(result.total).toBe(8);
    expect(result.markers.map(marker => [marker.index, marker.id])).toEqual([[0, 'u-0'], [4, 'u-4'], [7, 'u-6']]);
    expect(result.floorIndices).toEqual([0, 1, 3, 4, 5, 7]);
    const repaired = (await f.store.readFullHistory('outline')).messages;
    expect(repaired[6]).toMatchObject({ role: 'user', isFunctionResponse: true });
    expect(await manager.getMessagePosition('outline', 'u-6')).toEqual({ index: 7 });
  });

  test('缺少节点 ID 的旧历史先迁移再返回标记', async () => {
    await f.store.createConversation(metadata('legacy'));
    await f.store.appendHistory('legacy', [
      { role: 'user', parts: [{ text: '旧消息' }] }, { role: 'model', parts: [{ text: '旧回答' }] },
    ]);
    const manager = new ConversationManager(new SqliteStorageAdapter(f.store));
    const result = await manager.getMessageMarkers('legacy');
    expect(result.total).toBe(2);
    expect(result.markers).toEqual([{ index: 0, id: expect.any(String), preview: '旧消息' }]);
    const migrated = await f.store.readHistoryOutline('legacy');
    expect(migrated.entries.every(entry => entry.id && entry.hasParentId)).toBe(true);
    expect(result.markers[0].id).toBe(migrated.entries[0].id);
  });
});
