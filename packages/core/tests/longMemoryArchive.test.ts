import type { LongMemoryArchive, LongMemoryRecord, LongMemoryScope, LongMemorySource } from '@graycode/contracts';
import { MemoryArchive } from '../src/storage/longMemory/archive';
import { MemoryMutationStore } from '../src/storage/longMemory/mutations';
import { openDatabase, type SqliteConnection } from '../src/storage/schema';

const scope: LongMemoryScope = { id: 'archive-owner-real', actorId: 'owner', kind: 'personal', realm: 'real' };
const source: LongMemorySource = { id: 'base', scopeId: scope.id, version: 1, origin: 'user', text: '合成来源。', recordedAt: 1 };
function record(id: string, parent?: string, extra: Partial<LongMemoryRecord> = {}): LongMemoryRecord {
  return { id, scopeId: scope.id, version: 1, kind: 'fact', origin: 'user', confidence: 'confirmed', subject: '合成对象',
    text: `合成记忆 ${id}`, topic: [], entities: [], recordedAt: 1, validFrom: 1, supersedes: [],
    dependencies: [{ kind: 'source', id: source.id, version: 1 },
      ...(parent ? [{ kind: 'record' as const, id: parent, version: 1, association: true as const }] : [])], ...extra };
}
function archive(records: LongMemoryRecord[]): LongMemoryArchive {
  return { format: 'graycode-long-memory', version: 1, createdAt: 1,
    scopes: [{ ...scope, revision: 0, invalidation: 0, hasRecords: false }], sources: [source], records, tombstones: [] };
}

describe('长期记忆归档的实际 SQLite 依赖调度', () => {
  let db: SqliteConnection, store: MemoryMutationStore, exchange: MemoryArchive;
  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new MemoryMutationStore(db);
    exchange = new MemoryArchive(store);
  });
  afterEach(() => { jest.restoreAllMocks(); db.close(); });

  test.each([64, 128])('逆序的 %i 条依赖只需要与条目数成比例的记录查询', count => {
    const id = (index: number) => `memory-${String(index).padStart(4, '0')}`;
    const records = Array.from({ length: count }, (_, index) => record(id(index), index ? id(index - 1) : undefined));
    const reads = jest.spyOn(store, 'record');
    expect(exchange.restore('owner', archive([...records].reverse())))
      .toEqual({ sources: 1, records: count, skipped: 0, tombstones: 0 });
    // 保留遍历和写入边界的常数次校验，以查询次数约束重复扫描，避免墙钟时间断言。
    expect(reads.mock.calls.length).toBeLessThanOrEqual(count * 10);
    expect(exchange.export([scope]).records).toEqual(records);
  });

  test('唤醒顺序保留旧扫描的轮次与位置，失效计数保持一致', () => {
    const same = { attribute: '测试属性', value: '旧值' };
    const records = [record('a', 'b', { ...same, value: '新值' }), record('b', undefined, same),
      record('c', 'a', same), record('d', undefined, same), record('e', 'b', same)];
    expect(exchange.restore('owner', archive(records))).toEqual({ sources: 1, records: 5, skipped: 0, tombstones: 0 });
    expect(db.prepare('SELECT id FROM long_memory_records ORDER BY row_id').all())
      .toEqual(['b', 'd', 'e', 'a', 'c'].map(id => ({ id })));
    expect(store.state(scope)).toMatchObject({ revision: 6, invalidation: 2 });
  });

  test('已有旧版本、逆序新版、重复条目和高版本依赖可一起恢复', () => {
    const first = record('versioned');
    exchange.restore('owner', archive([first]));
    const second = { ...first, version: 2, text: '第二版。' };
    const third = { ...first, version: 3, text: '第三版。' };
    const child = record('child', 'versioned');
    child.dependencies[1].version = 3;
    expect(exchange.restore('owner', archive([third, second, child, first, second])))
      .toEqual({ sources: 0, records: 3, skipped: 3, tombstones: 0 });
    expect(exchange.export([scope]).records).toHaveLength(4);
    expect(JSON.parse(store.record(scope.id, 'versioned')!.payload)).toEqual(third);
  });

  test.each(['正文变化', '依赖缺失'])('相同身份与修订的冲突重复项（%s）仍优先比较内容并原子回滚', change => {
    const item = record('duplicate');
    const conflict = change === '正文变化' ? { ...item, text: '冲突正文。' }
      : { ...item, dependencies: [{ kind: 'source' as const, id: 'missing', version: 1 }] };
    expect(() => exchange.restore('owner', archive([item, conflict])))
      .toThrow('归档记忆与现有相同修订内容冲突。');
    expect(store.record(scope.id, item.id)).toBeUndefined();
    expect(store.source(scope.id, source.id)).toBeUndefined();
  });

  test('另一个范围的同名记录不能解除本范围缺失的依赖', () => {
    const other: LongMemoryScope = { ...scope, id: 'archive-other-real', kind: 'workspace', key: 'other' };
    const input = archive([record('waiting', 'missing'), record('missing', undefined, { scopeId: other.id })]);
    input.scopes.push({ ...other, revision: 0, invalidation: 0, hasRecords: false });
    input.sources.push({ ...source, scopeId: other.id });
    expect(() => exchange.restore('owner', input)).toThrow('归档存在缺失来源、修订或循环依赖，未执行部分恢复。');
    expect(store.record(other.id, 'missing')).toBeUndefined();
    expect(store.source(scope.id, source.id)).toBeUndefined();
  });
});
