import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import type { MigrationIssue, MigrationReport, MigrationProgress, PlatformConversation, PlatformMessage } from '@graycode/contracts';
import { PlatformStorage } from '../storage/client';
import { errorDetails, PlatformStorageError } from '../errors';
import { importLegacyArtifacts, type LegacyArtifactImportOptions } from './artifacts';

interface Segment { file: string; startIndex: number; endIndex: number; count: number }
interface Source {
  id: string;
  metadata: PlatformConversation;
  metadataPath?: string;
  historyFile?: string;
  indexPath?: string;
  segments?: Array<Segment & { path: string }>;
  files: string[];
  hashes: Map<string, string>;
}

export interface LegacyImportOptions {
  conversationIds?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: { conversationId: string; importedMessages: number }) => void;
  onStatus?: (progress: MigrationProgress) => void;
  /** 检查点转换由 server host 注入，core 不依赖 workspace-checkpoints 实现。 */
  convertCheckpoint?: LegacyArtifactImportOptions['convertCheckpoint'];
  convertUsage?: (conversationId: string, value: unknown) => Promise<unknown>;
  convertBranch?: LegacyArtifactImportOptions['convertBranch'];
  importAdditionalArtifacts?: () => Promise<{ consumed: string[]; issues: MigrationIssue[]; importedUnits?: number }>;
}

