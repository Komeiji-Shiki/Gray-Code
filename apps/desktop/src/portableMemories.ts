import path from 'node:path';
import { existsSync } from 'node:fs';
import { PlatformStorage } from '@graycode/core';
import { MEMORY_IMPORT_NAMESPACE, MEMORY_IMPORT_FILE_NAMESPACE, MEMORY_IMPORT_POLICY_NAMESPACE,
  type MemoryImportDataset, type MemoryImportPolicy, type LongMemoryScope } from '@graycode/contracts';
import type { PlatformApplication } from '../../server/src/application';
import { longMemoryScope } from '../../server/src/memory/longTerm/scopes';
import { upgradeImportedMemoryGraphs } from '../../server/src/memory/imports/upgrades';

/** 便携库只同步显式放入移动目录的资料库，正文合并复用现有修订和删除校验。 */
export class DesktopPortableMemories {
  private storage?: PlatformStorage;
  private application?: PlatformApplication;
  private libraries: MemoryImportDataset[] = [];
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private dirty = false;
  constructor(readonly directory: string) {}

  async initialize(application: PlatformApplication): Promise<void> {
    if (!existsSync(path.join(this.directory, 'platform.sqlite'))) return;
    this.application = application;
    const portable = this.storage = await PlatformStorage.open(this.directory);
    try {
      await upgradeImportedMemoryGraphs(portable);
      for (const id of await portable.listRecords(MEMORY_IMPORT_NAMESPACE, 'owner')) {
        const library = await portable.getRecord(MEMORY_IMPORT_NAMESPACE, id) as MemoryImportDataset;
        const scope = longMemoryScope('owner', 'library', 'real', id);
        if (library.actorId !== 'owner' || library.scopeId !== scope.id) throw new Error('便携资料库归属无效。');
        this.libraries.push(library);
        await this.transferLibrary(portable, application.storage, library, scope);
        // 本机上已有的修订和删除记录也合入移动副本，旧电脑不会恢复已删除内容。
        await this.transferLibrary(application.storage, portable, library, scope);
      }
      await this.transferPolicy(portable, application.storage);
      await portable.checkpoint();
      const scopes = new Set(this.libraries.map(library => library.scopeId));
      this.unsubscribe = application.subscribe(event => {
        if (event.type !== 'memory.import.changed' && !(event.type === 'memory.changed' && scopes.has(String(event.scopeId)))) return;
        this.dirty = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush().catch(error => application.publish({ type: 'notification', message: String(error.message) }));
        }, 1500);
        this.timer.unref?.();
      });
    } catch (error) {
      await portable.close(); this.storage = undefined;
      throw new Error(`便携记忆读取失败，原有资料仍保留：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async transferLibrary(source: PlatformStorage, target: PlatformStorage, library: MemoryImportDataset, scope: LongMemoryScope) {
    const saved = await target.getVersionedRecord(MEMORY_IMPORT_NAMESPACE, library.id);
    const sourceLibrary = await source.getRecord(MEMORY_IMPORT_NAMESPACE, library.id) as MemoryImportDataset;
    if (saved.value && (saved.value as MemoryImportDataset).fingerprint !== sourceLibrary.fingerprint)
      throw new Error('同一便携资料库对应了不同来源，未覆盖已有资料。');
    if (!saved.value) {
      const existing = new Set(await target.listRecords(MEMORY_IMPORT_FILE_NAMESPACE, library.id));
      for (const id of await source.listRecords(MEMORY_IMPORT_FILE_NAMESPACE, library.id)) {
        if (existing.has(id)) continue;
        const value = await source.getRecord(MEMORY_IMPORT_FILE_NAMESPACE, id);
        if (!value) throw new Error('便携记忆原始文件块缺失。');
        await target.commitRecords([{ namespace: MEMORY_IMPORT_FILE_NAMESPACE, id, ownerId: library.id, value, expectedRevision: null }]);
      }
    }
    const archive = await source.longMemoryExport([scope]);
    await target.longMemoryRestore({ actorId: 'owner', archive,
      ...(JSON.stringify(saved.value) !== JSON.stringify(sourceLibrary) ? { publication: [{ namespace: MEMORY_IMPORT_NAMESPACE,
        id: library.id, ownerId: 'owner', expectedRevision: saved.revision, value: sourceLibrary }] } : {}) });
  }

  private async transferPolicy(source: PlatformStorage, target: PlatformStorage) {
    if (!this.libraries.length) return;
    const managed = new Set(this.libraries.map(library => library.scopeId));
    const policy = await source.getRecord(MEMORY_IMPORT_POLICY_NAMESPACE, 'owner') as MemoryImportPolicy | null;
    const saved = await target.getVersionedRecord(MEMORY_IMPORT_POLICY_NAMESPACE, 'owner');
    const previous = saved.value as MemoryImportPolicy | null;
    const enabledScopes = [...(previous?.enabledScopes ?? []).filter(scope => !managed.has(scope.id)),
      ...(policy?.enabledScopes ?? []).filter(scope => managed.has(scope.id))].sort((left, right) => left.id.localeCompare(right.id));
    if (JSON.stringify(previous?.enabledScopes ?? []) === JSON.stringify(enabledScopes)) return;
    await target.commitRecords([{ namespace: MEMORY_IMPORT_POLICY_NAMESPACE, id: 'owner', ownerId: 'owner',
      expectedRevision: saved.revision, value: { enabledScopes } satisfies MemoryImportPolicy }]);
  }

  private flush(): Promise<void> {
    const operation = this.pending.catch(() => {}).then(async () => {
      if (!this.dirty || !this.storage || !this.application) return;
      this.dirty = false;
      try {
        for (const library of this.libraries) await this.transferLibrary(this.application.storage, this.storage, library,
          longMemoryScope('owner', 'library', 'real', library.id));
        await this.transferPolicy(this.application.storage, this.storage);
        await this.storage.checkpoint();
      } catch (error) {
        this.dirty = true;
        throw new Error(`记忆已保存在本机，但便携副本写入失败，请连接移动磁盘后重试：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    this.pending = operation;
    return operation;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
    this.unsubscribe?.(); this.unsubscribe = undefined;
    await this.storage?.close(); this.storage = undefined;
  }
}
