/**
 * GrayCode - 检查点管理器
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
import type { SettingsManager } from '../settings';
import type { ConversationManager } from '../conversation';
import { getDiffManager } from '../../core/services/diffManager';
import {
    computeRestorePlan,
    restoreWorkspaceSnapshot
} from './CheckpointRestoreEngine';
import {
    createRuntimeWorkspaceRoots,
    type RuntimeWorkspaceRoot
} from './CheckpointWorkspace';
import { checkpointOperationLockManager, CHECKPOINT_LOCK_CANCELLED_MESSAGE } from './CheckpointOperationLock';
import { Logger } from '../../core/logger';
import type {
    CheckpointSummary,
    CheckpointManifestMeta,
    CheckpointOperationProgress,
    CheckpointRecord,
    RestorePreviewResult,
    BatchCheckpointDeleteItem,
    BatchCheckpointDeleteResult,
    RestoreFailure,
    RestoreResult
} from './types';
import { CheckpointManifestRepository, isSafeCheckpointDirName } from './CheckpointManifestRepository';
import { CheckpointQueryService } from './CheckpointQueryService';
import { CheckpointRetentionService } from './CheckpointRetentionService';
import { throwIfAborted } from './checkpointConcurrency';
// CPF-12: 恢复侧辅助拆分为独立服务/模块（方法体原样平移，纯重构）
import { CheckpointRestoreService } from './CheckpointRestoreService';
import { refreshAffectedDocuments } from './WorkspaceEditorRefresher';
// BCP-06: 引用计数扫描 + 清理器注册表（BranchService purge/prune 联动）。
// E1 解环（第五批）：注册表收敛到 conversation 侧桥接 checkpointCleanerBridge，
// 本类构造时经桥接自注册生产实现（注册时机/语义不变）；checkpointRefCounts 为兼容导出壳。
import { setGlobalCheckpointRefCountCleaner } from '../conversation/branch/checkpointCleanerBridge';
// 第二批拆分：createCheckpoint 备份执行与删除族收敛为独立服务（方法体原样平移，纯重构）
import { CheckpointBackupExecutor } from './CheckpointBackupExecutor';
import { CheckpointDeletionService } from './CheckpointDeletionService';

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

// BCP-06: computeForcedKeepIds（CP-05 祖先闭包纯函数）随删除族收敛至
// CheckpointDeletionService，此处 re-export 兼容既有导入路径（checkpointRefCountDelete.test.ts）。
export { computeForcedKeepIds } from './CheckpointDeletionService';

const log = Logger.get('CheckpointManager');

/**
 * 检查点管理器
 */
export class CheckpointManager {
    private _checkpointsDir: string;

    /**
     * 检查点存储目录（只读暴露）。
     *
     * MIG-05：完整性检查等只读诊断场景需要存档备份目录位置；构造时已确定
     * （customDataPath 或 globalStorageUri 下 checkpoints 子目录），
     * 本 getter 仅暴露该值，不改变任何行为。
     */
    get checkpointsDir(): string {
        return this._checkpointsDir;
    }

    private readonly manifestRepository: CheckpointManifestRepository;
    private readonly queryService: CheckpointQueryService;
    private readonly retentionService: CheckpointRetentionService;
    /** CPF-11: 进行中操作的进度状态与取消控制器（operationId -> 记录） */
    private readonly operations = new Map<string, { progress: CheckpointOperationProgress; controller: AbortController; creatingBackupDir?: string }>();
    /** CPF-12: 恢复准备/执行辅助（从 CheckpointManager 拆分的独立服务） */
    private readonly restoreService: CheckpointRestoreService;
    /** 第二批拆分: createCheckpoint 备份执行辅助（扫描→哈希→复制→manifest 写入→进度上报） */
    private readonly backupExecutor: CheckpointBackupExecutor;
    /** 第二批拆分: 删除族收敛服务（deleteCheckpointInternal/FromIndexInternal/Batch/ByNodeIds） */
    private readonly deletionService: CheckpointDeletionService;
    
