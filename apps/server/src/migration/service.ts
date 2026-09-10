import { bindMigrationWorkspace, migrationWorkspaceRoots } from './workspaceBindings';
import { importRuntimeAssets, type RuntimeAssetReport } from './runtimeAssets';
import { importLegacyActivity, type ActivityImportReport } from './activity';
import { ConfigurationMigration, type ConfigurationFile } from './configuration';
import { validateLegacyUsageIndex } from '../conversations/usage';
import { importLegacySkills, type SkillImportReport } from '../skills/import';
import { LegacyMemoryImporter, type MemoryImportReport } from '../memory/import';
import type { PlatformApplication } from '../application';
import { importLegacyHistory, type LegacyImportOptions, type LegacyCheckpointConverter } from '@graycode/core';
import { validateLegacyImportPaths } from '@graycode/core';
import type { ConversationBranchGraph } from '../../../../backend/modules/conversation/branch/types';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrateBranchGraph } from '../../../../backend/modules/conversation/branch/BranchMigration';
import { validate } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { groupMessages } from '../conversations/branches';
import type { MigrationIssue, MigrationStatus, MigrationProgress } from '@graycode/contracts';
import { createWorkspaceRootId } from '../../../../backend/modules/checkpoint/CheckpointWorkspace';
import type { WorkspaceCheckpoint } from '../workspace/checkpoints';

export interface ServerMigrationOptions extends Omit<LegacyImportOptions, 'conversationIds' | 'convertBranch' | 'convertCheckpoint'> {
  conversationIds?: string[];
}

const safeConversationId = /^[a-zA-Z0-9_-]+$/;
const safeCheckpointDir = /^[a-zA-Z0-9_.-]+$/;
const scopedKeyPattern = /^ws_[a-f0-9]{16}\//;
const md5 = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');
const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

/** 与旧存档路径校验同口径：拒绝空串、绝对路径、盘符、`..` 与空字节。 */
function normalizeSafeScopedKey(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) throw new Error(`旧检查点路径非法：${raw}`);
  const normalized = normalizeSeparators(raw);
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error(`旧检查点路径非法：${raw}`);
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some(segment => segment === '..')) throw new Error(`旧检查点路径非法：${raw}`);
  return segments.join('/');
}

interface MigratedRoot { id: string; name: string; uri: string }

function cloneRoots(value: unknown): MigratedRoot[] {
  if (!Array.isArray(value)) return [];
  const result: MigratedRoot[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.uri !== 'string') continue;
    if (!candidate.id || !candidate.uri) continue;
    result.push({ id: candidate.id, name: candidate.name, uri: candidate.uri });
  }
  result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return result;
}

function toScopedKey(rawKey: string, roots: readonly MigratedRoot[]): string {
  const normalized = normalizeSafeScopedKey(rawKey);
  if (scopedKeyPattern.test(normalized)) {
    if (!roots.some(root => normalized.startsWith(`${root.id}/`))) throw new Error('检查点路径引用了未知工作区。');
    return normalized;
  }
  if (roots.length === 1) return `${roots[0].id}/${normalized.replace(/^\/+/, '')}`;
  if (roots.length > 1) throw new Error('多工作区存档缺少路径作用域，不能自动归入第一个工作区。');
  return normalized;
}

function directoryOfRoot(root: MigratedRoot | undefined): string {
  if (!root) return '';
  try {
    if (root.uri.startsWith('file://')) return fileURLToPath(root.uri);
  } catch { /* 非文件 URI 时目录留空，仅保留清单可读 */ }
  return '';
}

/**
 * 分支转换：旧 sidecar 图 → 新版 BranchState。
 *
 * 旧节点把正文（parts）、用量与非拓扑元数据（contentMetadata）混在同一对象里；
 * 新版按 branchMutation 口径分离：图节点只保留拓扑（parts 清空并删除
 * contentMetadata/usageMetadata），完整正文（含工具调用 ID 与签名）展开为
 * PlatformMessage 存入 groups（contentMetadata 展平到顶层，避免嵌套丢失
 * isSummary/requestKey 等往返字段；deleted 等分支标记不进入消息）。
 */
