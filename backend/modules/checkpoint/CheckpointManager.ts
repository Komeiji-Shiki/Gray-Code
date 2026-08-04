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
import { createReadStream } from 'fs';
import * as crypto from 'crypto';
import type { SettingsManager } from '../settings/SettingsManager';
import type { ConversationManager } from '../conversation/ConversationManager';
import { getDiffManager } from '../../tools/file/diffManager';
import { CheckpointIgnoreResolver, normalizeCheckpointPath } from './CheckpointIgnoreResolver';
import { buildWorkspaceSnapshot, type SnapshotFileStat } from './CheckpointSnapshotBuilder';
import { DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES, DEFAULT_ENABLED_PROFILES, buildIgnoreSnapshot } from './CheckpointExclusionProfiles';
import type { CheckpointIgnoreSnapshot } from './types';
import {
    computeRestorePlan,
    isWorkspaceScopedKey,
    restoreWorkspaceSnapshot,
    toScopedKey,
    type RestoreChainEntry,
    type RestoreTargetState
} from './CheckpointRestoreEngine';
import {
    createRuntimeWorkspaceRoots,
    createWorkspaceScopedPath,
    createWorkspaceSnapshot,
    parseWorkspaceScopedPath,
    validateWorkspaceSnapshot,
    type CheckpointWorkspaceRoot,
    type RuntimeWorkspaceRoot
} from './CheckpointWorkspace';
import { checkpointOperationLockManager } from './CheckpointOperationLock';
import { restoreChatInputFocus, shouldRestoreChatInputFocus } from '../../core/chatFocusGuard';
import { Logger } from '../../core/logger';
import type { CheckpointConfig } from '../settings/types';
import type {
    CheckpointSummary,
    CheckpointManifest,
    CheckpointExcludedEntry,
    CheckpointOperationProgress
} from './types';
import { CheckpointManifestRepository, CHECKPOINT_MANIFEST_VERSION } from './CheckpointManifestRepository';
import { CheckpointQueryService } from './CheckpointQueryService';
import { CheckpointRetentionService } from './CheckpointRetentionService';
import {
    DEFAULT_CHECKPOINT_CONCURRENCY,
    runBounded,
    throwIfAborted,
    CheckpointAbortError
} from './checkpointConcurrency';

const log = Logger.get('CheckpointManager');

/**
 * 文件变更记录
 */
export interface FileChange {
    /** 相对路径 */
    path: string;
    /** 变更类型 */
    type: 'added' | 'modified' | 'deleted';
    /** 文件哈希（仅 added/modified） */
    hash?: string;
}

/**
 * 恢复失败原因
 * - missing_in_chain: 文件在 fileHashes 中，但增量链里找不到备份内容
 * - hash_mismatch: 链中找到的备份内容与目标哈希不一致
 * - copy_failed: 备份内容复制回工作区失败
 * - delete_failed: 应删除的多余文件删除失败
 */
export type RestoreFailureReason = 'missing_in_chain' | 'hash_mismatch' | 'copy_failed' | 'delete_failed';

/**
 * 单个文件的恢复失败记录
 */
export interface RestoreFailure {
    /** 相对路径 */
    path: string;
    /** 失败原因 */
    reason: RestoreFailureReason;
}

/**
 * EX-11: 恢复时的排除说明（区分「快照规则」与「当前规则」）。
 *
 * - 快照规则来自 manifest.ignoreSnapshot（该存档创建时的排除配置）；
 * - 当前规则来自 settingsManager 的实时配置；
 * - 恢复仍然严格按当前规则过滤目标（filterRestoreTargetScoped），
 *   不会因为旧规则更宽而覆盖当前明确忽略的文件。
 */
export interface CheckpointExcludedNote {
    /** 该存档创建时按当时规则排除的文件数（来自 manifest.excluded） */
    excludedCount: number;
    /** 快照规则与当前规则是否不一致（大小上限 / 自定义模式等） */
    rulesChanged: boolean;
    /** 可直接展示的说明文本（中文；前端可自行本地化） */
    message: string;
    /** 快照时的排除规则 */
    snapshotRules?: CheckpointIgnoreSnapshot;
    /** 当前排除规则 */
    currentRules?: CheckpointIgnoreSnapshot;
}

/**
 * 恢复结果
 */
export interface RestoreResult {
    success: boolean;
    restored: number;
    deleted: number;
    skipped: number;
    error?: string;
    missingBackupDirs?: string[];
    autoPrunedCheckpointCount?: number;
    /** 未能恢复/删除的文件清单（存在时 success 必为 false） */
    failures?: RestoreFailure[];
    /**
     * 快照时未备份的文件（大小超限/不可读/复制失败）：恢复时受保护不会被删除。
     * 值为对用户友好的相对路径（scoped 键解析失败时保留原值）。
     */
    unbackedPaths?: string[];
    /** EX-11: 恢复时解释「该存档创建时按当时规则排除了哪些文件」（规则来自 manifest 快照） */
    excludedNote?: CheckpointExcludedNote;
}

/**
 * 恢复预览结果（CP-09）：执行恢复前先计算计划，供前端展示待删除文件清单并确认。
 */
export interface RestorePreviewResult {
    success: boolean;
    /** 将恢复（新增 + 修改）的文件数；legacy 存档为 -1（无法预知，以备份目录内容为准） */
    restored: number;
    /** 将删除的文件数（快照记录过 + 用户确认删除的快照后新建文件） */
    deleted: number;
    /** 与目标一致、无需操作的文件数；legacy 存档为 -1 */
    skipped: number;
    /** 将被删除的文件显示路径（快照记录过、按 #29 白名单删除；旧版存档无删除语义时为空） */
    deletablePaths: string[];
    /** 快照后新建的文件/空目录显示路径：默认保留，需用户确认后才删除（CP-09） */
    untrackedPaths: string[];
    /** 旧版存档（无 fileHashes）：预览无法给出精确数量，以恢复执行结果为准 */
    legacy?: boolean;
    error?: string;
    /** 预检失败（链断裂等）时携带 */
    failures?: RestoreFailure[];
    missingBackupDirs?: string[];
    autoPrunedCheckpointCount?: number;
    unbackedPaths?: string[];
    /** EX-11: 恢复预览同样携带排除说明（与 restoreCheckpoint 一致） */
    excludedNote?: CheckpointExcludedNote;
}

/**
 * 恢复准备上下文：restoreCheckpoint 与 previewRestore 共用的校验/计算产物。
 */
