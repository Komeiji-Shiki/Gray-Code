import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PlatformStorage } from '@graycode/core';
import type { AppSettings, BackupCategoryId } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { DesktopPortableProfile } from '../../../apps/desktop/src/portableProfile';
import { ApplicationBackups } from '../../../apps/server/src/backups/service';
import { keySecretCodec } from '../../../apps/server/src/settings/environmentSecrets';
import { PlatformSkills } from '../../../apps/server/src/skills/service';
import { fixture, metadata, message } from './fixtures';

describe('备份恢复与便携配置的启动顺序', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication | undefined;
  let skills: jest.SpyInstance;
  const machineCodec = keySecretCodec(randomBytes(32));
  beforeEach(async () => {
    f = await fixture();
    await f.store.close();
    skills = jest.spyOn(PlatformSkills.prototype, 'export').mockResolvedValue([]);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    skills.mockRestore();
    await f.cleanup();
  });

  test.each<{
    name: string; category?: BackupCategoryId; conflict?: 'keep' | 'replace'; expected: number;
    sourcePending?: boolean; currentPending?: boolean; removeCurrentSettings?: boolean; failures?: boolean;
  }>([
    { name: '完整恢复', expected: 17 },
    { name: '选择替换设置', category: 'settings', conflict: 'replace', expected: 17 },
    { name: '选择保留设置', category: 'settings', conflict: 'keep', expected: 27 },
    { name: '仅恢复会话', category: 'conversations', conflict: 'replace', expected: 27 },
    { name: '保留设置但目标尚无设置', category: 'settings', conflict: 'keep', removeCurrentSettings: true, expected: 17 },
    { name: '仅恢复元数据不采纳来源标记', category: 'other', conflict: 'replace', sourcePending: true, expected: 27 },
    { name: '恢复元数据保留本机未同步标记', category: 'other', conflict: 'replace', currentPending: true, expected: 23 },
    { name: '完整恢复写入失败后重新启动', failures: true, expected: 17 },
  ])('$name按实际恢复范围决定配置来源', async ({ category, conflict, expected,
    sourcePending, currentPending, removeCurrentSettings, failures }) => {
    const directory = path.join(f.root, 'portable-data');
    const options = { dataDirectory: f.data, secretCodec: machineCodec };
    app = await PlatformApplication.open({ ...options, configurationPersistence: new DesktopPortableProfile(directory) });
    const source = await app.product.draft();
    source.app.appearance.fontSize = 17;
    source.app.discord = { ...source.app.discord, enabled: false, autoConnect: true };
    await app.product.save(source);
    await app.storage.initializeConversation(metadata('restored-chat'), [message(0, '备份中的正文')]);
    if (sourcePending) await app.storage.putRecord({ namespace: 'portable-profile', id: 'main', value: { preferDatabase: true } });
    const backups = new ApplicationBackups(app.storage, { appVersion: '2.0.0-pre', secretCodec: machineCodec, notify() {} });
    const backup = path.join(f.root, 'settings.graycode-backup');
    await backups.export(backup);
    const current = await app.product.draft();
    current.app.appearance.fontSize = 23;
    await app.product.save(current);
    if (currentPending) await app.storage.putRecord({ namespace: 'portable-profile', id: 'main', value: { preferDatabase: true } });
    if (removeCurrentSettings) {
      await app.storage.deleteRecord('platform-settings', 'main');
      await app.storage.deleteRecord('product-settings', 'main');
    }
    const portableCodec = keySecretCodec(await fs.readFile(path.join(directory, 'profile.key')));
    const portableFile = path.join(directory, 'settings.enc');
    const external: { settings: Pick<AppSettings, 'appearance' | 'discord'> } = JSON.parse(
      await portableCodec.decrypt(await fs.readFile(portableFile)),
    );
    external.settings.appearance.fontSize = 27;
    await fs.writeFile(portableFile, await portableCodec.encrypt(JSON.stringify(external)));
    const prepared = await backups.prepareRestore(backup, undefined, { previewOnly: !!category });
    if (category) await backups.selectRestore({ mode: 'selective', categories: [{ id: category, conflict: conflict! }],
      expectedPreview: prepared.pending.preview!.fingerprint });
    await backups.restore.confirm();
    await app.close();
    app = undefined;
    await backups.restore.apply();

    if (failures) {
      const preserved = await fs.readFile(portableFile);
      const keyFile = path.join(directory, 'profile.key');
      const key = await fs.readFile(keyFile);
      await fs.unlink(keyFile);
      await expect(PlatformApplication.open({ ...options, configurationPersistence: new DesktopPortableProfile(directory) }))
        .rejects.toThrow('profile.key');
      expect(await fs.readFile(portableFile)).toEqual(preserved);
      await fs.writeFile(keyFile, key);
      const originalRename = fs.rename;
      const failure = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to === portableFile) throw new Error('fixture write failure');
        await originalRename(from, to);
      });
      try {
        await expect(PlatformApplication.open({ ...options, configurationPersistence: new DesktopPortableProfile(directory) }))
          .rejects.toThrow('便携配置写入失败');
      } finally { failure.mockRestore(); }
      expect(await fs.readFile(portableFile)).toEqual(preserved);
      const restored = await PlatformStorage.open(f.data);
      try {
        expect(await restored.getRecord('portable-profile', 'main')).toMatchObject({ preferDatabase: true });
        expect(await restored.getRecord('platform-settings', 'main')).toMatchObject({ appearance: { fontSize: 17 } });
      } finally { await restored.close(); }
    }

    // 模拟恢复目录已切换后进程退出，新的应用实例只能从持久状态确定配置来源。
    app = await PlatformApplication.open({ ...options, configurationPersistence: new DesktopPortableProfile(directory) });
    expect(app.settings.snapshot().settings.appearance.fontSize).toBe(expected);
    expect(app.settings.snapshot().settings.discord.autoConnect).toBe(expected !== 17);
    expect((await app.storage.readHistory('restored-chat')).messages[0].parts[0].text).toBe('备份中的正文');
    expect(await app.storage.getRecord('portable-profile', 'main')).not.toHaveProperty('preferDatabase');
    const saved: { settings: Pick<AppSettings, 'appearance' | 'discord'> } = JSON.parse(
      await portableCodec.decrypt(await fs.readFile(portableFile)),
    );
    expect(saved.settings.appearance.fontSize).toBe(expected);
    expect(saved.settings.discord.autoConnect).toBe(expected !== 17);
    if (failures) {
      await app.close();
      app = undefined;
      await backups.restore.apply();
      saved.settings.appearance.fontSize = 29;
      await fs.writeFile(portableFile, await portableCodec.encrypt(JSON.stringify(saved)));
      app = await PlatformApplication.open({ ...options, configurationPersistence: new DesktopPortableProfile(directory) });
      expect(app.settings.snapshot().settings.appearance.fontSize).toBe(29);
    }
  });

  test('完整恢复空设置后保存初始化的默认值，不重新导入旧便携设置', async () => {
    f.store = await PlatformStorage.open(f.data);
    const backup = path.join(f.root, 'empty.graycode-backup');
    await new ApplicationBackups(f.store, { appVersion: '2.0.0-pre', secretCodec: machineCodec, notify() {} }).export(backup);
    await f.store.close();
    const directory = path.join(f.root, 'portable-data');
    const options = { dataDirectory: f.data, secretCodec: machineCodec };
    app = await PlatformApplication.open({ ...options, configurationPersistence: new DesktopPortableProfile(directory) });
    const defaultSize = app.settings.snapshot().settings.appearance.fontSize;
    const current = await app.product.draft();
    current.app.appearance.fontSize = 27;
    await app.product.save(current);
    const backups = new ApplicationBackups(app.storage, { appVersion: '2.0.0-pre', secretCodec: machineCodec, notify() {} });
    await backups.prepareRestore(backup);
    await backups.restore.confirm();
    await app.close();
    app = undefined;
    await backups.restore.apply();
    app = await PlatformApplication.open({ ...options, configurationPersistence: new DesktopPortableProfile(directory) });
    expect(app.settings.snapshot().settings.appearance.fontSize).toBe(defaultSize);
    expect(await app.storage.getRecord('portable-profile', 'main')).not.toHaveProperty('preferDatabase');
  });
});