export async function convertBranch(conversationId: string, value: unknown): Promise<unknown> {
  void conversationId;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旧分支图不是对象。');
  const sourceGraph = value as Partial<ConversationBranchGraph>;
  if (!Number.isSafeInteger(sourceGraph.version) || !sourceGraph.nodes || typeof sourceGraph.nodes !== 'object' || Array.isArray(sourceGraph.nodes)) {
    throw new Error('旧分支图结构无效。');
  }
  const cloned = migrateBranchGraph(structuredClone(sourceGraph) as ConversationBranchGraph).graph;
  if (!validate(cloned).valid) throw new Error('旧分支图的父子关系无效。');
  const nodes = cloned.nodes as unknown as Record<string, Record<string, unknown>>;
  const groups: Record<string, unknown[]> = {};
  for (const [id, rawNode] of Object.entries(nodes)) {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) throw new Error(`旧分支节点 ${id} 不是对象。`);
    const node = rawNode as Record<string, unknown> & {
      id?: unknown; parentId?: unknown; role?: unknown; parts?: unknown; timestamp?: unknown;
      modelVersion?: unknown; usageMetadata?: unknown; usageMetadataPartial?: unknown; contentMetadata?: unknown;
    };
    const nodeId = typeof node.id === 'string' && node.id.length > 0 ? node.id : id;
    const role = node.role;
    if (role !== 'user' && role !== 'model' && role !== 'system') throw new Error(`旧分支节点 ${id} 角色非法。`);
    if (!Array.isArray(node.parts)) throw new Error(`旧分支节点 ${id} 缺少正文 parts。`);
    const contentMetadata = node.contentMetadata && typeof node.contentMetadata === 'object' && !Array.isArray(node.contentMetadata)
      ? structuredClone(node.contentMetadata) as Record<string, unknown>
      : {};
    // contentMetadata 按定义不含 id/parentId/role/parts/index 等结构字段；防御性剔除，避免覆盖真源。
    for (const key of ['id', 'parentId', 'role', 'parts', 'index']) delete contentMetadata[key];
    const message: Record<string, unknown> = {
      id: nodeId,
      parentId: node.parentId ?? null,
      role,
      parts: structuredClone(node.parts),
      ...contentMetadata,
    };
    if (typeof node.timestamp === 'number') message.timestamp = node.timestamp;
    if (typeof node.modelVersion === 'string') message.modelVersion = node.modelVersion;
    if (node.usageMetadata !== undefined) message.usageMetadata = structuredClone(node.usageMetadata);
    if (node.usageMetadataPartial !== undefined) message.usageMetadataPartial = node.usageMetadataPartial;
    const modelParts: unknown[] = [];
    const responses: Record<string, unknown>[] = [];
    let response: Record<string, unknown> | undefined;
    for (const part of message.parts as Record<string, unknown>[]) {
      if (part.functionResponse) {
        const responseId = (part.functionResponse as { id?: string }).id ?? String(responses.length);
        response = { id: `legacy-response-${sha256Hex(`${conversationId}:${nodeId}:${responseId}`).slice(0, 32)}`, role: 'user',
          isFunctionResponse: true, parts: [structuredClone(part)], timestamp: message.timestamp };
        responses.push(response);
      } else if (response) (response.parts as unknown[]).push(structuredClone(part));
      else modelParts.push(part);
    }
    message.parts = modelParts;
    groups[id] = [message, ...responses];
    const stripped = structuredClone(rawNode) as Record<string, unknown>;
    stripped.id = nodeId;
    stripped.parts = [];
    delete stripped.contentMetadata;
    delete stripped.usageMetadata;
    (cloned.nodes as unknown as Record<string, unknown>)[id] = stripped;
  }
  return {
    version: 1,
    graph: cloned,
    groups,
  };
}