interface RestorePreparedContext {
    checkpoint: CheckpointRecord;
    checkpoints: CheckpointRecord[];
    missingBackupDirs: string[];
    autoPrunedCheckpointCount: number;
    /** undefined = 旧版无 fileHashes 存档（legacy 恢复语义：不删除任何文件） */
    targetState?: RestoreTargetState;
    /** EX-11: 目标存档的 manifest（含排除规则快照；旧存档无 manifest 时为 undefined） */
    manifest?: CheckpointManifest;
    chain: CheckpointRecord[];
    chainEntries: RestoreChainEntry[];
    currentHashes: Record<string, string>;
    currentEmptyDirs: string[];
    protectedScopedPaths: Set<string>;
    deletableScopedPaths: Set<string>;
}

/**
 * 检查点记录
 */
export interface CheckpointRecord {
    /** 唯一标识 */
    id: string;
    /** 关联的对话 ID */
    conversationId: string;
    /** 关联的消息索引 */
    messageIndex: number;
    /** 触发检查点的工具名称 */
    toolName: string;
    /** 检查点阶段 */
    phase: 'before' | 'after';
    /** 创建时间戳 */
    timestamp: number;
    /** 备份目录名 */
    backupDir: string;
    /** 备份的文件数量 */
    fileCount: number;
    /** 内容签名（用于比较两个检查点是否内容一致） */
    contentHash: string;
    /** 可选描述 */
    description?: string;
    /** 备份类型：full=完整备份，incremental=增量备份 */
    type?: 'full' | 'incremental';
    /** 增量备份基于的检查点 ID（仅增量备份有效） */
    baseCheckpointId?: string;
    /** 变更的文件列表（仅增量备份有效） */
    changes?: FileChange[];
    /** 所有文件的哈希映射（用于增量比较）。只包含真正备份成功的文件 */
    fileHashes?: Record<string, string>;
    /** 快照时的文件 stat 信息（用于增量哈希复用；旧记录无此字段时回退全量哈希） */
    fileStats?: Record<string, { mtimeMs: number; size: number; mtimeNs?: string }>;
    /** 快照时的自定义忽略模式（restore 据此判断“快照时该路径是否可见”） */
    ignorePatterns?: string[];
    /** 快照时被排除的文件/目录数（EX-10；恢复时解释“为什么没有备份”） */
    excludedCount?: number;
    /** 快照时被排除路径的合计字节数（EX-10；size 排除等） */
    excludedBytes?: number;
    /** 快照时的排除规则快照（EX-10；恢复时与当前规则对比，解释规则差异） */
    ignoreSnapshot?: CheckpointIgnoreSnapshot;
    /** 快照时可见但备份复制失败的文件（restore 绝不能删除这些文件） */
    unbackedPaths?: string[];
    /** 空目录列表（相对路径） */
    emptyDirs?: string[];
    /** 存档时的工作区根目录集合（CP-01：恢复前校验当前工作区身份；旧存档无此字段） */
    workspaceRoots?: CheckpointWorkspaceRoot[];
    /** 工作区身份指纹（roots 集合的哈希，用于恢复前快速校验） */
    workspaceFingerprint?: string;
    /** 关联的消息节点 ID（树状分支扩展预留，与 CheckpointSummary 对齐） */
    messageNodeId?: string;
    /** CPF-09: 创建时记录的备份目录磁盘占用（字节）；旧存档缺失时按需懒扫描并写回 */
    backupBytes?: number;
    /** CPF-01: 本存档 manifest 的 schema 版本（写入 manifest.json 时记录） */
    manifestVersion?: number;
}

/**
 * 批量删除检查点的请求项
 */
export interface BatchCheckpointDeleteItem {
    /** 关联的对话 ID */
    conversationId: string;
    /**
     * 要删除的检查点 ID 列表
     * 空数组表示删除该对话的全部检查点
     */
    checkpointIds: string[];
}

/**
 * 批量删除检查点的单个对话处理结果
 */
export interface BatchCheckpointDeleteResult {
    /** 关联的对话 ID */
    conversationId: string;
    /** 实际删除的检查点 ID */
    deletedIds: string[];
    /** 因被其他保留的检查点引用为基快照而被拒绝删除的 ID（保护增量链完整性） */
    rejectedIds: string[];
    /** 该对话的处理是否成功 */
    success: boolean;
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
     * 为某个根目录创建检查点忽略解析器（H-1：恢复/当前状态过滤接入完整四层排除模型）。
     *
     * `includeCustomPatterns` 用于区分两类场景：
     * - 工作区侧：叠加完整 CheckpointConfig——旧字段 + exclusion.customPatterns 合并、
     *   enabledProfiles（缺省全开）、扩展存储根绝对路径强制排除
     * - 备份目录侧：只按备份内容本身遍历，不再追加工作区配置（不启用默认类别、
     *   不排除存储根——备份目录本身位于存储根内）
     */
    private createIgnoreResolver(rootDir: string, includeCustomPatterns: boolean = true): CheckpointIgnoreResolver {
        const config = this.settingsManager.getCheckpointConfig();
        const extraPatterns = includeCustomPatterns
            ? [
                ...(config.customIgnorePatterns ?? []),
                ...(config.exclusion?.customPatterns ?? [])
            ]
            : [];
        return new CheckpointIgnoreResolver(rootDir, extraPatterns, {
            // 与快照构建同一口径：缺省全部默认类别启用（前端未配置时全开）
            enabledProfiles: includeCustomPatterns
                ? (config.exclusion?.enabledProfiles ?? DEFAULT_ENABLED_PROFILES)
                : undefined,
            // 排除整个扩展存储根（含 checkpoints/memory/conversations 等），
            // 恢复过滤同样不得把文件写回/删除存储目录
            excludeAbsolutePaths: includeCustomPatterns ? [path.dirname(this.checkpointsDir)] : []
        });
    }

    /**
     * 收集某个根目录下应被检查点系统“看见”的文件和空目录。
     *
     * `includeCustomPatterns=false` 用于备份目录侧遍历：只按备份内容本身遍历，
     * 不再追加工作区配置的自定义忽略模式。
     */
    private async collectSnapshotEntries(
        rootDir: string,
        includeCustomPatterns: boolean = true
    ): Promise<{ files: string[]; dirs: string[] }> {
        return this.createIgnoreResolver(rootDir, includeCustomPatterns).collectEntries();
    }

