/**
 * CheckpointBackupExecutor - 检查点备份执行器（第二批拆分）。
 *
 * 从 CheckpointManager.createCheckpoint 抽出的「锁内」备份执行主体：
 * 扫描工作区 → 文件哈希 → 复制到备份目录 → manifest 写入 → 进度上报。
 * 方法体原样平移，纯重构；锁（CheckpointOperationLock）获取仍留在
 * CheckpointManager.createCheckpoint（本类只做锁内工作，调用方必须已持有
 * 工作区级存档锁并完成参数校验 / 进度注册）。
 */

import { t } from '../../i18n';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { hashFileStreaming } from './fileHashing';
import type { ConversationManager } from '../conversation';
import type { CheckpointConfig } from '../settings';
import { buildWorkspaceSnapshot, type SnapshotFileStat } from './CheckpointSnapshotBuilder';
import { DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES, buildIgnoreSnapshot } from './CheckpointExclusionProfiles';
import { toScopedKey } from './CheckpointRestoreEngine';
import { createWorkspaceSnapshot, parseWorkspaceScopedPath, type RuntimeWorkspaceRoot } from './CheckpointWorkspace';
import { Logger } from '../../core/logger';
import type {
    CheckpointManifest,
    CheckpointOperationProgress,
    CheckpointRecord,
    FileChange
} from './types';
import { CheckpointManifestRepository, CHECKPOINT_MANIFEST_VERSION } from './CheckpointManifestRepository';
import type { CheckpointQueryService } from './CheckpointQueryService';
import type { CheckpointRetentionService } from './CheckpointRetentionService';
import { runBounded, DEFAULT_CHECKPOINT_CONCURRENCY, throwIfAborted, CheckpointAbortError } from './checkpointConcurrency';

const log = Logger.get('CheckpointBackupExecutor');

/** C-13: copyFileToBackup 单次操作逐文件告警上限（其余失败由 unbackedPaths 统计聚合，避免超大备份刷屏） */
const MAX_COPY_FAILURE_WARN = 10;

/** CheckpointBackupExecutor 依赖（由 CheckpointManager 构造时注入，避免反向引用造成循环依赖） */
export interface CheckpointBackupExecutorDeps {
    /** 扩展存储下的 checkpoints 根目录（扫描排除绝对路径 = 其父目录） */
    checkpointsDir: string;
    manifestRepository: CheckpointManifestRepository;
    queryService: CheckpointQueryService;
    retentionService: CheckpointRetentionService;
    conversationManager: ConversationManager;
}

/** executeBackup 入参（CheckpointManager.createCheckpoint 壳层解析/校验后传入） */
export interface CheckpointBackupExecutorParams {
    conversationId: string;
    messageIndex: number;
    toolName: string;
    phase: 'before' | 'after';
    /** BCP-01：消息节点 ID（树状分支定位预留），仅附加写入记录 */
    messageNodeId?: string;
    /** 当前检查点配置（壳层已读取，与壳层校验使用同一对象，避免口径漂移） */
    config: Readonly<CheckpointConfig>;
    checkpointId: string;
    backupDir: string;
    roots: RuntimeWorkspaceRoot[];
    signal: AbortSignal;
    reportProgress: (patch: Partial<CheckpointOperationProgress>) => void;
}

/**
 * 检查点备份执行器
 */
export class CheckpointBackupExecutor {
    /** C-13: 本次复制失败已打印的逐文件告警条数（超上限后静默，由 unbackedPaths 统计兜底） */
    private copyFailureWarnCount = 0;

    constructor(private readonly deps: CheckpointBackupExecutorDeps) {}

