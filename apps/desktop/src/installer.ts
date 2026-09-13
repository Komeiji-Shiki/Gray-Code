import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { UpdateManager, type UpdateInfo, type VelopackAsset } from 'velopack';
import { compareVersions } from '../../../shared/updateVersion';
import { writeProgramRecovery } from './installerRecovery';
import { BackupRestoreState } from '../../server/src/backups/restore';

const updateChannel = 'win-x64';
const fileExists = (file: string) => fs.stat(file).then(value => value.isFile(), error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
export async function packageHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export interface DesktopRecovery {
  version: string;
  targetVersion: string;
  createdAt: string;
  packagePath: string;
  packageSha256: string;
  backupPath: string;
  backupSha256: string;
  dataDirectory: string;
}
interface InstallerState {
  format: 1;
  cachedCurrent?: { version: string; filePath: string; sha256: string };
  recovery?: DesktopRecovery;
  ready?: { source: string; update: UpdateInfo };
  transition?: { from: string; to: string; kind: 'update' | 'rollback'; startedAt: string; restoreId?: string };
}
interface InstallerOptions {
  executable: string;
  userData: string;
  dataDirectory: string;
  currentVersion: string;
  backup(destination: string): Promise<unknown>;
  assertCanRestart(restoreId?: string): Promise<void>;
  restore(archive: string): Promise<string>;
  cancelRestore(): Promise<void>;
  restart(apply: () => void): Promise<void>;
  confirm(message: string, detail: string): Promise<boolean>;
  restartArgs: string[];
  recoveryTemplate: string;
}

function updateDirectory(userData: string, root: string) {
  return path.join(userData, 'desktop-updates', createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16));
}

