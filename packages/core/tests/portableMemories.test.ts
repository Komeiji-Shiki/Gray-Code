import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PlatformStorage } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { DesktopPortableMemories } from '../../../apps/desktop/src/portableMemories';
import { importLifeBook } from '../../../apps/server/src/memory/imports/migrate';
import { listImportLibraries, setImportRecall } from '../../../apps/server/src/memory/imports/library';
import { readImportFileChunk } from '../../../apps/server/src/memory/imports/files';
import { longMemoryScope } from '../../../apps/server/src/memory/longTerm/scopes';
import { MEMORY_IMPORT_NAMESPACE, type MemoryImportDataset } from '@graycode/contracts';
import { fixture } from './fixtures';

function host(storage: PlatformStorage) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  return { storage, subscribe(listener: (event: Record<string, unknown>) => void) {
    listeners.add(listener); return () => { listeners.delete(listener); };
  }, publish(event: Record<string, unknown>) { for (const listener of listeners) listener(event); } } as unknown as PlatformApplication;
}

test('便携资料库携带原文件、人工修订、召回选择和删除状态，保留各台电脑的其他记忆', async () => {
  const f = await fixture();
  const stores: PlatformStorage[] = [];
  const managers: DesktopPortableMemories[] = [];
  try {
    await mkdir(path.join(f.source, 'daily'));
    await writeFile(path.join(f.source, 'daily', 'note.md'), '# 原始记忆\n这是来源正文。');
    const imported = await importLifeBook(f.store, f.source, { actorId: 'owner', name: '移动资料库' });
    const scope = longMemoryScope('owner', 'library', 'real', imported.id);
    await f.store.close();
    const a = await PlatformStorage.open(path.join(f.root, 'machine-a')); stores.push(a);
    const applicationA = host(a);
    const personal = longMemoryScope('owner', 'personal');
    await a.longMemoryWrite({ scope: personal });
    const first = new DesktopPortableMemories(f.data); managers.push(first);
    await first.initialize(applicationA);
    const original = (await a.longMemoryExport([scope])).records[0];
    await a.longMemoryWrite({ scope, records: [{ ...original, text: '电脑 A 核对后的内容', confidence: 'confirmed', expectedVersion: original.version }] });
    await setImportRecall(a, 'owner', imported.id, true);
    applicationA.publish({ type: 'memory.changed', scopeId: scope.id });
    // 写入失败必须保留本机修订并允许再次保存，不能把旧副本当作成功。
    const failed = jest.spyOn(a, 'longMemoryExport').mockRejectedValueOnce(new Error('模拟移动磁盘暂不可写'));
    await expect(first.close()).rejects.toThrow('便携副本写入失败');
    failed.mockRestore();
    await first.close();

    const moved = path.join(f.root, '移动后的记忆');
    expect(path.dirname(f.data)).toBe(f.root); expect(path.dirname(moved)).toBe(f.root);
    await rename(f.data, moved);
    const b = await PlatformStorage.open(path.join(f.root, 'machine-b')); stores.push(b);
    const applicationB = host(b);
    const second = new DesktopPortableMemories(moved); managers.push(second);
    await second.initialize(applicationB);
    expect((await b.longMemoryRevisions({ scope, id: original.id }))[0]).toMatchObject({ text: '电脑 A 核对后的内容', confidence: 'confirmed' });
    expect((await listImportLibraries(b, 'owner'))[0].recallEnabled).toBe(true);
    const library = await b.getRecord(MEMORY_IMPORT_NAMESPACE, imported.id) as MemoryImportDataset;
    expect(Buffer.from(await readImportFileChunk(b, library.id, library.files[0], 0)).toString()).toBe('# 原始记忆\n这是来源正文。');
    await b.longMemoryWrite({ scope, remove: [{ kind: 'record', id: original.id, action: 'delete' }] });
    await setImportRecall(b, 'owner', imported.id, false);
    applicationB.publish({ type: 'memory.import.changed' });
    await second.close();

    const returned = new DesktopPortableMemories(moved); managers.push(returned);
    await returned.initialize(applicationA);
    expect((await a.longMemoryExport([scope])).tombstones).toEqual(expect.arrayContaining([expect.objectContaining({ id: original.id, action: 'delete' })]));
    expect((await listImportLibraries(a, 'owner'))[0].recallEnabled).toBe(false);
    expect((await a.longMemoryScopes('owner')).some(item => item.id === personal.id)).toBe(true);
    await returned.close();
    const portable = await PlatformStorage.open(moved); stores.push(portable);
    expect((await portable.longMemoryScopes('owner')).map(item => item.id)).toEqual([scope.id]);
    expect((await portable.verify()).ok).toBe(true);
  } finally {
    for (const manager of managers) await manager.close();
    for (const store of stores) await store.close();
    await f.cleanup();
  }
});

test('未放入记忆数据库的便携程序继续只保存配置', async () => {
  const f = await fixture();
  const directory = path.join(f.root, 'not-configured');
  const manager = new DesktopPortableMemories(directory);
  try {
    await manager.initialize(host(f.store));
    await manager.close();
    expect(existsSync(directory)).toBe(false);
  } finally { await f.cleanup(); }
});
