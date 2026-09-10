import { captureDirectory as capture } from './directoryCapture';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { MigrationIssue, MigrationProgress } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

export interface RuntimeAssetReport { imported: string[]; skipped: string[]; consumed: string[]; issues: MigrationIssue[] }

/** 来源整目录保留，正式目录只在为空或内容完全相同时接收，不覆盖已有不同资源。 */
export async function importRuntimeAssets(app: PlatformApplication, actorId: string, source: string, signal: AbortSignal,
  onStatus?: (progress: MigrationProgress) => void): Promise<RuntimeAssetReport> {
  app.requireOwner(actorId);
  const report: RuntimeAssetReport = { imported: [], skipped: [], consumed: [], issues: [] };
  for (const name of ['dependencies', 'tokenizers'] as const) {
    signal.throwIfAborted();
    const original = path.join(source, name);
    try { await fs.lstat(original); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.issues.push({ path: original, code: 'IO_ERROR', message: String(error) });
      continue;
    }
    const operation = async () => {
      signal.throwIfAborted();
      const target = path.join(app.storage.directory, name);
      const staging = path.join(app.storage.directory, `.runtime-import-${randomUUID()}`);
      await fs.mkdir(staging);
      try {
        const captured = await capture(original, staging, signal, value => onStatus?.({ phase: 'runtimeAssets', detail: `复制${name === 'dependencies' ? '依赖' : '词表'}目录`, ...value }));
        onStatus?.({ phase: 'runtimeAssets', detail: '校验复制的资源', currentItem: original });
        if (name === 'tokenizers') await app.tokenizers.validateImportedDirectory(staging);
        let existing = false;
        try { existing = (await fs.readdir(target)).length > 0; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        signal.throwIfAborted();
        if (existing) {
          const current = await capture(target, undefined, signal, value => onStatus?.({ phase: 'runtimeAssets', detail: '核对目标已有资源', ...value }));
          if (current.fingerprint !== captured.fingerprint) throw new Error('新版目录已有不同内容，未覆盖；请保留来源，或在空的新数据目录中导入。');
        } else {
          // 只能移除经过确认的空目录，失败时来源和完整临时副本仍未替换正式资源。
          await fs.rmdir(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await fs.rename(staging, target);
        }
        const id = createHash('sha256').update(`${actorId}\0${source}\0${name}`).digest('hex');
        await app.storage.commitRecords([{ namespace: 'legacy-runtime-assets', id, ownerId: actorId,
          value: { name, source: original, fingerprint: captured.fingerprint, importedAt: Date.now() } }]);
        (existing ? report.skipped : report.imported).push(name); report.consumed.push(...captured.files);
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    };
    try {
      onStatus?.({ phase: 'runtimeAssets', detail: '等待正在进行的安装或词表下载结束', currentItem: original });
      if (name === 'dependencies') await app.dependencies.importDirectory(operation);
      else await app.tokenizers.importDirectory(operation);
    } catch (error) {
      signal.throwIfAborted();
      report.issues.push({ path: original, code: 'IO_ERROR', message: String(error) });
    }
  }
  return report;
}
