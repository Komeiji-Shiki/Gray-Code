/**
 * LimCode - 检查点管理器
 *
 * 负责工作区备份和恢复：
 * - 在工具执行前后创建工作区快照
 * - 存储检查点记录到对话元数据
 * - 支持恢复到指定检查点
 *
 * 增量备份策略：
 * - 第一个检查点：完整备份所有文件
 * - 后续检查点：始终使用增量备份，只复制有变化的文件（added/modified）
 * - 无变化时：创建空的增量备份，不复制任何文件
 * - 每个检查点都记录完整的文件哈希映射（fileHashes），用于增量比较和恢复
 */

import { t } from '../../i18n';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import type { SettingsManager } from '../settings/SettingsManager';
import type { ConversationManager } from '../conversation/ConversationManager';
import { getDiffManager } from '../../tools/file/diffManager';
import { isSafeRelativePath } from '../../core/idValidation';
import { buildWorkspaceSnapshot, type SnapshotFileStat } from './CheckpointSnapshotBuilder';
import { DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES, buildIgnoreSnapshot } from './CheckpointExclusionProfiles';
import {
    computeRestorePlan,
    restoreWorkspaceSnapshot,
    toScopedKey
} from './CheckpointRestoreEngine';
import {
    createRuntimeWorkspaceRoots,
    createWorkspaceSnapshot,
    parseWorkspaceScopedPath,
    type CheckpointWorkspaceRoot,
    type RuntimeWorkspaceRoot
} from './CheckpointWorkspace';
import { checkpointOperationLockManager, CHECKPOINT_LOCK_CANCELLED_MESSAGE } from './CheckpointOperationLock';
import { Logger } from '../../core/logger';
import type {
    CheckpointSummary,
    CheckpointManifest,
    CheckpointOperationProgress,
    CheckpointRecord,
    FileChange,
    RestorePreviewResult,
    BatchCheckpointDeleteItem,
    BatchCheckpointDeleteResult,
    RestoreFailure,
    RestoreFailureReason,
    CheckpointExcludedNote,
    RestoreResult
} from './types';
import { CheckpointManifestRepository, CHECKPOINT_MANIFEST_VERSION, isSafeCheckpointDirName } from './CheckpointManifestRepository';
import { CheckpointQueryService } from './CheckpointQueryService';
import { hashFileStreaming } from './fileHashing';
import { CheckpointRetentionService } from './CheckpointRetentionService';
import {
    DEFAULT_CHECKPOINT_CONCURRENCY,
    runBounded,
    throwIfAborted,
    CheckpointAbortError
} from './checkpointConcurrency';
// CPF-12: 恢复侧辅助拆分为独立服务/模块（方法体原样平移，纯重构）
import { CheckpointRestoreService } from './CheckpointRestoreService';
import { refreshAffectedDocuments } from './WorkspaceEditorRefresher';
// BCP-06: 引用计数扫描 + 清理器注册表（BranchService purge/prune 联动）；
// 本类作为生产实现自注册（见构造函数），不依赖注入链。
import { setGlobalCheckpointRefCountCleaner } from './checkpointRefCounts';

// L-11（R4 复查）：公共类型统一迁移到 ./types（单一真源），此处 re-export 兼容既有
// 导入路径（index.ts、CheckpointQueryService/RetentionService/ManifestRepository 等
// 仍从本模块导入这些类型，保持零改动）。
export type {
    FileChange,
    RestorePreviewResult,
    CheckpointRecord,
    BatchCheckpointDeleteItem,
    BatchCheckpointDeleteResult,
    RestoreFailure,
    RestoreFailureReason,
    CheckpointExcludedNote,
    RestoreResult
} from './types';

const log = Logger.get('CheckpointManager');

/**
 * BCP-06：计算「必须保留」的存档 ID 祖先闭包（CP-05 逻辑抽取，纯函数）。
 *
 * 从所有 keepIds（本次删除集合之外的保留记录）向前遍历完整 baseCheckpointId 祖先链：
 * 被保留记录直接或间接依赖的祖先都不能删（否则保留记录恢复时断链）。
 * 返回集合包含 keepIds 自身 + 全部祖先。
 *
 * 复用方：deleteCheckpointsBatch（CP-05）/ deleteCheckpointsByNodeIds（BCP-06 引用计数删除合并），
 * 保证「引用计数归零但被增量链引用为 base」的存档同样被拒绝。
 */
export function computeForcedKeepIds(
    records: readonly CheckpointRecord[],
    keepIds: ReadonlySet<string>
): Set<string> {
    const byId = new Map(records.map(cp => [cp.id, cp] as const));
    const forcedKeep = new Set<string>();
    for (const cp of records) {
        if (!keepIds.has(cp.id)) {
            continue;
        }
        forcedKeep.add(cp.id);
        let baseId = cp.baseCheckpointId;
        while (baseId && !forcedKeep.has(baseId)) {
            forcedKeep.add(baseId);
            baseId = byId.get(baseId)?.baseCheckpointId;
        }
    }
    return forcedKeep;
}

/**
 * 多工作区并发支持：归一化文件系统路径用于对比（反斜杠统一为斜杠、去尾部分隔符）。
 * 不做大小写折叠——VS Code 与 shim 的 Uri.fsPath 驱动盘符大小写一致，且不匹配时
 * 回退全根快照（安全降级）。
 */
