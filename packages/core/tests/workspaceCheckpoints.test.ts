import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture, message, metadata } from './fixtures';

describe('workspace checkpoints application contract', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  const owner = { actorId: 'owner', clientId: 'checkpoint-test' };
  const workspace = () => app.workspace('owner', 'project', ['workspace_read', 'workspace_write']);

  beforeEach(async () => {
    f = await fixture();
    await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data });
    const settings = app.settings.snapshot();
    settings.settings.workspaces.push({ id: 'project', name: 'Fixture', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
  });

  afterEach(async () => { await app.close(); await f.cleanup(); });

  async function createConversation(id: string) {
    await app.storage.createConversation({ ...metadata(id), actorId: 'owner', workspaceId: 'project', workspaceUri: f.source });
  }

  test('全量 create/preview/restore 恢复文件字节，并默认保留快照后的未跟踪文件', async () => {
    await createConversation('full');
    await writeFile(path.join(f.source, 'tracked.bin'), Buffer.from([0, 1, 255]));
    const large = Buffer.alloc(40 * 1024, 0x7f);
    await writeFile(path.join(f.source, 'large.bin'), large);
    const checkpoint = await app.checkpoints.create('owner', 'full', { name: 'before-edit' });
    await writeFile(path.join(f.source, 'tracked.bin'), 'changed');
    await writeFile(path.join(f.source, 'untracked.txt'), 'keep me');
    const preview = await app.checkpoints.preview('owner', 'full', checkpoint.id);
    expect(preview.untrackedPaths).toContain('untracked.txt');
    const restored = await app.checkpoints.restore('owner', 'full', checkpoint.id);
    expect(restored.success).toBe(true);
    expect(await readFile(path.join(f.source, 'tracked.bin'))).toEqual(Buffer.from([0, 1, 255]));
    await writeFile(path.join(f.source, 'large.bin'), 'changed-large');
    const secondPreview = await app.checkpoints.preview('owner', 'full', checkpoint.id);
    await app.checkpoints.restore('owner', 'full', checkpoint.id, { previewId: secondPreview.previewId });
    expect(await readFile(path.join(f.source, 'large.bin'))).toEqual(large);
    expect(await readFile(path.join(f.source, 'untracked.txt'), 'utf8')).toBe('keep me');
  });

  test('preview 后工作区变化时拒绝确认删除未跟踪文件', async () => {
    await createConversation('stale-preview');
    await writeFile(path.join(f.source, 'tracked.txt'), 'base');
    const checkpoint = await app.checkpoints.create('owner', 'stale-preview');
    await writeFile(path.join(f.source, 'new.txt'), 'new');
    const preview = await app.checkpoints.preview('owner', 'stale-preview', checkpoint.id);
    await writeFile(path.join(f.source, 'new.txt'), 'changed after preview');
    await expect(app.checkpoints.restore('owner', 'stale-preview', checkpoint.id, {
      previewId: preview.previewId,
      deleteUntrackedFiles: true,
    })).rejects.toThrow('STALE_RESTORE_PREVIEW');
    expect(await readFile(path.join(f.source, 'new.txt'), 'utf8')).toBe('changed after preview');
  });

  test('partial affectedPaths 只恢复限定文件，并把显式 absent 路径恢复为缺失', async () => {
    await createConversation('partial');
    await writeFile(path.join(f.source, 'a.txt'), 'a0');
    await writeFile(path.join(f.source, 'b.txt'), 'b0');
    const checkpoint = await app.checkpoints.create('owner', 'partial', { affectedPaths: ['a.txt', 'missing.txt'] });
    expect(checkpoint.manifest.partial).toBe(true);
    expect(checkpoint.manifest.absentPaths.length).toBeGreaterThan(0);
    await app.files.write(workspace(), 'a.txt', 'a1', (await app.files.read(workspace(), 'a.txt')).hash);
    await app.files.write(workspace(), 'b.txt', 'b1', (await app.files.read(workspace(), 'b.txt')).hash);
    await writeFile(path.join(f.source, 'missing.txt'), 'created-after-checkpoint');
    await app.checkpoints.restore('owner', 'partial', checkpoint.id);
    expect(await readFile(path.join(f.source, 'a.txt'), 'utf8')).toBe('a0');
    expect(await readFile(path.join(f.source, 'b.txt'), 'utf8')).toBe('b1');
    await expect(readFile(path.join(f.source, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('脏编辑阻止检查点恢复，且历史和磁盘文件保持不变', async () => {
    await createConversation('dirty');
    await writeFile(path.join(f.source, 'draft.txt'), 'base');
    const checkpoint = await app.checkpoints.create('owner', 'dirty');
    await writeFile(path.join(f.source, 'draft.txt'), 'changed-on-disk');
    const opened = await app.files.openDocument(workspace(), 'draft.txt', owner.clientId);
    await app.files.updateDocument(workspace(), 'draft.txt', owner.clientId, 'unsaved draft', opened.version);
    const before = await app.storage.readConversationState('dirty');
    await expect(app.checkpoints.restore('owner', 'dirty', checkpoint.id)).resolves.toMatchObject({ success: false, error: 'DOCUMENT_DIRTY', dirtyFiles: ['draft.txt'] });
    expect(await readFile(path.join(f.source, 'draft.txt'), 'utf8')).toBe('changed-on-disk');
    expect((await app.storage.readConversationState('dirty')).history.revision).toBe(before.history.revision);
  });

  test('其他对话不能读取或恢复当前对话的检查点', async () => {
    await createConversation('one'); await createConversation('two');
    await writeFile(path.join(f.source, 'shared.txt'), 'base');
    const checkpoint = await app.checkpoints.create('owner', 'one');
    await expect(app.checkpoints.get('owner', 'two', checkpoint.id)).rejects.toThrow('不属于当前对话');
    await expect(app.checkpoints.restore('owner', 'two', checkpoint.id)).rejects.toThrow('不属于当前对话');
  });

  test('删除检查点清理清单与内容记录，被历史引用时拒绝、强制可删', async () => {
    await createConversation('deletable');
    await writeFile(path.join(f.source, 'gone.txt'), 'bye');
    const checkpoint = await app.checkpoints.create('owner', 'deletable');
    // 手动检查点 messageNodeId 为空或指向历史尾部；先验证强制删除链路。
    const forced = await app.checkpoints.delete('owner', 'deletable', checkpoint.id, { force: true });
    expect(forced.success).toBe(true);
    await expect(app.checkpoints.get('owner', 'deletable', checkpoint.id)).rejects.toThrow('不属于当前对话');
    expect(await app.checkpoints.list('owner', 'deletable')).toHaveLength(0);
  });

  test('引用保护：messageNodeId 仍在历史中时拒绝删除', async () => {
    await createConversation('protected');
    await app.storage.appendHistory('protected', [message(0)]);
    const state = await app.storage.readConversationState('protected');
    const nodeId = state.history.messages.at(-1)!.id!;
    await writeFile(path.join(f.source, 'p.txt'), 'v');
    const checkpoint = await app.checkpoints.create('owner', 'protected', { messageId: nodeId });
    expect(checkpoint.messageNodeId).toBe(nodeId);
    const reread = await app.checkpoints.get('owner', 'protected', checkpoint.id);
    expect(reread.messageNodeId).toBe(nodeId);
    await expect(app.checkpoints.delete('owner', 'protected', checkpoint.id)).rejects.toThrow('仍被历史或分支引用');
    await app.checkpoints.delete('owner', 'protected', checkpoint.id, { force: true });
    expect(await app.checkpoints.list('owner', 'protected')).toHaveLength(0);
  });

  test('清单外脏文件也阻止恢复', async () => {
    await createConversation('dirty-outside');
    await writeFile(path.join(f.source, 'a.txt'), 'a0');
    const checkpoint = await app.checkpoints.create('owner', 'dirty-outside', { affectedPaths: ['a.txt'] });
    expect(checkpoint.manifest.partial).toBe(true);
    await writeFile(path.join(f.source, 'outside.txt'), 'on-disk');
    const opened = await app.files.openDocument(await workspace(), 'outside.txt', owner.clientId);
    await app.files.updateDocument(await workspace(), 'outside.txt', owner.clientId, 'unsaved', opened.version);
    await expect(app.checkpoints.restore('owner', 'dirty-outside', checkpoint.id)).resolves.toMatchObject({ success: false, error: 'DOCUMENT_DIRTY', dirtyFiles: ['outside.txt'] });
    expect(await readFile(path.join(f.source, 'outside.txt'), 'utf8')).toBe('on-disk');
  });
});
