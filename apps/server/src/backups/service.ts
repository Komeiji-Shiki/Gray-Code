import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PlatformStorage } from '@graycode/core';
import type { BackupProgress, PendingBackupRestore, BackupRestoreSelection } from '@graycode/contracts';
import type { SecretCodec } from '../settings/service';
import { captureDirectory } from '../migration/directoryCapture';
import { writeBackupArchive, extractBackupArchive } from './archive';
import { BackupRestoreState } from './restore';
import { restoreCatalog, selectBackupRestore } from './catalog';
import { validateBackupResources, pauseRestoredActivities } from './resources';

interface BackupOptions {
  appVersion: string;
  secretCodec: SecretCodec;
  skillsDirectory?: string;
  notify(progress: BackupProgress): void;
}
const fileName = (name: string) => name.includes('\\') ? path.win32.basename(name) : path.basename(name);
const botDirectory = (ownerId: string) => path.join('bot-documents', createHash('sha256').update(ownerId).digest('hex'));
const exists = async (file: string) => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export class ApplicationBackups {
  readonly restore: BackupRestoreState;
  private controller?: AbortController;
  private operation?: Promise<unknown>;
  private progress?: BackupProgress;
  private lastNotice = 0;
  constructor(private readonly storage: PlatformStorage, private readonly options: BackupOptions) {
    this.restore = new BackupRestoreState(storage.directory);
  }
  get busy() { return !!this.controller; }
  async status() { return { busy: this.busy, progress: this.progress, ...await this.restore.get() }; }
  cancel() { this.controller?.abort(new Error('已取消备份操作。')); }
  async close() { this.cancel(); await this.operation?.catch(() => {}); }
  async cancelRestore() { await this.close(); await this.restore.cancel(); }
  private publish(value: BackupProgress) {
    const previous = this.progress; this.progress = value;
    // 完成通知在临时文件清理和忙碌状态解除后发送，窗口关闭策略才能正确判断是否退出。
    if (['ready', 'error', 'cancelled'].includes(value.phase)) return;
    if (previous?.phase === value.phase && value.processedBytes !== undefined && Date.now() - this.lastNotice < 100) return;
    this.lastNotice = Date.now(); this.options.notify(value);
  }
  private run<T>(operation: 'export' | 'restore', action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controller) return Promise.reject(new Error('另一个备份或恢复操作正在进行。'));
    const controller = new AbortController(); this.controller = controller;
    const running = action(controller.signal).catch(error => {
      this.publish({ operation, phase: controller.signal.aborted ? 'cancelled' : 'error', message: String((error as Error).message ?? error) });
      throw error;
    }).finally(() => {
      this.controller = undefined; this.operation = undefined;
      if (this.progress) this.options.notify(this.progress);
    });
    this.operation = running; return running;
  }
  export(destination: string, password?: string) {
    return this.run('export', async signal => {
      if (!path.isAbsolute(destination)) throw new Error('请选择完整的备份文件路径。');
      const resolved = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
      const relative = path.relative(await fs.realpath(this.storage.directory), resolved);
      if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        throw new Error('请将备份保存到程序数据目录之外。');
      let snapshotDirectory: string | undefined;
      const temporary = path.join(path.dirname(destination), `.graycode-backup-${randomUUID()}.tmp`);
      try {
        this.publish({ operation: 'export', phase: 'snapshot', message: '正在生成数据库与附件快照…' });
        const snapshot = await this.storage.backupSnapshot(); snapshotDirectory = snapshot.directory;
        signal.throwIfAborted();
        this.publish({ operation: 'export', phase: 'resources', message: '正在收集本地技能与机器人文档…' });
        const captured = await PlatformStorage.open(snapshot.directory);
        let credentials: Record<string, string> | undefined;
        try {
          for (const id of await captured.listRecords('bot-documents')) {
            signal.throwIfAborted();
            const record = await captured.getRecord('bot-documents', id) as { path: string };
            const [ownerId] = JSON.parse(id) as string[];
            const relative = path.join(botDirectory(ownerId), fileName(record.path));
            const current = path.join(this.storage.directory, relative);
            const source = await exists(current) ? current : record.path;
            const before = await fs.stat(source);
            await fs.mkdir(path.dirname(path.join(snapshot.directory, relative)), { recursive: true });
            await fs.copyFile(source, path.join(snapshot.directory, relative));
            const after = await fs.stat(source);
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
              throw new Error(`备份期间机器人附件发生变化：${fileName(source)}`);
          }
          if (password) {
            credentials = {};
            for (const id of await captured.listRecords('platform-secrets')) {
              signal.throwIfAborted();
              const value = await captured.getRecord('platform-secrets', id) as { encrypted: Uint8Array };
              credentials[id] = await this.options.secretCodec.decrypt(value.encrypted);
            }
          }
          await captured.checkpoint();
        } finally { await captured.close(); }
        for (const name of ['skills', 'user-skills', 'skill-resources']) {
          const source = path.join(this.storage.directory, name);
          if (await exists(source)) await captureDirectory(source, path.join(snapshot.directory, name), signal);
        }
        if (this.options.skillsDirectory && await exists(this.options.skillsDirectory)) {
          // 外部技能原件保留在原目录；备份副本在恢复后作为本平台的技能来源。
          const target = path.join(snapshot.directory, 'user-skills', 'graycode');
          if (await exists(target)) await fs.rm(target, { recursive: true });
          await captureDirectory(this.options.skillsDirectory, target, signal);
        }
        signal.throwIfAborted();
        const reviewed = await PlatformStorage.open(snapshot.directory);
        let resources;
        try {
          await validateBackupResources(reviewed);
          resources = (await restoreCatalog(reviewed, reviewed)).preview.categories.map(category => ({ id: category.id, version: 1 as const, count: category.count }));
        } finally { await reviewed.close(); }
        const manifest = await writeBackupArchive({ directory: snapshot.directory, destination: temporary, password, credentials, signal,
          manifest: { format: 'graycode-backup', version: 2, resources, createdAt: snapshot.createdAt, appVersion: this.options.appVersion,
            schemaVersion: snapshot.statistics.schemaVersion, sourceDirectory: this.storage.directory, credentials: password ? 'password' : 'device',
            conversations: snapshot.statistics.conversations, messages: snapshot.statistics.messages,
            exclusions: ['项目源码与项目技能', '共享 .agents / .limcode 技能目录', '可重新下载的运行依赖与词表缓存', '浏览器网站登录状态与缓存', '未保存的编辑和设置、运行中的进程'] },
          progress: (processedBytes, totalBytes, filePath) => this.publish({ operation: 'export', phase: 'archive', message: '正在打包备份…', processedBytes, totalBytes, filePath }) });
        signal.throwIfAborted();
        await fs.rename(temporary, destination);
        this.publish({ operation: 'export', phase: 'ready', message: '程序数据备份已完成。', filePath: destination });
        return { success: true, filePath: destination, manifest };
      } finally {
        await fs.rm(temporary, { force: true });
        if (snapshotDirectory) await fs.rm(snapshotDirectory, { recursive: true, force: true });
      }
    });
  }
  previewRestore() {
    return this.run('restore', async signal => {
      const pending = await this.restore.preserveSource();
      const source = await PlatformStorage.open(pending.importPath!);
      try {
        const catalog = await restoreCatalog(source, this.storage, pending.preview?.migrations, pending.unavailableCredentials);
        signal.throwIfAborted(); pending.preview = catalog.preview; pending.selection = undefined; pending.error = undefined; pending.requiresSelection = true;
        await this.restore.update(pending); return { success: true, pending };
      } finally { await source.close(); }
    });
  }
  selectRestore(selection: BackupRestoreSelection) {
    return this.run('restore', async signal => {
      const pending = await this.restore.preserveSource();
      const source = await PlatformStorage.open(pending.importPath!);
      try {
        const catalog = await restoreCatalog(source, this.storage, pending.preview?.migrations, pending.unavailableCredentials);
        const plan = selectBackupRestore(catalog, selection); signal.throwIfAborted();
        pending.preview = catalog.preview; pending.selection = plan; pending.error = undefined; pending.requiresSelection = true;
        await this.restore.update(pending);
        this.publish({ operation: 'restore', phase: 'ready', message: '恢复范围已准备，请查看最终预览后确认重启。' });
        return { success: true, pending };
      } finally { await source.close(); }
    });
  }
  prepareRestore(source: string, password?: string, options: { previewOnly?: boolean } = {}) {
    return this.run('restore', async signal => {
      let pending: PendingBackupRestore | undefined;
      let scheduled = false;
      try {
        pending = await this.restore.prepare();
        this.publish({ operation: 'restore', phase: 'verify', message: '正在读取并校验备份…' });
        const result = await extractBackupArchive({ source, directory: pending.stagingPath, password, signal,
          progress: (processedBytes, totalBytes, filePath) => this.publish({ operation: 'restore', phase: 'verify', message: '正在校验备份文件…', processedBytes, totalBytes, filePath }) });
        signal.throwIfAborted();
        const restored = await PlatformStorage.open(pending.stagingPath);
        const unavailableCredentials: string[] = [];
        const migrations = result.manifest.version === 1 ? ['旧版清单已补全资源分类与版本信息。'] : [];
        try {
          const statistics = await restored.statistics();
          const checked = await restored.verify();
          if (!checked.ok) throw new Error(`备份数据库未通过校验：${checked.issues.slice(0, 3).join('；')}`);
          if (statistics.conversations !== result.manifest.conversations || statistics.messages !== result.manifest.messages)
            throw new Error('备份中的会话数量与清单不一致。');
          await validateBackupResources(restored, result.manifest);
          if (result.manifest.resources) {
            const actual = (await restoreCatalog(restored, restored)).preview.categories;
            if (result.manifest.resources.length !== actual.length || new Set(result.manifest.resources.map(item => item.id)).size !== actual.length
              || result.manifest.resources.some(item => actual.find(category => category.id === item.id)?.count !== item.count)) throw new Error('备份资源数量与清单不一致。');
          }
          for (const id of await restored.listRecords('platform-secrets')) {
            signal.throwIfAborted();
            const value = await restored.getRecord('platform-secrets', id) as { encrypted: Uint8Array };
            if (result.credentials && Object.hasOwn(result.credentials, id)) {
              await restored.putRecord({ namespace: 'platform-secrets', id, value: { encrypted: await this.options.secretCodec.encrypt(result.credentials[id]) } });
            } else {
              try { await this.options.secretCodec.decrypt(value.encrypted); }
              catch {
                if (!options.previewOnly) throw new Error('此备份的密钥受原电脑或原应用配置保护。请在原电脑设置备份密码后重新导出，再跨设备恢复。');
                unavailableCredentials.push(id);
              }
            }
          }
          for (const id of await restored.listRecords('bot-documents')) {
            const record = await restored.getRecord('bot-documents', id) as { path: string };
            const [ownerId] = JSON.parse(id) as string[];
            await restored.putRecord({ namespace: 'bot-documents', id, ownerId,
              value: { ...record, path: path.join(this.storage.directory, botDirectory(ownerId), fileName(record.path)) } });
          }
          // 仅恢复程序数据时，不重放旧文件事务，避免回滚当前项目里的实际源码。
          for (const id of await restored.listRecords('workspace-operations')) {
            const record = await restored.getRecord('workspace-operations', id);
            await restored.commitRecords([{ namespace: 'backup-workspace-operations', id, ownerId: id, value: record },
              { namespace: 'workspace-operations', id, delete: true }]);
          }
          await pauseRestoredActivities(restored);
          migrations.push('从备份恢复的自动任务、Bot 自动连接和执行设备入口保持暂停；临时登录会话与未完成记忆整理不继续执行。');
          const catalog = await restoreCatalog(restored, this.storage, migrations, unavailableCredentials);
          pending.preview = catalog.preview; pending.requiresSelection = options.previewOnly === true; pending.unavailableCredentials = unavailableCredentials;
          await restored.checkpoint();
        } finally { await restored.close(); }
        signal.throwIfAborted();
        Object.assign(pending, { backupCreatedAt: result.manifest.createdAt, conversations: result.manifest.conversations, messages: result.manifest.messages });
        await this.restore.schedule(pending); scheduled = true;
        this.publish({ operation: 'restore', phase: 'ready', message: options.previewOnly ? '备份已校验，请选择恢复范围并查看最终预览。' : '备份已校验。重启后应用，当前数据将完整保留。', filePath: source });
        return { success: true, pending, manifest: result.manifest };
      } finally { if (pending && !scheduled) await fs.rm(pending.stagingPath, { recursive: true, force: true }); }
    });
  }
}
