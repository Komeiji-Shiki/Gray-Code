import { resolveWorkspacePath, workspaceSnapshotRoots } from './paths';
import { buildIgnoreSnapshot } from '../../../../backend/modules/checkpoint/CheckpointExclusionProfiles';
import type { CheckpointIgnoreSnapshot } from '../../../../backend/modules/checkpoint/types';
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { WorkspaceDefinition } from "@graycode/contracts";
import type { CheckpointConfig } from "../../../../backend/modules/settings/types/checkpointTypes";
import {
  buildWorkspaceSnapshot,
  type CheckpointSnapshotBuildResult,
} from "../../../../backend/modules/checkpoint/CheckpointSnapshotBuilder";
import {
  parseWorkspaceScopedPath,
  resolveSafePathInsideRoot,
} from "../../../../backend/modules/checkpoint/CheckpointWorkspace";

export interface WorkspaceSnapshotManifest {
  version: 1;
  ignoreSnapshot?: CheckpointIgnoreSnapshot;
  workspaceId: string;
  roots: Array<{ id: string; name: string; uri: string }>;
  partial: boolean;
  files: Record<string, {
    hash: string;
    size: number;
    mode: number;
    /** 采集时的修改时间；下一次快照据此跳过未变化文件的重新哈希。旧清单没有该字段时按内容重新计算。 */
    mtimeMs?: number;
    mtimeNs?: string;
  }>;
  excluded: CheckpointSnapshotBuildResult["excluded"];
  absentPaths: string[];
  emptyDirs: string[];
}

export interface WorkspaceSnapshotFile {
  path: string;
  bytes: Uint8Array;
  mode: number;
}

export interface WorkspaceSnapshot {
  manifest: WorkspaceSnapshotManifest;
  /** 与基线内容不同、需要新保存的文件。 */
  files: WorkspaceSnapshotFile[];
  /** 与基线内容哈希相同的文件，直接沿用基线的不可变内容记录。 */
  reused: Record<string, string>;
}

/** 同一工作区上一次已发布的检查点；清单和内容记录都不可变，可以按文件复用。 */
export interface WorkspaceSnapshotBase {
  manifest: WorkspaceSnapshotManifest;
  contentIds: Record<string, string>;
}

export interface CollectWorkspaceSnapshotOptions {
  workspace: WorkspaceDefinition;
  config: CheckpointConfig;
  dataDirectory: string;
  signal: AbortSignal;
  affectedPaths?: string[];
  base?: WorkspaceSnapshotBase;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("SNAPSHOT_ABORTED");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

/** 只有基线里确实保存了内容的文件才能作为哈希与 stat 的复用来源。 */
function previousFromBase(base: WorkspaceSnapshotBase | undefined) {
  if (!base) return undefined;
  const fileHashes: Record<string, string> = {};
  const fileStats: Record<string, { mtimeMs: number; size: number; mtimeNs?: string }> = {};
  for (const [file, entry] of Object.entries(base.manifest.files)) {
    if (!base.contentIds[file]) continue;
    fileHashes[file] = entry.hash;
    if (typeof entry.mtimeMs === "number") fileStats[file] = { mtimeMs: entry.mtimeMs, size: entry.size, mtimeNs: entry.mtimeNs };
  }
  return { fileHashes, fileStats };
}

/** 采集工作区快照；只返回内存数据，存储和外层写锁由调用方负责。 */
export async function collectWorkspaceSnapshot(
  options: CollectWorkspaceSnapshotOptions,
): Promise<WorkspaceSnapshot> {
  checkAborted(options.signal);
  const roots = workspaceSnapshotRoots(options.workspace);
  const exclusion = options.config.exclusion;
  const built = await buildWorkspaceSnapshot({
    roots,
    signal: options.signal,
    customIgnorePatterns: [
      ...(options.config.customIgnorePatterns ?? []),
      ...(exclusion?.customPatterns ?? []),
    ],
    enabledProfiles: exclusion?.enabledProfiles,
    profilePatterns: exclusion?.profilePatterns,
    maxFileSizeBytes: exclusion?.maxFileSizeBytes,
    // 平台数据目录若位于工作区内，必须从快照边界排除，避免宿主数据被自包含采集。
    excludeAbsolutePaths: [options.dataDirectory],
    affectedPaths: options.affectedPaths?.map(file => resolveWorkspacePath(options.workspace, file)),
    previous: previousFromBase(options.base),
  });
  checkAborted(options.signal);

  const files: WorkspaceSnapshotFile[] = [];
  const reused: Record<string, string> = {};
  const manifestFiles: WorkspaceSnapshotManifest["files"] = {};
  for (const [scopedPath, expectedHash] of Object.entries(built.fileHashes)) {
    checkAborted(options.signal);
    const observed = built.fileStats[scopedPath];
    const baseContentId = options.base?.contentIds[scopedPath];
    // 内容哈希与基线一致时沿用已保存的字节，不再读取、传递和压缩同一份内容。
    if (baseContentId && observed?.mode !== undefined && options.base?.manifest.files[scopedPath]?.hash === expectedHash) {
      manifestFiles[scopedPath] = { hash: expectedHash, size: observed.size, mode: observed.mode, mtimeMs: observed.mtimeMs, mtimeNs: observed.mtimeNs };
      reused[scopedPath] = baseContentId;
      continue;
    }
    const parsed = parseWorkspaceScopedPath(scopedPath, roots);
    const absolutePath = await resolveSafePathInsideRoot(parsed.root.fsPath, parsed.relativePath);
    const [bytes, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath, { bigint: true })]);
    const actualHash = hashBytes(bytes);
    if (actualHash !== expectedHash) {
      throw new Error(`SNAPSHOT_CONFLICT: ${scopedPath} changed while collecting`);
    }
    const mode = Number(metadata.mode) & 0o777;
    manifestFiles[scopedPath] = { hash: actualHash, size: bytes.byteLength, mode, mtimeMs: Number(metadata.mtimeMs), mtimeNs: metadata.mtimeNs.toString() };
    files.push({ path: scopedPath, bytes: new Uint8Array(bytes), mode });
  }

  const partial = Boolean(options.affectedPaths?.length);
  return {
    manifest: {
      version: 1,
      workspaceId: options.workspace.id,
      roots: roots.map(({ id, name, uri }) => ({ id, name, uri })),
      partial,
      files: manifestFiles,
      excluded: built.excluded,
      ignoreSnapshot: buildIgnoreSnapshot({ enabledProfiles: exclusion?.enabledProfiles, profilePatterns: exclusion?.profilePatterns,
        maxFileSizeBytes: exclusion?.maxFileSizeBytes, customPatterns: [...(options.config.customIgnorePatterns ?? []), ...(exclusion?.customPatterns ?? [])] }),
      absentPaths: built.absent,
      emptyDirs: built.emptyDirs,
    },
    files,
    reused,
  };
}
