import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { UpdateManager } from 'velopack';
import { DesktopInstaller, confirmInstalledRecovery } from '../../../apps/desktop/src/installer';
import { BackupRestoreState } from '../../../apps/server/src/backups/restore';

jest.mock('velopack', () => ({ UpdateManager: jest.fn() }));

describe('安装版更新与配套数据回退', () => {
  let root: string, installed: string, data: string, profile: string;
  let downloadBytes: Buffer;
  let options: ConstructorParameters<typeof DesktopInstaller>[0];
  let installer: DesktopInstaller;
  const oldBytes = Buffer.from('current signed application package fixture');
  const bytes = Buffer.from('new application package fixture');
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const asset = { PackageId: 'GrayCode', Version: '2.0.0-pre.2', Type: 'Full', FileName: 'GrayCode-2.0.0-pre.2-win-x64-full.nupkg',
    SHA256: digest(bytes), SHA1: '', Size: bytes.length, NotesMarkdown: '', NotesHtml: '' };
  const manager = { getAppId: () => 'GrayCode', isPortable: () => false,
    checkForUpdatesAsync: jest.fn(), downloadUpdateAsync: jest.fn(), waitExitThenApplyUpdate: jest.fn() };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-installer-'));
    installed = path.join(root, 'installed'); data = path.join(root, 'data'); profile = path.join(root, 'profile');
    await fs.mkdir(path.join(installed, 'current'), { recursive: true });
    await fs.mkdir(path.join(installed, 'packages'));
    await fs.mkdir(data); await fs.mkdir(profile);
    await fs.writeFile(path.join(installed, 'current', 'sq.version'), '<package/>');
    await fs.writeFile(path.join(installed, 'current', 'GrayCode.exe'), 'current executable');
    await fs.writeFile(path.join(installed, 'Update.exe'), 'updater');
    await fs.writeFile(path.join(installed, 'packages', 'GrayCode-2.0.0-pre.1-full.nupkg'), oldBytes);
    downloadBytes = bytes;
    jest.clearAllMocks();
    (UpdateManager as unknown as jest.Mock).mockImplementation(() => manager);
    manager.checkForUpdatesAsync.mockResolvedValue({ TargetFullRelease: asset, DeltasToTarget: [], IsDowngrade: false });
    manager.downloadUpdateAsync.mockImplementation(async () => { await fs.writeFile(path.join(installed, 'packages', asset.FileName), downloadBytes);
      // 复现 SDK 下载完成后清理原安装包的行为，回退副本必须提前保存。
      await fs.rm(path.join(installed, 'packages', 'GrayCode-2.0.0-pre.1-full.nupkg'), { force: true }); });
    manager.waitExitThenApplyUpdate.mockImplementation(() => {});
    options = { executable: path.join(installed, 'current', 'GrayCode.exe'), userData: profile, dataDirectory: data, currentVersion: '2.0.0-pre.1',
      backup: jest.fn(async destination => { await fs.writeFile(destination, 'data backup'); }),
      assertCanRestart: jest.fn(async () => {}), confirm: jest.fn(async () => true),
      restore: jest.fn(async () => {
        const restore = new BackupRestoreState(data); const pending = await restore.prepare();
        await restore.schedule(pending); return pending.id;
      }), cancelRestore: jest.fn(() => new BackupRestoreState(data).cancel()),
      restart: jest.fn(async apply => apply()), restartArgs: ['--data', data], recoveryTemplate: path.resolve('resources/installer/restore-program.ps1'),
    };
    installer = new DesktopInstaller(options);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('校验失败只移除坏的下载缓存，当前安装和数据保持可用', async () => {
    downloadBytes = Buffer.from('corrupt');
    await expect(installer.prepare(path.join(root, 'feed'), asset.Version)).rejects.toThrow('校验失败');
    expect(await fs.readFile(options.executable, 'utf8')).toBe('current executable');
    expect(options.backup).not.toHaveBeenCalled(); expect(options.restart).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(installed, 'packages', asset.FileName))).rejects.toHaveProperty('code', 'ENOENT');
    downloadBytes = bytes;
    await expect(installer.prepare(path.join(root, 'feed'), asset.Version)).resolves.toMatchObject({ downloaded: true });
  });

  test('拒绝不匹配的发行版本，下载完成后跨重启保留待安装状态', async () => {
    await expect(installer.prepare(path.join(root, 'feed'), '9.0.0')).rejects.toThrow('不一致');
    expect(manager.downloadUpdateAsync).not.toHaveBeenCalled();
    await installer.prepare(path.join(root, 'feed'), asset.Version);
    expect(await new DesktopInstaller(options).status()).toMatchObject({ kind: 'installed', ready: { version: asset.Version } });
  });

  test('草稿和取消确认都阻止安装；真正安装前保留原程序与数据', async () => {
    await installer.prepare(path.join(root, 'feed'));
    (options.assertCanRestart as jest.Mock).mockRejectedValueOnce(new Error('尚未保存'));
    await expect(installer.apply()).rejects.toThrow('尚未保存');
    expect(options.confirm).not.toHaveBeenCalled();
    (options.confirm as jest.Mock).mockResolvedValueOnce(false);
    await expect(installer.apply()).resolves.toEqual({ cancelled: true });
    expect(options.backup).not.toHaveBeenCalled();
    await installer.apply();
    const recovery = (await installer.status()).recovery!;
    expect(await fs.readFile(recovery.packagePath)).toEqual(oldBytes);
    expect(await fs.readFile(recovery.backupPath, 'utf8')).toBe('data backup');
    expect(await fs.readFile(path.join(path.dirname(recovery.backupPath), 'Restore-GrayCode.cmd'), 'utf8')).toContain('restore-program.ps1');
    expect(manager.waitExitThenApplyUpdate).toHaveBeenCalledWith(expect.objectContaining({ TargetFullRelease: asset }), false, true, ['--data', data]);
    await expect(installer.apply()).rejects.toThrow('正在进行');
  });

  test('程序未退回目标版本时不切换旧数据，成功退回后才确认配套恢复', async () => {
    await installer.prepare(path.join(root, 'feed')); await installer.apply();
    const updated = new DesktopInstaller({ ...options, currentVersion: asset.Version });
    await updated.rollback();
    expect(options.backup).toHaveBeenCalledTimes(2);
    const restore = new BackupRestoreState(data);
    expect((await restore.get()).pending?.confirmed).toBeUndefined();
    await confirmInstalledRecovery(profile, options.executable, asset.Version, data);
    expect((await restore.get()).pending?.confirmed).toBeUndefined();
    await confirmInstalledRecovery(profile, options.executable, options.currentVersion, data);
    expect((await restore.get()).pending?.confirmed).toBe(true);
  });

  test('回退程序损坏时不准备恢复，更新器启动失败则取消已准备的恢复', async () => {
    await installer.prepare(path.join(root, 'feed')); await installer.apply();
    const updated = new DesktopInstaller({ ...options, currentVersion: asset.Version });
    const recovery = (await updated.status()).recovery!;
    await fs.writeFile(recovery.packagePath, 'corrupt');
    await expect(updated.rollback()).rejects.toThrow('校验失败');
    expect(options.restore).not.toHaveBeenCalled();
    await fs.writeFile(recovery.packagePath, oldBytes);
    manager.waitExitThenApplyUpdate.mockImplementationOnce(() => { throw new Error('updater cannot start'); });
    await expect(updated.rollback()).rejects.toThrow('updater cannot start');
    expect((await new BackupRestoreState(data).get()).pending).toBeUndefined();
  });

  test('准备恢复期间产生新草稿时取消本次恢复，保留正在使用的版本', async () => {
    await installer.prepare(path.join(root, 'feed')); await installer.apply();
    const originalRestore = options.restore; let dirty = false;
    const updated = new DesktopInstaller({ ...options, currentVersion: asset.Version,
      restore: async archive => { const id = await originalRestore(archive); dirty = true; return id; },
      assertCanRestart: async () => { if (dirty) throw new Error('新草稿尚未保存'); },
    });
    manager.waitExitThenApplyUpdate.mockClear();
    await expect(updated.rollback()).rejects.toThrow('尚未保存');
    expect(manager.waitExitThenApplyUpdate).not.toHaveBeenCalled();
    expect((await new BackupRestoreState(data).get()).pending).toBeUndefined();
  });

  test('数据位于安装目录时阻止会覆盖数据的更新', async () => {
    await fs.mkdir(path.join(installed, 'current', 'data'));
    const unsafe = new DesktopInstaller({ ...options, dataDirectory: path.join(installed, 'current', 'data') });
    await unsafe.prepare(path.join(root, 'feed'));
    await expect(unsafe.apply()).rejects.toThrow('安装目录之外');
    expect(options.backup).not.toHaveBeenCalled();
  });
});
