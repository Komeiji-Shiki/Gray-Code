import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { lstat, open, readdir, realpath, readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationIssue } from '@graycode/contracts';
import { ISO_DATE_RE, parse, isValidTreeRecord, logHeaderLooksLike, LEGACY_LOG_RECS, LEGACY_TREE_REC } from '../../../../backend/modules/memory/logFormat';
import { LOG_REC, TREE_REC } from '../../../../backend/modules/memory/types';
import { parseConfigContent } from '../../../../backend/modules/memory/configFile';
import type { PlatformApplication } from '../application';

interface SourceFile { file: string; snapshot: string; hash: string; size: number; mtimeMs: number; ctimeMs: number }
export interface MemoryImportReport { imported: string[]; skipped: string[]; consumed: string[]; issues: MigrationIssue[] }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function inside(root: string, file: string) { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
async function exists(file: string) { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

/** 源文件只以只读方式打开，不调用会修复、截断旧 LOG 的文件存储器。 */
export class LegacyMemoryImporter {
  private readonly captured = new Map<string, SourceFile>();
  private snapshotDirectory = '';
  constructor(private readonly app: PlatformApplication) {}
  private async regular(root: string, file: string) {
    const actual = await realpath(file);
    if (!inside(root, actual) || !(await lstat(file)).isFile()) throw new Error(`记忆源不是目录内的普通文件：${file}`);
    return actual;
  }
  private async fingerprint(root: string, file: string, signal: AbortSignal): Promise<SourceFile> {
    const cached = this.captured.get(file); if (cached) return cached;
    const actual = await this.regular(root, file); const before = await lstat(actual);
    const hash = createHash('sha256'); let size = 0;
    const snapshot = path.join(this.snapshotDirectory, digest(file));
    await pipeline(createReadStream(actual, { highWaterMark: 256 * 1024 }), new Transform({
      transform(bytes, _encoding, done) { hash.update(bytes); size += bytes.length; done(null, bytes); },
    }), createWriteStream(snapshot, { flags: 'wx' }), { signal });
    const after = await lstat(actual);
    if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('捕获记忆文件期间来源发生变化。');
    const result = { file, snapshot, size, hash: hash.digest('hex'), mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
    this.captured.set(file, result); return result;
  }
  private async records(source: SourceFile, width: number, signal: AbortSignal,
    consume: (text: string, position: number) => Promise<void>) {
    if (source.size % width) throw new Error(`记忆文件存在不完整的尾记录，未修改源文件：${source.file}`);
    const file = await open(source.snapshot, 'r');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      let offset = 0;
      while (offset < source.size) {
        signal.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(width * 256, source.size - offset));
        let read = 0;
        while (read < buffer.length) {
          const result = await file.read(buffer, read, buffer.length - read, offset + read);
          if (!result.bytesRead) throw new Error('记忆源文件在读取期间被截断。');
          read += result.bytesRead;
        }
        for (let position = 0; position < buffer.length; position += width)
          await consume(decoder.decode(buffer.subarray(position, position + width)).trimEnd(), (offset + position) / width);
        offset += buffer.length;
      }
    } finally { await file.close(); }
  }
  /**
   * LOG 的记录宽度：当前宽度（LOG_REC）或旧宽度（LEGACY_LOG_RECS：320 / 1024）。
   * 候选按「从旧到新」内容探测（前两条记录必须是 id 0/1 + ISO 日期），与 backend 的
   * MemoryLogStore 同一判定口径；单条旧记录（无法内容探测）按可整除的宽度兜底。
   */
  private async logWidth(source: SourceFile): Promise<number> {
    if (!source.size) return LOG_REC;
    const file = await open(source.file, 'r');
    try {
      for (const rec of LEGACY_LOG_RECS) {
        if (source.size % rec !== 0 || source.size < rec * 2) continue;
        const buffer = Buffer.alloc(rec * 2); await file.read(buffer, 0, buffer.length, 0);
        if (logHeaderLooksLike(buffer, rec)) return rec;
      }
    } finally { await file.close(); }
    if (source.size % LOG_REC === 0) return LOG_REC;
    // 单条旧宽度记录（文件过小而无法内容探测）：按能整除的旧宽度导入
    for (const rec of LEGACY_LOG_RECS) if (source.size % rec === 0) return rec;
    throw new Error('记忆 LOG 的记录宽度或尾部不完整，未尝试修复源文件。');
  }
  /**
   * 摘要文件的记录宽度：当前宽度（TREE_REC）或旧宽度（LEGACY_TREE_REC，288B/条）。
   * 两者同时整除的歧义尺寸靠内容探测（前两条必须是合法定宽记录）区分。
   */
  private async treeWidth(source: SourceFile): Promise<number> {
    if (!source.size) return TREE_REC;
    if (source.size % TREE_REC === 0 && source.size % LEGACY_TREE_REC !== 0) return TREE_REC;
    if (source.size >= LEGACY_TREE_REC * 2) {
      const file = await open(source.file, 'r');
      try {
        const buffer = Buffer.alloc(LEGACY_TREE_REC * 2); await file.read(buffer, 0, buffer.length, 0);
        let legacy = true;
        for (let index = 0; index < 2; index++)
          if (!isValidTreeRecord(buffer.subarray(index * LEGACY_TREE_REC, (index + 1) * LEGACY_TREE_REC))) legacy = false;
        if (legacy) return LEGACY_TREE_REC;
      } finally { await file.close(); }
    }
    if (source.size % TREE_REC === 0) return TREE_REC;
    if (source.size % LEGACY_TREE_REC === 0) return LEGACY_TREE_REC; // 单条旧记录（无法内容探测）
    throw new Error('摘要文件的记录宽度无法识别，未修改源文件。');
  }
  async run(actorId: string, root: string, signal: AbortSignal): Promise<MemoryImportReport> {
    this.app.requireOwner(actorId);
    this.snapshotDirectory = await mkdtemp(path.join(this.app.storage.directory, 'memory-import-capture-'));
    try { return await this.importCaptured(actorId, root, signal); }
    finally {
      try { await rm(this.snapshotDirectory, { recursive: true, force: true }); }
      catch (error) { this.app.publish({ type: 'notification', severity: 'warning', message: '导入临时快照未能清理：' + String(error) }); }
      this.captured.clear();
    }
  }
  private async importCaptured(actorId: string, root: string, signal: AbortSignal): Promise<MemoryImportReport> {
    const report: MemoryImportReport = { imported: [], skipped: [], consumed: [], issues: [] };
    const configConflicts = new Set<string>();
    const directories: string[] = [];
    const globalDirectory = path.join(root, 'memory');
    if (await exists(globalDirectory)) directories.push(globalDirectory);
    const workspaceDirectory = path.join(root, 'memory-workspaces');
    if (await exists(workspaceDirectory)) {
      if (!(await lstat(workspaceDirectory)).isDirectory() || !inside(root, await realpath(workspaceDirectory))) throw new Error('旧工作区记忆目录超出来源范围。');
      const entries = await readdir(workspaceDirectory, { withFileTypes: true });
      if (!entries.length) report.consumed.push(workspaceDirectory);
      for (const entry of entries) {
        if (entry.isDirectory()) directories.push(path.join(workspaceDirectory, entry.name));
        else report.issues.push({ path: path.join(workspaceDirectory, entry.name), code: 'MEMORY_SOURCE', message: '无法识别的工作区记忆目录项，已保留。' });
      }
    }
    for (const directory of directories) {
      signal.throwIfAborted();
      try {
        if (!(await lstat(directory)).isDirectory() || !inside(root, await realpath(directory))) throw new Error('记忆目录超出来源范围。');
        const files: SourceFile[] = [];
        const log = await this.fingerprint(root, path.join(directory, 'LOG.txt'), signal); files.push(log);
        let workspaceKey: string | undefined;
        if (directory !== globalDirectory) {
          const metadataFile = await this.fingerprint(root, path.join(directory, 'scope.json'), signal); files.push(metadataFile);
          if (metadataFile.size > 1024 * 1024) throw new Error('工作区记忆归属文件过大。');
          const bytes = await readFile(metadataFile.snapshot);
          const metadata = JSON.parse(bytes.toString('utf8'));
          if (typeof metadata.fsPath !== 'string' || !path.isAbsolute(metadata.fsPath)) throw new Error('工作区记忆缺少可识别的绝对路径。');
          if (metadata.uri && !String(metadata.uri).startsWith('file:')) throw new Error('远程工作区记忆需要显式绑定目标，未猜测本地路径。');
          workspaceKey = (metadata.fsPath as string).replaceAll('\\', '/');
          if (process.platform === 'win32') workspaceKey = workspaceKey.toLowerCase();
          if (metadata.uri) {
            let uriKey = fileURLToPath(String(metadata.uri)).replaceAll('\\', '/');
            if (process.platform === 'win32') uriKey = uriKey.toLowerCase();
            if (uriKey !== workspaceKey) throw new Error('工作区记忆的路径与 URI 不一致，未猜测归属。');
          }
        }
        const configFile = path.join(globalDirectory, 'config');
        let config: ReturnType<typeof parseConfigContent> | undefined;
        if (await exists(configFile)) {
          const source = await this.fingerprint(root, configFile, signal); files.push(source);
          if (source.size > 1024 * 1024) throw new Error('记忆配置文件过大。');
          const bytes = await readFile(source.snapshot);
          config = parseConfigContent(bytes.toString('utf8'));
        }
        const treeDirectory = path.join(directory, 'TREE'); const trees: Array<{ source: SourceFile; width: number }> = [];
        let emptyTree = false;
        if (await exists(treeDirectory)) {
          if (!(await lstat(treeDirectory)).isDirectory() || !inside(root, await realpath(treeDirectory))) throw new Error('摘要目录超出来源范围。');
          const treeEntries = await readdir(treeDirectory, { withFileTypes: true });
          emptyTree = treeEntries.length === 0;
          for (const entry of treeEntries) {
            const width = Number(entry.name);
            if (!entry.isFile() || entry.name !== String(width) || !Number.isSafeInteger(width) || width < 2 || !Number.isInteger(Math.log2(width))) throw new Error(`无法识别的摘要文件：${entry.name}`);
            const source = await this.fingerprint(root, path.join(treeDirectory, entry.name), signal);
            trees.push({ source, width }); files.push(source);
          }
        }
        files.sort((left, right) => left.file.localeCompare(right.file));
        const fingerprint = digest(JSON.stringify(files.map(file => [path.relative(root, file.file), file.size, file.hash])));
        const target = { id: digest(JSON.stringify([actorId, workspaceKey ?? null])), actorId, ...(workspaceKey ? { workspaceKey } : {}) };
        const sourceKey = digest(JSON.stringify([root, directory, target.id]));
        const staging = { id: digest(`${sourceKey}:${fingerprint}`), actorId: `memory-import-${actorId}`, ...(workspaceKey ? { workspaceKey } : {}) };
        const width = await this.logWidth(log); const total = log.size / width;
        const publication = { staging, target, sourceKey, fingerprint, entries: total,
          ...(config ? { config: { id: this.app.memory.scope(actorId).id, value: { ...config } } } : {}) };
        const recordResult = async (skipped: boolean) => {
          (skipped ? report.skipped : report.imported).push(directory);
          const currentConfig = config ? await this.app.storage.getRecord('memory-config', this.app.memory.scope(actorId).id) as Record<string, unknown> | null : null;
          const configMatches = !config || Object.entries(config).every(([key, value]) => currentConfig?.[key] === value);
          report.consumed.push(...files.filter(file => file.file !== configFile || configMatches).map(file => file.file));
          if (emptyTree) report.consumed.push(treeDirectory);
          if (!configMatches && !configConflicts.has(configFile)) {
            configConflicts.add(configFile);
            report.issues.push({ path: configFile, code: 'MEMORY_CONFIG_CONFLICT', message: '已保留当前记忆参数；旧参数与其不同，尚未自动合并。' });
          }
        };
        if (await this.app.storage.getRecord('legacy-memory-imports', sourceKey)) {
          const result = await this.app.memory.serialized(actorId, () => { signal.throwIfAborted(); return this.app.storage.memoryImportPublish(publication); }, target.id);
          await recordResult(result.skipped); continue;
        }
        let state = await this.app.storage.memoryState(staging);
        const entries: Array<{ date: string; text: string; source: Record<string, unknown> }> = [];
        const flush = async () => {
          if (!entries.length) return;
          state = await this.app.storage.memoryImportBatch({ staging, sourceKey, fingerprint, expectedRevision: state.revision, entries: entries.splice(0) });
        };
        await this.records(log, width, signal, async (text, position) => {
          const entry = parse(text);
          if (!entry || entry.id !== position || !ISO_DATE_RE.test(entry.date) || !entry.text.trim() || /[\r\n]/.test(entry.text)) throw new Error(`原记忆第 ${position} 条记录损坏或编号不连续。`);
          if (position < state.length) return;
          entries.push({ date: entry.date, text: entry.text, source: { origin: 'legacy_import', sourceKey, originalId: entry.id } });
          if (entries.length >= 256) await flush();
        });
        await flush();
        const summaries: Array<{ lo: number; hi: number; text: string }> = [];
        const flushSummaries = async () => { if (summaries.length) state = await this.app.storage.memoryImportBatch({ staging, sourceKey, fingerprint, expectedRevision: state.revision, summaries: summaries.splice(0) }); };
        for (const tree of trees.sort((a, b) => a.width - b.width)) {
          const recordWidth = await this.treeWidth(tree.source);
          await this.records(tree.source, recordWidth, signal, async (text, position) => {
            if (!text) return;
            const lo = position * tree.width; const hi = lo + tree.width;
            if (hi > total || /[\r\n]/.test(text)) throw new Error(`摘要范围超出原始记忆：${lo}-${hi - 1}`);
            summaries.push({ lo, hi, text }); if (summaries.length >= 256) await flushSummaries();
          });
        }
        await flushSummaries();
        // 正文来自同一份捕获文件，发布前只检查来源元数据是否变化。
        for (const file of files) {
          const current = await lstat(file.file);
          if (current.size !== file.size || current.mtimeMs !== file.mtimeMs || current.ctimeMs !== file.ctimeMs) throw new Error('源记忆在迁移期间发生变化，未发布正式记忆。');
        }
        signal.throwIfAborted();
        const result = await this.app.memory.serialized(actorId, () => { signal.throwIfAborted(); return this.app.storage.memoryImportPublish(publication); }, target.id);
        await recordResult(result.skipped);
      } catch (error) {
        signal.throwIfAborted();
        report.issues.push({ path: directory, code: 'MEMORY_IMPORT', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  }
}