function hash(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function fileWithin(root: string, file: string): Promise<string> {
  const real = await fs.realpath(file);
  if (!contains(root, real) || !(await fs.stat(real)).isFile()) {
    throw new PlatformStorageError('INVALID_INPUT', `Source path is not a regular file inside the selected source: ${file}`);
  }
  return real;
}

async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function readJson(root: string, file: string, hashes: Map<string, string>): Promise<unknown> {
  const safe = await fileWithin(root, file);
  if ((await fs.stat(safe)).size > 128 * 1024 * 1024) {
    throw new PlatformStorageError('INVALID_INPUT', `Source metadata exceeds 128 MiB: ${file}`);
  }
  try {
    const bytes = await fs.readFile(safe);
    hashes.set(safe, hash(bytes));
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  }
  catch (error) { throw new PlatformStorageError('CORRUPT_DATA', `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function prepareSource(root: string, directory: string, id: string): Promise<Source> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new PlatformStorageError('INVALID_INPUT', `Unsafe legacy conversation ID: ${id}`);
  const metadataPath = path.join(directory, `${id}.meta.json`);
  const indexPath = path.join(directory, id, 'history.index.json');
  const historyFile = path.join(directory, `${id}.json`);
  const source: Source = { id, metadata: {} as PlatformConversation, files: [], hashes: new Map() };
  if (await exists(metadataPath)) {
    const metadata = await readJson(root, metadataPath, source.hashes);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || (metadata as PlatformConversation).id !== id) {
      throw new PlatformStorageError('CORRUPT_DATA', `Metadata identity does not match ${id}.`);
    }
    source.metadata = metadata as PlatformConversation;
    source.metadataPath = await fileWithin(root, metadataPath);
    source.files.push(source.metadataPath);
  } else {
    // Missing metadata is reported rather than silently inventing user-visible timestamps.
    throw new PlatformStorageError('CORRUPT_DATA', `Metadata is missing for ${id}; source is preserved for repair.`);
  }
  if (await exists(indexPath)) {
    const index = await readJson(root, indexPath, source.hashes) as Record<string, unknown>;
    if (!index || index.version !== 1 || !Number.isSafeInteger(index.totalMessages) || Number(index.totalMessages) < 0 || !Array.isArray(index.segments)) {
      throw new PlatformStorageError('CORRUPT_DATA', `Invalid segmented history index for ${id}.`);
    }
    source.indexPath = await fileWithin(root, indexPath);
    source.files.push(source.indexPath);
    source.segments = [];
    const filenames = new Set<string>();
    let total = 0;
    for (const entry of index.segments as Segment[]) {
      if (!entry || typeof entry.file !== 'string' || !/^[a-zA-Z0-9_-]+\.ndjson$/.test(entry.file)
        || filenames.has(entry.file) || !Number.isSafeInteger(entry.count) || entry.count < 1
        || entry.startIndex !== total || entry.endIndex !== total + entry.count - 1) {
        throw new PlatformStorageError('CORRUPT_DATA', `Noncontiguous or unsafe history segments for ${id}.`);
      }
      filenames.add(entry.file);
      const file = await fileWithin(root, path.join(directory, id, 'history', entry.file));
      source.segments.push({ ...entry, path: file });
      source.files.push(file);
      total += entry.count;
    }
    if (total !== index.totalMessages) throw new PlatformStorageError('CORRUPT_DATA', `History index count mismatch for ${id}.`);
  } else if (await exists(historyFile)) {
    source.historyFile = await fileWithin(root, historyFile);
    source.files.push(source.historyFile);
  } else {
    throw new PlatformStorageError('NOT_FOUND', `History is missing for ${id}.`);
  }
  return source;
}

async function fingerprint(source: Source, signal?: AbortSignal, onFile?: (file: string, processedBytes: number, totalBytes: number) => void): Promise<string> {
  const digest = createHash('sha256');
  for (const file of source.files) {
    signal?.throwIfAborted();
    digest.update(file); digest.update('\0');
    const fileHash = createHash('sha256');
    const totalBytes = (await fs.stat(file)).size;
    let processedBytes = 0;
    onFile?.(file, 0, totalBytes);
    for await (const chunk of createReadStream(file, { signal })) {
      fileHash.update(chunk); processedBytes += chunk.length; onFile?.(file, processedBytes, totalBytes);
    }
    const value = fileHash.digest('hex');
    checkSourceHash(source, file, value);
    source.hashes.set(file, value);
    digest.update(Buffer.from(value, 'hex'));
  }
  return digest.digest('hex');
}

function checkSourceHash(source: Source, file: string, value: string): void {
  const expected = source.hashes.get(file);
  if (expected !== undefined && expected !== value) {
    throw new PlatformStorageError('SOURCE_CHANGED', `Source changed while being imported: ${file}. Stop the old writer before retrying.`);
  }
}

async function* messages(source: Source, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (source.historyFile) {
    const input = createReadStream(source.historyFile, { signal });
    const digest = createHash('sha256');
    const hashing = new Transform({ transform(chunk, _encoding, callback) { digest.update(chunk); callback(null, chunk); } });
    const values = streamArray.withParserAsStream();
    const done = pipeline(input, hashing, values);
    // Errors are consumed below; register immediately to avoid an unhandled rejection during yield.
    void done.catch(() => undefined);
    try {
      for await (const entry of values) { signal?.throwIfAborted(); yield (entry as { value: unknown }).value; }
      await done;
      checkSourceHash(source, source.historyFile, digest.digest('hex'));
    } finally { input.destroy(); hashing.destroy(); values.destroy(); await done.catch(() => undefined); }
    return;
  }
  for (const segment of source.segments!) {
    const input = createReadStream(segment.path, { signal });
    const digest = createHash('sha256');
    input.on('data', chunk => { digest.update(chunk); });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let failure: Error | undefined;
    input.on('error', error => { failure = error; reader.close(); });
    let count = 0;
    try {
      for await (const line of reader) {
        signal?.throwIfAborted();
        if (!line.trim() || count >= segment.count) continue;
        if (Buffer.byteLength(line) > 128 * 1024 * 1024) throw new PlatformStorageError('INVALID_INPUT', 'A source message exceeds 128 MiB.');
        yield JSON.parse(line);
        count++;
      }
      if (failure) throw failure;
      if (count !== segment.count) throw new PlatformStorageError('CORRUPT_DATA', `Missing committed messages in ${segment.file}.`);
      checkSourceHash(source, segment.path, digest.digest('hex'));
    } finally { reader.close(); input.destroy(); }
  }
}

function prepareMessage(value: unknown, sourceKey: string, index: number, parentId: string | null): PlatformMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformStorageError('CORRUPT_DATA', `Message ${index} is not an object.`);
  const message = value as PlatformMessage;
  if (!['user', 'model', 'system'].includes(message.role) || !Array.isArray(message.parts)) {
    throw new PlatformStorageError('CORRUPT_DATA', `Invalid legacy message at index ${index}.`);
  }
  const id = message.id ?? `legacy_${hash(`${sourceKey}\0${index}`).slice(0, 32)}`;
  return { ...message, id, ...(message.parentId === undefined ? { parentId } : {}) };
}

async function resolveDestination(directory: string): Promise<string> {
  try { return await fs.realpath(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await resolveDestination(parent), path.basename(directory));
  }
}

/** Validate before opening/creating the destination so an invalid CLI invocation cannot modify its source. */
export async function validateLegacyImportPaths(sourcePath: string, destinationPath: string): Promise<string> {
  const root = await fs.realpath(sourcePath);
  if (!(await fs.stat(root)).isDirectory()) throw new PlatformStorageError('INVALID_INPUT', 'Source must be a directory.');
  const destination = await resolveDestination(path.resolve(destinationPath));
  if (contains(root, destination) || contains(destination, root)) {
    throw new PlatformStorageError('INVALID_INPUT', 'Source and destination must be separate, non-nested directories.');
  }
  return root;
}

/** Report every unconsumed file/subtree, including usage, unselected conversations and old snapshots. */
async function pendingArtifacts(root: string, consumed: Set<string>, options: LegacyImportOptions): Promise<string[]> {
  const directories = new Set<string>([root]);
  for (const file of consumed) {
    let directory = path.dirname(file);
    while (contains(root, directory) && directory !== root) { directories.add(directory); directory = path.dirname(directory); }
  }
  const pending: string[] = [];
  async function visit(directory: string): Promise<void> {
    options.signal?.throwIfAborted();
    options.onStatus?.({ phase: 'finalizing', detail: '核对尚未处理的文件', currentItem: directory });
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      // Never follow sidecar symlinks or user-supplied conversation IDs during discovery.
      if (entry.isFile() && consumed.has(file)) continue;
      if (entry.isDirectory() && consumed.has(file) && (await fs.readdir(file)).length === 0) continue;
      if (entry.isDirectory() && directories.has(file) && await fs.realpath(file) === file) await visit(file);
      else pending.push(relative);
    }
  }
  await visit(root);
  return pending.sort();
}

/** Import explicit local legacy data. No automatic cutover and no source mutations. */
export async function importLegacyHistory(store: PlatformStorage, sourcePath: string, options: LegacyImportOptions = {}): Promise<MigrationReport> {
  options.onStatus?.({ phase: 'scanning', detail: '扫描旧存档目录', currentItem: sourcePath });
  const root = await validateLegacyImportPaths(sourcePath, store.directory);
  const directory = await exists(path.join(root, 'conversations')) ? path.join(root, 'conversations') : root;
  const directoryReal = await fs.realpath(directory);
  if (!contains(root, directoryReal)) throw new PlatformStorageError('INVALID_INPUT', 'Conversations directory leaves the selected source.');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const ids = new Set<string>(options.conversationIds ?? []);
  if (!options.conversationIds) {
    for (const entry of entries) {
      if (directory === root && entry.name === 'settings.json' && !await exists(path.join(root, 'settings.meta.json'))) continue;
      if (entry.isFile() && entry.name.endsWith('.meta.json')) ids.add(entry.name.slice(0, -10));
      else if (entry.isFile() && /^[a-zA-Z0-9_-]+\.json$/.test(entry.name)) ids.add(entry.name.slice(0, -5));
      else if (entry.isDirectory() && await exists(path.join(directory, entry.name, 'history.index.json'))) ids.add(entry.name);
    }
  }
  const report: MigrationReport = { source: root, imported: [], skipped: [], issues: [], pendingArtifacts: [], readyForCutover: false };
  const consumed = new Set<string>();
  let completed = 0;
  for (const id of [...ids].sort()) {
    options.signal?.throwIfAborted();
    const progress = (detail: string, extra: Partial<MigrationProgress> = {}) => options.onStatus?.({ phase: 'history', detail,
      conversationId: id, currentItem: id, completed, total: ids.size, unit: '个对话', ...extra });
    try {
      progress('读取对话目录与元数据');
      const source = await prepareSource(root, directory, id);
      const sourceKey = hash(`${process.platform === 'win32' ? directoryReal.toLowerCase() : directoryReal}\0${id}`);
      const initialFingerprint = await fingerprint(source, options.signal, (file, processedBytes, totalBytes) =>
        progress('校验来源文件', { currentItem: file, processedBytes, totalBytes }));
      const state = await store.beginMigration({ sourceKey, fingerprint: initialFingerprint, metadata: source.metadata });
      if (state.complete) { report.skipped.push(id); source.files.forEach(file => consumed.add(file)); continue; }
      let total = 0;
      let parentId: string | null = null;
      let batch: PlatformMessage[] = [];
      let bytes = 0;
      progress('导入对话消息', { importedMessages: state.nextIndex });
      const flush = async () => {
        if (!batch.length) return;
        await store.appendMigration({ sourceKey, offset: total - batch.length, messages: batch });
        batch = []; bytes = 0;
        options.onProgress?.({ conversationId: id, importedMessages: total });
        progress('保存对话消息', { importedMessages: total });
      };
      for await (const value of messages(source, options.signal)) {
        const message = prepareMessage(value, sourceKey, total, parentId);
        parentId = message.id!;
        if (total >= state.nextIndex) { batch.push(message); bytes += Buffer.byteLength(JSON.stringify(message)); }
        total++;
        if (batch.length >= 128 || bytes >= 4 * 1024 * 1024) await flush();
      }
      await flush();
      const finalFingerprint = await fingerprint(source, options.signal, (file, processedBytes, totalBytes) =>
        progress('确认来源未发生变化', { currentItem: file, processedBytes, totalBytes, importedMessages: total }));
      if (initialFingerprint !== finalFingerprint) throw new PlatformStorageError('SOURCE_CHANGED', 'Source files changed while being imported. Stop the old writer before retrying.');
      await store.finishMigration({ sourceKey, fingerprint: finalFingerprint, total });
      report.imported.push(id);
      source.files.forEach(file => consumed.add(file));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const detail = errorDetails(error);
      report.issues.push({ conversationId: id, path: directory, code: detail.code, message: detail.message });
    } finally {
      completed++;
      progress('已处理对话历史');
    }
  }
  const artifacts = await importLegacyArtifacts(store, root, {
    conversationIds: [...report.imported, ...report.skipped], signal: options.signal, includeSharedAssets: !options.conversationIds,
    convertCheckpoint: options.convertCheckpoint, convertBranch: options.convertBranch, convertUsage: options.convertUsage, onStatus: options.onStatus,
  });
  artifacts.consumed.forEach(file => consumed.add(file));
  report.artifacts = artifacts.imported;
  report.issues.push(...artifacts.issues);
  let additionalUnits = 0;
  if (options.importAdditionalArtifacts) {
    const additional = await options.importAdditionalArtifacts();
    additional.consumed.forEach(file => { if (contains(root, file)) consumed.add(file); });
    report.issues.push(...additional.issues);
    additionalUnits = additional.importedUnits ?? 0;
  }
  report.pendingArtifacts = await pendingArtifacts(root, consumed, options);
  report.readyForCutover = report.issues.length === 0 && report.pendingArtifacts.length === 0 && (report.imported.length + report.skipped.length + additionalUnits > 0);
  return report;
}
