import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { PetResources } from '../../../apps/server/src/pets/resources';
import { petAnimations } from '../../../shared/petFormat';
import { PlatformStorage } from '@graycode/core';
import { ApplicationBackups } from '../../../apps/server/src/backups/service';
import { BackupRestoreState } from '../../../apps/server/src/backups/restore';
import { fixture, metadata, message } from './fixtures';

function codec(device: string) {
  return { encrypt: async (value: string) => Buffer.from(`${device}:${value}`), decrypt: async (value: Uint8Array) => {
    const text = Buffer.from(value).toString();
    if (!text.startsWith(`${device}:`)) throw new Error('different device');
    return text.slice(device.length + 1);
  } };
}

describe('application data backup and restore', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('captures a consistent live database and pins external attachments through later garbage collection', async () => {
    const bytes = randomBytes(1_200_000);
    await f.store.createConversation(metadata('alpha'));
    await f.store.appendHistory('alpha', [{ ...message(0), parts: [{ inlineData: { mimeType: 'application/octet-stream', data: bytes.toString('base64') } }] }]);
    const snapshotRequest = f.store.backupSnapshot();
    // 快照暂时占用写入线程时，正常并发读取应排队完成，不能因第 65 个请求而失败。
    const [snapshot, reads] = await Promise.all([snapshotRequest, Promise.all(Array.from({ length: 96 }, () => f.store.getConversation('alpha')))]);
    expect(reads.every(value => value?.id === 'alpha')).toBe(true);
    await f.store.deleteConversation('alpha'); await f.store.collectGarbage();
    const saved = await PlatformStorage.open(snapshot.directory);
    try {
      expect((await saved.readHistory('alpha')).messages[0].parts[0].inlineData).toEqual({ mimeType: 'application/octet-stream', data: bytes.toString('base64') });
      expect((await saved.verify()).ok).toBe(true);
      expect(await f.store.getConversation('alpha')).toBeNull();
    } finally { await saved.close(); }
  });

  test('restores an encrypted backup on a different codec, preserves previous data and resumes an interrupted directory switch', async () => {
    await f.store.createConversation(metadata('alpha')); await f.store.appendHistory('alpha', [message(0, '备份中的消息')]);
    await f.store.putRecord({ namespace: 'platform-secrets', id: 'example', value: { encrypted: await codec('device-a').encrypt('fixture-secret') } });
    await f.store.putRecord({ namespace: 'workspace-operations', id: 'alpha', value: { id: 'interrupted-file-write', original: '项目操作记录' } });
    const documentDirectory = path.join(f.data, 'bot-documents', createHash('sha256').update('alpha').digest('hex'));
    await fs.mkdir(documentDirectory, { recursive: true });
    await fs.writeFile(path.join(documentDirectory, 'note.txt'), '机器人附件正文');
    await f.store.putRecord({ namespace: 'bot-documents', id: JSON.stringify(['alpha', 'doc']), ownerId: 'alpha',
      value: { id: 'doc', name: 'note.txt', path: path.join(documentDirectory, 'note.txt'), sizeBytes: 21, encoding: 'utf-8' } });
    const skills = path.join(f.root, 'user-skills', 'example');
    await fs.mkdir(skills, { recursive: true }); await fs.writeFile(path.join(skills, 'SKILL.md'), '# 备份技能');
    const exporter = new ApplicationBackups(f.store, { appVersion: '2.0.0-pre', secretCodec: codec('device-a'), skillsDirectory: path.dirname(skills), notify() {} });
    const file = path.join(f.root, 'data.graycode-backup');
    const exported = await exporter.export(file, 'test-password');
    expect(exported.manifest.files.some(item => item.path.endsWith('/note.txt'))).toBe(true);
    expect(exported.manifest.files.some(item => item.path.endsWith('/SKILL.md'))).toBe(true);
    expect((await fs.readFile(file)).includes(Buffer.from('fixture-secret'))).toBe(false);
    await f.store.appendHistory('alpha', [message(1, '备份之后的消息')]);

    const targetPath = path.join(f.root, 'target'); let target = await PlatformStorage.open(targetPath);
    await target.createConversation(metadata('before-restore'));
    const importer = new ApplicationBackups(target, { appVersion: '2.0.0-pre', secretCodec: codec('device-b'), notify() {} });
    try {
      const result = await importer.prepareRestore(file, 'test-password');
      expect(await target.getConversation('before-restore')).not.toBeNull();
      await target.close();
      // 准备完成后普通重启仍不应用，只有用户最终确认才切换。
      expect((await importer.restore.apply()).pending).toBeDefined();
      await importer.restore.confirm();
      await fs.rename(targetPath, result.pending.previousPath);
      await new BackupRestoreState(targetPath).apply();
      target = await PlatformStorage.open(targetPath);
      expect((await target.readHistory('alpha')).messages.map(item => item.parts[0].text)).toEqual(['备份中的消息']);
      const secret = await target.getRecord('platform-secrets', 'example') as { encrypted: Uint8Array };
      expect(await codec('device-b').decrypt(secret.encrypted)).toBe('fixture-secret');
      expect(await target.listRecords('workspace-operations')).toEqual([]);
      expect(await target.getRecord('backup-workspace-operations', 'alpha')).toMatchObject({ id: 'interrupted-file-write' });
      const document = await target.getRecord('bot-documents', JSON.stringify(['alpha', 'doc'])) as { path: string };
      expect(document.path.startsWith(targetPath)).toBe(true);
      expect(await fs.readFile(document.path, 'utf8')).toBe('机器人附件正文');
      const previous = await PlatformStorage.open(result.pending.previousPath);
      try { expect(await previous.getConversation('before-restore')).not.toBeNull(); } finally { await previous.close(); }
    } finally { await target.close(); }
  });

  test('rejects wrong passwords and corrupt files before scheduling a restore', async () => {
    await f.store.createConversation(metadata('alpha'));
    const backups = new ApplicationBackups(f.store, { appVersion: '2.0.0-pre', secretCodec: codec('device'), notify() {} });
    const encrypted = path.join(f.root, 'encrypted.graycode-backup');
    await backups.export(encrypted, 'correct');
    await expect(backups.prepareRestore(encrypted, 'wrong')).rejects.toThrow('密码不正确');
    expect((await backups.status()).pending).toBeUndefined();
    const file = path.join(f.root, 'plain.graycode-backup'); await backups.export(file);
    const zip = new AdmZip(file), database = zip.readFile('data/platform.sqlite')!;
    database[20] ^= 1; zip.updateFile('data/platform.sqlite', database); zip.writeZip(file);
    await expect(backups.prepareRestore(file)).rejects.toThrow('备份校验失败');
    expect((await backups.status()).pending).toBeUndefined();
    expect(await f.store.getConversation('alpha')).not.toBeNull();
    expect((await fs.readdir(f.root)).some(name => name.startsWith('.graycode-restored-'))).toBe(false);
  });

  test('旧整库备份不能复活已忘记内容，准备恢复之后的删除也会保留',async()=>{
    const scope={id:'backup-memory-scope',actorId:'owner',kind:'personal' as const,realm:'real'},at=Date.now();
    await f.store.longMemoryWrite({scope,sources:[{id:'backup-source',expectedVersion:0,origin:'user',text:'仅用于恢复验证的临时记忆。',recordedAt:at}],records:[{
      id:'backup-fact',expectedVersion:0,kind:'fact',origin:'user',confidence:'confirmed',subject:'fixture',text:'仅用于恢复验证的临时记忆。',topic:['测试'],entities:[],recordedAt:at,validFrom:at,
      dependencies:[{kind:'source',id:'backup-source',version:1}],supersedes:[]}]});
    const backups=new ApplicationBackups(f.store,{appVersion:'2.0.0-pre',secretCodec:codec('device'),notify(){}});
    const file=path.join(f.root,'memory.graycode-backup');await backups.export(file);
    await backups.prepareRestore(file);
    await f.store.longMemoryWrite({scope,remove:[{kind:'record',id:'backup-fact',expectedVersion:1,action:'delete'}]});
    const before=await f.store.longMemoryDeletionState();
    await backups.restore.confirm();await f.store.close();await new BackupRestoreState(f.data).apply();
    f.store=await PlatformStorage.open(f.data);
    const archive=await f.store.longMemoryExport([scope]);expect(archive.records).toEqual([]);expect(archive.sources).toEqual([]);
    expect(archive.tombstones.find(item=>item.id==='backup-fact')?.at).toBe(before.tombstones.find(item=>item.id==='backup-fact')?.at);
    expect((await f.store.verify()).ok).toBe(true);
  });

  test('选择性恢复在实际切换时保留未选择会话的新修改和新建会话', async () => {
    await f.store.createConversation(metadata('source-chat')); await f.store.appendHistory('source-chat', [message(0, '来源会话')]);
    const backup = new ApplicationBackups(f.store, { appVersion: '2.0.0-pre', secretCodec: codec('same'), notify() {} });
    const file = path.join(f.root, 'selective.graycode-backup'); await backup.export(file);
    const targetPath = path.join(f.root, 'target'); let target = await PlatformStorage.open(targetPath);
    try {
      await target.createConversation(metadata('keep-chat')); await target.appendHistory('keep-chat', [message(0, '选择之前')]);
      const importer = new ApplicationBackups(target, { appVersion: '2.0.0-pre', secretCodec: codec('same'), notify() {} });
      const preview = await importer.prepareRestore(file, undefined, { previewOnly: true });
      await expect(importer.restore.confirm()).rejects.toThrow('选择恢复范围');
      await importer.selectRestore({ mode: 'selective', categories: [{ id: 'conversations', conflict: 'replace' }], expectedPreview: preview.pending.preview!.fingerprint });
      await target.appendHistory('keep-chat', [message(1, '最终预览后的新消息')]);
      await target.createConversation(metadata('new-after-preview'));
      await importer.restore.confirm(); await target.close(); await importer.restore.apply();
      target = await PlatformStorage.open(targetPath);
      expect((await target.readHistory('source-chat')).messages[0].parts[0].text).toBe('来源会话');
      expect((await target.readHistory('keep-chat')).messages.map(item => item.parts[0].text)).toEqual(['选择之前', '最终预览后的新消息']);
      expect(await target.getConversation('new-after-preview')).not.toBeNull();
      expect((await importer.restore.get()).pending).toBeUndefined();
    } finally { await target.close(); }
  });

  test('最终预览后修改所选对象时不切换数据，保留原库并返回重新选择', async () => {
    await f.store.createConversation(metadata('alpha')); await f.store.appendHistory('alpha', [message(0, '备份版本')]);
    const backups = new ApplicationBackups(f.store, { appVersion: '2.0.0-pre', secretCodec: codec('same'), notify() {} });
    const file = path.join(f.root, 'stale.graycode-backup'); await backups.export(file);
    const prepared = await backups.prepareRestore(file, undefined, { previewOnly: true });
    await backups.selectRestore({ mode: 'selective', categories: [{ id: 'conversations', conflict: 'replace' }], expectedPreview: prepared.pending.preview!.fingerprint });
    await f.store.appendHistory('alpha', [message(1, '必须保留的新编辑')]);
    await backups.restore.confirm(); await f.store.close(); const state = await backups.restore.apply();
    expect(state.pending?.confirmed).toBe(false); expect(state.pending?.selection).toBeUndefined(); expect(state.pending?.error).toContain('发生了变化');
    f.store = await PlatformStorage.open(f.data);
    expect((await f.store.readHistory('alpha')).messages.at(-1)?.parts[0].text).toBe('必须保留的新编辑');
    await backups.restore.cancel(); expect((await backups.restore.get()).pending).toBeUndefined();
  });

  test('不同保护器无法解密凭据时仍能选择恢复真实图集，旧清单迁移后保持资源校验', async () => {
    const width = 1536, height = 2288, pixels = Buffer.alloc(width * height * 4);
    for (let row = 0; row < 11; row++) for (let col = 0; col < 8; col++) {
      if (row < 9 && col >= petAnimations[row].frames && !(row === 0 && col === 6)) continue;
      pixels.set([140, 180, 220, 255], ((row * 208 + 70) * width + col * 192 + 80) * 4);
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const resource = await new PetResources(f.store).import({ entry: 'pet.json', files: [
      { path: 'pet.json', data: Buffer.from(JSON.stringify({ id: 'backup-fixture', displayName: '备份验证图集', spriteVersionNumber: 2, spritesheetPath: 'atlas.png' })).toString('base64') },
      { path: 'atlas.png', data: png.toString('base64') },
    ] });
    await f.store.putRecord({ namespace: 'platform-secrets', id: 'protected', value: { encrypted: await codec('device-a').encrypt('fixture-secret') } });
    await f.store.createConversation(metadata('not-selected'));
    const backup = new ApplicationBackups(f.store, { appVersion: '2.0.0-pre', secretCodec: codec('device-a'), notify() {} });
    const file = path.join(f.root, 'pet.graycode-backup'); const exported = await backup.export(file);
    expect(exported.manifest.version).toBe(2); expect(exported.manifest.resources?.find(item => item.id === 'pets')?.count).toBe(1);
    const zip = new AdmZip(file), manifest = JSON.parse(zip.readAsText('manifest.json')); manifest.version = 1; delete manifest.resources;
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest))); zip.writeZip(file);
    const targetPath = path.join(f.root, 'other-device'); let target = await PlatformStorage.open(targetPath);
    try {
      await target.createConversation(metadata('keep-current'));
      const importer = new ApplicationBackups(target, { appVersion: '2.0.0-pre', secretCodec: codec('device-b'), notify() {} });
      const prepared = await importer.prepareRestore(file, undefined, { previewOnly: true });
      expect(prepared.pending.preview?.unavailableCredentials).toEqual(['protected']); expect(prepared.pending.preview?.migrations[0]).toContain('旧版清单');
      await expect(importer.selectRestore({ mode: 'complete', expectedPreview: prepared.pending.preview!.fingerprint })).rejects.toThrow('解密');
      await importer.selectRestore({ mode: 'selective', categories: [{ id: 'pets', conflict: 'replace' }], expectedPreview: prepared.pending.preview!.fingerprint });
      await importer.restore.confirm(); await target.close(); await importer.restore.apply(); target = await PlatformStorage.open(targetPath);
      expect(Buffer.from((await new PetResources(target).file(resource.id, 'atlas.png')).bytes)).toEqual(png);
      expect(await target.getRecord('platform-secrets', 'protected')).toBeNull(); expect(await target.getConversation('not-selected')).toBeNull(); expect(await target.getConversation('keep-current')).not.toBeNull();
      expect((await target.verify()).ok).toBe(true);
    } finally { await target.close(); }
  });

  test('cancelling a backup leaves an existing destination and the running database intact', async () => {
    await f.store.createConversation(metadata('alpha'));
    const destination = path.join(f.root, 'existing.graycode-backup'); await fs.writeFile(destination, 'previous backup');
    const completedStates: boolean[] = [];
    const backups = new ApplicationBackups(f.store, { appVersion: '2.0.0-pre', secretCodec: codec('device'), notify(progress) {
      if (progress.phase === 'resources') backups.cancel();
      if (progress.phase === 'cancelled') completedStates.push(backups.busy);
    } });
    await expect(backups.export(destination)).rejects.toThrow('已取消');
    expect(await fs.readFile(destination, 'utf8')).toBe('previous backup');
    expect(await f.store.getConversation('alpha')).not.toBeNull();
    expect((await fs.readdir(f.data)).some(name => name.startsWith('.backup-snapshot-'))).toBe(false);
    expect((await backups.status()).busy).toBe(false);
    expect(completedStates).toEqual([false]);
  });
});