interface CheckpointRecordLike {
  ignoreSnapshot?: WorkspaceCheckpoint['manifest']['ignoreSnapshot'];
  id: string;
  conversationId?: string;
  messageIndex?: unknown;
  messageNodeId?: unknown;
  toolName?: unknown;
  phase?: unknown;
  timestamp?: unknown;
  backupDir?: unknown;
  fileHashes?: unknown;
  fileStats?: unknown;
  workspaceRoots?: unknown;
  emptyDirs?: unknown;
  absentPaths?: unknown;
  unbackedPaths?: unknown;
  partial?: unknown;
  baseCheckpointId?: unknown;
}

async function readJsonFile(file: string, sourceRoot: string): Promise<unknown> {
  const canonical = await fs.realpath(file);
  if (!contains(sourceRoot, canonical)) throw new Error('检查点源文件位于所选目录之外。');
  const bytes = await fs.readFile(canonical);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * 检查点转换：旧备份目录 → 新内容记录 + 清单。
 *
 * 源目录只读；目标仅走 artifacts 定义的记录写入路径（调用方 putRecord）。
 * 保留语义：多根 workspaceRoots、emptyDirs/absentPaths、excluded（旧 manifest
 * 或 unbackedPaths 近似）、partial 局部范围标记；manifest.files 含 hash/size/mode。
 * 增量链按 baseCheckpointId 回溯找字节，使迁移后的清单自包含（不依赖补丁链重放）。
 */
export async function convertCheckpoint(
  conversationId: string,
  sourceRoot: string,
  context?: Parameters<LegacyCheckpointConverter>[2],
): Promise<{ records: readonly { namespace: string; id: string; ownerId?: string; value: unknown }[]; consumed: readonly string[]; issues?: MigrationIssue[] }> {
  sourceRoot = await fs.realpath(sourceRoot);
  if (!safeConversationId.test(conversationId)) return { records: [], consumed: [] };
  const conversationsDir = path.join(sourceRoot, 'conversations');
  const metaPath = path.join(conversationsDir, `${conversationId}.meta.json`);
  let meta: unknown;
  try {
    meta = await readJsonFile(metaPath, sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return { records: [], consumed: [] };
    }
    throw new Error(`旧检查点元数据不可读：${String(error)}`);
  }
  const metaObject = (meta && typeof meta === 'object' ? meta as Record<string, unknown> : {}) as Record<string, unknown>;
  const custom = (metaObject.custom && typeof metaObject.custom === 'object' ? metaObject.custom as Record<string, unknown> : undefined);
  const rawList = custom && Array.isArray(custom.checkpoints)
    ? custom.checkpoints
    : Array.isArray(metaObject.checkpoints) ? metaObject.checkpoints as unknown[] : [];
  const candidates = (rawList as unknown[]).filter((entry): entry is CheckpointRecordLike => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length === 0) return false;
    if (typeof record.conversationId === 'string' && record.conversationId !== conversationId) return false;
    return true;
  });
  if (candidates.length === 0) return { records: [], consumed: [] };
  const checkpointsDir = path.join(sourceRoot, 'checkpoints');
  let checkpointsDirExists = true;
  try {
    const stat = await fs.stat(checkpointsDir);
    if (!stat.isDirectory()) checkpointsDirExists = false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') checkpointsDirExists = false;
    else throw error;
  }
  if (!checkpointsDirExists) throw new Error('对话包含检查点记录，但备份目录不存在。');

  const byId = new Map<string, CheckpointRecordLike>();
  for (const record of candidates) byId.set(record.id, record);

  const records: { namespace: string; id: string; ownerId?: string; value: unknown }[] = [];
  const consumed: string[] = [];
  const consumedSet = new Set<string>();
  const issues: MigrationIssue[] = [];
  let checkpointConsumed = new Set<string>();
  const addConsumed = (file: string): void => {
    checkpointConsumed.add(file);
  };
  const bytesCache = new Map<string, { bytes: Uint8Array; mode: number; hash: string }>();
  let cachedBytes = 0;
  let completedCheckpoints = 0;
  const progress = (detail: string, currentItem: string) => context?.onStatus?.({ phase: 'artifacts', detail, currentItem,
    conversationId, completed: completedCheckpoints, total: candidates.length, unit: '个检查点' });

  async function readBackupBytes(backupDir: string, scopedKey: string, roots: readonly MigratedRoot[]): Promise<{ bytes: Uint8Array; mode: number; hash: string; file: string } | null> {
    context?.signal?.throwIfAborted();
    if (typeof backupDir !== 'string' || !safeCheckpointDir.test(backupDir) || backupDir.includes('/') || backupDir.includes('\\')) return null;
    const normalized = normalizeSeparators(scopedKey);
    const attempts: string[][] = [[...normalized.split('/')]];
    const slash = normalized.indexOf('/');
    if (slash > 0 && roots.length === 1) attempts.push([...normalized.slice(slash + 1).split('/')]);
    else if (roots.length === 1) attempts.push([roots[0].id, ...normalized.split('/')]);
    for (const segments of attempts) {
      const candidate = path.join(checkpointsDir, backupDir, ...segments);
      if (!contains(checkpointsDir, candidate)) continue;
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try { stat = await fs.lstat(candidate); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (!contains(sourceRoot, await fs.realpath(candidate))) throw new Error('备份路径指向所选目录之外。');
      const cached = bytesCache.get(candidate);
      if (cached) { addConsumed(candidate); return { ...cached, file: candidate }; }
      const raw = await fs.readFile(candidate, { signal: context?.signal });
      const bytes = new Uint8Array(raw);
      const mode = (stat.mode & 0o777) || 0o644;
      const content = { bytes, mode, hash: md5(bytes) };
      // 缓存只用于复用增量链中的文件，限制大小后逐个检查点写入。
      while (cachedBytes + bytes.byteLength > 64 * 1024 * 1024 && bytesCache.size) {
        const oldest = bytesCache.keys().next().value!;
        cachedBytes -= bytesCache.get(oldest)!.bytes.byteLength; bytesCache.delete(oldest);
      }
      if (bytes.byteLength <= 64 * 1024 * 1024) { bytesCache.set(candidate, content); cachedBytes += bytes.byteLength; }
      addConsumed(candidate);
      return { ...content, file: candidate };
    }
    return null;
  }

  async function loadOldManifest(backupDir: string): Promise<{ manifest: Record<string, unknown> | null; filesMap: Record<string, unknown> | null }> {
    if (!safeCheckpointDir.test(backupDir) || backupDir === '.' || backupDir === '..') throw new Error('备份目录名称非法。');
    const backupPath = path.join(checkpointsDir, backupDir);
    const manifestPath = path.join(backupPath, 'manifest.json');
    if (!await isRegularFile(manifestPath)) return { manifest: null, filesMap: null };
    const parsed = await readJsonFile(manifestPath, sourceRoot);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('检查点清单格式无效。');
    const manifest = parsed as Record<string, unknown>;
    if (typeof manifest.checkpointId !== 'string') throw new Error('检查点清单缺少标识。');
    addConsumed(manifestPath);
    const isMapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    if (isMapping(manifest.files)) return { manifest, filesMap: manifest.files };
    // 沿用旧格式的配对版本语义，只读取匹配的 .prev，不在原目录执行修复或重命名。
    for (const name of ['files.json', 'files.json.prev']) {
      const file = path.join(backupPath, name);
      if (!await isRegularFile(file)) continue;
      let payload: Record<string, unknown>;
      try { payload = await readJsonFile(file, sourceRoot) as Record<string, unknown>; }
      catch { continue; }
      if (!payload || payload.checkpointId !== manifest.checkpointId || !isMapping(payload.files)
        || (manifest.filesRevision !== undefined && payload.filesRevision !== manifest.filesRevision)) continue;
      addConsumed(file);
      return { manifest, filesMap: payload.files };
    }
    throw new Error('检查点文件清单缺失、损坏或版本不匹配。');
  }

  const toScopedList = (value: unknown, roots: readonly MigratedRoot[]): string[] => {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      try { result.push(toScopedKey(entry, roots)); } catch { /* 单条非法路径跳过，不中断整组 */ }
    }
    return [...new Set(result)].sort();
  };

  for (const record of candidates) {
    context?.signal?.throwIfAborted();
    progress('读取检查点清单', record.id);
    checkpointConsumed = new Set<string>();
    try {
      const checkpointId = record.id;
      if (!safeCheckpointDir.test(checkpointId) && !safeConversationId.test(checkpointId)) continue;
      const backupDir = typeof record.backupDir === 'string' ? record.backupDir : checkpointId;
      const { manifest, filesMap } = await loadOldManifest(backupDir);
      const manifestRoots = manifest && Array.isArray((manifest as Record<string, unknown>).workspaceRoots)
        ? cloneRoots((manifest as Record<string, unknown>).workspaceRoots)
        : [];
      const recordRoots = cloneRoots(record.workspaceRoots);
      let roots = manifestRoots.length > 0 ? manifestRoots : recordRoots;
      if (roots.length === 0 && typeof metaObject.workspaceUri === 'string' && metaObject.workspaceUri.startsWith('file://')) {
        const uri = metaObject.workspaceUri;
        roots = [{ id: createWorkspaceRootId(uri), name: path.basename(fileURLToPath(uri)), uri }];
      }
      if (roots.length === 0) throw new Error('检查点缺少原工作区身份，无法确定恢复目录。');
      const workspaceId = `legacy-${conversationId}`;
      const directory = directoryOfRoot(roots[0]);

      let fullKeys: string[] = [];
      if (filesMap) fullKeys = Object.keys(filesMap);
      else if (record.fileHashes && typeof record.fileHashes === 'object' && !Array.isArray(record.fileHashes)) {
        fullKeys = Object.keys(record.fileHashes as Record<string, unknown>);
      }
      if (!filesMap && !record.fileHashes) throw new Error('检查点文件清单缺失，不能作为空快照导入。');
      const sourceKeys = new Map(fullKeys.map(key => [toScopedKey(key, roots), key]));
      const scopedKeys = [...sourceKeys.keys()].sort();

      // 增量链回溯：目标缺失的字节沿 base 链向上找，使清单自包含。
      const chain: CheckpointRecordLike[] = [];
      const seen = new Set<string>();
      let cursor: CheckpointRecordLike | undefined = record;
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        chain.push(cursor);
        const baseId = typeof cursor.baseCheckpointId === 'string' ? cursor.baseCheckpointId : undefined;
        cursor = baseId ? byId.get(baseId) : undefined;
      }

      const resolved = new Map<string, { bytes: Uint8Array; mode: number; hash: string }>();
      for (const scopedKey of scopedKeys) {
        context?.signal?.throwIfAborted();
        progress(`转换检查点 ${record.id}（${resolved.size}/${scopedKeys.length} 个文件）`, scopedKey);
        const rawKey = sourceKeys.get(scopedKey)!;
        const fileEntry = filesMap?.[rawKey] as { hash?: string; backupSourceCheckpointId?: string } | undefined;
        const expectedHash = fileEntry?.hash ?? (record.fileHashes as Record<string, string> | undefined)?.[rawKey];
        if (typeof expectedHash !== 'string' || !/^[a-f0-9]{32}$/i.test(expectedHash)) throw new Error(`文件缺少有效哈希：${scopedKey}`);
        const source = fileEntry?.backupSourceCheckpointId ? byId.get(fileEntry.backupSourceCheckpointId) : undefined;
        if (fileEntry?.backupSourceCheckpointId && !source) throw new Error(`缺少引用的备份节点：${fileEntry.backupSourceCheckpointId}`);
        for (const node of source ? [source, ...chain] : chain) {
          const nodeBackupDir = typeof node.backupDir === 'string' ? node.backupDir : node.id;
          const found = await readBackupBytes(nodeBackupDir, scopedKey, roots);
          if (found && found.hash === expectedHash.toLowerCase()) { resolved.set(scopedKey, found); break; }
        }
        if (!resolved.has(scopedKey)) throw new Error(`备份文件缺失或与清单不符：${scopedKey}`);
      }

      const files: Record<string, { hash: string; size: number; mode: number }> = {};
      const contentIds: Record<string, string> = {};
      for (const [scopedKey, content] of [...resolved.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        files[scopedKey] = { hash: content.hash, size: content.bytes.byteLength, mode: content.mode };
        contentIds[scopedKey] = `${checkpointId}-${sha256Hex(scopedKey)}`;
      }

      const manifestExcluded = manifest && Array.isArray((manifest as Record<string, unknown>).excluded)
        ? (manifest as Record<string, unknown>).excluded as unknown[]
        : null;
      let excluded: Record<string, unknown>[];
      if (manifestExcluded) {
        excluded = [];
        for (const entry of manifestExcluded) {
          if (!entry || typeof entry !== 'object') continue;
          const cloned = structuredClone(entry) as Record<string, unknown>;
          if (typeof cloned.path === 'string') {
            try { cloned.path = toScopedKey(cloned.path, roots); } catch { continue; }
          } else continue;
          excluded.push(cloned);
        }
        excluded.sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0);
      } else {
        const unbacked = Array.isArray(record.unbackedPaths) ? record.unbackedPaths as unknown[] : [];
        excluded = [];
        for (const entry of unbacked) {
          if (typeof entry !== 'string') continue;
          try { excluded.push({ path: toScopedKey(entry, roots), reason: 'unreadable', source: 'legacy' }); } catch { /* 跳过 */ }
        }
        excluded.sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0);
      }

      const manifestEmpty = manifest && Array.isArray((manifest as Record<string, unknown>).emptyDirs)
        ? (manifest as Record<string, unknown>).emptyDirs : record.emptyDirs;
      const emptyDirs = toScopedList(manifestEmpty, roots);
      const manifestAbsent = manifest && Array.isArray((manifest as Record<string, unknown>).absentPaths)
        ? (manifest as Record<string, unknown>).absentPaths : record.absentPaths;
      const absentPaths = toScopedList(manifestAbsent, roots);
      const partial = (manifest as Record<string, unknown> | null)?.partial === true || record.partial === true;

      // 空快照（无文件、无空目录、无排除）且备份目录缺失时跳过，避免凭空造出空检查点。
      if (resolved.size === 0 && emptyDirs.length === 0) {
        const backupPath = path.join(checkpointsDir, backupDir);
        let exists = false;
        try { exists = (await fs.stat(backupPath)).isDirectory(); } catch { exists = false; }
        if (!exists) continue;
        // 备份目录存在但无可解析文件时仍保留空清单（真空工作区快照），便于恢复侧显式处理。
      }

      const timestamp = typeof record.timestamp === 'number' ? record.timestamp : 0;
      const messageIndex = Number.isSafeInteger(record.messageIndex) ? (record.messageIndex as number) : 0;
      const toolName = typeof record.toolName === 'string' && record.toolName.length > 0 ? record.toolName : 'legacy';
      const phase = record.phase === 'before' ? 'before' : 'after';
      const messageNodeId = typeof record.messageNodeId === 'string' ? record.messageNodeId : undefined;
      const manifestValue = {
        ...(manifest?.ignoreSnapshot ? { ignoreSnapshot: manifest.ignoreSnapshot } : record.ignoreSnapshot ? { ignoreSnapshot: record.ignoreSnapshot } : {}),
        version: 1 as const,
        workspaceId,
        roots: roots.map(root => ({ id: root.id, name: root.name, uri: root.uri })),
        partial,
        files,
        excluded,
        absentPaths,
        emptyDirs,
      };
      const checkpointValue = {
        id: checkpointId,
        conversationId,
        workspaceId,
        directory,
        timestamp,
        messageIndex,
        ...(messageNodeId ? { messageNodeId } : {}),
        toolName,
        phase,
        manifest: manifestValue,
        contentIds,
      };
      const checkpointRecords: typeof records = [{ namespace: 'workspace-checkpoints', id: checkpointId, ownerId: conversationId, value: checkpointValue }];
      for (const [scopedKey, content] of resolved) {
        checkpointRecords.push({ namespace: 'workspace-checkpoint-content', id: contentIds[scopedKey], ownerId: conversationId, value: content.bytes });
      }
      context?.signal?.throwIfAborted();
      if (context?.writeRecords) await context.writeRecords(checkpointRecords);
      else records.push(...checkpointRecords);
      for (const file of checkpointConsumed) if (!consumedSet.has(file)) { consumedSet.add(file); consumed.push(file); }
    } catch (error) {
      context?.signal?.throwIfAborted();
      issues.push({ conversationId, path: path.join(checkpointsDir, record.id), code: 'CORRUPT_DATA', message: String(error) });
      continue;
    } finally {
      completedCheckpoints++;
      progress('已处理检查点', record.id);
    }
  }
  return { records, consumed, issues };
}

