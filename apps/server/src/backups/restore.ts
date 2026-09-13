import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { PendingBackupRestore } from '@graycode/contracts';
import {preserveMemoryDeletions} from './memoryDeletion';
import { preserveNodeRevocations } from './nodeRevocations';

interface RestoreState {
  version: 1;
  pending?: PendingBackupRestore;
  lastRestore?: { completedAt: number; backupCreatedAt: number; previousPath: string };
}
const exists = async (file: string) => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

/** 切换记录位于数据目录之外，两个重命名之间中断后仍能在下次启动继续。 */
export class BackupRestoreState {
  readonly filename: string;
  constructor(readonly directory: string) {
    const id = createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16);
    this.filename = path.join(path.dirname(directory), `.graycode-restore-${id}.json`);
  }
  async get(): Promise<RestoreState> {
    try {
      const value = JSON.parse(await fs.readFile(this.filename, 'utf8')) as RestoreState;
      if (value.version !== 1) throw new Error('恢复记录版本无效。');
      if (value.pending) this.validate(value.pending);
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }; throw error; }
  }
  private validate(value: PendingBackupRestore) {
    const parent = path.dirname(this.directory);
    if (parent === this.directory) throw new Error('不能将磁盘根目录整体替换为备份，请先使用独立的数据目录。');
    if (!/^[a-f0-9-]{36}$/.test(value.id) || value.sourcePath !== this.directory ||
      value.stagingPath !== path.join(parent, `.graycode-restored-${value.id}`) ||
      value.previousPath !== `${this.directory}.before-restore-${value.id}`) throw new Error('恢复记录的目录归属无效。');
  }
  private async save(value: RestoreState) {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporary, this.filename);
  }
  async prepare(): Promise<PendingBackupRestore> {
    if (path.dirname(this.directory) === this.directory) throw new Error('不能将磁盘根目录整体替换为备份，请先使用独立的数据目录。');
    if ((await this.get()).pending) throw new Error('已有等待重启的恢复，请先完成或取消。');
    const id = randomUUID();
    const value = { id, createdAt: Date.now(), sourcePath: this.directory,
      stagingPath: path.join(path.dirname(this.directory), `.graycode-restored-${id}`),
      previousPath: `${this.directory}.before-restore-${id}`, backupCreatedAt: 0, conversations: 0, messages: 0 };
    await fs.mkdir(value.stagingPath, { mode: 0o700 });
    return value;
  }
  async schedule(pending: PendingBackupRestore) {
    this.validate(pending);
    const state = await this.get();
    if (state.pending) throw new Error('已有等待重启的恢复。');
    await fs.writeFile(path.join(pending.stagingPath, 'backup-origin.json'), JSON.stringify({ id: pending.id }), { flag: 'wx', mode: 0o600 });
    await this.save({ ...state, pending });
  }
  async cancel() {
    const state = await this.get();
    if (!state.pending) return;
    if (await exists(state.pending.previousPath)) throw new Error('恢复已开始切换，请重新启动应用完成恢复。');
    await fs.rm(state.pending.stagingPath, { recursive: true, force: true });
    await this.save({ ...state, pending: undefined });
  }
  async confirm() {
    const state = await this.get();
    if (!state.pending) throw new Error('没有准备好的恢复数据。');
    await this.save({ ...state, pending: { ...state.pending, confirmed: true } });
  }
  async apply() {
    const state = await this.get(), pending = state.pending;
    if (!pending?.confirmed) return state;
    const marker = async (root: string) => {
      try { return JSON.parse(await fs.readFile(path.join(root, 'backup-origin.json'), 'utf8')).id === pending.id; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    };
    if (!await marker(this.directory)) {
      if (!await marker(pending.stagingPath)) throw new Error('准备好的恢复数据不存在，当前数据未替换。');
      const currentDirectory=await exists(this.directory)?this.directory:pending.previousPath;
      if(!await exists(currentDirectory))throw new Error('恢复前的数据目录不存在，不能保留当前删除状态。');
      await preserveMemoryDeletions(currentDirectory,pending.stagingPath);
      await preserveNodeRevocations(currentDirectory,pending.stagingPath);
      if (await exists(this.directory)) {
        if (await exists(pending.previousPath)) throw new Error('恢复前目录已存在，当前数据未覆盖。');
        await fs.rename(this.directory, pending.previousPath);
      } else if (!await exists(pending.previousPath)) throw new Error('恢复前的数据目录不存在，不能继续切换。');
      await fs.rename(pending.stagingPath, this.directory);
    }
    const complete: RestoreState = { version: 1, lastRestore: { completedAt: Date.now(), backupCreatedAt: pending.backupCreatedAt, previousPath: pending.previousPath } };
    await this.save(complete);
    return complete;
  }
}
