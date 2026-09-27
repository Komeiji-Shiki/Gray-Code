import path from 'node:path';
import type { PlatformMessage } from '@graycode/contracts';
import { HistoryStore } from '../src/storage/histories';
import { ObjectStore } from '../src/storage/objects';
import { openDatabase, type SqliteConnection } from '../src/storage/schema';
import { fixture, message } from './fixtures';

describe('楼层窗口复用不可变历史前缀', () => {
  let f: Awaited<ReturnType<typeof fixture>>, db: SqliteConnection, objects: ObjectStore, histories: HistoryStore, id: string;
  let original: PlatformMessage[];
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    db = openDatabase(path.join(f.data, 'platform.sqlite'));
    objects = new ObjectStore(db, path.join(f.data, 'objects')); histories = new HistoryStore(db, objects); id = histories.create();
    original = Array.from({ length: 260 }, (_, index) => ({ ...message(index), ...(index % 5 === 0 ? { isFunctionResponse: true } : {}) }));
    db.transaction(() => histories.append(id, original))();
  });
  afterEach(async () => { jest.restoreAllMocks(); db.close(); await f.cleanup(); });
  const floors = (messages: PlatformMessage[]) => messages.flatMap((message, index) => message.isFunctionResponse || !['user', 'model'].includes(message.role) ? [] : [index]);

  test('无变化翻页不重读整段楼层标记，调用方修改返回值不影响后续窗口', () => {
    const reads = jest.spyOn(objects, 'getValue');
    const first = histories.pageWithFloors(id, { limit: 2 });
    expect(first.floorIndices).toEqual(floors(original));
    first.floorIndices.splice(0, first.floorIndices.length);
    reads.mockClear();
    const next = histories.pageWithFloors(id, { offset: 0, limit: 2 });
    expect(next.floorIndices).toEqual(floors(original));
    expect(next.messages).toEqual(original.slice(0, 2));
    expect(reads.mock.calls.filter(([, projection]) => projection?.fields?.includes('isFunctionResponse'))).toHaveLength(0);
  });

  test('追加只读取新条目的楼层标记，跨段修改和截断保留正确前缀', () => {
    histories.pageWithFloors(id);
    const reads = jest.spyOn(objects, 'getValue');
    const appended = [{ ...message(260), isFunctionResponse: true }, message(261)];
    db.transaction(() => histories.append(id, appended))();
    expect(histories.pageWithFloors(id).floorIndices).toEqual(floors([...original, ...appended]));
    expect(reads.mock.calls.filter(([, projection]) => projection?.fields?.includes('isFunctionResponse'))).toHaveLength(2);
    const updated = { ...original[129], isFunctionResponse: true };
    db.transaction(() => histories.patch(id, [{ index: 129, message: updated }]))();
    reads.mockClear();
    const changed = [...original, ...appended]; changed[129] = updated;
    expect(histories.pageWithFloors(id).floorIndices).toEqual(floors(changed));
    expect(reads.mock.calls.filter(([, projection]) => projection?.fields?.includes('isFunctionResponse'))).toHaveLength(changed.length - 129);
    db.transaction(() => histories.replace(id, original.slice(0, 3)))();
    reads.mockClear();
    expect(histories.pageWithFloors(id)).toMatchObject({ total: 3, floorIndices: [1, 2] });
    expect(reads.mock.calls.filter(([, projection]) => projection?.fields?.includes('isFunctionResponse'))).toHaveLength(0);
  });

  test('相同修订号的不同会话、共享分支与存储回收各自保持正确楼层', () => {
    const fork = db.transaction(() => histories.fork(id, 2))();
    const other = histories.create();
    db.transaction(() => histories.append(other, [{ ...message(0), role: 'system' }]))();
    expect(histories.pageWithFloors(id).floorIndices).toEqual(floors(original));
    expect(histories.pageWithFloors(other).floorIndices).toEqual([]);
    expect(histories.pageWithFloors(fork).floorIndices).toEqual([1]);
    const reads = jest.spyOn(objects, 'getValue');
    histories.clearSnapshots();
    expect(histories.pageWithFloors(fork).floorIndices).toEqual([1]);
    expect(reads.mock.calls.filter(([, projection]) => projection?.fields?.includes('isFunctionResponse'))).toHaveLength(2);
  });
});
