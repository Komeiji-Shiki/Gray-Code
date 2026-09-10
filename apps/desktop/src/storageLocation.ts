import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { captureDirectory } from '../../server/src/migration/directoryCapture';
interface LocationState { version: 1; currentPath: string; previousPaths?: Record<string, string>; preservedDirectories?: string[]; pendingMigration?: { sourcePath: string; targetPath: string; stagingPath: string; backupPath?: string; createdAt: number }; }
/** 迁移安排在下一次启动、数据库打开之前执行；旧目录始终保留。 */
export class DesktopStorageLocation {
  private state: LocationState;
  private readonly filename: string;
  constructor(userData: string, readonly defaultPath: string, private readonly explicitPath?: string) {
    this.filename = path.join(userData, 'storage-location.json');
    this.state = { version: 1, currentPath: explicitPath ?? defaultPath };
  }
  private async save(state: LocationState) {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, this.filename); this.state = state;
  }
  private overlaps(left: string, right: string) {
    const relative = path.relative(path.resolve(left), path.resolve(right));
    return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  async validate(target: unknown) {
    if (this.explicitPath) return { valid: false, error: '当前使用 --data 指定数据目录，请移除该启动参数后通过界面迁移。' };
    if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) === path.parse(path.resolve(target)).root)
      return { valid: false, error: '请选择完整的数据目录路径，不能使用磁盘根目录。' };
    const destination = path.resolve(target);
    if (this.overlaps(this.state.currentPath, destination) || this.overlaps(destination, this.state.currentPath))
      return { valid: false, error: '新目录必须与当前目录相互独立。' };
    try {
      const info = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (info && (!info.isDirectory() || info.isSymbolicLink() || (await fs.readdir(destination)).length && !this.state.previousPaths?.[destination])) return { valid: false, error: '请选择空目录，现有内容不会被覆盖。' };
      let parent = destination;
      while (!(await fs.stat(parent).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }))) parent = path.dirname(parent);
      await fs.access(parent, constants.W_OK);
      return { valid: true };
    } catch (error) { return { valid: false, error: String(error) }; }
  }
  async startup(): Promise<string> {
    if (this.explicitPath) return this.explicitPath;
    try {
      const value = JSON.parse(await fs.readFile(this.filename, 'utf8')) as LocationState;
      if (value.version !== 1 || !path.isAbsolute(value.currentPath)) throw new Error('存储目录配置无效。');
      this.state = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const pending = this.state.pendingMigration;
    if (!pending) return this.state.currentPath;
    if (path.resolve(pending.sourcePath) !== path.resolve(this.state.currentPath) || !path.isAbsolute(pending.targetPath) ||
      !path.isAbsolute(pending.stagingPath) || path.dirname(pending.stagingPath) !== path.dirname(pending.targetPath) || !/^\.graycode-move-[0-9a-f-]{36}$/.test(path.basename(pending.stagingPath)) ||
      this.overlaps(pending.stagingPath, pending.sourcePath) || this.overlaps(pending.sourcePath, pending.stagingPath) ||
      this.overlaps(pending.stagingPath, pending.targetPath) || this.overlaps(pending.targetPath, pending.stagingPath) ||
      this.overlaps(pending.sourcePath, pending.targetPath) || this.overlaps(pending.targetPath, pending.sourcePath)) throw new Error('待迁移路径无效，原目录未改变。');
    const signal = new AbortController().signal;
    // 未完成的副本由本迁移记录明确归属，只删除该临时目录。
    await fs.rm(pending.stagingPath, { recursive: true, force: true });
    await fs.mkdir(pending.stagingPath, { recursive: true });
    const captured = await captureDirectory(pending.sourcePath, pending.stagingPath, signal);
    const existing = await fs.readdir(pending.targetPath).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    if (existing.length) {
      // 若上次在发布目录后中断，内容完全一致才继续切换指针。
      const previous = await captureDirectory(pending.targetPath, undefined, signal);
      if (previous.fingerprint === captured.fingerprint) await fs.rm(pending.stagingPath, { recursive: true, force: true });
      else {
        const backup = pending.backupPath;
        if (previous.fingerprint !== this.state.previousPaths?.[pending.targetPath] || !backup || !path.isAbsolute(backup) ||
          path.dirname(backup) !== path.dirname(pending.targetPath) || !/^\.graycode-previous-[0-9a-f-]{36}$/.test(path.basename(backup)) ||
          this.overlaps(backup, pending.sourcePath) || this.overlaps(pending.sourcePath, backup) ||
          this.overlaps(backup, pending.targetPath) || this.overlaps(pending.targetPath, backup))
          throw new Error('目标目录已有不同内容，未覆盖；原数据和待迁移副本均保留。');
        if (await fs.lstat(backup).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) throw new Error('旧目录保留路径已被占用。');
        await fs.rename(pending.targetPath, backup);
        await fs.rename(pending.stagingPath, pending.targetPath);
      }
    } else {
      await fs.rmdir(pending.targetPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rename(pending.stagingPath, pending.targetPath);
    }
    const previousPaths = { ...this.state.previousPaths, [pending.sourcePath]: captured.fingerprint }; delete previousPaths[pending.targetPath];
    await this.save({ version: 1, currentPath: pending.targetPath, previousPaths,
      preservedDirectories: [...(this.state.preservedDirectories ?? []), ...(pending.backupPath ? [pending.backupPath] : [])] });
    return this.state.currentPath;
  }
  getConfig() {
    return { config: { customDataPath: path.resolve(this.state.currentPath) === path.resolve(this.defaultPath) ? undefined : this.state.currentPath,
      pendingMigration: this.state.pendingMigration }, defaultPath: this.defaultPath, effectivePath: this.state.currentPath, externallyConfigured: !!this.explicitPath };
  }
  async schedule(target: string) {
    const result = await this.validate(target); if (!result.valid) return { success: false, error: result.error };
    const targetPath = path.resolve(target);
    await this.save({ ...this.state, pendingMigration: { sourcePath: this.state.currentPath, targetPath,
      stagingPath: path.join(path.dirname(targetPath), `.graycode-move-${randomUUID()}`),
      ...(this.state.previousPaths?.[targetPath] ? { backupPath: path.join(path.dirname(targetPath), `.graycode-previous-${randomUUID()}`) } : {}), createdAt: Date.now() } });
    return { success: true, requiresReload: true };
  }
}