    constructor(
        private settingsManager: SettingsManager,
        private conversationManager: ConversationManager,
        private context: vscode.ExtensionContext,
        customDataPath?: string
    ) {
        // 如果提供了自定义路径，使用自定义路径下的 checkpoints 目录
        // 否则使用扩展存储目录
        const basePath = customDataPath || context.globalStorageUri.fsPath;
        this._checkpointsDir = path.join(basePath, 'checkpoints');
        // CPF-01/CPF-12: manifest 读写、查询与保留策略拆分为独立服务
        this.manifestRepository = new CheckpointManifestRepository(this._checkpointsDir);
        this.queryService = new CheckpointQueryService(
            conversationManager,
            this._checkpointsDir,
            this.manifestRepository,
            (conversationId: string) => t('modules.checkpoint.defaultConversationTitle', { conversationId: conversationId.slice(0, 8) }),
            // C-2: 孤儿清理前检查「进行中 create」——避免跨工作区清理删掉正在创建的备份目录
            (backupDir: string) => this.isBackupDirBeingCreated(backupDir)
        );
        this.retentionService = new CheckpointRetentionService(
            {
                getCheckpointRecords: (conversationId: string) => this.readCheckpointListFromConversation(conversationId),
                deleteCheckpointInternal: (conversationId: string, checkpointId: string) => this.deleteCheckpointInternal(conversationId, checkpointId),
                getCheckpointConfig: () => this.settingsManager.getCheckpointConfig()
            },
            this._checkpointsDir,
            this.manifestRepository,
            conversationManager
        );
        // CPF-12: 恢复准备/执行辅助拆分为独立服务（从 CheckpointManager 平移）
        this.restoreService = new CheckpointRestoreService(
            this._checkpointsDir,
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
        // 第二批拆分: 创建/删除族辅助服务（依赖注入，避免反向引用本类造成循环依赖）
        this.backupExecutor = new CheckpointBackupExecutor({
            checkpointsDir: this._checkpointsDir,
            manifestRepository: this.manifestRepository,
            queryService: this.queryService,
            retentionService: this.retentionService,
            conversationManager
        });
        this.deletionService = new CheckpointDeletionService({
            conversationManager,
            manifestRepository: this.manifestRepository,
            checkpointsDir: this._checkpointsDir,
            getDeletionLockIds: () => this.getCheckpointDeletionLockIds(),
            beginOperation: (kind, conversationId, checkpointId) => this.beginOperation(kind, conversationId, checkpointId),
            endOperation: operationId => this.endOperation(operationId),
            isFileLockCancellationError: error => this.isFileLockCancellationError(error)
        });
    }
    
    /**
     * 初始化
     */
    async initialize(): Promise<void> {
        // 确保检查点目录存在
        await fs.mkdir(this._checkpointsDir, { recursive: true });
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
     * 创建检查点
     *
     * @param conversationId 对话 ID
     * @param messageIndex 消息索引
     * @param toolName 工具名称或消息类型（user_message, model_message, tool_batch）
     * @param phase 阶段（执行前/执行后）
     * @param options.messageNodeId BCP-01：消息节点 ID（树状分支定位预留）。
     *   仅附加写入，不改变按 messageIndex 的定位语义；缺省时记录不带该字段（旧存档兼容）。
     * @param options.forceCreate 手动创建（用户显式请求）：跳过 enabled 开关与工具/消息类型
     *   过滤，无条件创建；仍尊重排除规则（自定义忽略 / 默认类别 / 文件大小上限等安全边界）。
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
            forceCreate?: boolean;
        }
    ): Promise<CheckpointRecord | null> {
        // 检查是否应该创建检查点
        const config = this.settingsManager.getCheckpointConfig();
        const forceCreate = options?.forceCreate === true;
        if (!forceCreate && !config.enabled) {
            return null;
        }
        
        let shouldCreate = true;
        if (!forceCreate) {
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
        }

        // CPF-11: 注册进度与取消句柄（等待锁 / 扫描 / 复制全程可查询、可取消）
        const { operationId, signal } = this.beginOperation('create', conversationId);
        const progressCb = options?.progress;
        const reportProgress = (patch: Partial<CheckpointOperationProgress>): void => {
            const merged = this.updateOperation(operationId, patch);
            if (merged) {
                progressCb?.(merged);
            }
        };
        reportProgress({ phase: 'scanning', processed: 0, total: 0 });
        
        // CP-02: 使用全部工作区根，不再只备份第一个根目录
        const roots = this.getRuntimeWorkspaceRoots();
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
        
        const checkpointId = this.generateCheckpointId();
        const backupDir = path.join(this._checkpointsDir, checkpointId);
        // C-2: 登记「进行中 create」的目标备份目录，供孤儿清理（removeOrphanBackupDirs）
        // 避开跨工作区误删；在操作 finally 中注销（早退/失败路径同样覆盖）。
        const createOperationRecord = this.operations.get(operationId);
        if (createOperationRecord) {
            createOperationRecord.creatingBackupDir = checkpointId;
        }

        // CP-03: 存档创建进入工作区级互斥（与恢复、删除、写工具互斥，保证快照一致性）
        // 第二批拆分：锁内工作（扫描→哈希→复制→manifest 写入→进度上报）委托
        // CheckpointBackupExecutor.executeBackup（方法体原样平移），锁获取位置不变。
        try {
            return await checkpointOperationLockManager.runExclusive(
            roots.map(root => root.id),
            'create',
            `checkpoint:${conversationId}:${checkpointId}`,
            () => this.backupExecutor.executeBackup({
                conversationId,
                messageIndex,
                toolName,
                phase,
                messageNodeId: options?.messageNodeId,
                config,
                checkpointId,
                backupDir,
                roots,
                signal,
                reportProgress
            }),
            signal
            );
        } catch (err) {
            // M4: 等待文件写锁期间被取消时 fileWriteLockManager.acquire 抛普通 Error，
            // 从 runExclusive 漏出到此处（任务内部 catch 接不到锁获取错误）；
            // 转换为取消结果，不冒泡到工具循环。
            // C-2: 取消/异常路径同样清除「进行中 create」登记（与 finally 的清除互为兜底），
            // 避免 creatingBackupDir 残留导致孤儿清理误判（取消发生在任务开始前/锁获取期间时
            // 任务内 catch/finally 不可达）
            if (createOperationRecord) {
                createOperationRecord.creatingBackupDir = undefined;
            }
            if (signal.aborted || this.isFileLockCancellationError(err)) {
                reportProgress({ phase: 'cancelled', cancelled: true, message: 'cancelled by user' });
                return null;
            }
            throw err;
        } finally {
            if (createOperationRecord) {
                createOperationRecord.creatingBackupDir = undefined;
            }
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
    
    private async readCheckpointListFromConversation(conversationId: string): Promise<CheckpointRecord[]> {
        return this.queryService.getCheckpointRecords(conversationId);
    }

    /**
     * 保存检查点到对话元数据
     *
     * 实现位于 CheckpointBackupExecutor（create 路径主体）；本方法为兼容既有
     * 调用方/测试保留的同名委托。
     */
    private async saveCheckpointToConversation(
        conversationId: string,
        checkpoint: CheckpointRecord
    ): Promise<void> {
        return this.backupExecutor.saveCheckpointToConversation(conversationId, checkpoint);
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
            `checkpoint:${conversationId}:${checkpointId}:restore:${operationId}`,
            async () => {
                try {
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

                    // 校验已通过（prepareRestore ok）：恢复前取消所有 pending diffs
                    //（恢复后它们将无效），并拒绝所有未响应的工具调用（持久化「用户拒绝」占位）。
                    // 副作用只对有效恢复生效——校验失败的恢复不会取消/拒绝任何东西。
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
                            checkpointsDir: this._checkpointsDir,
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
                        excludedNote: this.restoreService.buildExcludedNote(prepared.ctx.manifest),
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
            `checkpoint:${conversationId}:${checkpointId}:preview:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
                            excludedNote: prepared.ctx.manifest ? this.restoreService.buildExcludedNote(prepared.ctx.manifest) : undefined,
                        };
                    }

                    // 与 restoreWorkspaceSnapshot 共用 computeRestorePlan，清单与执行严格一致
                    const plan = computeRestorePlan(
                        {
                            checkpointsDir: this._checkpointsDir,
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
                        excludedNote: this.restoreService.buildExcludedNote(prepared.ctx.manifest),
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
        // C-1: ownerId 追加本次调用唯一 token——restoreCheckpoint 与 deleteCheckpoint 原先共用
        // `checkpoint:{conversationId}:{checkpointId}` 模板，并发恢复+删除同一存档时
        // CheckpointOperationLock 的可重入分支会按 ownerId 把第二次调用误判为同栈嵌套而跳过
        // 互斥，恢复可能读到正在被删除的备份目录。唯一 token 使二者真正串行；
        // 当前代码中不存在同 ownerId 的合法嵌套调用（锁内清理走无锁 Internal 版）。
        const ownerId = `checkpoint:${conversationId}:${checkpointId}:delete:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return checkpointOperationLockManager.runExclusive(
            this.getCheckpointDeletionLockIds(),
            'delete',
            ownerId,
            () => this.deletionService.deleteCheckpointInternal(conversationId, checkpointId)
        );
    }

    /**
     * 无锁删除检查点（调用方必须已持有工作区级存档锁）。
     *
     * 供 cleanupOldCheckpoints 等锁内链路复用：createCheckpoint 的锁内
     * 清理旧存档时若再走公开方法，会以不同 ownerId 等待自己持有的锁而死锁。
     *
     * 实现位于 CheckpointDeletionService（第二批拆分收敛），本方法为保留既有
     * 私有入口（CheckpointRetentionService 构造回调）的同名委托。
     */
    private async deleteCheckpointInternal(conversationId: string, checkpointId: string): Promise<boolean> {
        return this.deletionService.deleteCheckpointInternal(conversationId, checkpointId);
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
            `checkpoint:${conversationId}:delete-from-index:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            () => this.deletionService.deleteCheckpointsFromIndexInternal(conversationId, fromIndex, excludeCheckpointId)
        );
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
            `checkpoint:${conversationId}:delete-all:${operationId}`,
            async () => {
                try {
                    // 清空列表在链内原子完成；磁盘删除放在写回成功之后
                    let backupDirsToDelete: string[] = [];
                    await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
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
                        const backupPath = path.join(this._checkpointsDir, backupDir);
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
     *
     * 第二批拆分：实现（含锁获取、进度上报、CP-05 闭包）原样平移至
     * CheckpointDeletionService.deleteCheckpointsBatch，本方法为同签名委托。
     */
    async deleteCheckpointsBatch(items: BatchCheckpointDeleteItem[]): Promise<BatchCheckpointDeleteResult[]> {
        return this.deletionService.deleteCheckpointsBatch(items);
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
     *
     * 第二批拆分：实现（含锁获取与三重闸门）原样平移至
     * CheckpointDeletionService.deleteCheckpointsByNodeIds，本方法为同签名委托。
     */
    async deleteCheckpointsByNodeIds(
        conversationId: string,
        nodeIds: string[],
        options?: { force?: boolean; referenceCounts?: Map<string, number> }
    ): Promise<BatchCheckpointDeleteResult> {
        return this.deletionService.deleteCheckpointsByNodeIds(conversationId, nodeIds, options);
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
     * 按 checkpointId 加载 manifest 轻量元数据视图（CPF-03/CPF-LAZY-1）。
     *
     * 前端只消费排除清单 / 排除规则快照等元数据字段，完整 files 映射（10-20MB）
     * 不再经 IPC 下发；新格式存档直接读取，旧存档（无 manifest 文件）时返回 null。
     *
     * L6 差异说明：本方法不带 fallbackRecord，legacy 存档的迁移路径（
     * buildManifestFromRecord）不会在此触发——如需读取 legacy 存档的完整数据，
     * 请走 getCheckpoints / restore 路径（它们传入 fallbackRecord 触发迁移生成），
     * 或调用方先取得对应记录再自行迁移。消费场景：设置页查看某存档的排除清单时，
     * 应先确认存档为新格式（summary.manifestVersion > 0）再调用，避免 null 歧义。
     */
    async getManifest(checkpointId: string): Promise<CheckpointManifestMeta | null> {
        const meta = await this.manifestRepository.loadManifest(checkpointId);
        // L6: 返回深拷贝（excluded/changes/emptyDirs/workspaceRoots 数组及嵌套 ignoreSnapshot
        // 一并复制），避免经 IPC 下发的对象被外部消费方意外写入污染 manifest 缓存
        return meta ? structuredClone(meta) : null;
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

    /** C-2: 该备份目录是否正被进行中的 create 使用（孤儿清理保护，供 CheckpointQueryService 查询） */
    private isBackupDirBeingCreated(backupDir: string): boolean {
        for (const record of this.operations.values()) {
            if (record.creatingBackupDir === backupDir) {
                return true;
            }
        }
        return false;
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
    ): { operationId: string; signal: AbortSignal; report: (patch: Partial<CheckpointOperationProgress>) => CheckpointOperationProgress | null } {
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

        // 容量保护只清理终态记录。进行中操作必须保留取消句柄和 creatingBackupDir
        // 守卫；淘汰活跃记录会让孤儿清理误删仍在创建的备份目录。
        if (this.operations.size > 64) {
            const finished = [...this.operations.entries()]
                .filter(([, record]) =>
                    record.progress.phase === 'done' || record.progress.phase === 'failed' || record.progress.phase === 'cancelled')
                .sort((a, b) => a[1].progress.updatedAt - b[1].progress.updatedAt);
            const terminalRetention = 32;
            const removeCount = Math.max(0, this.operations.size - 64, finished.length - terminalRetention);
            for (const [id] of finished.slice(0, removeCount)) {
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
    private updateOperation(operationId: string, patch: Partial<CheckpointOperationProgress>): CheckpointOperationProgress | null {
        const record = this.operations.get(operationId);
        if (!record) {
            // C-8: 操作已被清理时返回 null，而非硬编码 kind:'create' 的兜底对象——
            // 恢复/删除进度回调若转发该兜底会把操作类型误报为 create。
            return null;
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

