import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
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

  test('cancelling a backup leaves an existing destination and the running database intact', async () => {
    await f.store.createConversation(metadata('alpha'));
    const destination = path.join(f.root, 'existing.graycode-backup'); await fs.writeFile(destination, 'previous backup');
    const backups = new ApplicationBackups(f.store, { appVersion: '2.0.0-pre', secretCodec: codec('device'), notify(progress) {
      if (progress.phase === 'resources') backups.cancel();
    } });
    await expect(backups.export(destination)).rejects.toThrow('已取消');
    expect(await fs.readFile(destination, 'utf8')).toBe('previous backup');
    expect(await f.store.getConversation('alpha')).not.toBeNull();
    expect((await fs.readdir(f.data)).some(name => name.startsWith('.backup-snapshot-'))).toBe(false);
    expect((await backups.status()).busy).toBe(false);
  });
});