function normalizeRootFsPath(fsPath: string): string {
    return String(fsPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 检查点管理器
 */
export class CheckpointManager {
    private checkpointsDir: string;

    private readonly manifestRepository: CheckpointManifestRepository;
    private readonly queryService: CheckpointQueryService;
    private readonly retentionService: CheckpointRetentionService;
    /** CPF-11: 进行中操作的进度状态与取消控制器（operationId -> 记录） */
    private readonly operations = new Map<string, { progress: CheckpointOperationProgress; controller: AbortController }>();
    /** CPF-12: 恢复准备/执行辅助（从 CheckpointManager 拆分的独立服务） */
    private readonly restoreService: CheckpointRestoreService;
    
    constructor(
        private settingsManager: SettingsManager,
        private conversationManager: ConversationManager,
        private context: vscode.ExtensionContext,
        customDataPath?: string
    ) {
        // 如果提供了自定义路径，使用自定义路径下的 checkpoints 目录
        // 否则使用扩展存储目录
        const basePath = customDataPath || context.globalStorageUri.fsPath;
        this.checkpointsDir = path.join(basePath, 'checkpoints');
        // CPF-01/CPF-12: manifest 读写、查询与保留策略拆分为独立服务
        this.manifestRepository = new CheckpointManifestRepository(this.checkpointsDir);
        this.queryService = new CheckpointQueryService(
            conversationManager,
            this.checkpointsDir,
            this.manifestRepository,
            (conversationId: string) => t('modules.checkpoint.defaultConversationTitle', { conversationId: conversationId.slice(0, 8) })
        );
        this.retentionService = new CheckpointRetentionService(
            {
                getCheckpointRecords: (conversationId: string) => this.readCheckpointListFromConversation(conversationId),
                deleteCheckpointInternal: (conversationId: string, checkpointId: string) => this.deleteCheckpointInternal(conversationId, checkpointId),
                getCheckpointConfig: () => this.settingsManager.getCheckpointConfig()
            },
            this.checkpointsDir,
            this.manifestRepository,
            conversationManager
        );
        // CPF-12: 恢复准备/执行辅助拆分为独立服务（从 CheckpointManager 平移）
        this.restoreService = new CheckpointRestoreService(
            this.checkpointsDir,
            settingsManager,
            this.manifestRepository,
            this.queryService,
            conversationManager
        );
        // BCP-06: 本类作为「引用计数存档清理器」的生产实现自注册（模块级单例，
        // 与 BranchService.setGlobalBranchService 同模式）。BranchService 的
        // purge/prune 物理清理后经 getGlobalCheckpointRefCountCleaner() 调用
        // deleteCheckpointsByNodeIds（引用计数扫描在 BranchService 侧完成并传入）。
        setGlobalCheckpointRefCountCleaner(this);
    }
    
    /**
     * 初始化
     */
    async initialize(): Promise<void> {
        // 确保检查点目录存在
        await fs.mkdir(this.checkpointsDir, { recursive: true });
    }
    
    /**
     * 生成检查点 ID
     */
    private generateCheckpointId(): string {
        return `cp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }
    
    /**
     * 获取全部工作区根的运行时身份集合（CP-01/CP-02）。
     *
     * 每个根目录都会生成稳定的 `ws_xxx` 身份 ID；身份字符串按
     * `scheme://authority/path` 序列化（vscode.Uri 结构），本地与远程
     * 工作区（vscode-remote）都不会碰撞；测试 mock 无 scheme/authority 时退化为 fsPath。
     */
    private getRuntimeWorkspaceRoots(): RuntimeWorkspaceRoot[] {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return createRuntimeWorkspaceRoots(
            folders.map(folder => {
                const rawUri = folder.uri as unknown;
                const uriLike = (rawUri && typeof rawUri === 'object')
                    ? rawUri as { scheme?: unknown; authority?: unknown; path?: unknown; fsPath?: unknown }
                    : null;
                let uriString: string;
                if (
                    uriLike &&
                    typeof uriLike.scheme === 'string' &&
                    typeof uriLike.authority === 'string' &&
                    typeof uriLike.path === 'string'
                ) {
                    uriString = `${uriLike.scheme}://${uriLike.authority}${uriLike.path}`;
                } else if (uriLike && typeof uriLike.fsPath === 'string') {
                    uriString = uriLike.fsPath;
                } else {
                    uriString = String(rawUri);
                }
                return {
                    name: folder.name,
                    uri: uriString,
                    fsPath: folder.uri.fsPath
                };
            })
        );
    }

    /**
     * 检查点备份和索引位于扩展 globalStorage；删除不要求当前工作区仍处于打开状态。
     * 有工作区时沿用工作区锁，无工作区时用稳定虚拟键保持删除操作之间的互斥。
     */
    private getCheckpointDeletionLockIds(): string[] {
        const roots = this.getRuntimeWorkspaceRoots();
        return roots.length > 0 ? roots.map(root => root.id) : ['checkpoint-global-storage'];
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
     * 创建检查点
     *
     * @param conversationId 对话 ID
     * @param messageIndex 消息索引
     * @param toolName 工具名称或消息类型（user_message, model_message, tool_batch）
     * @param phase 阶段（执行前/执行后）
     * @param options.messageNodeId BCP-01：消息节点 ID（树状分支定位预留）。
     *   仅附加写入，不改变按 messageIndex 的定位语义；缺省时记录不带该字段（旧存档兼容）。
     * @returns 检查点记录，如果创建失败返回 null
     */
    async createCheckpoint(
        conversationId: string,
        messageIndex: number,
        toolName: string,
        phase: 'before' | 'after',
        options?: {
            progress?: (progress: CheckpointOperationProgress) => void;
            messageNodeId?: string;
        }
    ): Promise<CheckpointRecord | null> {
        // 检查是否应该创建检查点
        const config = this.settingsManager.getCheckpointConfig();
        if (!config.enabled) {
            return null;
        }
        
        let shouldCreate = false;
        
        // 检查是否是消息类型
        if (toolName === 'user_message' || toolName === 'model_message') {
            // 使用消息类型配置
            const messageType = toolName === 'user_message' ? 'user' : 'model';
            if (phase === 'before') {
                shouldCreate = config.messageCheckpoint?.beforeMessages?.includes(messageType) ?? false;
            } else {
                shouldCreate = config.messageCheckpoint?.afterMessages?.includes(messageType) ?? false;
            }
        } else if (toolName === 'tool_batch') {
            // 批量工具：只要配置了任何工具的检查点，就创建
            // tool_batch 表示多个工具调用被批量处理
            if (phase === 'before') {
                shouldCreate = config.beforeTools.length > 0;
            } else {
                shouldCreate = config.afterTools.length > 0;
            }
        } else {
            // 使用工具配置
            shouldCreate = phase === 'before'
                ? config.beforeTools.includes(toolName)
                : config.afterTools.includes(toolName);
        }
            
        if (!shouldCreate) {
            return null;
        }

        // CPF-11: 注册进度与取消句柄（等待锁 / 扫描 / 复制全程可查询、可取消）
        const { operationId, signal } = this.beginOperation('create', conversationId);
        const progressCb = options?.progress;
        const reportProgress = (patch: Partial<CheckpointOperationProgress>): void => {
            const merged = this.updateOperation(operationId, patch);
            progressCb?.(merged);
        };
        reportProgress({ phase: 'scanning', processed: 0, total: 0 });
        
        // CP-02: 使用全部工作区根，不再只备份第一个根目录
        // 多工作区并发支持：对话绑定了工作区时只快照该工作区（文件锁也按该根获取），
        // 绑定不同工作区的其他对话在存档期间可无冲突地继续写文件；
        // 未绑定 / 绑定工作区已关闭时回退全部根（旧行为）。
        let roots = this.getRuntimeWorkspaceRoots();
        if (roots.length === 0) {
            // M-1: 早退前把操作推进到终态并结束。否则操作以 phase:'scanning' 永久留在
            // operations map（容量清理只淘汰终态条目），getOperationProgress()（不带
            // operationId）会把这条死记录当“最近进行中操作”返回。
            // 选型：保留 beginOperation 在早退检查之前（CPF-11 先注册、后校验），早退时显式
            // reportProgress(failed) + endOperation——传入 progress 回调的调用方仍能收到终态
            // 通知，getOperationProgress(operationId) 也能查到失败原因；
            // 若把 roots 检查移到 beginOperation 之前（与 restoreCheckpoint 对齐），
            // 则失败静默、进度回调不触发，且早退路径与 config.enabled/!shouldCreate 一致，
            // 但丢失“已开始即终态”的可观测性，故不采用。
            console.warn('[CheckpointManager] No workspace root');
            reportProgress({ phase: 'failed', cancelled: false, message: 'No workspace root' });
            this.endOperation(operationId);
            return null;
        }
        if (roots.length > 1) {
            try {
                const boundWorkspaceUri = await this.conversationManager.getMetadata(conversationId)
                    .then((meta: any) => meta?.workspaceUri as string | undefined)
                    .catch(() => undefined);
                if (boundWorkspaceUri) {
                    let boundFsPath = '';
                    try {
                        boundFsPath = vscode.Uri.parse(boundWorkspaceUri).fsPath;
                    } catch {
                        boundFsPath = '';
                    }
                    if (boundFsPath) {
                        const matched = roots.filter(r => normalizeRootFsPath(r.fsPath) === normalizeRootFsPath(boundFsPath));
                        if (matched.length === 1) {
                            roots = matched;
                        }
                    }
                }
            } catch {
                // 元数据读取失败回退全部根（旧行为）
            }
        }
        
        const checkpointId = this.generateCheckpointId();
        const backupDir = path.join(this.checkpointsDir, checkpointId);

        // CP-03: 存档创建进入工作区级互斥（与恢复、删除、写工具互斥，保证快照一致性）
        // 多工作区并发支持：文件锁范围 = 本次快照的工作区根，不再取全局根锁，
        // 避免绑定其他工作区的对话写工具在存档期间无谓失败。
        try {
            return await checkpointOperationLockManager.runExclusive(
            roots.map(root => root.id),
            'create',
            `checkpoint:${conversationId}:${checkpointId}`,
            async () => {
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
                        lastCheckpoint = await this.manifestRepository.enrichRecord(lastCheckpoint);
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
                        excludeAbsolutePaths: [path.dirname(this.checkpointsDir)],
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
                            // TOCTOU 防护：增量备份时把记录哈希传给复制逻辑，
                            // 复制完成后重哈希校验，不一致即回滚并标记 unbacked
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
                    const hashParts: string[] = [];
                    for (const scopedPath of Object.keys(currentHashes).sort()) {
                        hashParts.push(`${scopedPath}:${currentHashes[scopedPath]}`);
                    }
                    for (const scopedPath of snapshot.emptyDirs) {
                        hashParts.push(`${scopedPath}:empty-dir`);
                    }
                    const contentHash = crypto.createHash('sha256')
                        .update(hashParts.join('\n'))
                        .digest('hex')
                        .substring(0, 16);

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
                    await this.manifestRepository.writeManifest(checkpointId, manifest);

                    // 创建检查点记录
                    const phaseText = phase === 'before'
                        ? t('modules.checkpoint.description.before')
                        : t('modules.checkpoint.description.after');
                    const checkpoint: CheckpointRecord = {
                        id: checkpointId,
                        conversationId,
                        messageIndex,
                        // BCP-01: 关联消息节点 ID（附加字段；旧存档/未传时缺省，读取端回退 index 定位）
                        messageNodeId: options?.messageNodeId,
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
                        this.manifestRepository.clearCache(checkpointId);
                        try {
                            await fs.rm(backupDir, { recursive: true, force: true });
                        } catch (rmErr) {
                            console.warn('[CheckpointManager] Failed to recycle backup directory:', rmErr);
                        }
                    }
                    return null;
                }
            },
            signal,
            { fileLockPaths: roots.map(root => root.fsPath) }
            );
        } catch (err) {
            // M4: 等待文件写锁期间被取消时 fileWriteLockManager.acquire 抛普通 Error，
            // 从 runExclusive 漏出到此处（任务内部 catch 接不到锁获取错误）；
            // 转换为取消结果，不冒泡到工具循环。
            if (signal.aborted || this.isFileLockCancellationError(err)) {
                reportProgress({ phase: 'cancelled', cancelled: true, message: 'cancelled by user' });
                return null;
            }
            throw err;
        } finally {
            this.endOperation(operationId);
        }
    }

    /**
     * M4: 判断是否为文件写锁获取被取消的普通 Error（fileWriteLockManager.acquire）。
     */
    private isFileLockCancellationError(error: unknown): boolean {
        return error instanceof Error && (
            error.message === 'File write lock acquisition was cancelled' ||
            // CP-LOCK-1: 工作区锁排队等待中被取消（CheckpointOperationLock.acquireWorkspaceLock）
            error.message === CHECKPOINT_LOCK_CANCELLED_MESSAGE
        );
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
            console.warn(`[CheckpointManager] Failed to copy ${scopedPath}:`, err);
            return { ok: false, bytes: 0 };
        }
    }
    
    private async readCheckpointListFromConversation(conversationId: string): Promise<CheckpointRecord[]> {
        return this.queryService.getCheckpointRecords(conversationId);
    }

    /**
     * 保存检查点到对话元数据
     */
    private async saveCheckpointToConversation(
        conversationId: string,
        checkpoint: CheckpointRecord
    ): Promise<void> {
        try {
            // 追加在链内原子完成：并发创建检查点时不会基于同一旧列表互相覆盖（记录丢失）
            await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                return [...list, checkpoint];
            });
        } catch (err) {
            console.error('[CheckpointManager] Failed to save checkpoint to conversation:', err);
            throw err;
        }
    }

    /**
     * 获取对话的所有存档摘要（CPF-03）。
     *
     * 返回轻量 CheckpointSummary（含 fileCount/backupBytes/excludedCount），
     * 不再下发完整 fileHashes 映射；withSize=true 时附加 size 字段：
     * 优先使用创建时记录的 backupBytes，旧存档缺失时按需懒扫描一次并写回摘要缓存（CPF-09/CPF-10）。
     */
    async getCheckpoints(conversationId: string, options?: { withSize?: boolean }): Promise<Array<CheckpointSummary & { size?: number }>> {
        return this.queryService.getCheckpoints(conversationId, options);
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
    
    /**
     * 恢复到指定检查点
     *
     * 支持增量备份恢复：
     * 1. 如果是完整备份，直接恢复
     * 2. 如果是增量备份，先恢复基准点，然后按顺序应用增量变更
     * 3. 智能比较哈希，只更新有变化的文件
     */
    /**
     * 恢复检查点
     *
     * @param options.deleteUntrackedFiles 是否删除快照后新建的文件（CP-09）。
     *        默认 false（#29 保护：快照后新建文件不被静默删除）；
     *        恢复确认流程在用户确认待删除文件清单后传 true。
     */
    async restoreCheckpoint(
        conversationId: string,
        checkpointId: string,
        options?: { deleteUntrackedFiles?: boolean }
    ): Promise<RestoreResult> {
        // CP-02: 使用全部工作区根，不再只使用第一个根目录
        const roots = this.getRuntimeWorkspaceRoots();
        if (roots.length === 0) {
            return { success: false, restored: 0, deleted: 0, skipped: 0, error: 'No workspace root' };
        }

        // CPF-11: 注册进度与取消句柄（等待锁 / 准备 / 恢复全程可查询、可取消）
        const { operationId, signal } = this.beginOperation('restore', conversationId, checkpointId);
        const reportProgress = (patch: Partial<CheckpointOperationProgress>): void => {
            this.updateOperation(operationId, patch);
        };

        // CP-03: 恢复进入工作区级互斥（等待已开始的写工具/SubAgent 退出，并阻止新的写工具进入）
        try {
            return await checkpointOperationLockManager.runExclusive(
            roots.map(root => root.id),
            'restore',
            `checkpoint:${conversationId}:${checkpointId}`,
            async () => {
                try {
                    // 在恢复前，取消所有 pending diffs（因为恢复后它们将无效），
                    // 并拒绝所有未响应的工具调用（持久化「用户拒绝」占位）。
                    // 校验类工作全部在 prepareRestore 内完成，无效恢复不会产生这些副作用。
                    try {
                        const diffManager = getDiffManager();
                        await diffManager.cancelAllPending();
                    } catch (err) {
                        console.warn('[CheckpointManager] Failed to cancel pending diffs:', err);
                    }
                    try {
                        await this.conversationManager.rejectAllPendingToolCalls(conversationId);
                    } catch (err) {
                        console.warn('[CheckpointManager] Failed to reject pending tool calls:', err);
                    }

                    // CP-09: 校验/计算与 previewRestore 共用同一路径（prepareRestore），
                    // 保证「预览确认的删除清单」与「实际执行的删除」严格一致。
                    reportProgress({ phase: 'preparing' });
                    const prepared = await this.restoreService.prepareRestore(conversationId, checkpointId, roots);
                    if (!prepared.ok) {
                        reportProgress({ phase: 'failed' });
                        return prepared.result;
                    }
                    const {
                        checkpoint,
                        missingBackupDirs,
                        autoPrunedCheckpointCount,
                        targetState,
                        chain,
                        chainEntries,
                        currentHashes,
                        currentEmptyDirs,
                        protectedScopedPaths,
                        deletableScopedPaths
                    } = prepared.ctx;

                    // 旧版存档（无 fileHashes）：以备份目录内容为恢复目标，
                    // 且绝不删除当前工作区任何文件（旧记录没有“快照时可见”清单，无法安全判断归属）。
                    if (!targetState) {
                        reportProgress({ phase: 'restoring', processed: 0, total: 0 });
                        const legacyResult = await this.restoreService.restoreLegacyCheckpointViaEngine(
                            checkpoint,
                            roots,
                            missingBackupDirs,
                            autoPrunedCheckpointCount,
                            signal
                        );
                        // M5: 取消尾窗竞态——done 不覆盖 cancelOperation 设置的 cancelled
                        reportProgress({ phase: signal.aborted ? 'cancelled' : 'done', cancelled: signal.aborted, processed: legacyResult.restored, total: legacyResult.restored });
                        return legacyResult;
                    }

                    // 恢复引擎：增量链文件索引 O(1) 查询 + 路径安全校验 + 失败清单（区分原因）
                    // CPF-06/CPF-11: 有界并发 + 取消信号 + 进度回调
                    reportProgress({ phase: 'restoring', processed: 0, total: 0 });
                    const engineResult = await restoreWorkspaceSnapshot(
                        {
                            checkpointsDir: this.checkpointsDir,
                            roots,
                            protectedScopedPaths,
                            deletableScopedPaths,
                            deleteUntrackedFiles: options?.deleteUntrackedFiles === true,
                            signal,
                            onProgress: (processed, total) => reportProgress({ phase: 'restoring', processed, total })
                        },
                        chainEntries,
                        targetState,
                        currentHashes,
                        currentEmptyDirs
                    );
                    // M5: 取消尾窗竞态——done 不覆盖 cancelOperation 设置的 cancelled
                    reportProgress({ phase: signal.aborted ? 'cancelled' : 'done', cancelled: signal.aborted, processed: engineResult.restored, total: engineResult.restored + engineResult.skipped });

                    // 刷新 VSCode 中被修改的文档（引擎返回绝对路径）
                    await refreshAffectedDocuments(engineResult.modifiedPaths, engineResult.deletedPaths);

                    // 失败路径转为相对路径展示（scoped 键对用户不友好）
                    const failures: RestoreFailure[] = engineResult.failures.map(f => ({
                        path: this.restoreService.toDisplayPath(f.path, roots),
                        reason: f.reason
                    }));
                    const hasFailures = failures.length > 0;

                    // 显示恢复结果（L-2: 与 legacy 恢复共用同一文案/拼接/状态栏逻辑）
                    this.restoreService.showRestoreResultMessage(
                        checkpoint,
                        { restored: engineResult.restored, deleted: engineResult.deleted, skipped: engineResult.skipped },
                        failures.length
                    );

                    log.info('restore_from_chain', { chainLength: chain.length, restored: engineResult.restored, deleted: engineResult.deleted, skipped: engineResult.skipped, failureCount: failures.length });

                    return {
                        success: engineResult.success,
                        restored: engineResult.restored,
                        deleted: engineResult.deleted,
                        skipped: engineResult.skipped,
                        failures: hasFailures ? failures : undefined,
                        error: hasFailures ? this.restoreService.formatFailureSummary(failures) : undefined,
                        missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                        autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                        // CP-08: 快照时未备份的文件（超限/不可读/复制失败）转为显示路径，
                        // 前端据此提示“这些文件未被该存档备份，恢复不会删除/恢复它们”
                        unbackedPaths: this.restoreService.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
                        // EX-11: 解释「该存档创建时按当时规则排除了哪些文件」
                        excludedNote: this.restoreService.buildExcludedNote(prepared.ctx.manifest, checkpoint),
                    };

                } catch (err) {
                    const error = err instanceof Error ? err.message : 'Unknown error';
                    console.error('[CheckpointManager] Failed to restore checkpoint:', err);
                    reportProgress({
                        phase: signal.aborted ? 'cancelled' : 'failed',
                        cancelled: signal.aborted,
                        message: signal.aborted ? 'cancelled by user' : undefined
                    });
                    return { success: false, restored: 0, deleted: 0, skipped: 0, error };
                }
            },
            signal
            );
        } catch (err) {
            // M4: 等待文件写锁期间被取消时 fileWriteLockManager.acquire 抛普通 Error，
            // 从 runExclusive 漏出到此处（任务内部 catch 接不到锁获取错误）；
            // 转换为取消结果返回（handler 兜底不变），不冒泡。
            if (signal.aborted || this.isFileLockCancellationError(err)) {
                reportProgress({ phase: 'cancelled', cancelled: true, message: 'cancelled by user' });
                return { success: false, restored: 0, deleted: 0, skipped: 0, error: 'cancelled' };
            }
            throw err;
        } finally {
            this.endOperation(operationId);
        }
    }

    /**
     * 预览恢复（CP-09）：计算恢复计划（将恢复/删除/跳过的文件数 + 待删除文件清单），
     * 不执行任何文件写入、不取消 pending diff、不刷新编辑器。
     *
     * 前端展示确认对话框（含待删除文件清单）后，再调用 restoreCheckpoint 真正执行。
     */
    async previewRestore(conversationId: string, checkpointId: string): Promise<RestorePreviewResult> {
        const roots = this.getRuntimeWorkspaceRoots();
        if (roots.length === 0) {
            return { success: false, restored: 0, deleted: 0, deletedIfUnconfirmed: 0, skipped: 0, deletablePaths: [], untrackedPaths: [], error: 'No workspace root' };
        }

        return checkpointOperationLockManager.runExclusive(
            roots.map(root => root.id),
            'restore',
            `checkpoint:${conversationId}:${checkpointId}:preview`,
            async () => {
                try {
                    const prepared = await this.restoreService.prepareRestore(conversationId, checkpointId, roots);
                    if (!prepared.ok) {
                        const r = prepared.result;
                        return {
                            success: r.success,
                            restored: r.restored,
                            deleted: r.deleted,
                            deletedIfUnconfirmed: 0,
                            skipped: r.skipped,
                            deletablePaths: [],
                            untrackedPaths: [],
                            error: r.error,
                            failures: r.failures,
                            missingBackupDirs: r.missingBackupDirs,
                            autoPrunedCheckpointCount: r.autoPrunedCheckpointCount,
                            unbackedPaths: r.unbackedPaths
                        };
                    }
                    const {
                        checkpoint,
                        targetState,
                        chainEntries,
                        currentHashes,
                        currentEmptyDirs,
                        protectedScopedPaths,
                        deletableScopedPaths,
                        missingBackupDirs,
                        autoPrunedCheckpointCount
                    } = prepared.ctx;

                    // 旧版存档（无 fileHashes）：恢复只复制、绝不删除，清单为空；
                    // legacy 标记让前端区分「预览未知」与「无变更」，避免误导
                    if (!targetState) {
                        return {
                            success: true,
                            restored: -1, // legacy 以备份目录内容为目标，预览无法预知数量，执行结果会展示实际值
                            deleted: 0,
                            deletedIfUnconfirmed: 0,
                            skipped: -1,
                            deletablePaths: [],
                            untrackedPaths: [],
                            legacy: true,
                            unbackedPaths: this.restoreService.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
                            missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                            autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                            // EX-11: 旧存档无 manifest 时不生成排除说明
                            excludedNote: prepared.ctx.manifest ? this.restoreService.buildExcludedNote(prepared.ctx.manifest, checkpoint) : undefined,
                        };
                    }

                    // 与 restoreWorkspaceSnapshot 共用 computeRestorePlan，清单与执行严格一致
                    const plan = computeRestorePlan(
                        {
                            checkpointsDir: this.checkpointsDir,
                            roots,
                            protectedScopedPaths,
                            deletableScopedPaths
                        },
                        chainEntries,
                        targetState,
                        currentHashes,
                        currentEmptyDirs
                    );

                    return {
                        success: true,
                        restored: plan.added.length + plan.modified.length,
                        // CP-PREV-1: deleted 为“确认删除 untracked 后”的总数；
                        // deletedIfUnconfirmed 仅计快照记录过的路径（默认执行时的真实删除数）
                        deleted: plan.toDelete.length + plan.untrackedToDelete.length,
                        deletedIfUnconfirmed: plan.toDelete.length,
                        skipped: plan.skipped,
                        deletablePaths: plan.toDelete.map(p => this.restoreService.toDisplayPath(p, roots)),
                        // 快照后新建的文件与空目录合并展示，确认后一并清理
                        untrackedPaths: [
                            ...plan.untrackedToDelete.map(p => this.restoreService.toDisplayPath(p, roots)),
                            ...plan.untrackedEmptyDirs.map(p => this.restoreService.toDisplayPath(p, roots))
                        ],
                        unbackedPaths: this.restoreService.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
                        missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                        autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                        // EX-11: 解释「该存档创建时按当时规则排除了哪些文件」
                        excludedNote: this.restoreService.buildExcludedNote(prepared.ctx.manifest, checkpoint),
                    };
                } catch (err) {
                    const error = err instanceof Error ? err.message : 'Unknown error';
                    console.error('[CheckpointManager] Failed to preview restore:', err);
                    return { success: false, restored: 0, deleted: 0, deletedIfUnconfirmed: 0, skipped: 0, deletablePaths: [], untrackedPaths: [], error };
                }
            },
            undefined,
            // CP-LOCK-2: 预览是纯计算（prepareRestore + computeRestorePlan，无文件写入），
            // 只取工作区级互斥，不 acquire 全局文件写锁，避免扫描/哈希期间阻塞全部写工具
            { needFileLock: false }
        );
    }

    /**
     * 清理过期检查点（CPF-12：委托 CheckpointRetentionService）
     */
    private async cleanupOldCheckpoints(conversationId: string): Promise<void> {
        await this.retentionService.cleanupOldCheckpoints(conversationId);
    }
    
    /**
     * 删除检查点
     */
    async deleteCheckpoint(conversationId: string, checkpointId: string): Promise<boolean> {
        return checkpointOperationLockManager.runExclusive(
            this.getCheckpointDeletionLockIds(),
            'delete',
            `checkpoint:${conversationId}:${checkpointId}`,
            () => this.deleteCheckpointInternal(conversationId, checkpointId)
        );
    }

    /**
     * 无锁删除检查点（调用方必须已持有工作区级存档锁）。
     *
     * 供 cleanupOldCheckpoints 等锁内链路复用：createCheckpoint 的锁内
     * 清理旧存档时若再走公开方法，会以不同 ownerId 等待自己持有的锁而死锁。
     */
    private async deleteCheckpointInternal(conversationId: string, checkpointId: string): Promise<boolean> {
        try {
            // 元数据更新（读-判-算保留集合）在链内原子完成；磁盘删除放在写回成功之后，
            // 此时竞态窗口已收敛，不会出现「读到旧列表 → 删磁盘 → 覆盖他人新写入」的丢记录场景。
            let backupDirToDelete: string | undefined;
            const result = await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                // 路径安全：删除路径同样经过 sanitize，非法 backupDir 绝不进入 fs.rm
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const checkpoint = list.find(cp => cp.id === checkpointId);
                if (!checkpoint) {
                    return current; // 不存在：原引用=无变更跳过写回
                }
                // CP-DEL-1: 损坏/恶意元数据中的 backupDir 可能越界（如 `../../victim`），
                // 绝不把未校验目录名交给 fs.rm(recursive)——拒绝删除并告警，记录保留。
                if (!isSafeCheckpointDirName(checkpoint.backupDir)) {
                    console.warn(`[CheckpointManager] Refusing to delete checkpoint ${checkpointId}: unsafe backupDir ${checkpoint.backupDir}`);
                    return current;
                }
                // 被其他检查点引用为基快照时拒绝删除（返回原引用=无变更跳过写回），
                // 否则会破坏增量链，恢复时 chainBroken 100% 失败
                if (list.some(cp => cp.baseCheckpointId === checkpointId)) {
                    return current;
                }
                backupDirToDelete = checkpoint.backupDir;
                return list.filter(cp => cp.id !== checkpointId);
            });
            void result;

            if (backupDirToDelete === undefined) {
                return false;
            }

            // CPF-01: 目录删除后清掉 manifest 缓存，避免后续读旧数据
            this.manifestRepository.clearCache(backupDirToDelete);

            // 删除备份目录（写回成功后才删）
            const backupPath = path.join(this.checkpointsDir, backupDirToDelete);
            try {
                await fs.rm(backupPath, { recursive: true, force: true });
            } catch (err) {
                // 元数据已移除；磁盘目录残留为孤儿目录，不影响增量链正确性，但必须记录以便排查
                console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDirToDelete}:`, err);
            }
            
            return true;
            
        } catch (err) {
            console.error('[CheckpointManager] Failed to delete checkpoint:', err);
            return false;
        }
    }
    
    /**
     * 删除指定消息索引及之后的检查点
     *
     * 用于重试/编辑消息时清理关联的检查点
     *
     * @param excludeCheckpointId 可选，保留该检查点（含其增量基链）。
     *                            用于回档场景：刚用于恢复的存档点应保留，支持反复回档到同一位置。
     */
    async deleteCheckpointsFromIndex(conversationId: string, fromIndex: number, excludeCheckpointId?: string): Promise<number> {
        return checkpointOperationLockManager.runExclusive(
            this.getCheckpointDeletionLockIds(),
            'delete',
            `checkpoint:${conversationId}:delete-from-index`,
            () => this.deleteCheckpointsFromIndexInternal(conversationId, fromIndex, excludeCheckpointId)
        );
    }

    /**
     * 无锁版 deleteCheckpointsFromIndex（调用方必须已持有工作区级存档锁）。
     */
    private async deleteCheckpointsFromIndexInternal(conversationId: string, fromIndex: number, excludeCheckpointId?: string): Promise<number> {
        try {
            // 计算与写回在链内原子完成（基于最新列表），磁盘删除放在写回成功之后
            let toDelete: CheckpointRecord[] = [];
            let backupDirsToDelete: string[] = [];
            await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const checkpoints = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const byId = new Map(checkpoints.map(cp => [cp.id, cp] as const));

                // 需要保留的检查点 ID 集合：目标检查点及其增量基链（否则保留的检查点会因基快照被删而无法恢复）
                // + 消息索引在保留区间内（messageIndex < fromIndex）的节点。
                const keepIds = new Set<string>();
                if (excludeCheckpointId) {
                    let cur = byId.get(excludeCheckpointId);
                    while (cur && !keepIds.has(cur.id)) {
                        keepIds.add(cur.id);
                        cur = cur.baseCheckpointId ? byId.get(cur.baseCheckpointId) : undefined;
                    }
                }
                for (const cp of checkpoints) {
                    if (cp.messageIndex < fromIndex) {
                        keepIds.add(cp.id);
                    }
                }

                // CP-IDX-1: 祖先闭包——从所有保留节点向前遍历完整祖先链，被依赖的基快照
                // 即使消息索引 >= fromIndex 也强制保留。
                // 编辑/回档/重试会让消息索引回退：B(index=10) → 截断对话 → 重试产生
                // R(index=3, base=B) → 再次截断到 fromIndex=4 时，仅按索引判断会删 B 而留 R →
                // R 的 baseCheckpointId 悬空（chainBroken 且无法修复）。
                // 闭包与 deleteCheckpointsBatch 的 CP-05 口径一致。
                const forcedKeep = new Set<string>();
                for (const cp of checkpoints) {
                    if (!keepIds.has(cp.id)) {
                        continue;
                    }
                    forcedKeep.add(cp.id);
                    let baseId = cp.baseCheckpointId;
                    while (baseId && !forcedKeep.has(baseId)) {
                        forcedKeep.add(baseId);
                        baseId = byId.get(baseId)?.baseCheckpointId;
                    }
                }

                // 筛选出需要删除的检查点（消息索引 >= fromIndex、不在保留闭包中、backupDir 安全）
                toDelete = checkpoints.filter(cp => {
                    if (cp.messageIndex < fromIndex || forcedKeep.has(cp.id)) {
                        return false;
                    }
                    // CP-DEL-1: 未校验目录名绝不删除（记录保留 + 告警）
                    if (!isSafeCheckpointDirName(cp.backupDir)) {
                        console.warn(`[CheckpointManager] Refusing to delete checkpoint ${cp.id}: unsafe backupDir ${cp.backupDir}`);
                        return false;
                    }
                    return true;
                });
                if (toDelete.length === 0) {
                    return current; // 无变更，跳过写回
                }
                backupDirsToDelete = toDelete.map(cp => cp.backupDir);
                // 保留：索引保留区 + 强制保留闭包 + backupDir 越界被拒绝删除的记录
                const toDeleteIds = new Set(toDelete.map(cp => cp.id));
                return checkpoints.filter(cp => !toDeleteIds.has(cp.id));
            });

            // 删除备份目录（写回成功后才删）；失败只留孤儿目录，不影响增量链正确性
            for (const backupDir of backupDirsToDelete) {
                // CPF-01: 目录删除后清掉 manifest 缓存
                this.manifestRepository.clearCache(backupDir);
                const backupPath = path.join(this.checkpointsDir, backupDir);
                try {
                    await fs.rm(backupPath, { recursive: true, force: true });
                } catch (err) {
                    console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDir}:`, err);
                }
            }
            
            return toDelete.length;
            
        } catch (err) {
            console.error('[CheckpointManager] Failed to delete checkpoints from index:', err);
            return 0;
        }
    }
    
    /**
     * 删除对话的所有检查点
     */
    async deleteAllCheckpoints(conversationId: string): Promise<{ success: boolean; deletedCount: number }> {
        const lockWorkspaceIds = this.getCheckpointDeletionLockIds();
        // CPF-11: 删除操作注册进度/取消句柄
        const { operationId, signal, report } = this.beginOperation('delete', conversationId);
        try {
            return await checkpointOperationLockManager.runExclusive(
            lockWorkspaceIds,
            'delete',
            `checkpoint:${conversationId}:delete-all`,
            async () => {
                try {
                    // 清空列表在链内原子完成；磁盘删除放在写回成功之后
                    let backupDirsToDelete: string[] = [];
                    await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                        // 路径安全：删除路径同样经过 sanitize，非法 backupDir 绝不进入 fs.rm
                        const checkpoints = Array.isArray(current) ? current as CheckpointRecord[] : [];
                        if (checkpoints.length === 0) {
                            return current; // 无变更，跳过写回
                        }
                        // CP-DEL-1: backupDir 越界的记录绝不删除（记录保留 + 告警），
                        // 只删除 backupDir 安全的记录
                        const unsafe = checkpoints.filter(cp => !isSafeCheckpointDirName(cp.backupDir));
                        for (const cp of unsafe) {
                            console.warn(`[CheckpointManager] Refusing to delete checkpoint ${cp.id}: unsafe backupDir ${cp.backupDir}`);
                        }
                        backupDirsToDelete = checkpoints
                            .filter(cp => isSafeCheckpointDirName(cp.backupDir))
                            .map(cp => cp.backupDir);
                        return unsafe; // 只保留越界记录（拒绝删除），安全记录全部移除
                    });

                    report({ phase: 'deleting', processed: 0, total: backupDirsToDelete.length });
                    let deletedCount = 0;
                    for (const backupDir of backupDirsToDelete) {
                        throwIfAborted(signal);
                        // CPF-01: 目录删除后清掉 manifest 缓存
                        this.manifestRepository.clearCache(backupDir);
                        const backupPath = path.join(this.checkpointsDir, backupDir);
                        try {
                            await fs.rm(backupPath, { recursive: true, force: true });
                            deletedCount++;
                        } catch (err) {
                            // 元数据已清空；磁盘目录残留为孤儿目录，不影响正确性，但必须记录以便排查
                            console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDir}:`, err);
                        }
                        report({ processed: deletedCount });
                    }
                    report({ phase: signal.aborted ? 'cancelled' : 'done', cancelled: signal.aborted });
                    
                    return { success: true, deletedCount };
                    
                } catch (err) {
                    console.error('[CheckpointManager] Failed to delete all checkpoints:', err);
                    report({ phase: signal.aborted ? 'cancelled' : 'failed', cancelled: signal.aborted });
                    return { success: false, deletedCount: 0 };
                }
            },
            signal
            );
        } catch (err) {
            // M4: 等待文件写锁期间被取消 → 转换为取消结果返回（handler 兜底不变）
            if (signal.aborted || this.isFileLockCancellationError(err)) {
                report({ phase: 'cancelled', cancelled: true });
                return { success: false, deletedCount: 0 };
            }
            throw err;
        } finally {
            this.endOperation(operationId);
        }
    }
    
    /**
     * 批量删除多个对话的检查点（支持跨对话）
     *
     * 遵循与单删一致的增量链保护规则：被「不在本次删除集合内」的检查点
     * 引用为基快照（baseCheckpointId）时，拒绝删除该检查点；
     * 批量删除整条链（基与后继都在删除集合内）时不受此限制。
     *
     * @param items 每个对话的删除请求；checkpointIds 为空数组时表示删除该对话全部检查点
     */
    async deleteCheckpointsBatch(items: BatchCheckpointDeleteItem[]): Promise<BatchCheckpointDeleteResult[]> {
        const results: BatchCheckpointDeleteResult[] = [];

        for (const item of items) {
            const result: BatchCheckpointDeleteResult = {
                conversationId: item.conversationId,
                deletedIds: [],
                rejectedIds: [],
                success: false
            };

            // M7: 每个对话注册进度/取消句柄（设置页批量删除可展示进度并取消）
            const { operationId, signal, report } = this.beginOperation('delete', item.conversationId);
            try {
                await checkpointOperationLockManager.runExclusive(
                    this.getCheckpointDeletionLockIds(),
                    'delete',
                    `checkpoint:${item.conversationId}:delete-batch`,
                    async () => {
                        // 计算与写回在链内原子完成；磁盘删除放在写回成功之后
                        let backupDirsToDelete: string[] = [];
                        await this.conversationManager.updateCustomMetadata(item.conversationId, 'checkpoints', current => {
                            // 路径安全：删除路径同样经过 sanitize，非法 backupDir 绝不进入 fs.rm
                            const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                            if (list.length === 0) {
                                return current; // 无变更，跳过写回
                            }

                            // 空 ID 列表 = 删除该对话全部检查点
                            const deleteSet = new Set(
                                item.checkpointIds.length === 0 ? list.map(cp => cp.id) : item.checkpointIds
                            );

                            // CP-05: 闭包计算强制保留集合（BCP-06 抽取为 computeForcedKeepIds）——
                            // 从所有保留节点向前遍历完整祖先链，被保留节点直接或间接依赖的祖先
                            // 都不能删（否则保留节点恢复时断链）。
                            // 旧实现只检查一层直接引用：链 A→B→C 删除 {A,B} 时 A 被删而 B 保留 → B 断链。
                            const keepIds = new Set(list.filter(cp => !deleteSet.has(cp.id)).map(cp => cp.id));
                            const forcedKeep = computeForcedKeepIds(list, keepIds);

                            // 请求删除但被强制保留的 ID 全部拒绝，并返回给前端展示原因
                            const rejectedIds = new Set<string>();
                            for (const id of deleteSet) {
                                if (forcedKeep.has(id)) rejectedIds.add(id);
                            }

                            // CP-DEL-1: backupDir 越界的记录绝不删除（进 rejectedIds 上报前端 + 告警）
                            const toDelete = [...deleteSet].filter(id => !rejectedIds.has(id));
                            for (const id of toDelete) {
                                const cp = list.find(c => c.id === id);
                                if (cp && !isSafeCheckpointDirName(cp.backupDir)) {
                                    console.warn(`[CheckpointManager] Refusing to delete checkpoint ${id}: unsafe backupDir ${cp.backupDir}`);
                                    rejectedIds.add(id);
                                }
                            }

                            result.rejectedIds = [...rejectedIds];
                            const safeToDelete = toDelete.filter(id => !rejectedIds.has(id));
                            if (safeToDelete.length === 0) {
                                return current; // 无变更，跳过写回
                            }

                            result.deletedIds = safeToDelete;
                            backupDirsToDelete = safeToDelete
                                .map(id => list.find(cp => cp.id === id)?.backupDir)
                                .filter((dir): dir is string => !!dir);

                            return list.filter(cp => !safeToDelete.includes(cp.id));
                        });

                        // 删除备份目录（写回成功后才删）；失败只留孤儿目录，不影响增量链正确性
                        report({ phase: 'deleting', processed: 0, total: backupDirsToDelete.length });
                        let deletedCount = 0;
                        for (const backupDir of backupDirsToDelete) {
                            throwIfAborted(signal);
                            // CPF-01: 目录删除后清掉 manifest 缓存
                            this.manifestRepository.clearCache(backupDir);
                            const backupPath = path.join(this.checkpointsDir, backupDir);
                            try {
                                await fs.rm(backupPath, { recursive: true, force: true });
                                deletedCount++;
                            } catch (err) {
                                console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDir}:`, err);
                            }
                            report({ processed: deletedCount });
                        }
                        report({ phase: signal.aborted ? 'cancelled' : 'done', cancelled: signal.aborted });

                        result.success = true;
                    },
                    signal
                );
            } catch (err) {
                // M4: 等待文件写锁期间被取消 → 取消结果（不冒泡）
                if (signal.aborted || this.isFileLockCancellationError(err)) {
                    report({ phase: 'cancelled', cancelled: true });
                } else {
                    console.error(`[CheckpointManager] Failed to delete checkpoints batch for ${item.conversationId}:`, err);
                    report({ phase: 'failed', cancelled: false });
                }
            } finally {
                this.endOperation(operationId);
            }

            results.push(result);
        }

        return results;
    }

    /**
     * BCP-06：按分支节点删除存档（引用计数删除——BranchService purge/prune 物理清理后的联动入口）。
     *
     * 候选 = 本对话中 messageNodeId ∈ nodeIds 的存档记录；旧存档无 messageNodeId 不匹配 → 不误删。
     * 三重拒绝闸门（按序合并进 rejectedIds）：
     * 1. 引用计数：options.referenceCounts 中 refCount > 0 的候选拒绝（仍被其他存活分支节点引用），
     *    除非 options.force = true（force 只跳过引用计数闸门，不跳过链保护）;
     *    缺省 referenceCounts 时跳过本闸门（退化为研究 §5.4 的 nodeId 清理语义，仅链保护）；
     * 2. CP-05 祖先闭包：即使 refCount === 0，被保留存档引用为 base（增量链依赖）的候选也拒绝——
     *    与 deleteCheckpointsBatch 的 rejectedIds 语义合并（BCP-07：增量链共享不因引用计数删除破坏）;
     * 3. CP-DEL-1：backupDir 越界的记录拒绝（绝不把未校验目录名交给 fs.rm）。
     *
     * 写回/删盘与 deleteCheckpointsBatch 同路径：updateCustomMetadata 链内原子写回，
     * 写回成功后才删除备份目录；失败只留孤儿目录，不影响增量链正确性。
     * 锁：工作区级存档锁（delete），调用方必须从会话锁之外发起（锁序约束见 BranchService 头注释）。
     */
    async deleteCheckpointsByNodeIds(
        conversationId: string,
        nodeIds: string[],
        options?: { force?: boolean; referenceCounts?: Map<string, number> }
    ): Promise<BatchCheckpointDeleteResult> {
        const result: BatchCheckpointDeleteResult = {
            conversationId,
            deletedIds: [],
            rejectedIds: [],
            success: false,
        };
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
            result.success = true;
            return result;
        }
        try {
            await checkpointOperationLockManager.runExclusive(
                this.getCheckpointDeletionLockIds(),
                'delete',
                `checkpoint:${conversationId}:delete-by-node-ids`,
                async () => {
                    // 计算与写回在链内原子完成；磁盘删除放在写回成功之后（与 deleteCheckpointsBatch 一致）
                    let backupDirsToDelete: string[] = [];
                    await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                        const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                        if (list.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }

                        const nodeIdSet = new Set(nodeIds);
                        // 候选：messageNodeId 精确匹配被移除节点（旧存档无 messageNodeId → 不误删）
                        const candidates = list.filter(
                            cp => cp.messageNodeId !== undefined && nodeIdSet.has(cp.messageNodeId)
                        );
                        if (candidates.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }
                        const candidateIds = new Set(candidates.map(cp => cp.id));
                        const rejectedIds = new Set<string>();

                        // 闸门 1：引用计数（refCount>0 → 拒绝，除非 force）
                        const referenceCounts = options?.referenceCounts;
                        if (!options?.force && referenceCounts) {
                            for (const id of candidateIds) {
                                if ((referenceCounts.get(id) ?? 0) > 0) {
                                    rejectedIds.add(id);
                                }
                            }
                        }

                        // 闸门 2：CP-05 祖先闭包（被保留存档引用为 base → 拒绝，即使 refCount 0）
                        const keepIds = new Set(
                            list.filter(cp => !candidateIds.has(cp.id)).map(cp => cp.id)
                        );
                        const forcedKeep = computeForcedKeepIds(list, keepIds);
                        for (const id of candidateIds) {
                            if (forcedKeep.has(id)) {
                                rejectedIds.add(id);
                            }
                        }

                        // 闸门 3：CP-DEL-1 backupDir 越界 → 拒绝 + 告警
                        const toDelete = [...candidateIds].filter(id => !rejectedIds.has(id));
                        for (const id of toDelete) {
                            const cp = list.find(c => c.id === id);
                            if (cp && !isSafeCheckpointDirName(cp.backupDir)) {
                                console.warn(`[CheckpointManager] Refusing to delete checkpoint ${id}: unsafe backupDir ${cp.backupDir}`);
                                rejectedIds.add(id);
                            }
                        }

                        result.rejectedIds = [...rejectedIds];
                        const safeToDelete = toDelete.filter(id => !rejectedIds.has(id));
                        if (safeToDelete.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }

                        result.deletedIds = safeToDelete;
                        backupDirsToDelete = safeToDelete
                            .map(id => list.find(cp => cp.id === id)?.backupDir)
                            .filter((dir): dir is string => !!dir);
                        return list.filter(cp => !safeToDelete.includes(cp.id));
                    });

                    // 删除备份目录（写回成功后才删）；失败只留孤儿目录，不影响增量链正确性
                    for (const backupDir of backupDirsToDelete) {
                        // CPF-01: 目录删除后清掉 manifest 缓存
                        this.manifestRepository.clearCache(backupDir);
                        const backupPath = path.join(this.checkpointsDir, backupDir);
                        try {
                            await fs.rm(backupPath, { recursive: true, force: true });
                        } catch (err) {
                            console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDir}:`, err);
                        }
                    }
                    result.success = true;
                }
            );
        } catch (err) {
            console.error('[CheckpointManager] Failed to delete checkpoints by node ids:', err);
        }
        return result;
    }

    /**
     * 获取所有对话的检查点统计信息（CPF-10）。
     *
     * 基于摘要字段（backupBytes）聚合，不递归扫描存档目录；
     * 旧存档缺 backupBytes 时标记 sizeIncomplete，由设置页展开时按需懒扫描补齐。
     *
     * @returns 对话列表，包含检查点数量和总大小（可能不完整，见 sizeIncomplete）
     */
    async getAllConversationsWithCheckpoints(): Promise<Array<{
        conversationId: string;
        title: string;
        checkpointCount: number;
        totalSize: number;
        createdAt?: number;
        updatedAt?: number;
        sizeIncomplete?: boolean;
    }>> {
        return this.queryService.getAllConversationsWithCheckpoints();
    }

    /**
     * 按 checkpointId 加载完整 manifest（CPF-03：前端按需取完整存档数据）。
     *
     * 新格式存档直接读取；旧存档（无 manifest 文件）时返回 null。
     *
     * L6 差异说明：本方法不带 fallbackRecord，legacy 存档的迁移路径（
     * buildManifestFromRecord）不会在此触发——如需读取 legacy 存档的完整数据，
     * 请走 getCheckpoints / restore 路径（它们传入 fallbackRecord 触发迁移生成），
     * 或调用方先取得对应记录再自行迁移。消费场景：设置页查看某存档的排除清单时，
     * 应先确认存档为新格式（summary.manifestVersion > 0）再调用，避免 null 歧义。
     */
    async getManifest(checkpointId: string): Promise<CheckpointManifest | null> {
        return this.manifestRepository.loadManifest(checkpointId);
    }

    /**
     * 查询进行中存档操作的进度（CPF-11）。
     *
     * @param operationId 指定操作 ID；缺省时返回最近更新的进行中操作。
     */
    getOperationProgress(operationId?: string): CheckpointOperationProgress | null {
        if (operationId) {
            return this.operations.get(operationId)?.progress ?? null;
        }
        let latest: CheckpointOperationProgress | null = null;
        for (const record of this.operations.values()) {
            const progress = record.progress;
            if (progress.phase === 'done' || progress.phase === 'failed' || progress.phase === 'cancelled') {
                continue;
            }
            if (!latest || progress.updatedAt > latest.updatedAt) {
                latest = progress;
            }
        }
        return latest;
    }

    /**
     * 取消指定存档操作（CPF-11）：触发 AbortSignal，操作循环内检查并中止。
     *
     * @returns 是否存在该操作
     */
    cancelOperation(operationId: string): boolean {
        const record = this.operations.get(operationId);
        if (!record) {
            return false;
        }
        record.controller.abort();
        record.progress.cancelled = true;
        record.progress.phase = 'cancelled';
        record.progress.updatedAt = Date.now();
        return true;
    }

    /**
     * 注册一个存档操作的进度/取消句柄（CPF-11）。
     * 返回的 report 回调用于更新进度；signal 在操作循环内通过 throwIfAborted 检查。
     */
    private beginOperation(
        kind: CheckpointOperationProgress['kind'],
        conversationId?: string,
        checkpointId?: string
    ): { operationId: string; signal: AbortSignal; report: (patch: Partial<CheckpointOperationProgress>) => CheckpointOperationProgress } {
        const operationId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        const now = Date.now();
        const progress: CheckpointOperationProgress = {
            operationId,
            kind,
            conversationId,
            checkpointId,
            phase: 'pending',
            processed: 0,
            total: 0,
            cancelled: false,
            startedAt: now,
            updatedAt: now
        };
        this.operations.set(operationId, { progress, controller });

        // 容量保护：清理已结束的最旧记录，避免长期累积
        if (this.operations.size > 64) {
            const finished = [...this.operations.entries()]
                .filter(([, record]) =>
                    record.progress.phase === 'done' || record.progress.phase === 'failed' || record.progress.phase === 'cancelled')
                .sort((a, b) => a[1].progress.updatedAt - b[1].progress.updatedAt);
            for (const [id] of finished.slice(0, this.operations.size - 32)) {
                this.operations.delete(id);
            }
        }

        return {
            operationId,
            signal: controller.signal,
            report: patch => this.updateOperation(operationId, patch)
        };
    }

    /** 更新操作进度（并刷新 updatedAt） */
    private updateOperation(operationId: string, patch: Partial<CheckpointOperationProgress>): CheckpointOperationProgress {
        const record = this.operations.get(operationId);
        if (!record) {
            // 操作已被清理：返回补丁快照（调用方仅用于转发给 progress 回调）
            return {
                operationId,
                kind: 'create',
                phase: 'unknown',
                processed: 0,
                total: 0,
                cancelled: false,
                startedAt: Date.now(),
                updatedAt: Date.now(),
                ...patch
            };
        }
        Object.assign(record.progress, patch, { updatedAt: Date.now() });
        return record.progress;
    }

    /** 结束操作（保留记录供 getOperationProgress 查询，由容量保护清理） */
    private endOperation(operationId: string): void {
        const record = this.operations.get(operationId);
        if (record) {
            record.progress.updatedAt = Date.now();
        }
    }

}