    /**
     * 执行备份（调用方必须已持有工作区级存档锁）。
     *
     * 与旧 CheckpointManager.createCheckpoint 锁内主体逐位一致：
     * - 先复制全部成功文件（复制失败经 markUnbacked 剔除后再删除，保证 fileHashes
     *   只声称真正备份成功的文件）；
     * - 进度上报顺序：copying(0/total) → copying(processed) → cleaning → done；
     * - 写 manifest / 写会话记录前检查取消；失败回收已创建的备份目录并返回 null。
     *
     * @returns 成功返回带完整哈希/统计的记录（兼容调用方/测试）；失败返回 null
     */
    async executeBackup(params: CheckpointBackupExecutorParams): Promise<CheckpointRecord | null> {
        const {
            conversationId,
            messageIndex,
            toolName,
            phase,
            messageNodeId,
            config,
            checkpointId,
            backupDir,
            roots,
            signal,
            reportProgress
        } = params;
        const deps = this.deps;

        // C-13: 实例级告警计数在每次创建开始时复位——实例跨多次创建复用，
        // 不复位会导致后续创建的复制失败被静默吞掉（计数超上限后不再逐文件告警）
        this.copyFailureWarnCount = 0;
        let backupDirCreated = false;

        try {
            // 创建备份目录
            await fs.mkdir(backupDir, { recursive: true });
            backupDirCreated = true;

            // 获取该对话的上一个检查点：增量备份与 stat 哈希复用都依赖它
            const existingCheckpoints = await this.readCheckpointListFromConversation(conversationId);
            let lastCheckpoint = existingCheckpoints.length > 0
                ? existingCheckpoints[existingCheckpoints.length - 1]
                : null;

            // CPF-01: 新格式记录元数据不含 fileHashes/fileStats，增量比较前从 manifest 回填
            if (lastCheckpoint) {
                lastCheckpoint = await deps.manifestRepository.enrichRecord(lastCheckpoint);
            }

            // CP-01: 同一对话切换工作区后，新存档不再串接到旧增量链上。
            // 旧链的文件归属不同工作区，跨工作区增量会让恢复链错乱；
            // 识别到身份不一致时从新的完整备份开始。
            const workspaceSnapshot = createWorkspaceSnapshot(roots);
            if (
                lastCheckpoint &&
                lastCheckpoint.workspaceFingerprint &&
                lastCheckpoint.workspaceFingerprint !== workspaceSnapshot.workspaceFingerprint
            ) {
                log.info('checkpoint_chain_reset', {
                    conversationId,
                    previousFingerprint: lastCheckpoint.workspaceFingerprint,
                    currentFingerprint: workspaceSnapshot.workspaceFingerprint
                });
                lastCheckpoint = null;
            }

            // 用快照构建器扫描全部工作区根：
            // - 多根扫描（每个根独立 .gitignore 作用域）
            // - 强制排除存档目录自身（防止存档把自己再次备份）
            // - 流式哈希 + 有界并发（不再整文件 readFile、不再无限 Promise.all）
            // - stat 未变化的文件复用上一快照哈希（统一使用 scoped 键比较）
            const snapshot = await buildWorkspaceSnapshot({
                roots,
                // EX-01/EX-08: 自定义模式（旧字段 + 新 exclusion.customPatterns 合并，向后兼容）
                customIgnorePatterns: [
                    ...(config.customIgnorePatterns ?? []),
                    ...(config.exclusion?.customPatterns ?? [])
                ],
                // EX-01: 默认排除类别（设置页可分别关闭；缺省全部启用）
                enabledProfiles: config.exclusion?.enabledProfiles,
                // 每类别自定义模式覆盖（设置页可编辑；缺省/空 = 使用类别默认清单）
                profilePatterns: config.exclusion?.profilePatterns,
                // EX-07: 单文件大小上限（默认 50 MiB，0=不限制）
                maxFileSizeBytes: config.exclusion?.maxFileSizeBytes ?? DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
                // 排除整个扩展存储根（含 checkpoints/memory/conversations 等）：
                // 自定义数据目录位于工作区内时，扩展自身数据绝不能进入存档
                excludeAbsolutePaths: [path.dirname(deps.checkpointsDir)],
                previous: lastCheckpoint
                    ? {
                        fileHashes: this.normalizeHashesToScoped(lastCheckpoint.fileHashes ?? {}, roots),
                        fileStats: this.normalizeStatsToScoped(lastCheckpoint.fileStats ?? {}, roots)
                    }
                    : undefined
            });

            // 当前快照的哈希/统计：备份复制失败的文件从这里剔除，
            // 保证 fileHashes 只声称真正备份成功的文件，同时让下一个检查点重新尝试备份
            const currentHashes: Record<string, string> = { ...snapshot.fileHashes };
            const currentStats: Record<string, SnapshotFileStat> = { ...snapshot.fileStats };
            const unbackedPaths: string[] = [];
            // CP-PERF-2: Set 旁路去重——sizeExcluded/unreadable 达十万级时逐条
            // Array.includes 是 O(n²)；Set.has 为 O(1)，输出顺序保持插入序不变。
            const unbackedPathSet = new Set<string>();
            const markUnbacked = (scopedPath: string) => {
                unbackedPaths.push(scopedPath);
                unbackedPathSet.add(scopedPath);
                delete currentHashes[scopedPath];
                delete currentStats[scopedPath];
            };

            // 判断是否可以进行增量备份
            let isIncremental = false;
            let baseCheckpointId: string | undefined;
            let changes: FileChange[] = [];
            let fileCount = 0;
            let backupBytes = 0;
            let copiedCount = 0;

            if (lastCheckpoint && lastCheckpoint.fileHashes) {
                // 旧存档（相对路径键）与当前 scoped 键统一后比较，兼容旧增量链
                const previousHashes = this.normalizeHashesToScoped(lastCheckpoint.fileHashes, roots);

                // 计算变更
                const { added, modified, deleted } = this.computeChanges(
                    previousHashes,
                    currentHashes
                );

                // 始终使用增量备份（只要有上一个检查点）
                // 增量备份的主要目的是节省磁盘空间，恢复时性能差异可忽略
                isIncremental = true;
                baseCheckpointId = lastCheckpoint.id;

                // 构建变更列表（scoped 键）
                changes = [
                    ...added.map(p => ({ path: p, type: 'added' as const, hash: currentHashes[p] })),
                    ...modified.map(p => ({ path: p, type: 'modified' as const, hash: currentHashes[p] })),
                    ...deleted.map(p => ({ path: p, type: 'deleted' as const }))
                ];

                // 只复制变更的文件（如果没有变更，则不复制任何文件）
                // 备份布局：backupDir/ws_xxx/relative（多根安全；旧存档为 backupDir/relative）
                // CPF-06/CPF-11: 有界并发复制 + 取消检查 + 进度上报
                const copyTargets = changes.filter(c => c.type !== 'deleted').map(c => c.path);
                reportProgress({ phase: 'copying', processed: 0, total: copyTargets.length });
                await runBounded(copyTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async scopedPath => {
                    throwIfAborted(signal);
                    // TOCTOU 防护：复制与哈希是两个时刻，期间文件可能被并发修改。
                    // 复制完成后重新哈希备份内容，与记录值不一致则回滚该备份文件
                    // （记录为 unbacked，下一个检查点重新备份），
                    // 避免“fileHashes 声称有备份、恢复时必报 hash_mismatch”的假完整状态。
                    const result = await this.copyFileToBackup(scopedPath, backupDir, roots, currentHashes[scopedPath]);
                    if (result.ok) {
                        fileCount++;
                        backupBytes += result.bytes;
                    } else {
                        markUnbacked(scopedPath);
                    }
                    copiedCount++;
                    reportProgress({ processed: copiedCount });
                });

                // 复制失败（markUnbacked 剔除）的文件已从 currentHashes 剔除，
                // changes 必须按同一口径过滤（复制失败发生在记录 change 之后）：
                // manifest.files 只含真正备份成功的文件，若 changes 仍引用未落盘路径，
                // 恢复/增量链会指向不存在的备份文件
                if (unbackedPathSet.size > 0) {
                    changes = changes.filter(c => !unbackedPathSet.has(c.path));
                }

                log.info('incremental_backup', { added: added.length, modified: modified.length, deleted: deleted.length, unbacked: unbackedPaths.length });
            }

            // 如果不是增量备份，进行完整备份
            if (!isIncremental) {
                // CPF-06/CPF-11: 有界并发复制 + 取消检查 + 进度上报
                const fullTargets = Object.keys(currentHashes).sort();
                reportProgress({ phase: 'copying', processed: 0, total: fullTargets.length });
                await runBounded(fullTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async scopedPath => {
                    throwIfAborted(signal);
                    const result = await this.copyFileToBackup(scopedPath, backupDir, roots);
                    if (result.ok) {
                        fileCount++;
                        backupBytes += result.bytes;
                    } else {
                        markUnbacked(scopedPath);
                    }
                    copiedCount++;
                    reportProgress({ processed: copiedCount });
                });

                // 备份空目录
                for (const scopedPath of snapshot.emptyDirs) {
                    try {
                        await fs.mkdir(path.join(backupDir, ...scopedPath.split('/')), { recursive: true });
                    } catch (err) {
                        console.warn(`[CheckpointManager] Failed to create empty dir ${scopedPath}:`, err);
                    }
                }

                log.info('full_backup', { fileCount, unbacked: unbackedPaths.length });
            }

            // 大小超限与不可读文件合并进 unbackedPaths：
            // 恢复时这些路径绝不能自动删除（protectedScopedPaths 边界）
            for (const entry of [...snapshot.sizeExcluded, ...snapshot.unreadable]) {
                if (!unbackedPathSet.has(entry.scopedPath)) {
                    unbackedPathSet.add(entry.scopedPath);
                    unbackedPaths.push(entry.scopedPath);
                }
            }

            // 计算综合内容签名（基于实际备份成功的文件集合）
            // 增量哈希：逐项直接 update，避免为十万级文件构建大字符串数组
            //（字节流与旧实现 hashParts.join('\n') 完全一致：项间 '\n'、无尾部 '\n'）
            const contentHashBuilder = crypto.createHash('sha256');
            let hashFirstPart = true;
            const updateHashPart = (part: string): void => {
                if (!hashFirstPart) {
                    contentHashBuilder.update('\n');
                }
                hashFirstPart = false;
                contentHashBuilder.update(part);
            };
            for (const scopedPath of Object.keys(currentHashes).sort()) {
                updateHashPart(`${scopedPath}:${currentHashes[scopedPath]}`);
            }
            for (const scopedPath of snapshot.emptyDirs) {
                updateHashPart(`${scopedPath}:empty-dir`);
            }
            const contentHash = contentHashBuilder.digest('hex').substring(0, 16);

            // CPF-01/EX-10: 完整数据（哈希/stat/空目录/变更/排除清单/规则快照）写入独立 manifest，
            // 会话元数据只保留摘要（fileHashes/fileStats 不再写入记录）
            const files: CheckpointManifest['files'] = {};
            for (const [scopedPath, hash] of Object.entries(currentHashes)) {
                const stat = currentStats[scopedPath];
                files[scopedPath] = {
                    hash,
                    size: stat?.size ?? 0,
                    mtimeMs: stat?.mtimeMs ?? 0,
                    mtimeNs: stat?.mtimeNs
                };
            }
            // CPF-01/EX-10: 排除规则快照（manifest 与记录使用同一对象，避免口径漂移）
            const exclusionSnapshot = buildIgnoreSnapshot({
                enabledProfiles: config.exclusion?.enabledProfiles,
                profilePatterns: config.exclusion?.profilePatterns,
                maxFileSizeBytes: config.exclusion?.maxFileSizeBytes ?? DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
                customPatterns: [
                    ...(config.customIgnorePatterns ?? []),
                    ...(config.exclusion?.customPatterns ?? [])
                ]
            });
            const manifest: CheckpointManifest = {
                version: CHECKPOINT_MANIFEST_VERSION,
                checkpointId,
                workspaceRoots: workspaceSnapshot.workspaceRoots,
                files,
                emptyDirs: snapshot.emptyDirs,
                changes: changes as CheckpointManifest['changes'],
                excluded: snapshot.excluded,
                ignoreSnapshot: exclusionSnapshot
            };
            // M5: 写 manifest 前检查取消（取消尾窗：避免取消发生在写前仍落盘）
            throwIfAborted(signal);
            await deps.manifestRepository.writeManifest(checkpointId, manifest);

            // 创建检查点记录
            const phaseText = phase === 'before'
                ? t('modules.checkpoint.description.before')
                : t('modules.checkpoint.description.after');
            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex,
                // BCP-01: 关联消息节点 ID（附加字段；旧存档/未传时缺省，读取端回退 index 定位）
                messageNodeId,
                toolName,
                phase,
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount,
                contentHash,
                description: `${phaseText}: ${toolName}`,
                type: isIncremental ? 'incremental' : 'full',
                baseCheckpointId: isIncremental ? baseCheckpointId : undefined,
                changes: isIncremental ? changes : undefined,
                ignorePatterns: config.customIgnorePatterns ?? [],
                // M-3: 记录补写死字段——排除统计与规则快照（与快照构建同一口径）
                excludedCount: snapshot.excluded.length,
                excludedBytes: snapshot.excluded.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
                ignoreSnapshot: exclusionSnapshot,
                unbackedPaths: unbackedPaths.length > 0 ? unbackedPaths.sort() : undefined,
                emptyDirs: snapshot.emptyDirs,
                workspaceRoots: workspaceSnapshot.workspaceRoots,
                workspaceFingerprint: workspaceSnapshot.workspaceFingerprint,
                // CPF-09: 创建时记录磁盘占用，设置页无需重复扫描目录
                backupBytes,
                manifestVersion: CHECKPOINT_MANIFEST_VERSION
            };

            // 保存到对话元数据（失败会抛出，由外层 catch 回收备份目录）
            // M5: 写前检查取消，避免取消发生在落盘前仍持久化
            throwIfAborted(signal);
            await this.saveCheckpointToConversation(conversationId, checkpoint);

            // 清理过期检查点
            reportProgress({ phase: 'cleaning' });
            await this.cleanupOldCheckpoints(conversationId);

            // M5: done 上报前检查取消——cancelOperation 已把进度置为 cancelled，
            // 这里不能再被 done 覆盖（取消尾窗竞态）
            reportProgress({ phase: signal.aborted ? 'cancelled' : 'done', cancelled: signal.aborted, processed: copiedCount, total: copiedCount });

            // 返回带完整哈希的记录（兼容调用方/测试）；元数据已按 CPF-01 精简
            return { ...checkpoint, fileHashes: currentHashes, fileStats: currentStats };

        } catch (err) {
            // 用户取消不算错误：降噪，仅记录取消状态
            if (!(err instanceof CheckpointAbortError)) {
                console.error('[CheckpointManager] Failed to create checkpoint:', err);
            }
            reportProgress({
                phase: signal.aborted ? 'cancelled' : 'failed',
                cancelled: signal.aborted,
                message: signal.aborted ? 'cancelled by user' : undefined
            });
            // 保证“记录没落盘 ⇔ 备份目录不存在”：回收已创建的备份目录，
            // 避免返回一个没持久化的幽灵检查点并泄漏备份目录
            if (backupDirCreated) {
                // L3: 目录回收前清掉 manifest 缓存，避免残留内存态
                deps.manifestRepository.clearCache(checkpointId);
                try {
                    await fs.rm(backupDir, { recursive: true, force: true });
                } catch (rmErr) {
                    console.warn('[CheckpointManager] Failed to recycle backup directory:', rmErr);
                }
            }
            return null;
        }
    }

    /**
     * 把快照中的单个 scoped 路径复制进备份目录（scoped 布局：backupDir/ws_xxx/relative）。
     *
     * @returns ok=复制成功并返回复制字节数（CPF-09 backupBytes 统计）；失败由调用方标记 unbacked。
     */
    private async copyFileToBackup(
        scopedPath: string,
        backupDir: string,
        roots: readonly RuntimeWorkspaceRoot[],
        expectedHash?: string
    ): Promise<{ ok: true; bytes: number } | { ok: false; bytes: 0 }> {
        try {
            const parsed = parseWorkspaceScopedPath(scopedPath, roots as RuntimeWorkspaceRoot[]);
            const srcPath = path.join(parsed.root.fsPath, ...parsed.relativePath.split('/'));
            const destPath = path.join(backupDir, ...scopedPath.split('/'));
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            const stat = await fs.stat(srcPath);
            await fs.copyFile(srcPath, destPath);
            // TOCTOU 防护：复制与哈希是两个时刻，期间文件可能被并发修改。
            // 复制完成后重新哈希备份内容，与记录值不一致则回滚该备份文件
            // （记录为 unbacked，下一个检查点重新备份），
            // 避免“fileHashes 声称有备份、恢复时必报 hash_mismatch”的假完整状态。
            if (expectedHash) {
                let backupHash: string;
                try {
                    backupHash = await hashFileStreaming(destPath);
                } catch {
                    backupHash = '';
                }
                if (backupHash !== expectedHash) {
                    console.warn(`[CheckpointManager] Backup hash mismatch for ${scopedPath}, rolling back`);
                    try {
                        await fs.rm(destPath, { force: true });
                    } catch { /* ignore rollback failure */ }
                    return { ok: false, bytes: 0 };
                }
            }
            return { ok: true, bytes: stat.size };
        } catch (err) {
            // C-13: 超大备份逐文件告警会刷屏——只打印前 MAX_COPY_FAILURE_WARN 条，
            // 其余由调用方的 unbackedPaths 统计/日志（full_backup/incremental_backup）聚合。
            if (this.copyFailureWarnCount < MAX_COPY_FAILURE_WARN) {
                this.copyFailureWarnCount += 1;
                console.warn(`[CheckpointManager] Failed to copy ${scopedPath}:`, err);
            }
            return { ok: false, bytes: 0 };
        }
    }

    private async readCheckpointListFromConversation(conversationId: string): Promise<CheckpointRecord[]> {
        return this.deps.queryService.getCheckpointRecords(conversationId);
    }

    /**
     * 保存检查点到对话元数据
     *
     * create 路径使用；CheckpointManager 保留同名私有委托（测试/兼容入口）。
     */
    async saveCheckpointToConversation(
        conversationId: string,
        checkpoint: CheckpointRecord
    ): Promise<void> {
        try {
            // 追加在链内原子完成：并发创建检查点时不会基于同一旧列表互相覆盖（记录丢失）
            await this.deps.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                return [...list, checkpoint];
            });
        } catch (err) {
            console.error('[CheckpointManager] Failed to save checkpoint to conversation:', err);
            throw err;
        }
    }

    /** 清理过期检查点（CPF-12：委托 CheckpointRetentionService） */
    private async cleanupOldCheckpoints(conversationId: string): Promise<void> {
        await this.deps.retentionService.cleanupOldCheckpoints(conversationId);
    }

    /**
     * 把存档键（可能为旧格式相对路径）归一化为 scoped 键。
     * 旧格式单根时按当前第一个根包装；多根下无法包装的键原样保留（不参与匹配）。
     */
    private normalizeHashesToScoped(
        fileHashes: Record<string, string>,
        roots: readonly RuntimeWorkspaceRoot[]
    ): Record<string, string> {
        return Object.fromEntries(
            Object.entries(fileHashes).map(([key, hash]) => [toScopedKey(key, roots), hash])
        );
    }

    private normalizeStatsToScoped(
        fileStats: Record<string, SnapshotFileStat>,
        roots: readonly RuntimeWorkspaceRoot[]
    ): Record<string, SnapshotFileStat> {
        return Object.fromEntries(
            Object.entries(fileStats).map(([key, stat]) => [toScopedKey(key, roots), stat])
        );
    }

    /**
     * 计算两个文件哈希映射之间的差异
     */
    private computeChanges(
        oldHashes: Record<string, string>,
        newHashes: Record<string, string>
    ): { added: string[]; modified: string[]; deleted: string[] } {
        const added: string[] = [];
        const modified: string[] = [];
        const deleted: string[] = [];
        
        // 检查新增和修改的文件
        for (const [path, hash] of Object.entries(newHashes)) {
            if (!(path in oldHashes)) {
                added.push(path);
            } else if (oldHashes[path] !== hash) {
                modified.push(path);
            }
        }
        
        // 检查删除的文件
        for (const path of Object.keys(oldHashes)) {
            if (!(path in newHashes)) {
                deleted.push(path);
            }
        }
        
        return { added, modified, deleted };
    }
}
