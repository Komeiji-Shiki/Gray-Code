import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceChanges, operationNamespace, type WorkspaceOperation } from '../../../apps/server/src/workspace/changes';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';
import { readFileVersion, fileHash, type FileChange, type FileTransaction } from '../../../apps/server/src/workspace/fileTransaction';
import { fixture, metadata } from './fixtures';
import type { WorkspaceDefinition } from '@graycode/contracts';

const workspaceOf = (directory: string): WorkspaceDefinition => ({ id: 'workspace', name: 'Fixture', directory, deviceId: 'local' });
const version = (bytes: Uint8Array | null) => ({ bytes, hash: bytes === null ? null : fileHash(bytes), mode: 0o644 });

describe('workspace file change coordination', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('多文件事务在第二项磁盘冲突时整批不写', async () => {
    const workspace = workspaceOf(f.source); const files = new WorkspaceFiles();
    await writeFile(path.join(f.source, 'a.txt'), 'a'); await writeFile(path.join(f.source, 'b.txt'), 'b');
    const a = await readFileVersion(path.join(f.source, 'a.txt')); const b = await readFileVersion(path.join(f.source, 'b.txt'));
    await writeFile(path.join(f.source, 'b.txt'), 'changed');
    const changes: FileChange[] = [
      { path: 'a.txt', before: a, after: version(Buffer.from('new-a')) },
      { path: 'b.txt', before: b, after: version(Buffer.from('new-b')) },
    ];
    await expect(files.transaction(workspace, transaction => transaction.apply(changes))).rejects.toThrow('FILE_CONFLICT');
    expect(await readFile(path.join(f.source, 'a.txt'), 'utf8')).toBe('a');
    expect(await readFile(path.join(f.source, 'b.txt'), 'utf8')).toBe('changed');
  });

  test('创建、修改、删除都能按字节版本恢复，并保留缺失状态', async () => {
    const workspace = workspaceOf(f.source); const files = new WorkspaceFiles();
    const create: FileChange = { path: 'new.bin', before: version(null), after: version(Uint8Array.from([0, 1, 255])) };
    await files.transaction(workspace, async transaction => {
      await transaction.apply([create]);
      expect(await readFile(path.join(f.source, 'new.bin'))).toEqual(Buffer.from([0, 1, 255]));
      const current = await transaction.capture('new.bin');
      await transaction.apply([{ path: 'new.bin', before: current, after: version(Buffer.from('edited')) }]);
      expect(await readFile(path.join(f.source, 'new.bin'), 'utf8')).toBe('edited');
      const edited = await transaction.capture('new.bin');
      await transaction.apply([{ path: 'new.bin', before: edited, after: version(null) }]);
    });
    expect((await readFileVersion(path.join(f.source, 'new.bin'))).hash).toBeNull();
  });

  test('perform 最终对话 CAS 失败会回滚文件并保留历史', async () => {
    await f.store.createConversation(metadata('cas'));
    const state = await f.store.readConversationState('cas'); const workspace = workspaceOf(f.source); const files = new WorkspaceFiles();
    const before = version(null); const after = version(Buffer.from('written'));
    let firstApply = true;
    const operation = new WorkspaceChanges(f.store, files);
    await expect(files.transaction(workspace, async real => operation.perform({
      ...real,
      apply: async changes => {
        await real.apply(changes);
        if (firstApply) { firstApply = false; const latest = await f.store.readConversationState('cas'); await f.store.saveMetadata({ ...latest.metadata, title: 'raced' }); }
      },
    }, workspace, state, [{ path: 'cas.txt', before, after }]))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await readFileVersion(path.join(f.source, 'cas.txt'))).hash).toBeNull();
    expect((await f.store.readConversationState('cas')).metadata.title).toBe('raced');
    expect(await f.store.getRecord(operationNamespace, 'cas')).toBeNull();
  });

  test('recover 会回滚 prepared 中部分已写文件，外部未知修改不会被覆盖并阻止后续写入', async () => {
    await f.store.createConversation(metadata('recover'));
    const workspace = workspaceOf(f.source); const files = new WorkspaceFiles(); const changes: FileChange[] = [
      { path: 'one.txt', before: version(null), after: version(Buffer.from('one')) },
      { path: 'two.txt', before: version(null), after: version(Buffer.from('two')) },
    ];
    await writeFile(path.join(f.source, 'one.txt'), 'one');
    const prepared: WorkspaceOperation = { id: 'prepared', conversationId: 'recover', workspace, createdAt: Date.now(), changes };
    await f.store.putRecord({ namespace: operationNamespace, id: 'recover', ownerId: 'recover', value: prepared });
    const result = await new WorkspaceChanges(f.store, files).recover();
    expect(result.recovered).toEqual(['prepared']);
    expect((await readFileVersion(path.join(f.source, 'one.txt'))).hash).toBeNull();
    expect((await readFileVersion(path.join(f.source, 'two.txt'))).hash).toBeNull();
  });

  test('recover 遇到外部未知修改会拒绝覆盖，并阻止新的写入', async () => {
    await f.store.createConversation(metadata('conflict-recover'));
    const workspace = workspaceOf(f.source); const files = new WorkspaceFiles();
    const prepared: WorkspaceOperation = { id: 'prepared-conflict', conversationId: 'conflict-recover', workspace, createdAt: Date.now(), changes: [
      { path: 'one.txt', before: version(null), after: version(Buffer.from('tool')) },
    ] };
    await writeFile(path.join(f.source, 'one.txt'), 'someone-else');
    await f.store.putRecord({ namespace: operationNamespace, id: 'conflict-recover', ownerId: 'conflict-recover', value: prepared });
    const result = await new WorkspaceChanges(f.store, files).recover();
    expect(result.conflicts).toHaveLength(1);
    expect(await readFile(path.join(f.source, 'one.txt'), 'utf8')).toBe('someone-else');
    await expect(files.transaction(workspace, async () => {})).rejects.toThrow('WORKSPACE_RECOVERY_REQUIRED');
    await expect(f.store.commitConversation({ conversationId: 'conflict-recover', expectedRevision: 0, messages: [] })).rejects.toMatchObject({ code: 'STORAGE_BUSY' });
  });

  test('活跃 journal 阻止新的历史变更，脏编辑也不会被文件操作覆盖', async () => {
    await f.store.createConversation(metadata('busy'));
    const workspace = workspaceOf(f.source); const files = new WorkspaceFiles();
    const prepared: WorkspaceOperation = { id: 'busy-operation', conversationId: 'busy', workspace, createdAt: Date.now(), changes: [] };
    await f.store.putRecord({ namespace: operationNamespace, id: 'busy', ownerId: 'busy', value: prepared });
    await expect(f.store.commitConversation({ conversationId: 'busy', expectedRevision: 0, messages: [] })).rejects.toMatchObject({ code: 'STORAGE_BUSY' });
    await writeFile(path.join(f.source, 'dirty.txt'), 'disk');
    const opened = await files.openDocument(workspace, 'dirty.txt', 'client');
    await files.updateDocument(workspace, 'dirty.txt', 'client', 'local draft', opened.version);
    await expect(files.write(workspace, 'dirty.txt', 'tool overwrite', opened.baseHash)).rejects.toThrow('DOCUMENT_DIRTY');
    expect(await readFile(path.join(f.source, 'dirty.txt'), 'utf8')).toBe('disk');
  });
});