    /**
     * 创建检查点
     *
     * @param conversationId 对话 ID
     * @param messageIndex 消息索引
     * @param toolName 工具名称或消息类型（user_message, model_message, tool_batch）
     * @param phase 阶段（执行前/执行后）
     * @returns 检查点记录，如果创建失败返回 null
     */
    async createCheckpoint(
        conversationId: string,
        messageIndex: number,
        toolName: string,
        phase: 'before' | 'after',
        options?: { progress?: (progress: CheckpointOperationProgress) => void }
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
        const { operationId, signal, report } = this.beginOperation('create', conversationId);
        const progressCb = options?.progress;
        const reportProgress = (patch: Partial<CheckpointOperationProgress>): void => {
            const merged = this.updateOperation(operationId, patch);
            progressCb?.(merged);
        };
        reportProgress({ phase: 'scanning', processed: 0, total: 0 });
        
        // CP-02: 使用全部工作区根，不再只备份第一个根目录
        const roots = this.getRuntimeWorkspaceRoots();
        if (roots.length === 0) {
            console.warn('[CheckpointManager] No workspace root');
            return null;
        }
        
        const checkpointId = this.generateCheckpointId();
        const backupDir = path.join(this.checkpointsDir, checkpointId);

        // CP-03: 存档创建进入工作区级互斥（与恢复、删除、写工具互斥，保证快照一致性）
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
                    const markUnbacked = (scopedPath: string) => {
                        unbackedPaths.push(scopedPath);
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
                        if (!unbackedPaths.includes(entry.scopedPath)) {
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
            signal
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
        return error instanceof Error && error.message === 'File write lock acquisition was cancelled';
    }

    /**
     * 把快照中的单个 scoped 路径复制进备份目录（scoped 布局：backupDir/ws_xxx/relative）。
     *
     * @returns ok=复制成功并返回复制字节数（CPF-09 backupBytes 统计）；失败由调用方标记 unbacked。
     */
    private async copyFileToBackup(
        scopedPath: string,
        backupDir: string,
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ ok: true; bytes: number } | { ok: false; bytes: 0 }> {
        try {
            const parsed = parseWorkspaceScopedPath(scopedPath, roots as RuntimeWorkspaceRoot[]);
            const srcPath = path.join(parsed.root.fsPath, ...parsed.relativePath.split('/'));
            const destPath = path.join(backupDir, ...scopedPath.split('/'));
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            const stat = await fs.stat(srcPath);
            await fs.copyFile(srcPath, destPath);
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
     * 计算文件的 MD5 哈希（流式读取，避免把大文件整体读入内存）
     */
    private async getFileHash(filePath: string): Promise<string | null> {
        try {
            const hash = crypto.createHash('md5');
            await new Promise<void>((resolve, reject) => {
                const stream = createReadStream(filePath);
                stream.on('error', reject);
                stream.on('data', chunk => hash.update(chunk));
                stream.on('end', () => resolve());
            });
            return hash.digest('hex');
        } catch {
            return null;
        }
    }

    /**
     * 基于“当前工作区规则”过滤检查点目标状态（多根 scoped 版本）。
     *
     * 每个根目录使用各自的忽略解析器；旧格式相对路径键在单根下自动包装为 scoped 键。
     * 无法解析的键（如旧存档多根下）跳过，不恢复该路径。
     */
    private async filterRestoreTargetScoped(
        fileHashes: Record<string, string>,
        emptyDirs: string[],
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ fileHashes: Record<string, string>; emptyDirs: string[] }> {
        const resolvers = new Map<string, CheckpointIgnoreResolver>();
        const getResolver = (root: RuntimeWorkspaceRoot): CheckpointIgnoreResolver => {
            let resolver = resolvers.get(root.id);
            if (!resolver) {
                resolver = this.createIgnoreResolver(root.fsPath);
                resolvers.set(root.id, resolver);
            }
            return resolver;
        };

        const filteredFileHashes: Record<string, string> = {};
        // 文件恢复目标和工作区扫描使用同一忽略口径，确保比较一致。
        for (const [rawKey, hash] of Object.entries(fileHashes)) {
            const scopedKey = toScopedKey(rawKey, roots);
            try {
                const parsed = parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]);
                if (!(await getResolver(parsed.root).isIgnored(parsed.relativePath, false))) {
                    filteredFileHashes[scopedKey] = hash;
                }
            } catch (err) {
                console.warn(`[CheckpointManager] Skip unparsable checkpoint path ${scopedKey}:`, err);
            }
        }

        const filteredEmptyDirs: string[] = [];
        // 空目录同样需要按当前规则过滤，否则 restore 会重新创建当前已忽略的目录壳。
        for (const rawKey of emptyDirs) {
            const scopedKey = toScopedKey(rawKey, roots);
            try {
                const parsed = parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]);
                if (!(await getResolver(parsed.root).isIgnored(parsed.relativePath, true))) {
                    filteredEmptyDirs.push(scopedKey);
                }
            } catch (err) {
                console.warn(`[CheckpointManager] Skip unparsable checkpoint dir ${scopedKey}:`, err);
            }
        }

        return {
            fileHashes: filteredFileHashes,
            emptyDirs: filteredEmptyDirs
        };
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
     * 获取从基准点到目标点的增量链
     */
    private getIncrementalChain(
        checkpoints: CheckpointRecord[],
        targetCheckpoint: CheckpointRecord
    ): { chain: CheckpointRecord[]; broken: boolean } {
        const chain: CheckpointRecord[] = [];
        let current: CheckpointRecord | undefined = targetCheckpoint;
        let broken = false;

        while (current) {
            chain.unshift(current);  // 添加到链的开头

            if (current.type !== 'incremental' || !current.baseCheckpointId) {
                break;  // 到达完整备份，停止
            }

            current = checkpoints.find(cp => cp.id === current!.baseCheckpointId);
            if (!current) {
                broken = true;  // #28: 增量链断裂（找不到 baseCheckpointId 对应的检查点）
            }
        }

        return { chain, broken };
    }

    private async backupDirectoryExists(backupDir: string): Promise<boolean> {
        return this.queryService.backupDirectoryExists(backupDir);
    }

    private async pruneMissingBackupCheckpointRecords(
        conversationId: string,
        checkpoints: CheckpointRecord[]
    ): Promise<{ checkpoints: CheckpointRecord[]; missingBackupDirs: string[]; prunedCount: number }> {
        return this.queryService.pruneMissingBackupCheckpointRecords(conversationId, checkpoints);
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
        const { operationId, signal, report } = this.beginOperation('restore', conversationId, checkpointId);
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
                    const prepared = await this.prepareRestore(conversationId, checkpointId, roots);
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
                        const legacyResult = await this.restoreLegacyCheckpointViaEngine(
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
                    await this.refreshAffectedDocuments(engineResult.modifiedPaths, engineResult.deletedPaths);

                    // 失败路径转为相对路径展示（scoped 键对用户不友好）
                    const failures: RestoreFailure[] = engineResult.failures.map(f => ({
                        path: this.toDisplayPath(f.path, roots),
                        reason: f.reason
                    }));
                    const hasFailures = failures.length > 0;

                    // 显示恢复结果
                    const phaseText = checkpoint.phase === 'before'
                        ? t('modules.checkpoint.description.before')
                        : t('modules.checkpoint.description.after');
                    let message: string;
                    if (hasFailures) {
                        message = `$(warning) ${t('modules.checkpoint.restore.partialFailure', { toolName: checkpoint.toolName, phase: phaseText, count: failures.length })}`;
                    } else {
                        message = `$(check) ${t('modules.checkpoint.restore.success', { toolName: checkpoint.toolName, phase: phaseText })}`;
                    }
                    const details: string[] = [];
                    if (engineResult.restored > 0) details.push(t('modules.checkpoint.restore.filesUpdated', { count: engineResult.restored }));
                    if (engineResult.deleted > 0) details.push(t('modules.checkpoint.restore.filesDeleted', { count: engineResult.deleted }));
                    if (engineResult.skipped > 0) details.push(t('modules.checkpoint.restore.filesUnchanged', { count: engineResult.skipped }));
                    if (details.length > 0) {
                        message += `（${details.join('，')}）`;
                    }
                    vscode.window.setStatusBarMessage(message, 5000);

                    log.info('restore_from_chain', { chainLength: chain.length, restored: engineResult.restored, deleted: engineResult.deleted, skipped: engineResult.skipped, failureCount: failures.length });

                    return {
                        success: engineResult.success,
                        restored: engineResult.restored,
                        deleted: engineResult.deleted,
                        skipped: engineResult.skipped,
                        failures: hasFailures ? failures : undefined,
                        error: hasFailures ? this.formatFailureSummary(failures) : undefined,
                        missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                        autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                        // CP-08: 快照时未备份的文件（超限/不可读/复制失败）转为显示路径，
                        // 前端据此提示“这些文件未被该存档备份，恢复不会删除/恢复它们”
                        unbackedPaths: this.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
                        // EX-11: 解释「该存档创建时按当时规则排除了哪些文件」
                        excludedNote: this.buildExcludedNote(prepared.ctx.manifest, checkpoint),
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
            return { success: false, restored: 0, deleted: 0, skipped: 0, deletablePaths: [], untrackedPaths: [], error: 'No workspace root' };
        }

        return checkpointOperationLockManager.runExclusive(
            roots.map(root => root.id),
            'restore',
            `checkpoint:${conversationId}:${checkpointId}:preview`,
            async () => {
                try {
                    const prepared = await this.prepareRestore(conversationId, checkpointId, roots);
                    if (!prepared.ok) {
                        const r = prepared.result;
                        return {
                            success: r.success,
                            restored: r.restored,
                            deleted: r.deleted,
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
                            skipped: -1,
                            deletablePaths: [],
                            untrackedPaths: [],
                            legacy: true,
                            unbackedPaths: this.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
                            missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                            autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                            // EX-11: 旧存档无 manifest 时不生成排除说明
                            excludedNote: prepared.ctx.manifest ? this.buildExcludedNote(prepared.ctx.manifest, checkpoint) : undefined,
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
                        deleted: plan.toDelete.length + plan.untrackedToDelete.length,
                        skipped: plan.skipped,
                        deletablePaths: plan.toDelete.map(p => this.toDisplayPath(p, roots)),
                        // 快照后新建的文件与空目录合并展示，确认后一并清理
                        untrackedPaths: [
                            ...plan.untrackedToDelete.map(p => this.toDisplayPath(p, roots)),
                            ...plan.untrackedEmptyDirs.map(p => this.toDisplayPath(p, roots))
                        ],
                        unbackedPaths: this.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
                        missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                        autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                        // EX-11: 解释「该存档创建时按当时规则排除了哪些文件」
                        excludedNote: this.buildExcludedNote(prepared.ctx.manifest, checkpoint),
                    };
                } catch (err) {
                    const error = err instanceof Error ? err.message : 'Unknown error';
                    console.error('[CheckpointManager] Failed to preview restore:', err);
                    return { success: false, restored: 0, deleted: 0, skipped: 0, deletablePaths: [], untrackedPaths: [], error };
                }
            }
        );
    }

    /**
     * 恢复公共准备（CP-09）：prune 缺失记录、工作区校验、增量链完整性验证、
     * 收集当前工作区状态、计算删除边界。
     *
     * restoreCheckpoint 与 previewRestore 共用此路径，保证「预览确认的删除清单」
     * 与「实际执行的删除」基于同一套校验与计算；本方法不执行文件写入。
     *
     * @returns ok=true 时携带恢复上下文；ok=false 时携带可直接返回的失败结果。
     */
    private async prepareRestore(
        conversationId: string,
        checkpointId: string,
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ ok: true; ctx: RestorePreparedContext } | { ok: false; result: RestoreResult }> {
        // 查找检查点（缺失备份目录的记录先裁剪）
        let checkpoints = await this.readCheckpointListFromConversation(conversationId);
        let missingBackupDirs: string[] = [];
        let autoPrunedCheckpointCount = 0;

        const pruneResult = await this.pruneMissingBackupCheckpointRecords(conversationId, checkpoints);
        checkpoints = pruneResult.checkpoints;
        missingBackupDirs = pruneResult.missingBackupDirs;
        autoPrunedCheckpointCount = pruneResult.prunedCount;

        const foundCheckpoint = checkpoints.find(cp => cp.id === checkpointId);
        // CPF-01: 新格式记录（元数据不含 fileHashes/fileStats）从 manifest 回填完整数据；旧记录直接使用
        const checkpoint = foundCheckpoint
            ? await this.manifestRepository.enrichRecord(foundCheckpoint)
            : undefined;
        // EX-11: 目标存档的 manifest（含排除规则快照；enrichRecord 已加载并缓存）
        const restoreManifest = checkpoint
            ? await this.manifestRepository.loadManifest(checkpoint.id, checkpoint)
            : undefined;

        const failResult = (error: string, extra?: Partial<RestoreResult>): { ok: false; result: RestoreResult } => ({
            ok: false,
            result: {
                success: false,
                restored: 0,
                deleted: 0,
                skipped: 0,
                error,
                missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                ...extra
            }
        });

        if (!checkpoint) {
            return failResult('Checkpoint not found');
        }

        // CP-01: 新格式存档（带工作区身份元数据）必须通过工作区校验，
        // 防止项目 A 的存档被静默恢复到项目 B；旧存档无身份元数据，保持兼容。
        if (checkpoint.workspaceRoots?.length) {
            const validation = validateWorkspaceSnapshot(
                checkpoint.workspaceRoots,
                checkpoint.workspaceFingerprint,
                roots
            );
            if (!validation.valid) {
                return failResult(t('modules.checkpoint.restore.workspaceMismatch'));
            }
        }

        // 旧存档（相对路径键）无法在多根工作区中确定文件归属，明确拒绝而不是静默错恢复
        const hasLegacyKeys = checkpoint.fileHashes
            ? Object.keys(checkpoint.fileHashes).some(key => !isWorkspaceScopedKey(key))
            : false;
        if (hasLegacyKeys && roots.length > 1) {
            return failResult(t('modules.checkpoint.restore.multiRootLegacyNotSupported'));
        }

        // 先用当前规则裁剪目标状态（每个根独立 ignore 作用域），再进行 diff / restore。
        const targetState = checkpoint.fileHashes
            ? await this.filterRestoreTargetScoped(
                checkpoint.fileHashes,
                checkpoint.emptyDirs || [],
                roots
            )
            : undefined;

        // 旧版存档（无 fileHashes）：单根走 legacy 语义（只复制、绝不删除）；多根明确拒绝
        if (!checkpoint.fileHashes) {
            // L5: 新格式记录（带 manifestVersion/workspaceRoots）但 manifest 缺失（磁盘文件
            // 丢失/从未写入）→ 不是旧版 legacy 存档，而是存档数据丢失：显式报错，
            // 避免按 legacy 路径“假成功”（只恢复备份目录残留内容）。
            if (checkpoint.manifestVersion !== undefined || (checkpoint.workspaceRoots?.length ?? 0) > 0) {
                return failResult('Checkpoint backup data is missing (manifest not found)');
            }
            if (roots.length > 1) {
                return failResult(t('modules.checkpoint.restore.multiRootLegacyNotSupported'));
            }
            return {
                ok: true,
                ctx: {
                    checkpoint,
                    checkpoints,
                    missingBackupDirs,
                    autoPrunedCheckpointCount,
                    targetState: undefined,
                    manifest: restoreManifest ?? undefined,
                    chain: [],
                    chainEntries: [],
                    currentHashes: {},
                    currentEmptyDirs: [],
                    protectedScopedPaths: new Set(),
                    deletableScopedPaths: new Set()
                }
            };
        }

        // 获取增量链（从基准点到目标点）
        const { chain, broken } = this.getIncrementalChain(checkpoints, checkpoint);

        // #28: 增量链断裂时显式失败，不静默降级
        if (broken) {
            return failResult(t('modules.checkpoint.restore.chainBroken'), { failures: [] });
        }

        if (chain.length === 0) {
            return failResult('Cannot build checkpoint chain');
        }

        // 验证链的完整性（确保所有备份目录都存在）；缺失记录在链内裁剪
        const chainMissingBackupDirs: string[] = [];
        for (const cp of chain) {
            if (!(await this.backupDirectoryExists(cp.backupDir))) {
                chainMissingBackupDirs.push(cp.backupDir);
            }
        }
        if (chainMissingBackupDirs.length > 0) {
            const chainMissingSet = new Set(chainMissingBackupDirs);
            const pruned = await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const remained = list.filter(cp => !chainMissingSet.has(cp.backupDir));
                return remained.length === list.length ? current : remained;
            });
            if (Array.isArray(pruned)) {
                autoPrunedCheckpointCount += checkpoints.length - pruned.length;
            }
            const allMissingBackupDirs = Array.from(
                new Set([...missingBackupDirs, ...chainMissingBackupDirs])
            );
            return failResult(
                `Backup directory not found: ${allMissingBackupDirs.join(', ')}`,
                { missingBackupDirs: allMissingBackupDirs }
            );
        }

        // 工作区当前状态与目标状态使用同一 ignore 口径收集（每个根独立 resolver）
        const { currentHashes, currentEmptyDirs } = await this.collectCurrentWorkspaceState(roots);

        // 快照时可见但未备份的路径（复制失败/大小超限/不可读）：恢复时绝不能删除
        const protectedScopedPaths = new Set<string>();
        for (const rawKey of checkpoint.unbackedPaths ?? []) {
            protectedScopedPaths.add(toScopedKey(rawKey, roots));
        }

        // #29: 只删除目标快照 fileHashes 中记录过的路径，
        // 快照后新建、快照时被忽略/未备份的文件不会被静默删除
        const deletableScopedPaths = new Set<string>();
        for (const rawKey of Object.keys(checkpoint.fileHashes)) {
            deletableScopedPaths.add(toScopedKey(rawKey, roots));
        }

        // CPF-01/CPF-08: 增量链节点同样从 manifest 回填 fileHashes/changes（新格式记录元数据不含），
        // 恢复引擎据此构建 O(1) 文件路径索引
        const chainEntries: RestoreChainEntry[] = [];
        for (const cp of chain) {
            const enriched = await this.manifestRepository.enrichRecord(cp);
            chainEntries.push({
                checkpointId: cp.id,
                backupDir: cp.backupDir,
                fileHashes: enriched.fileHashes,
                // 增量节点磁盘上只保存 changes 里的文件；引擎据此限定备份文件边界
                changes: enriched.changes
            });
        }

        return {
            ok: true,
            ctx: {
                checkpoint,
                checkpoints,
                missingBackupDirs,
                autoPrunedCheckpointCount,
                targetState,
                manifest: restoreManifest ?? undefined,
                chain,
                chainEntries,
                currentHashes,
                currentEmptyDirs,
                protectedScopedPaths,
                deletableScopedPaths
            }
        };
    }

    /**
     * 收集当前工作区的文件哈希与空目录（scoped 键）。
     *
     * 与目标状态过滤使用同一 ignore 口径（每个根独立 resolver），
     * 保证 diff 与删除边界一致：当前被忽略的文件不进入哈希、也不会被删除。
     */
    private async collectCurrentWorkspaceState(
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ currentHashes: Record<string, string>; currentEmptyDirs: string[] }> {
        const currentHashes: Record<string, string> = {};
        const currentEmptyDirs: string[] = [];
        for (const root of roots) {
            const resolver = this.createIgnoreResolver(root.fsPath);
            const { files, dirs } = await resolver.collectEntries();
            for (const file of files) {
                const relativePath = path.relative(root.fsPath, file).replace(/\\/g, '/');
                const scopedPath = createWorkspaceScopedPath(root.id, relativePath);
                const hash = await this.getFileHash(file);
                if (hash) {
                    currentHashes[scopedPath] = hash;
                }
            }
            for (const dir of dirs) {
                const relativePath = path.relative(root.fsPath, dir).replace(/\\/g, '/');
                currentEmptyDirs.push(createWorkspaceScopedPath(root.id, relativePath));
            }
        }
        return { currentHashes, currentEmptyDirs };
    }

    /**
     * 把引擎返回的 scoped 失败路径转为相对路径展示；解析失败时保留原值。
     */
    private toDisplayPath(scopedKey: string, roots: readonly RuntimeWorkspaceRoot[]): string {
        try {
            return parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]).relativePath;
        } catch {
            return scopedKey;
        }
    }

    /**
     * 把存档记录的 unbackedPaths（scoped 键）批量转为显示路径。
     * 旧存档无该字段时返回空数组。
     */
    private toDisplayUnbackedPaths(
        unbackedPaths: string[] | undefined,
        roots: readonly RuntimeWorkspaceRoot[]
    ): string[] | undefined {
        if (!unbackedPaths || unbackedPaths.length === 0) {
            return undefined;
        }
        const displayed = unbackedPaths.map(pathKey => this.toDisplayPath(pathKey, roots));
        // 限制数量，避免把大量超限文件路径塞进 IPC 响应
        return displayed.length > 50 ? displayed.slice(0, 50) : displayed;
    }

    /** 把失败清单压缩成单行摘要（供前端直接展示），超出 5 条时截断并计数 */
    private formatFailureSummary(failures: RestoreFailure[]): string {
        const shown = failures.slice(0, 5).map(f => `${f.path}: ${f.reason}`).join('; ');
        const rest = failures.length - 5;
        return rest > 0 ? `${shown}; ... (${rest} more)` : shown;
    }

    /**
     * 旧版本检查点（无 fileHashes）恢复。
     *
     * 以备份目录实际内容为恢复目标（相对路径键 → scoped 包装），复用恢复引擎
     * 获得路径安全校验与失败清单；删除白名单传空集——旧记录没有“快照时可见/未备份”
     * 清单，无法安全判断当前文件归属，因此绝不删除工作区任何文件。
     */
    private async restoreLegacyCheckpointViaEngine(
        checkpoint: CheckpointRecord,
        roots: RuntimeWorkspaceRoot[],
        missingBackupDirs: string[],
        autoPrunedCheckpointCount: number,
        signal?: AbortSignal
    ): Promise<RestoreResult> {
        // 备份目录以“备份内容自身”为遍历边界（不叠加工作区自定义模式）
        const backupPath = path.join(this.checkpointsDir, checkpoint.backupDir);
        let backupFiles: string[];
        let backupDirs: string[];
        try {
            const entries = await this.collectSnapshotEntries(backupPath, false);
            backupFiles = entries.files;
            backupDirs = entries.dirs;
        } catch (err) {
            console.error('[CheckpointManager] Failed to scan legacy checkpoint backup:', err);
            return { success: false, restored: 0, deleted: 0, skipped: 0, error: 'Failed to scan checkpoint backup' };
        }

        // 以备份目录内容构造目标状态（相对路径键，引擎内自动包装为 scoped）
        const rawHashes: Record<string, string> = {};
        for (const backupFile of backupFiles) {
            const relativePath = normalizeCheckpointPath(path.relative(backupPath, backupFile));
            if (relativePath) {
                const hash = await this.getFileHash(backupFile);
                if (hash) rawHashes[relativePath] = hash;
            }
        }
        const rawEmptyDirs = backupDirs
            .map(dir => normalizeCheckpointPath(path.relative(backupPath, dir)))
            .filter(Boolean);

        // 当前规则裁剪目标状态 + 当前工作区状态（同一 ignore 口径）
        const targetState = await this.filterRestoreTargetScoped(rawHashes, rawEmptyDirs, roots);
        const { currentHashes, currentEmptyDirs } = await this.collectCurrentWorkspaceState(roots);

        // 引擎执行：白名单为空集 → 不删除任何文件
        const engineResult = await restoreWorkspaceSnapshot(
            {
                checkpointsDir: this.checkpointsDir,
                roots,
                deletableScopedPaths: new Set<string>(),
                signal
            },
            [{
                checkpointId: checkpoint.id,
                backupDir: checkpoint.backupDir,
                fileHashes: rawHashes,
                changes: Object.keys(rawHashes).map(rawKey => ({ path: rawKey, type: 'added' as const }))
            }],
            { fileHashes: targetState.fileHashes, emptyDirs: targetState.emptyDirs },
            currentHashes,
            currentEmptyDirs
        );

        await this.refreshAffectedDocuments(engineResult.modifiedPaths, engineResult.deletedPaths);

        const failures: RestoreFailure[] = engineResult.failures.map(f => ({
            path: this.toDisplayPath(f.path, roots),
            reason: f.reason
        }));
        const hasFailures = failures.length > 0;

        const phaseText = checkpoint.phase === 'before'
            ? t('modules.checkpoint.description.before')
            : t('modules.checkpoint.description.after');
        let message: string;
        if (hasFailures) {
            message = `$(warning) ${t('modules.checkpoint.restore.partialFailure', { toolName: checkpoint.toolName, phase: phaseText, count: failures.length })}`;
        } else {
            message = `$(check) ${t('modules.checkpoint.restore.success', { toolName: checkpoint.toolName, phase: phaseText })}`;
        }
        const details: string[] = [];
        if (engineResult.restored > 0) details.push(t('modules.checkpoint.restore.filesUpdated', { count: engineResult.restored }));
        if (engineResult.skipped > 0) details.push(t('modules.checkpoint.restore.filesUnchanged', { count: engineResult.skipped }));
        if (details.length > 0) {
            message += `（${details.join('，')}）`;
        }
        vscode.window.setStatusBarMessage(message, 5000);

        log.info('restore_legacy_backup', { restored: engineResult.restored, skipped: engineResult.skipped, failureCount: failures.length });

        return {
            success: engineResult.success,
            restored: engineResult.restored,
            deleted: 0,
            skipped: engineResult.skipped,
            failures: hasFailures ? failures : undefined,
            error: hasFailures ? this.formatFailureSummary(failures) : undefined,
            missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
            autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
            unbackedPaths: this.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
        };
    }
    
    /**
     * 清理过期检查点（CPF-12：委托 CheckpointRetentionService）
     */
    private async cleanupOldCheckpoints(conversationId: string): Promise<void> {
        await this.retentionService.cleanupOldCheckpoints(conversationId);
    }
    
    /**
     * 把被删除检查点的备份内容合并进其后继（链重挂），并持久化后继的元数据。
     *
     * 增量链 A → M → B（B.base = M）：直接删除 M 会让 B 的恢复链变成 [A, B]，
     * 而 B 的备份目录只有 B 相对 M 变更的文件——M 独有（B 未改）的文件会从链上
     * 消失，恢复 B 时 findFileInChain 报 missing_in_chain。
     * 合并 = 把 M 的备份文件复制进 B 的目录（force:false 不覆盖 B 已有的更新版本），
     * 把 M.changes 并入 B.changes（B 未涉及的路径保留），B.baseCheckpointId 改指 M.base。
     * 新格式存档的 changes 存于 manifest，合并时同步更新后继 manifest（CPF-01）。
     *
     * CPF-12：委托 CheckpointRetentionService。
     */
    private async mergeCheckpointIntoSuccessor(
        conversationId: string,
        successor: CheckpointRecord,
        removed: CheckpointRecord
    ): Promise<void> {
        await this.retentionService.mergeCheckpointIntoSuccessor(conversationId, successor, removed);
    }

    /**
     * 删除检查点
     */
    async deleteCheckpoint(conversationId: string, checkpointId: string): Promise<boolean> {
        const roots = this.getRuntimeWorkspaceRoots();
        if (roots.length === 0) {
            return false;
        }
        return checkpointOperationLockManager.runExclusive(
            roots.map(root => root.id),
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
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const checkpoint = list.find(cp => cp.id === checkpointId);
                if (!checkpoint) {
                    return current; // 不存在：原引用=无变更跳过写回
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
        const roots = this.getRuntimeWorkspaceRoots();
        if (roots.length === 0) {
            return 0;
        }
        return checkpointOperationLockManager.runExclusive(
            roots.map(root => root.id),
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

                // 需要保留的检查点 ID 集合：目标检查点及其增量基链（否则保留的检查点会因基快照被删而无法恢复）。
                // 其余保留节点（messageIndex < fromIndex）的祖先链按索引天然也在保留区间内，无需额外闭包。
                const excludeIds = new Set<string>();
                if (excludeCheckpointId) {
                    let cur = checkpoints.find(cp => cp.id === excludeCheckpointId);
                    while (cur && !excludeIds.has(cur.id)) {
                        excludeIds.add(cur.id);
                        const baseId = cur.baseCheckpointId;
                        cur = baseId ? checkpoints.find(cp => cp.id === baseId) : undefined;
                    }
                }

                // 筛选出需要删除的检查点（消息索引 >= fromIndex 且不在保留集合中）
                toDelete = checkpoints.filter(cp => cp.messageIndex >= fromIndex && !excludeIds.has(cp.id));
                if (toDelete.length === 0) {
                    return current; // 无变更，跳过写回
                }
                backupDirsToDelete = toDelete.map(cp => cp.backupDir);
                return checkpoints.filter(cp => cp.messageIndex < fromIndex || excludeIds.has(cp.id));
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
     * 只刷新受影响的文档
     *
     * 相比刷新所有文档，这种方式更高效，只处理实际被修改或删除的文件
     *
     * @param modifiedFiles 被修改或新增的文件路径列表
     * @param deletedFiles 被删除的文件路径列表
     */
    private async refreshAffectedDocuments(modifiedFiles: string[], deletedFiles: string[]): Promise<void> {
        // 创建快速查找集合
        const modifiedSet = new Set(modifiedFiles.map(f => f.toLowerCase()));
        const deletedSet = new Set(deletedFiles.map(f => f.toLowerCase()));
        
        try {
            // 获取所有已打开的文本文档
            const openDocuments = vscode.workspace.textDocuments;
            
            for (const doc of openDocuments) {
                if (doc.uri.scheme !== 'file') continue;
                
                const docPath = doc.uri.fsPath.toLowerCase();
                
                // 检查文档是否在受影响列表中
                if (modifiedSet.has(docPath)) {
                    // 恢复场景：磁盘上已是恢复后的内容，打开着的文档 buffer 是旧内容。
                    // 绝不能直接 doc.save()（会把用户旧 buffer 写回磁盘，覆盖刚恢复的内容），
                    // 也不能直接 revert（dirty 时会弹 VSCode 原生"是否放弃更改？"确认框阻塞流程）。
                    // 方案：把文档 buffer 替换为磁盘内容后静默 save，丢弃旧 buffer。
                    try {
                        if (doc.isDirty) {
                            const diskText = await fs.readFile(doc.uri.fsPath, 'utf8');
                            const edit = new vscode.WorkspaceEdit();
                            const fullRange = new vscode.Range(
                                doc.positionAt(0),
                                doc.positionAt(doc.getText().length)
                            );
                            edit.replace(doc.uri, fullRange, diskText);
                            const applied = await vscode.workspace.applyEdit(edit);
                            if (applied) {
                                await doc.save();
                                continue;
                            }
                        }
                        // applyEdit 失败时回退到 revert（可能弹框，作为最后手段）
                        await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                    } catch (err) {
                        console.warn(`[CheckpointManager] Failed to revert ${doc.uri.fsPath}:`, err);
                    }
                }
                // 删除的文件不做任何处理，让 VSCode 自然显示"文件已删除"的状态
            }
            
            // 关闭涉及受影响文件的 diff 视图。
            // 关闭前采样聊天输入框焦点状态：preserveFocus 只能阻止焦点跳进
            // 编辑器，无法阻止 workbench 把焦点从侧边栏 webview 收走，
            // 关闭后按需把焦点归还给聊天视图
            const restoreFocus = shouldRestoreChatInputFocus();
            let closedAnyDiffTab = false;
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    if (tab.input instanceof vscode.TabInputTextDiff) {
                        const diffInput = tab.input as vscode.TabInputTextDiff;
                        const modifiedPath = diffInput.modified.fsPath.toLowerCase();
                        
                        // 如果 diff 涉及被修改或删除的文件，关闭它
                        if (modifiedSet.has(modifiedPath) || deletedSet.has(modifiedPath)) {
                            await vscode.window.tabGroups.close(tab, true);
                            closedAnyDiffTab = true;
                        }
                    }
                }
            }
            if (closedAnyDiffTab) {
                await restoreChatInputFocus(restoreFocus);
            }
        } catch (err) {
            console.error('[CheckpointManager] Failed to refresh affected documents:', err);
        }
    }
    
    /**
     * 删除对话的所有检查点
     */
    async deleteAllCheckpoints(conversationId: string): Promise<{ success: boolean; deletedCount: number }> {
        const roots = this.getRuntimeWorkspaceRoots();
        if (roots.length === 0) {
            return { success: false, deletedCount: 0 };
        }
        // CPF-11: 删除操作注册进度/取消句柄
        const { operationId, signal, report } = this.beginOperation('delete', conversationId);
        try {
            return await checkpointOperationLockManager.runExclusive(
            roots.map(root => root.id),
            'delete',
            `checkpoint:${conversationId}:delete-all`,
            async () => {
                try {
                    // 清空列表在链内原子完成；磁盘删除放在写回成功之后
                    let backupDirsToDelete: string[] = [];
                    await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                        const checkpoints = Array.isArray(current) ? current as CheckpointRecord[] : [];
                        if (checkpoints.length === 0) {
                            return current; // 无变更，跳过写回
                        }
                        backupDirsToDelete = checkpoints.map(cp => cp.backupDir);
                        return [];
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

            const roots = this.getRuntimeWorkspaceRoots();
            if (roots.length === 0) {
                results.push(result);
                continue;
            }

            // M7: 每个对话注册进度/取消句柄（设置页批量删除可展示进度并取消）
            const { operationId, signal, report } = this.beginOperation('delete', item.conversationId);
            try {
                await checkpointOperationLockManager.runExclusive(
                    roots.map(root => root.id),
                    'delete',
                    `checkpoint:${item.conversationId}:delete-batch`,
                    async () => {
                        // 计算与写回在链内原子完成；磁盘删除放在写回成功之后
                        let backupDirsToDelete: string[] = [];
                        await this.conversationManager.updateCustomMetadata(item.conversationId, 'checkpoints', current => {
                            const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                            if (list.length === 0) {
                                return current; // 无变更，跳过写回
                            }

                            // 空 ID 列表 = 删除该对话全部检查点
                            const deleteSet = new Set(
                                item.checkpointIds.length === 0 ? list.map(cp => cp.id) : item.checkpointIds
                            );

                            // CP-05: 闭包计算强制保留集合——从所有保留节点向前遍历完整祖先链，
                            // 被保留节点直接或间接依赖的祖先都不能删（否则保留节点恢复时断链）。
                            // 旧实现只检查一层直接引用：链 A→B→C 删除 {A,B} 时 A 被删而 B 保留 → B 断链。
                            const byId = new Map(list.map(cp => [cp.id, cp] as const));
                            const forcedKeep = new Set<string>();
                            for (const cp of list) {
                                if (deleteSet.has(cp.id)) continue;
                                let baseId = cp.baseCheckpointId;
                                while (baseId && !forcedKeep.has(baseId)) {
                                    forcedKeep.add(baseId);
                                    baseId = byId.get(baseId)?.baseCheckpointId;
                                }
                            }

                            // 请求删除但被强制保留的 ID 全部拒绝，并返回给前端展示原因
                            const rejectedIds = new Set<string>();
                            for (const id of deleteSet) {
                                if (forcedKeep.has(id)) rejectedIds.add(id);
                            }

                            result.rejectedIds = [...rejectedIds];
                            const toDelete = [...deleteSet].filter(id => !rejectedIds.has(id));
                            if (toDelete.length === 0) {
                                return current; // 无变更，跳过写回
                            }

                            result.deletedIds = toDelete;
                            backupDirsToDelete = toDelete
                                .map(id => list.find(cp => cp.id === id)?.backupDir)
                                .filter((dir): dir is string => !!dir);

                            return list.filter(cp => !toDelete.includes(cp.id));
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

    /**
     * 构建当前排除规则快照（EX-10/EX-11）。
     *
     * 与快照构建器使用同一口径：自定义模式 = 旧字段 + exclusion.customPatterns 合并。
     */
    private buildIgnoreSnapshot(config: Readonly<CheckpointConfig>): CheckpointIgnoreSnapshot {
        return buildIgnoreSnapshot({
            enabledProfiles: config.exclusion?.enabledProfiles,
            maxFileSizeBytes: config.exclusion?.maxFileSizeBytes ?? DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
            customPatterns: [
                ...(config.customIgnorePatterns ?? []),
                ...(config.exclusion?.customPatterns ?? [])
            ]
        });
    }

    /**
     * EX-11: 构建恢复时的排除说明（区分快照规则与当前规则）。
     *
     * - 快照规则来自 manifest.ignoreSnapshot（该存档创建时的排除配置）；
     * - 当前规则来自 settingsManager 实时配置；
     * - 恢复仍严格按当前规则过滤（filterRestoreTargetScoped），不会因旧规则宽而覆盖
     *   当前明确忽略的文件。
     */
    private buildExcludedNote(
        manifest: CheckpointManifest | undefined,
        _record: CheckpointRecord
    ): CheckpointExcludedNote | undefined {
        if (!manifest) {
            return undefined; // 旧存档无规则快照，不生成说明
        }
        const excludedCount = manifest.excluded.length;
        if (excludedCount === 0) {
            return undefined;
        }
        const snapshotRules = manifest.ignoreSnapshot;
        const currentRules = this.buildIgnoreSnapshot(this.settingsManager.getCheckpointConfig());
        const rulesChanged =
            snapshotRules.maxFileSizeBytes !== currentRules.maxFileSizeBytes ||
            snapshotRules.customPatterns.join('\n') !== currentRules.customPatterns.join('\n') ||
            // M-4: 默认类别开关变化同样视为规则变化（键排序后比较）
            serializeEnabledProfiles(snapshotRules.enabledProfiles) !== serializeEnabledProfiles(currentRules.enabledProfiles) ||
            // 版本号变化（未来规则/类别升级时）同样视为规则变化
            snapshotRules.version !== currentRules.version ||
            snapshotRules.forcedRulesVersion !== currentRules.forcedRulesVersion ||
            snapshotRules.defaultProfileVersion !== currentRules.defaultProfileVersion;
        const message = rulesChanged
            ? `该存档创建时按当时规则排除了 ${excludedCount} 个文件；当前排除规则已变化，恢复仍按当前规则跳过这些路径。`
            : `该存档创建时按当时规则排除了 ${excludedCount} 个文件。`;
        return {
            excludedCount,
            rulesChanged,
            message,
            snapshotRules,
            currentRules
        };
    }
}

/**
 * 规范化序列化 enabledProfiles：键排序后比较，忽略对象键顺序差异（M-4）。
 */
function serializeEnabledProfiles(profiles: Record<string, boolean>): string {
    return Object.entries(profiles)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}:${value}`)
        .join('|');
}
