import type { LongMemoryQuery, LongMemoryRecordInput, LongMemoryScope, LongMemorySourceInput } from '@graycode/contracts';
import { PlatformStorage } from '@graycode/core';
import { VectorMatrixCache, rankVectors, vectorNorms } from '../src/storage/longMemory/vectors';
import { fixture, message, metadata } from './fixtures';

describe('会话列表批量读取', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('摘要与逐条读取一致，编号列表与完整列表的筛选、顺序和游标相同', async () => {
    for (let index = 0; index < 7; index++) {
      const id = `list_${index}`;
      await f.store.createConversation({ ...metadata(id), updatedAt: 1000 + (index % 3), workspaceUri: index % 2 ? 'file:///odd' : undefined,
        ...(index === 1 ? { workspaceId: 'workspace-one', actorId: 'owner', custom: { botOrigin: { platform: 'discord' }, platformMode: 'chat' } } : {}),
        ...(index === 2 ? { actorId: 42, custom: { platformMode: ['code'] } } : {}) });
      if (index % 2) await f.store.appendHistory(id, [message(0), message(1)]);
    }
    const all = await f.store.listConversations({ limit: 1000 });
    for (const item of all.items) {
      const info = (await f.store.getConversationInfo(item.id))!;
      expect(item).toMatchObject({ messageCount: info.messageCount, revision: info.historyRevision, updatedAt: info.metadata.updatedAt });
    }
    expect(all.items.find(item => item.id === 'list_1')).toMatchObject({ workspaceId: 'workspace-one', botPlatform: 'discord', actorId: 'owner', platformMode: 'chat', messageCount: 2 });
    // 没有归属与模式的旧元数据、类型不对的字段都不出现在摘要里。
    for (const id of ['list_0', 'list_2']) {
      const item = all.items.find(row => row.id === id)!;
      expect('actorId' in item).toBe(false); expect('platformMode' in item).toBe(false);
    }
    for (const options of [{}, { workspaceUri: 'file:///odd' }, { query: '会话 list_' }]) {
      const summaries: string[] = [], ids: string[] = [];
      let cursor: { updatedAt: number; id: string } | undefined;
      do { const page = await f.store.listConversations({ ...options, limit: 2, cursor }); summaries.push(...page.items.map(item => item.id)); cursor = page.nextCursor; } while (cursor);
      do { const page = await f.store.listConversationIds({ ...options, limit: 2, cursor }); ids.push(...page.ids); cursor = page.nextCursor; } while (cursor);
      expect(ids).toEqual(summaries); expect(ids.length).toBeGreaterThan(0);
    }
    // 元数据换新内容后摘要投影随哈希更新。
    const current = (await f.store.getConversation('list_1'))!;
    await f.store.saveMetadata({ ...current, workspaceId: 'workspace-two', custom: {} });
    const updated = (await f.store.listConversations({ limit: 1000 })).items.find(item => item.id === 'list_1')!;
    expect(updated.workspaceId).toBe('workspace-two'); expect(updated.botPlatform).toBeUndefined();
    expect(updated.actorId).toBe('owner'); expect(updated.platformMode).toBeUndefined();
  });
});

