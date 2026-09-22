import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PlatformApplication } from '../../server/src/application';
import type { SecretCodec } from '../../server/src/settings/service';
import { keySecretCodec } from '../../server/src/settings/environmentSecrets';
import { SettingsTransfer } from '../../server/src/settings/transfer';
import { DesktopPortableMemories } from './portableMemories';

/** 免安装程序默认携带配置；安装版和显式 --data 实例沿用各自的存储规则。 */
export function portableProfileDirectory(executable: string, packaged: boolean, explicitData: boolean): string | undefined {
  if (!packaged || explicitData) return undefined;
  const directory = path.dirname(executable);
  if (existsSync(path.join(directory, 'sq.version')) && existsSync(path.join(directory, '..', 'Update.exe'))) return undefined;
  return path.join(directory, 'portable-data');
}

const fingerprint = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** 只同步配置导出格式；历史、草稿、检查点和工作区位置始终留在本机数据库。 */
export class DesktopPortableProfile {
  private codec!: SecretCodec;
  private queue: Promise<void> = Promise.resolve();
  private readonly filename: string;
  private memories?: DesktopPortableMemories;
  constructor(readonly directory: string) { this.filename = path.join(directory, 'settings.enc'); }

  async initialize(application: PlatformApplication): Promise<void> {
    await this.loadSettings(application);
    this.memories = new DesktopPortableMemories(path.join(this.directory, 'memory-storage'));
    await this.memories.initialize(application);
  }

  async close(): Promise<void> { await this.memories?.close(); }

  private async loadSettings(application: PlatformApplication): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const bytes = await readFile(this.filename).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    const keyFile = path.join(this.directory, 'profile.key');
    let key = await readFile(keyFile).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (!key) {
      if (bytes) throw new Error('便携配置缺少 portable-data/profile.key，请恢复完整的便携配置目录。');
      key = randomBytes(32);
      await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 });
    }
    this.codec = keySecretCodec(key);
    if (!bytes) { await this.save(application); return; }
    const previous = await application.storage.getRecord('portable-profile', 'main') as { fingerprint: string; revision: number } | null;
    if (previous?.fingerprint === fingerprint(bytes) && previous.revision === application.settings.snapshot().revision) return;
    // 在启动后台任务之前导入；解密或校验失败时保留原文件，不以空配置覆盖。
    const value = JSON.parse(await this.codec.decrypt(bytes));
    const draft = await application.product.draft();
    const result = await new SettingsTransfer(application).import(draft, value, true);
    if (!result.success) throw new Error(`便携配置导入失败：${result.errors.join('；')}`);
    await application.product.save(draft);
    await this.remember(application, bytes);
  }

  save(application: PlatformApplication): Promise<void> {
    const operation = this.queue.catch(() => {}).then(async () => {
      const draft = await application.product.draft();
      const exported = await new SettingsTransfer(application).export(draft, true);
      // 机器授权、工作区路径和自动生成的对话目录不属于可携带的用户偏好。
      const { accounts, bindings, workspaces, botGuestAccountId, ...settings } = exported.settings;
      const { storagePath, ...features } = exported.features;
      const bytes = await this.codec.encrypt(JSON.stringify({ ...exported, settings, features }));
      const temporary = path.join(this.directory, `.settings-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.filename);
        await this.remember(application, bytes, draft.revision);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }).catch(error => {
      throw new Error(`配置已保存在本机，但便携配置写入失败，请确认目录可写后重新保存：${error instanceof Error ? error.message : String(error)}`);
    });
    this.queue = operation;
    return operation;
  }

  private async remember(application: PlatformApplication, bytes: Uint8Array, revision = application.settings.snapshot().revision): Promise<void> {
    await application.storage.putRecord({ namespace: 'portable-profile', id: 'main', value: {
      fingerprint: fingerprint(bytes), revision,
    } });
  }
}
