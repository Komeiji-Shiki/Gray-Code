/**
 * LimCode - 检查点模块
 *
 * 提供工作区备份和恢复功能
 *
 * 增量备份策略：
 * - 第一个检查点：完整备份所有文件
 * - 后续检查点：始终使用增量备份，只存储与上一个检查点相比有变化的文件
 * - 无变化时：创建空的增量备份（不复制任何文件，只记录文件哈希）
 * - 恢复时：从增量链中查找每个文件的最新版本
 *
 * CPF-01/CPF-12：完整存档数据（fileHashes/fileStats/excluded/ignoreSnapshot）写入
 * 独立 manifest（CheckpointManifestRepository），查询与保留策略拆分为独立服务。
 */

export { CheckpointManager } from './CheckpointManager';
export type {
    CheckpointRecord,
    FileChange,
    RestoreResult,
    RestorePreviewResult,
    CheckpointExcludedNote,
    BatchCheckpointDeleteItem,
    BatchCheckpointDeleteResult
} from './CheckpointManager';
export { CheckpointManifestRepository, CHECKPOINT_MANIFEST_VERSION } from './CheckpointManifestRepository';
export { CheckpointQueryService } from './CheckpointQueryService';
export { CheckpointRetentionService } from './CheckpointRetentionService';
export { runBounded, DEFAULT_CHECKPOINT_CONCURRENCY, CheckpointAbortError, throwIfAborted } from './checkpointConcurrency';
export type { CheckpointManifest, CheckpointSummary, CheckpointOperationProgress } from './types';

// 排除类别（EX-03~EX-06）与默认规则
export {
    CHECKPOINT_EXCLUSION_PROFILE_VERSION,
    FORCED_RULES_VERSION,
    CHECKPOINT_EXCLUSION_CONFIG_VERSION,
    DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
    DEFAULT_EXCLUSION_PROFILES,
    DEFAULT_ENABLED_PROFILES,
    getExclusionProfile,
    resolveEnabledProfiles,
    collectEnabledProfilePatterns,
    buildIgnoreSnapshot,
    validateCustomExclusionPatterns
} from './CheckpointExclusionProfiles';
export type {
    CheckpointExclusionProfile,
    CheckpointExclusionPatternIssueReason,
    CheckpointExclusionPatternIssue
} from './CheckpointExclusionProfiles';

// 存档引用计数清理
export {
    computeCheckpointReferenceCounts,
    setGlobalCheckpointRefCountCleaner,
    getGlobalCheckpointRefCountCleaner
} from './checkpointRefCounts';
export type {
    CheckpointRefCountGraphSource,
    CheckpointRefCountCleaner
} from './checkpointRefCounts';

// 忽略解析器
export { CheckpointIgnoreResolver } from './CheckpointIgnoreResolver';
export type {
    CheckpointIgnoreResult,
    CheckpointIgnoreResolverOptions,
    CheckpointResolverExcludedEntry,
    CheckpointSnapshotEntries
} from './CheckpointIgnoreResolver';

// 恢复引擎
export {
    isProtectedScopedPath,
    computeRestorePlan,
    isWorkspaceScopedKey,
    toScopedKey,
    restoreWorkspaceSnapshot
} from './CheckpointRestoreEngine';
export type {
    RestoreFailureReason,
    RestoreFailure,
    RestoreFileChangeType,
    RestoreFileChange,
    RestoreEngineResult,
    RestoreChainEntry,
    RestoreTargetState,
    RestoreEngineOptions,
    RestorePlan
} from './CheckpointRestoreEngine';

// 工作区根与 scoped 路径工具
export {
    CheckpointPathError,
    createWorkspaceRootId,
    createRuntimeWorkspaceRoots,
    createWorkspaceSnapshot,
    validateWorkspaceSnapshot,
    normalizeSafeCheckpointPath,
    createWorkspaceScopedPath,
    parseWorkspaceScopedPath,
    resolvePathInsideRoot,
    resolveSafePathInsideRoot
} from './CheckpointWorkspace';
export type {
    CheckpointWorkspaceRoot,
    RuntimeWorkspaceRoot,
    WorkspaceRootInput,
    CheckpointWorkspaceSnapshot,
    WorkspaceValidationResult
} from './CheckpointWorkspace';

// 快照构建与排除预览
export {
    buildWorkspaceSnapshot,
    previewExclusions
} from './CheckpointSnapshotBuilder';
export type {
    SnapshotFileStat,
    SnapshotExcludedEntry,
    SnapshotBuildOptions,
    CheckpointSnapshotBuildResult,
    ExclusionPreviewOptions
} from './CheckpointSnapshotBuilder';
