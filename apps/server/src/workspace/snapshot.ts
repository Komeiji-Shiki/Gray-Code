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
  files: WorkspaceSnapshotFile[];
}

export interface CollectWorkspaceSnapshotOptions {
  workspace: WorkspaceDefinition;
  config: CheckpointConfig;
  dataDirectory: string;
  signal: AbortSignal;
  affectedPaths?: string[];
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("SNAPSHOT_ABORTED");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
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
  });
  checkAborted(options.signal);

  const files: WorkspaceSnapshotFile[] = [];
  const manifestFiles: WorkspaceSnapshotManifest["files"] = {};
  for (const [scopedPath, expectedHash] of Object.entries(built.fileHashes)) {
    checkAborted(options.signal);
    const parsed = parseWorkspaceScopedPath(scopedPath, roots);
    const absolutePath = await resolveSafePathInsideRoot(parsed.root.fsPath, parsed.relativePath);
    const [bytes, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    const actualHash = hashBytes(bytes);
    if (actualHash !== expectedHash) {
      throw new Error(`SNAPSHOT_CONFLICT: ${scopedPath} changed while collecting`);
    }
    const mode = metadata.mode & 0o777;
    manifestFiles[scopedPath] = { hash: actualHash, size: bytes.byteLength, mode };
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
  };
}
