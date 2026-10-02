import type { PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { PlatformUsage } from '../../../apps/server/src/conversations/usage';
import { fixture } from './fixtures';

const answer = (id: string, prompt: number, extra: Partial<PlatformMessage> = {}): PlatformMessage => ({ id, role: 'model', timestamp: 1_700_000_000_000, modelVersion: 'fixture-model',
  parts: [{ text: `回复 ${id}` }], usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 1 }, ...extra });
const question = (id: string): PlatformMessage => ({ id, role: 'user', timestamp: 1_700_000_000_000, parts: [{ text: `问题 ${id}` }] });

describe('用量前缀令牌只读取新增后缀', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('追加、重生成、无效令牌和回收后的回退', async () => {
    await f.store.createConversation({ id: 'usage', title: '用量', createdAt: 1, updatedAt: 1 });
    await f.store.appendHistory('usage', [question('q1'), answer('a1', 10), question('q2'), answer('a2', 20)]);
    const full = await f.store.readUsageState('usage');
    expect(full.keep).toBe(0); expect(full.messages.map(item => item.id)).toEqual(['a1', 'a2']);

    // 只追加用户消息：没有需要解码的后缀。
    await f.store.appendHistory('usage', [question('q3')]);
    const userOnly = await f.store.readUsageState('usage', [], full.token);
    expect(userOnly.keep).toBe(2); expect(userOnly.messages).toEqual([]);

    await f.store.appendHistory('usage', [answer('a3', 30)]);
    const appended = await f.store.readUsageState('usage', [], userOnly.token);
    expect(appended.keep).toBe(2); expect(appended.messages.map(item => item.id)).toEqual(['a3']);

    // 重生成最后一条回复：被改写的位置之后重新返回，共享前缀保留。
    const history = (await f.store.readFullHistory('usage')).messages;
    await f.store.replaceHistory('usage', [...history.slice(0, -1), answer('a3-retry', 31)]);
    const regenerated = await f.store.readUsageState('usage', [], appended.token);
    expect(regenerated.keep).toBe(2); expect(regenerated.messages.map(item => item.id)).toEqual(['a3-retry']);

    // 删除中间消息：共享前缀缩短到改写位置。
    await f.store.replaceHistory('usage', [history[0], history[1], history[4]]);
    const deleted = await f.store.readUsageState('usage', [], regenerated.token);
    expect(deleted.keep + deleted.messages.length).toBe(1);
    expect([...full.messages.slice(0, deleted.keep), ...deleted.messages].map(item => item.id)).toEqual(['a1']);

    for (const token of ['不是令牌', JSON.stringify(['other-epoch', []]), JSON.stringify([JSON.parse(deleted.token)[0], [[0, -1, 0, 1]]])]) {
      const fallback = await f.store.readUsageState('usage', [], token);
      expect(fallback.keep).toBe(0); expect(fallback.messages.map(item => item.id)).toEqual(['a1']);
    }
    // 回收可能复用段号，旧令牌随之失效。
    await f.store.collectGarbage();
    const collected = await f.store.readUsageState('usage', [], deleted.token);
    expect(collected.keep).toBe(0); expect(collected.messages.map(item => item.id)).toEqual(['a1']);
  });
});

describe('服务端用量缓存增量重建', () => {
  test('增量结果与全量重建一致，并保留分支去重与部分输出估算', async () => {
    const f = await fixture(); await f.store.close();
    const app = await PlatformApplication.open({ dataDirectory: f.data });
    try {
      const { id } = await app.createConversation('owner', '增量', undefined, undefined, [question('q1'), answer('a1', 100), question('q2'),
        answer('partial', 0, { usageMetadataPartial: true, usageMetadata: { promptTokenCount: 5 }, parts: [{ text: '中断的长回复'.repeat(10) }] })]);
      const read = jest.spyOn(app.storage, 'readUsageState');
      const same = async () => {
        const warm = await app.usage.stats('owner', {}), cold = await new PlatformUsage(app).stats('owner', {});
        expect(warm.totals).toEqual(cold.totals); expect(warm.byConversation).toEqual(cold.byConversation); expect(warm.byModel).toEqual(cold.byModel);
        return warm;
      };
      const initial = await same();
      // 部分输出按正文长度估算，不信任半截用量。
      expect(initial.totals.candidatesTokens).toBeGreaterThan(2);
      read.mockClear();

      await app.storage.appendHistory(id, [question('q3')]);
      await same();
      // 第一次调用来自 app.usage（带令牌），第二次来自全新实例（无令牌）。
      expect(read.mock.calls[0][2]).toEqual(expect.any(String));
      expect((await read.mock.results[0].value).messages).toEqual([]);
      read.mockClear();
      await app.storage.appendHistory(id, [answer('a3', 7)]);
      await same();
      expect((await read.mock.results[0].value).messages.map((item: PlatformMessage) => item.id)).toEqual(['a3']);

      const history = (await app.storage.readFullHistory(id)).messages;
      await app.storage.replaceHistory(id, [...history.slice(0, -1), answer('a3-retry', 8)]);
      expect((await same()).totals.promptTokens).toBe(113);

      // 非活跃候选计入，活跃路径上已在主历史中的节点不重复计入。
      const node = (nodeId: string, parentId: string | null, role: 'user' | 'model', prompt = 0, activeChildId?: string) => ({ id: nodeId, parentId, role, kind: 'message',
        createdAt: 1, timestamp: 1_700_000_000_000, parts: [{ text: nodeId }], ...(role === 'model' ? { usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 1 } } : {}),
        ...(activeChildId ? { activeChildId } : {}) });
      const graph = (active: string) => ({ version: 1, rootNodeId: 'q1', activeTailNodeId: active, nodes: {
        q1: node('q1', null, 'user', 0, active), a1: node('a1', 'q1', 'model', 100), alt: node('alt', 'q1', 'model', 1000) } });
      await app.storage.putRecord({ namespace: 'conversation-branches', id, value: { graph: graph('a1') } });
      expect((await same()).totals.promptTokens).toBe(1113);
      await app.storage.putRecord({ namespace: 'conversation-branches', id, value: { graph: graph('alt') } });
      expect((await same()).totals.promptTokens).toBe(1113);

      // 主历史没有消息 ID 时回退为按图的活跃路径去重。
      const anonymous = (await app.storage.readFullHistory(id)).messages.map(({ id: _, ...message }) => message as PlatformMessage);
      await app.storage.replaceHistory(id, anonymous);
      await same();
      await app.storage.putRecord({ namespace: 'conversation-branches', id, value: { graph: graph('a1') } });
      expect((await same()).totals.promptTokens).toBe(1113);
      await app.storage.deleteRecord('conversation-branches', id);
      expect((await same()).totals.promptTokens).toBe(113);
    } finally { await app.close(); await f.cleanup(); }
  });
});