/** 独立宿主迁移组合层：core 只做安全读取/记录，server 注入分支与检查点语义转换。 */
export class MigrationService {
  private active?: { id: string; controller: AbortController; status: MigrationStatus; lastPublishedAt: number };
  private latestStatus: MigrationStatus = { active: false };
  readonly configurations: ConfigurationMigration;
  constructor(private readonly app: PlatformApplication) { this.configurations = new ConfigurationMigration(app); }
  cancel(actorId: string) {
    this.app.requireOwner(actorId);
    if (this.active) {
      this.active.status.state = 'cancelling';
      this.active.controller.abort(new Error('主人取消了迁移，已保存的数据可以在再次导入时续传。'));
      this.app.publish({ type: 'migration.progress', ...this.status(actorId) });
    }
    return { success: true };
  }
  status(actorId: string): MigrationStatus { this.app.requireOwner(actorId); return structuredClone(this.active?.status ?? this.latestStatus); }
  start(actorId: string, source: string, options: ServerMigrationOptions = {}): MigrationStatus {
    this.app.requireOwner(actorId);
    if (this.active) throw new Error('已有迁移正在执行，请先等待完成或取消。');
    // 核心持有迁移，界面请求只负责启动；长任务不占用设置请求队列。
    void this.importDirectory(actorId, source, options).catch(() => {});
    return this.status(actorId);
  }