describe('向量候选矩阵缓存', () => {
  test('按字节预算淘汰最久未用的范围，最新矩阵总是保留，按范围或全部失效', () => {
    const cache = new VectorMatrixCache(100);
    cache.add('a', 40, ['scope-a']); cache.add('b', 40, ['scope-b']);
    expect(cache.has('a')).toBe(true);
    cache.add('c', 40, ['scope-c']);
    expect(cache.has('b')).toBe(false); expect(cache.has('a')).toBe(true); expect(cache.drain()).toEqual(['b']);
    cache.add('huge', 500, ['scope-a']);
    expect(cache.size).toBe(1); expect(cache.has('huge')).toBe(true); expect(cache.drain().sort()).toEqual(['a', 'c']);
    cache.add('d', 10, ['scope-d', 'scope-e']);
    expect(cache.has('huge')).toBe(false);
    cache.add('f', 10, ['scope-f']); cache.drain();
    cache.invalidate(['scope-e']);
    expect(cache.has('d')).toBe(false); expect(cache.has('f')).toBe(true); expect(cache.drain()).toEqual(['d']);
    cache.discard(['f', 'never-added']);
    expect(cache.has('f')).toBe(false); expect(cache.totalBytes).toBe(0); expect(cache.drain()).toEqual(['f', 'never-added']);
    cache.add('g', 10, ['scope-g']); cache.invalidate();
    expect(cache.size).toBe(0); expect(cache.drain()).toEqual(['g']);
  });

  test('预计算模长与逐行计算的分数逐位一致', () => {
    const dimensions = 5, rows = 30, buffer = new ArrayBuffer(rows * dimensions * 4), view = new DataView(buffer);
    for (let index = 0; index < rows * dimensions; index++) view.setFloat32(index * 4, index % 7 === 0 ? 0 : Math.sin(index) * 3, true);
    for (let column = 0; column < dimensions; column++) view.setFloat32(column * 4, 0, true);
    const input = { dimensions, values: [0.3, -1, 2, 0.5, 1e-3], ids: Array.from({ length: rows }, (_, index) => `id-${index % 4}`), vectors: buffer, limit: 41 };
    const norms = vectorNorms(buffer, dimensions);
    const expected = input.ids.map((_, index) => {
      let dot = 0, square = 0;
      for (let column = 0; column < dimensions; column++) { const value = view.getFloat32((index * dimensions + column) * 4, true); dot += value * input.values[column]; square += value * value; }
      return square ? dot / (Math.sqrt(input.values.reduce((sum, value) => sum + value * value, 0)) * Math.sqrt(square)) : 0;
    });
    const ranked = rankVectors(input, norms);
    expect(ranked).toEqual(rankVectors(input));
    for (const item of ranked) expect(item.score).toBe(expected[item.index]);
  });

  const time = Date.parse('2026-07-01T00:00:00Z');
  const scopes: LongMemoryScope[] = ['project-a', 'project-b'].map(key => ({ id: `vector-${key}`, actorId: 'owner', kind: 'workspace', key, realm: 'real' }));
  const source = (id: string): LongMemorySourceInput => ({ id, text: `来源 ${id}`, origin: 'user', expectedVersion: 0, recordedAt: time });
  const record = (id: string, values: number[], topic: string): LongMemoryRecordInput => ({ id, text: `向量条目 ${id}`, kind: 'fact', origin: 'user', confidence: 'confirmed',
    subject: '测试', topic: ['向量', topic], entities: [], expectedVersion: 0, recordedAt: time, validFrom: time, dependencies: [{ kind: 'source', id: `${id}-source`, version: 1 }],
    supersedes: [], vector: { model: 'fixture-vector', dimensions: 3, values } });
  const query = (scope: LongMemoryScope, topic?: string): LongMemoryQuery => ({ scopes: [scope], asOf: time + 1, knownAt: time + 1, limit: 8, tokenBudget: 16000,
    ...(topic ? { topic: ['向量', topic] } : {}), vector: { model: 'fixture-vector', dimensions: 3, values: [1, 0.5, 0.25] } });
  const ranking = async (store: PlatformStorage, value: LongMemoryQuery) =>
    (await store.longMemoryRecall(value)).hits.map(hit => [hit.record.id, hit.score, hit.reasons]);

  test('多个范围交替检索的排序与分数和新开存储一致，写入只影响对应范围', async () => {
    const f = await fixture();
    try {
      for (const [scopeIndex, scope] of scopes.entries()) {
        const items = Array.from({ length: 12 }, (_, index) => ({ id: `${scope.key}-${index}`, values: [Math.cos(index + scopeIndex), Math.sin(index), (index % 3) - 1], topic: index % 2 ? '奇' : '偶' }));
        await f.store.longMemoryWrite({ scope, sources: items.map(item => source(`${item.id}-source`)), records: items.map(item => record(item.id, item.values, item.topic)) });
      }
      const queries = [query(scopes[0]), query(scopes[1]), query(scopes[0], '奇'), query(scopes[1], '偶')];
      const baseline = [];
      for (const value of queries) baseline.push(await ranking(f.store, value));
      // 交替多轮，结果必须与首次（未命中缓存）完全相同。
      for (let round = 0; round < 3; round++) for (const [index, value] of queries.entries()) expect(await ranking(f.store, value)).toEqual(baseline[index]);

      // 修改 A 范围中一条向量：A 的结果变化并与重新打开存储得到的结果一致，B 不变。
      const top = baseline[0][0][0] as string;
      await f.store.longMemoryVector({ scope: scopes[0], id: top, version: 1, vector: { model: 'fixture-vector', dimensions: 3, values: [-1, -0.5, -0.25] } });
      const changed = [];
      for (const value of queries) changed.push(await ranking(f.store, value));
      expect(changed[0]).not.toEqual(baseline[0]); expect(changed[0].map(item => item[0])).not.toContain(top);
      expect(changed[1]).toEqual(baseline[1]); expect(changed[3]).toEqual(baseline[3]);
      await f.store.close();
      f.store = await PlatformStorage.open(f.data);
      for (const [index, value] of queries.entries()) expect(await ranking(f.store, value)).toEqual(changed[index]);

      // 删除后再写入：行号可能复用，结果仍须与重新打开一致。
      await f.store.longMemoryWrite({ scope: scopes[1], remove: [{ kind: 'record', id: 'project-b-0', action: 'delete', expectedVersion: 1 }] });
      await f.store.longMemoryWrite({ scope: scopes[0], sources: [source('late-source')], records: [{ ...record('late', [1, 0.5, 0.25], '偶'), dependencies: [{ kind: 'source', id: 'late-source', version: 1 }] }] });
      const rewritten = [];
      for (const value of queries) rewritten.push(await ranking(f.store, value));
      expect(rewritten[0][0][0]).toBe('late'); expect(rewritten[1].map(item => item[0])).not.toContain('project-b-0');
      await f.store.close();
      f.store = await PlatformStorage.open(f.data);
      for (const [index, value] of queries.entries()) expect(await ranking(f.store, value)).toEqual(rewritten[index]);
    } finally { await f.cleanup(); }
  });
});