/** 只有程序已成功退回目标版本，才允许切换与该版本配套的数据。 */
export async function confirmInstalledRecovery(userData: string, executable: string, version: string, dataDirectory: string) {
  const filename = path.join(updateDirectory(userData, path.dirname(path.dirname(executable))), 'state.json');
  let saved: InstallerState;
  try { saved = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (saved.format !== 1 || saved.transition?.kind !== 'rollback' || saved.transition.to !== version
    || saved.recovery?.dataDirectory !== dataDirectory || !saved.transition.restoreId) return;
  const restore = new BackupRestoreState(dataDirectory);
  if ((await restore.get()).pending?.id === saved.transition.restoreId) await restore.confirm();
}

/** 原生安装器负责目录切换；应用负责草稿、数据快照与用户确认。 */
export class DesktopInstaller {
  private readonly root: string;
  private readonly directory: string;
  private readonly stateFile: string;
  private state: InstallerState = { format: 1 };
  private initialized?: Promise<void>;
  private busy = false;
  private restarting = false;
  private progress?: { phase: string; percent?: number };
  private installed = false;

  constructor(private readonly options: InstallerOptions) {
    this.root = path.dirname(path.dirname(options.executable));
    this.directory = updateDirectory(options.userData, this.root);
    this.stateFile = path.join(this.directory, 'state.json');
  }
  private initialize() {
    return this.initialized ??= (async () => {
      if (!await fileExists(path.join(path.dirname(this.options.executable), 'sq.version'))
        || !await fileExists(path.join(this.root, 'Update.exe'))) return;
      const manager = this.manager(path.join(this.root, 'packages'));
      if (manager.getAppId() !== 'GrayCode' || manager.isPortable()) return;
      this.installed = true;
      await fs.mkdir(this.directory, { recursive: true });
      try {
        const saved = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as InstallerState;
        if (saved.format !== 1) throw new Error('更新记录版本不受支持。');
        this.state = saved;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (this.state.ready && compareVersions(this.state.ready.update.TargetFullRelease.Version, this.options.currentVersion) <= 0) {
        this.state.ready = undefined;
        await this.save();
      }
    })();
  }
  private manager(source: string, downgrade = false) {
    return new UpdateManager(source, { ExplicitChannel: updateChannel, AllowVersionDowngrade: downgrade, MaximumDeltasBeforeFallback: 10 });
  }
  private async save() {
    const temporary = `${this.stateFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fs.rename(temporary, this.stateFile);
  }
  async status() {
    await this.initialize();
    return { kind: this.installed ? 'installed' : 'portable', currentVersion: this.options.currentVersion,
      rootDirectory: this.installed ? this.root : undefined, busy: this.busy || this.restarting, progress: this.progress,
      ready: this.state.ready ? { version: this.state.ready.update.TargetFullRelease.Version } : undefined,
      recovery: this.state.recovery, transition: this.state.transition,
      transitionResult: this.state.transition ? this.state.transition.to === this.options.currentVersion ? 'applied' : 'not-applied' : undefined };
  }
  private async run<T>(action: () => Promise<T>): Promise<T> {
    await this.initialize();
    if (!this.installed) throw new Error('当前为便携版，请下载安装包后使用应用内安装与回退。');
    if (this.busy || this.restarting) throw new Error('另一个更新操作正在进行。');
    this.busy = true;
    try { return await action(); }
    finally { this.busy = false; this.progress = undefined; }
  }
  async prepare(source: string, expectedVersion?: string) {
    return this.run(async () => {
      this.progress = { phase: 'checking' };
      const manager = this.manager(source);
      const update = await manager.checkForUpdatesAsync();
      if (!update) return { success: true, alreadyUpToDate: true };
      const asset = update.TargetFullRelease;
      if (asset.PackageId !== 'GrayCode' || asset.Type !== 'Full' || path.basename(asset.FileName) !== asset.FileName
        || /[\\/]/.test(asset.FileName) || !/^[a-f\d]{64}$/i.test(asset.SHA256) || asset.Size <= 0
        || expectedVersion && compareVersions(asset.Version, expectedVersion) !== 0)
        throw new Error('更新清单与 GrayCode 发行版本不一致，未下载或安装。');
      await this.preserveCurrentPackage();
      this.progress = { phase: 'downloading', percent: 0 };
      try { await manager.downloadUpdateAsync(update, percent => { this.progress = { phase: 'downloading', percent }; }); }
      catch (error) { throw new Error(`更新包下载或校验失败，请重新下载或选择完整的离线更新包。\n${String(error)}`); }
      await this.verifyAsset(asset);
      this.state.ready = { source, update };
      await this.save();
      return { success: true, downloaded: true, version: asset.Version, message: '更新包已下载并校验。保存编辑后，选择“重启并安装”。' };
    });
  }
  private async verifyAsset(asset: VelopackAsset) {
    const file = path.join(this.root, 'packages', asset.FileName);
    if ((await fs.stat(file)).size !== asset.Size || (await packageHash(file)).toLowerCase() !== asset.SHA256.toLowerCase()) {
      await fs.rm(file);
      throw new Error('更新包校验失败，当前程序和数据未被替换。请重新下载。');
    }
    return file;
  }
  private async assertExternalData() {
    const root = await fs.realpath(this.root);
    for (const directory of [this.options.dataDirectory, this.options.userData]) {
      const relative = path.relative(root, await fs.realpath(directory));
      if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        throw new Error('数据或用户配置位于安装目录内。请先将数据迁移到安装目录之外，再安装更新。');
    }
  }
  private async currentPackage() {
    const packages = path.join(this.root, 'packages');
    // 安装器会清理旧包，因此在更新前另存当前完整包，供离线回退使用。
    // Setup 首次保存的包省略渠道名，应用内下载保留发行清单中的渠道名。
    for (const name of [`GrayCode-${this.options.currentVersion}-${updateChannel}-full.nupkg`, `GrayCode-${this.options.currentVersion}-full.nupkg`]) {
      const file = path.join(packages, name);
      if (await fileExists(file)) return file;
    }
    throw new Error('未找到当前版本的完整安装包，无法建立回退点。请先用当前版本安装器修复安装。');
  }
  private async preserveCurrentPackage() {
    const saved = this.state.cachedCurrent;
    if (saved?.version === this.options.currentVersion && await fileExists(saved.filePath) && await packageHash(saved.filePath) === saved.sha256)
      return saved.filePath;
    const source = await this.currentPackage();
    const directory = path.join(this.directory, 'packages');
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, path.basename(source));
    const temporary = `${filePath}.tmp`;
    await fs.copyFile(source, temporary);
    const sha256 = await packageHash(temporary);
    await fs.rename(temporary, filePath);
    // SDK 下载成功后会清理原缓存，必须在下载之前保存独立的回退副本。
    this.state.cachedCurrent = { version: this.options.currentVersion, filePath, sha256 };
    await this.save();
    return filePath;
  }
  async apply() {
    return this.run(async () => {
      const ready = this.state.ready;
      if (!ready) throw new Error('请先下载并校验更新包。');
      await this.assertExternalData();
      await this.options.assertCanRestart();
      await this.verifyAsset(ready.update.TargetFullRelease);
      if (!await this.options.confirm(`重启并安装 GrayCode ${ready.update.TargetFullRelease.Version}？`,
        '安装前会备份当前数据，并保留当前程序包。后台连接与任务将停止，应用会在安装结束后重新打开。')) return { cancelled: true };
      this.progress = { phase: 'backup' };
      const point = await fs.mkdtemp(path.join(this.directory, 'recovery-'));
      const originalPackage = await this.preserveCurrentPackage();
      const packagePath = path.join(point, path.basename(originalPackage));
      const backupPath = path.join(point, 'before-update.graycode-backup');
      await fs.copyFile(originalPackage, packagePath);
      await this.options.backup(backupPath);
      await this.options.assertCanRestart();
      this.state.recovery = { version: this.options.currentVersion, targetVersion: ready.update.TargetFullRelease.Version,
        createdAt: new Date().toISOString(), packagePath, packageSha256: await packageHash(packagePath),
        backupPath, backupSha256: await packageHash(backupPath), dataDirectory: this.options.dataDirectory };
      await writeProgramRecovery(this.state.recovery, this.root, this.options.restartArgs, this.options.recoveryTemplate);
      this.state.transition = { from: this.options.currentVersion, to: ready.update.TargetFullRelease.Version, kind: 'update', startedAt: new Date().toISOString() };
      await this.save();
      const manager = this.manager(ready.source);
      await this.options.assertCanRestart();
      await this.options.restart(() => manager.waitExitThenApplyUpdate(ready.update, false, true, this.options.restartArgs));
      this.restarting = true;
      return { success: true, restarting: true };
    });
  }
  async rollback() {
    return this.run(async () => {
      const recovery = this.state.recovery;
      if (!recovery || recovery.version === this.options.currentVersion) throw new Error('当前没有可用的上一版本回退点。');
      await this.assertExternalData();
      if (path.resolve(recovery.dataDirectory) !== path.resolve(this.options.dataDirectory)) throw new Error('回退点属于另一数据目录。请切回原目录后重试。');
      await this.options.assertCanRestart();
      if (await packageHash(recovery.packagePath) !== recovery.packageSha256 || await packageHash(recovery.backupPath) !== recovery.backupSha256)
        throw new Error('回退程序包或数据备份校验失败，当前安装未改变。');
      if (!await this.options.confirm(`恢复 GrayCode ${recovery.version} 与更新前的数据？`,
        `将恢复 ${new Date(recovery.createdAt).toLocaleString()} 的数据。更新后的当前数据会先单独备份；已删除的记忆与已撤销的设备仍受恢复保护。恢复后需手动重新连接后台服务。`)) return { cancelled: true };
      this.progress = { phase: 'backup' };
      const currentBackup = path.join(path.dirname(recovery.backupPath), `before-rollback-${Date.now()}.graycode-backup`);
      await this.options.backup(currentBackup);
      await this.options.assertCanRestart();
      const restoreId = await this.options.restore(recovery.backupPath);
      try {
        const bytes = await fs.stat(recovery.packagePath);
        const asset: VelopackAsset = { PackageId: 'GrayCode', Version: recovery.version, Type: 'Full', FileName: path.basename(recovery.packagePath),
          SHA256: recovery.packageSha256, SHA1: '', Size: bytes.size, NotesMarkdown: '', NotesHtml: '' };
        await fs.copyFile(recovery.packagePath, path.join(this.root, 'packages', asset.FileName));
        this.state.ready = undefined;
        this.state.transition = { from: this.options.currentVersion, to: recovery.version, kind: 'rollback', startedAt: new Date().toISOString(), restoreId };
        await this.save();
        const manager = this.manager(path.dirname(recovery.packagePath), true);
        await this.options.assertCanRestart(restoreId);
        await this.options.restart(() => manager.waitExitThenApplyUpdate(asset, false, true, this.options.restartArgs));
        this.restarting = true;
        return { success: true, restarting: true, currentBackup };
      } catch (error) { await this.options.cancelRestore(); throw error; }
    });
  }
}