  workspaceRoots(actorId: string, conversationId: string) { return migrationWorkspaceRoots(this.app, actorId, conversationId); }
  bindWorkspace(actorId: string, conversationId: string, workspaceId: string, mapping?: Record<string, string>) {
    return bindMigrationWorkspace(this.app, actorId, conversationId, workspaceId, mapping);
  }

  async importDirectory(actorId: string, source: string, options: ServerMigrationOptions = {}) {
    this.app.requireOwner(actorId);
    if (this.active) throw new Error('已有迁移正在执行，请先等待完成或取消。');
    const now = Date.now();
    const operation = { id: randomUUID(), controller: new AbortController(), lastPublishedAt: 0,
      status: { active: true, source, state: 'running', startedAt: now, updatedAt: now } as MigrationStatus };
    operation.status.operationId = operation.id;
    this.active = operation;
    const update = (progress: MigrationProgress) => {
      const changed = progress.phase !== operation.status.progress?.phase;
      operation.status.progress = progress; operation.status.updatedAt = Date.now();
      // 文件读取可每个数据块回报，传输最多每 150ms 更新一次，阶段切换立即发送。
      if (changed || Date.now() - operation.lastPublishedAt >= 150) {
        operation.lastPublishedAt = Date.now();
        this.app.publish({ type: 'migration.progress', ...this.status(actorId) });
      }
      options.onStatus?.(progress);
    };
    try {
    update({ phase: 'scanning', detail: '检查旧数据目录', currentItem: source });
    const root = await validateLegacyImportPaths(source, this.app.storage.directory);
    let memory: MemoryImportReport | undefined;
    let skills: SkillImportReport | undefined;
    let configurationFiles: ConfigurationFile[] = [];
    let activity: ActivityImportReport | undefined;
    let runtimeAssets: RuntimeAssetReport | undefined;
    const report = await importLegacyHistory(this.app.storage, root, {
      ...options,
      signal: operation.controller.signal,
      onStatus: update,
      onProgress: progress => {
        options.onProgress?.(progress);
      },
      conversationIds: options.conversationIds,
      convertBranch: async (conversationId, value) => {
        const converted = await convertBranch(conversationId, value) as { version: number; graph: ConversationBranchGraph; groups: Record<string, unknown[]> };
        // 主历史仍保留原工具结果消息 ID；只为旧图没有保存的非活跃响应生成确定标识。
        Object.assign(converted.groups, groupMessages((await this.app.storage.readFullHistory(conversationId)).messages));
        return converted;
      },
      convertCheckpoint,
      convertUsage: async (id, value) => validateLegacyUsageIndex(value, id),
      importAdditionalArtifacts: options.conversationIds ? undefined : async () => {
        operation.controller.signal.throwIfAborted();
        update({ phase: 'memory', detail: '导入长期记忆' });
        memory = await new LegacyMemoryImporter(this.app).run(actorId, root, operation.controller.signal);
        update({ phase: 'skills', detail: '导入技能及附属文件' });
        skills = await importLegacySkills(this.app, actorId, root, operation.controller.signal);
        update({ phase: 'activity', detail: '导入使用时间记录' });
        activity = await importLegacyActivity(this.app, actorId, root, operation.controller.signal);
        update({ phase: 'runtimeAssets', detail: '等待依赖与词表目录可用' });
        runtimeAssets = await importRuntimeAssets(this.app, actorId, root, operation.controller.signal, update);
        update({ phase: 'configuration', detail: '识别旧配置文件' });
        const configurations = await this.configurations.inspect(root, operation.controller.signal);
        configurationFiles = configurations.files;
        return { consumed: [...memory.consumed, ...skills.consumed, ...activity.consumed, ...runtimeAssets.consumed, ...configurations.consumed], issues: [...memory.issues, ...skills.issues, ...activity.issues, ...runtimeAssets.issues, ...configurations.issues],
          importedUnits: memory.imported.length + memory.skipped.length + skills.imported.length + skills.skipped.length + activity.imported.length + activity.skipped.length + runtimeAssets.imported.length + runtimeAssets.skipped.length + configurations.importedUnits };
      },
    });
    operation.controller.signal.throwIfAborted();
    // 取消可能发生在历史已提交、归属尚未保存之间，续传时也要补齐这些字段。
    const conversations = [...report.imported, ...report.skipped];
    for (const [index, id] of conversations.entries()) {
      operation.controller.signal.throwIfAborted();
      update({ phase: 'finalizing', detail: '保存迁入对话归属', currentItem: id, completed: index, total: conversations.length, unit: '个对话' });
      const state = await this.app.storage.readConversationState(id);
      if (state.metadata.actorId === actorId && state.metadata.legacySource === root) continue;
      await this.app.storage.commitConversation({ conversationId: id, expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken,
        metadata: { ...state.metadata, actorId, legacySource: root } });
    }
    const result = this.configurations.complete({ ...report, operationId: operation.id, configurationFiles, ...(runtimeAssets ? { runtimeAssets: { imported: runtimeAssets.imported, skipped: runtimeAssets.skipped } } : {}), ...(activity ? { activity: { imported: activity.imported, skipped: activity.skipped } } : {}), ...(skills ? { skills: { imported: skills.imported, skipped: skills.skipped } } : {}), ...(memory ? { memory: { imported: memory.imported, skipped: memory.skipped } } : {}) });
    update({ phase: 'finalizing', detail: '保存迁移报告' });
    await this.app.storage.commitRecords([{ namespace: 'migration-reports', id: operation.id, ownerId: actorId, value: result },
      { namespace: 'migration-latest', id: actorId, ownerId: actorId, value: { operationId: operation.id } }]);
    this.app.productUi.conversations.clearMetadataCache();
    this.app.publish({ type: 'migration.completed', operationId: operation.id, report: result });
    operation.status.state = 'completed';
    return result;
    } catch (error) {
      operation.status.state = operation.controller.signal.aborted ? 'cancelled' : 'failed';
      operation.status.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      operation.status.active = false; operation.status.updatedAt = Date.now();
      this.latestStatus = operation.status;
      if (this.active === operation) this.active = undefined;
      this.app.publish({ type: 'migration.progress', ...this.status(actorId) });
    }
  }
}
