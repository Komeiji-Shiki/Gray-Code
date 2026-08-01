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
import { CheckpointIgnoreResolver, normalizeCheckpointPath } from './CheckpointIgnoreResolver';
import { restoreChatInputFocus, shouldRestoreChatInputFocus } from '../../core/chatFocusGuard';
import { Logger } from '../../core/logger';

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
    /** 快照时可见但备份复制失败的文件（restore 绝不能删除这些文件） */
    unbackedPaths?: string[];
    /** 空目录列表（相对路径） */
    emptyDirs?: string[];
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
     * 获取工作区根目录
     */
    private getWorkspaceRoot(): vscode.Uri | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    /**
     * 为某个根目录创建检查点忽略解析器。
     *
     * `includeCustomPatterns` 用于区分两类场景：
     * - 工作区侧：需要叠加用户配置的自定义忽略模式
     * - 备份目录侧：只按备份内容本身遍历，不再追加工作区配置
     */
    private createIgnoreResolver(rootDir: string, includeCustomPatterns: boolean = true): CheckpointIgnoreResolver {
        const extraPatterns = includeCustomPatterns
            ? (this.settingsManager.getCheckpointConfig().customIgnorePatterns ?? [])
            : [];
        return new CheckpointIgnoreResolver(rootDir, extraPatterns);
    }

    /**
     * 收集某个根目录下应被检查点系统“看见”的文件和空目录。
     *
     * 这个包装方法的意义是把具体 ignore 语义留在 resolver 内部，
     * `CheckpointManager` 只消费结果，不再关心规则细节。
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
        phase: 'before' | 'after'
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
        
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            console.warn('[CheckpointManager] No workspace root');
            return null;
        }
        
        const checkpointId = this.generateCheckpointId();
        const backupDir = path.join(this.checkpointsDir, checkpointId);
        let backupDirCreated = false;

        try {
            // 创建备份目录
            await fs.mkdir(backupDir, { recursive: true });
            backupDirCreated = true;

            // 收集需要备份的文件和目录
            const { files, dirs } = await this.collectSnapshotEntries(workspaceRoot.fsPath);

            // 获取该对话的上一个检查点：增量备份与 stat 哈希复用都依赖它
            const existingCheckpoints = await this.getCheckpoints(conversationId);
            const lastCheckpoint = existingCheckpoints.length > 0
                ? existingCheckpoints[existingCheckpoints.length - 1]
                : null;

            // 计算当前所有文件的哈希（stat 未变化的文件直接复用上一快照的哈希，避免全量读盘）
            const sortedFiles = [...files].sort();
            const { hashes: currentHashes, stats: currentStats } = await this.computeFileHashes(
                sortedFiles,
                workspaceRoot.fsPath,
                lastCheckpoint ?? undefined
            );

            // 收集空目录的相对路径
            const currentEmptyDirs: string[] = [];
            for (const dir of dirs) {
                const relativePath = normalizeCheckpointPath(path.relative(workspaceRoot.fsPath, dir));
                currentEmptyDirs.push(relativePath);
            }
            currentEmptyDirs.sort();

            // 判断是否可以进行增量备份
            let isIncremental = false;
            let baseCheckpointId: string | undefined;
            let changes: FileChange[] = [];
            let fileCount = 0;
            const unbackedPaths: string[] = [];

            // 备份复制失败的文件：从哈希/统计中剔除，
            // 保证 fileHashes 只声称真正备份成功的文件，同时让下一个检查点重新尝试备份
            const markUnbacked = (relativePath: string) => {
                unbackedPaths.push(relativePath);
                delete currentHashes[relativePath];
                delete currentStats[relativePath];
            };

            if (lastCheckpoint && lastCheckpoint.fileHashes) {
                const previousHashes = this.normalizeFileHashMap(lastCheckpoint.fileHashes);

                // 计算变更
                const { added, modified, deleted } = this.computeChanges(
                    previousHashes,
                    currentHashes
                );

                // 始终使用增量备份（只要有上一个检查点）
                // 增量备份的主要目的是节省磁盘空间，恢复时性能差异可忽略
                isIncremental = true;
                baseCheckpointId = lastCheckpoint.id;

                // 构建变更列表
                changes = [
                    ...added.map(p => ({ path: p, type: 'added' as const, hash: currentHashes[p] })),
                    ...modified.map(p => ({ path: p, type: 'modified' as const, hash: currentHashes[p] })),
                    ...deleted.map(p => ({ path: p, type: 'deleted' as const }))
                ];

                // 只复制变更的文件（如果没有变更，则不复制任何文件）
                for (const change of changes) {
                    if (change.type === 'deleted') continue;

                    const srcPath = path.join(workspaceRoot.fsPath, change.path);
                    const destPath = path.join(backupDir, change.path);

                    try {
                        await fs.mkdir(path.dirname(destPath), { recursive: true });
                        await fs.copyFile(srcPath, destPath);
                        fileCount++;
                    } catch (err) {
                        console.warn(`[CheckpointManager] Failed to copy ${change.path}:`, err);
                        markUnbacked(change.path);
                    }
                }

                log.info('incremental_backup', { added: added.length, modified: modified.length, deleted: deleted.length, unbacked: unbackedPaths.length });
            }

            // 如果不是增量备份，进行完整备份
            if (!isIncremental) {
                for (const file of sortedFiles) {
                    const relativePath = normalizeCheckpointPath(path.relative(workspaceRoot.fsPath, file));
                    // 哈希失败的文件无法被记录，跳过复制，避免“备份了但未声称”的孤儿内容
                    if (!(relativePath in currentHashes)) continue;
                    const destPath = path.join(backupDir, relativePath);

                    try {
                        await fs.mkdir(path.dirname(destPath), { recursive: true });
                        await fs.copyFile(file, destPath);
                        fileCount++;
                    } catch (err) {
                        console.warn(`[CheckpointManager] Failed to copy ${file}:`, err);
                        markUnbacked(relativePath);
                    }
                }

                // 备份空目录
                for (const dir of dirs) {
                    try {
                        const relativePath = normalizeCheckpointPath(path.relative(workspaceRoot.fsPath, dir));
                        const destPath = path.join(backupDir, relativePath);
                        await fs.mkdir(destPath, { recursive: true });
                    } catch (err) {
                        console.warn(`[CheckpointManager] Failed to create empty dir ${dir}:`, err);
                    }
                }

                log.info('full_backup', { fileCount, unbacked: unbackedPaths.length });
            }

            // 计算综合内容签名（基于实际备份成功的文件集合）
            const hashParts: string[] = [];
            for (const relativePath of Object.keys(currentHashes).sort()) {
                hashParts.push(`${relativePath}:${currentHashes[relativePath]}`);
            }
            for (const relativePath of currentEmptyDirs) {
                hashParts.push(`${relativePath}:empty-dir`);
            }
            const contentHash = crypto.createHash('sha256')
                .update(hashParts.join('\n'))
                .digest('hex')
                .substring(0, 16);

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
                fileHashes: currentHashes,
                fileStats: currentStats,
                ignorePatterns: config.customIgnorePatterns ?? [],
                unbackedPaths: unbackedPaths.length > 0 ? unbackedPaths.sort() : undefined,
                emptyDirs: currentEmptyDirs
            };

            // 保存到对话元数据（失败会抛出，由外层 catch 回收备份目录）
            await this.saveCheckpointToConversation(conversationId, checkpoint);

            // 清理过期检查点
            await this.cleanupOldCheckpoints(conversationId);

            return checkpoint;

        } catch (err) {
            console.error('[CheckpointManager] Failed to create checkpoint:', err);
            // 保证“记录没落盘 ⇔ 备份目录不存在”：回收已创建的备份目录，
            // 避免返回一个没持久化的幽灵检查点并泄漏备份目录
            if (backupDirCreated) {
                try {
                    await fs.rm(backupDir, { recursive: true, force: true });
                } catch (rmErr) {
                    console.warn('[CheckpointManager] Failed to recycle backup directory:', rmErr);
                }
            }
            return null;
        }
    }
    
    private async readCheckpointListFromConversation(conversationId: string): Promise<CheckpointRecord[]> {
        const conversationManager = this.conversationManager as any;

        if (typeof conversationManager.getCustomMetadata === 'function') {
            const checkpoints = await conversationManager.getCustomMetadata(conversationId, 'checkpoints');
            return Array.isArray(checkpoints) ? checkpoints as CheckpointRecord[] : [];
        }

        if (typeof conversationManager.getMetadata === 'function') {
            const metadata = await conversationManager.getMetadata(conversationId);
            const checkpoints = metadata?.custom?.checkpoints;
            return Array.isArray(checkpoints) ? checkpoints as CheckpointRecord[] : [];
        }

        return [];
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
     * 获取对话的所有检查点
     *
     * @param options.withSize 为 true 时额外计算并附加每条检查点备份目录的磁盘占用（size 字段）
     */
    async getCheckpoints(conversationId: string, options?: { withSize?: boolean }): Promise<Array<CheckpointRecord & { size?: number }>> {
        try {
            const checkpoints = await this.readCheckpointListFromConversation(conversationId);
            if (!options?.withSize) {
                return checkpoints;
            }

            const withSize: Array<CheckpointRecord & { size?: number }> = [];
            for (const cp of checkpoints) {
                const backupPath = path.join(this.checkpointsDir, cp.backupDir);
                withSize.push({ ...cp, size: await this.getDirectorySize(backupPath) });
            }
            return withSize;
        } catch (err) {
            console.error('[CheckpointManager] Failed to get checkpoints:', err);
            return [];
        }
    }
    
    /**
     * 计算文件的 MD5 哈希
     */
    private async getFileHash(filePath: string): Promise<string | null> {
        try {
            const content = await fs.readFile(filePath);
            return crypto.createHash('md5').update(content).digest('hex');
        } catch {
            return null;
        }
    }

    /**
     * 计算文件列表的哈希和 stat 信息。
     *
     * 优化：若提供了 lastCheckpoint 且其 fileStats 中某文件的 mtimeMs+size
     * 未变化，则直接复用其 fileHashes 中的旧哈希，避免重复读盘 + MD5。
     * 旧记录无 fileStats 字段时回退到全量哈希计算。
     */
    private async computeFileHashes(
        sortedFiles: string[],
        workspaceRootPath: string,
        lastCheckpoint?: CheckpointRecord
    ): Promise<{
        hashes: Record<string, string>;
        stats: Record<string, { mtimeMs: number; size: number; mtimeNs?: string }>;
    }> {
        const hashes: Record<string, string> = {};
        const stats: Record<string, { mtimeMs: number; size: number; mtimeNs?: string }> = {};

        const previousHashes = lastCheckpoint?.fileHashes
            ? this.normalizeFileHashMap(lastCheckpoint.fileHashes)
            : null;
        const previousStats = lastCheckpoint?.fileStats ?? null;

        for (const file of sortedFiles) {
            const relativePath = normalizeCheckpointPath(path.relative(workspaceRootPath, file));

            try {
                // bigint stat 提供纳秒精度 mtimeNs：mtimeMs 只有毫秒精度，
                // 同一毫秒内的等长修改会被漏检（复用旧哈希）。
                // 旧记录没有 mtimeNs 时回退到 mtimeMs+size 比较（与旧行为一致）。
                const stat = await fs.stat(file, { bigint: true });
                const mtimeMs = Number(stat.mtimeMs);
                const mtimeNs = stat.mtimeNs.toString();
                const size = Number(stat.size);
                stats[relativePath] = { mtimeMs, size, mtimeNs };

                // 若 stat 信息与上一检查点一致，复用旧哈希
                if (previousStats && previousHashes) {
                    const prevStat = previousStats[relativePath];
                    const statUnchanged = prevStat
                        ? (prevStat.mtimeNs !== undefined
                            ? prevStat.mtimeNs === mtimeNs
                            : prevStat.mtimeMs === mtimeMs && prevStat.size === size)
                        : false;
                    if (
                        statUnchanged &&
                        previousHashes[relativePath] !== undefined
                    ) {
                        hashes[relativePath] = previousHashes[relativePath];
                        continue;
                    }
                }

                // 回退：读出文件内容计算 MD5
                const content = await fs.readFile(file);
                hashes[relativePath] = crypto.createHash('md5').update(content).digest('hex');
            } catch {
                // 文件无法访问（权限、已删除等），跳过
            }
        }

        return { hashes, stats };
    }

    private normalizeFileHashMap(fileHashes: Record<string, string>): Record<string, string> {
        return Object.fromEntries(
            Object.entries(fileHashes).map(([relativePath, hash]) => [
                normalizeCheckpointPath(relativePath),
                hash
            ])
        );
    }

    private normalizePathList(paths: string[]): string[] {
        return paths.map(relativePath => normalizeCheckpointPath(relativePath));
    }

    /**
     * 基于“当前工作区规则”过滤检查点目标状态。
     *
     * 目的不是改变检查点历史数据，而是保证 restore 的行为始终围绕
     * “当前应该触碰哪些路径”展开，避免把现在已经忽略的内容重新写回工作区。
     */
    private async filterRestoreTarget(
        resolver: CheckpointIgnoreResolver,
        fileHashes: Record<string, string>,
        emptyDirs: string[]
    ): Promise<{ fileHashes: Record<string, string>; emptyDirs: string[] }> {
        const filteredFileHashes: Record<string, string> = {};

        // 文件恢复目标和工作区扫描都使用同一个 resolver，确保比较口径一致。
        for (const [relativePath, hash] of Object.entries(this.normalizeFileHashMap(fileHashes))) {
            if (!(await resolver.isIgnored(relativePath, false))) {
                filteredFileHashes[relativePath] = hash;
            }
        }

        const filteredEmptyDirs: string[] = [];
        // 空目录同样需要按当前规则过滤，否则 restore 会重新创建当前已忽略的目录壳。
        for (const relativePath of this.normalizePathList(emptyDirs)) {
            if (!(await resolver.isIgnored(relativePath, true))) {
                filteredEmptyDirs.push(relativePath);
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
     * 查找完整备份的基准点
     * 从目标检查点向前查找，直到找到完整备份
     */
    private findBaseCheckpoint(
        checkpoints: CheckpointRecord[],
        targetCheckpoint: CheckpointRecord
    ): CheckpointRecord | null {
        // 如果目标本身是完整备份
        if (targetCheckpoint.type !== 'incremental') {
            return targetCheckpoint;
        }
        
        // 查找基准检查点
        if (!targetCheckpoint.baseCheckpointId) {
            return null;
        }
        
        const baseCheckpoint = checkpoints.find(cp => cp.id === targetCheckpoint.baseCheckpointId);
        if (!baseCheckpoint) {
            return null;
        }
        
        // 递归查找（如果基准也是增量的话）
        return this.findBaseCheckpoint(checkpoints, baseCheckpoint);
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
        try {
            const backupPath = path.join(this.checkpointsDir, backupDir);
            await fs.access(backupPath);
            return true;
        } catch {
            return false;
        }
    }

    private async pruneMissingBackupCheckpointRecords(
        conversationId: string,
        checkpoints: CheckpointRecord[]
    ): Promise<{ checkpoints: CheckpointRecord[]; missingBackupDirs: string[]; prunedCount: number }> {
        if (checkpoints.length === 0) {
            return { checkpoints, missingBackupDirs: [], prunedCount: 0 };
        }

        // 备份目录存在性预检（锁外，不修改列表；真实过滤在链内基于最新列表重算，
        // 避免并发创建/删除时基于旧列表的整体写回互相覆盖）
        const backupDirExists = new Map<string, boolean>();
        const missingBackupDirs: string[] = [];
        for (const checkpoint of checkpoints) {
            if (!backupDirExists.has(checkpoint.backupDir)) {
                const exists = await this.backupDirectoryExists(checkpoint.backupDir);
                backupDirExists.set(checkpoint.backupDir, exists);
            }
            if (!backupDirExists.get(checkpoint.backupDir)) {
                missingBackupDirs.push(checkpoint.backupDir);
            }
        }

        const uniqueMissing = Array.from(new Set(missingBackupDirs));
        if (uniqueMissing.length === 0) {
            return { checkpoints, missingBackupDirs: [], prunedCount: 0 };
        }

        try {
            const pruned = await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', async current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const kept: CheckpointRecord[] = [];
                const foundMissing: string[] = [];
                for (const cp of list) {
                    if (backupDirExists.get(cp.backupDir) === false) {
                        foundMissing.push(cp.backupDir);
                        continue;
                    }
                    if (!backupDirExists.has(cp.backupDir)) {
                        // 并发新增的检查点：现场核验，避免误删
                        const exists = await this.backupDirectoryExists(cp.backupDir);
                        backupDirExists.set(cp.backupDir, exists);
                        if (!exists) {
                            foundMissing.push(cp.backupDir);
                            continue;
                        }
                    }
                    kept.push(cp);
                }
                return foundMissing.length === 0 ? current : kept;
            });

            if (Array.isArray(pruned)) {
                const prunedCount = checkpoints.length - pruned.length;
                return { checkpoints: pruned, missingBackupDirs: uniqueMissing, prunedCount };
            }
            return { checkpoints, missingBackupDirs: uniqueMissing, prunedCount: 0 };
        } catch (err) {
            console.warn('[CheckpointManager] Failed to prune checkpoint metadata:', err);
            return { checkpoints, missingBackupDirs: uniqueMissing, prunedCount: 0 };
        }
    }
    
    /**
     * 恢复到指定检查点
     *
     * 支持增量备份恢复：
     * 1. 如果是完整备份，直接恢复
     * 2. 如果是增量备份，先恢复基准点，然后按顺序应用增量变更
     * 3. 智能比较哈希，只更新有变化的文件
     */
    async restoreCheckpoint(
        conversationId: string,
        checkpointId: string
    ): Promise<RestoreResult> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            return { success: false, restored: 0, deleted: 0, skipped: 0, error: 'No workspace root' };
        }

        try {
            // 查找检查点
            let checkpoints = await this.getCheckpoints(conversationId);
            let missingBackupDirs: string[] = [];
            let autoPrunedCheckpointCount = 0;

            const pruneResult = await this.pruneMissingBackupCheckpointRecords(conversationId, checkpoints);
            checkpoints = pruneResult.checkpoints;
            missingBackupDirs = pruneResult.missingBackupDirs;
            autoPrunedCheckpointCount = pruneResult.prunedCount;

            const checkpoint = checkpoints.find(cp => cp.id === checkpointId);

            if (!checkpoint) {
                return {
                    success: false,
                    restored: 0,
                    deleted: 0,
                    skipped: 0,
                    error: 'Checkpoint not found',
                    missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                    autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                };
            }

            // 在恢复前，取消所有 pending diffs（因为恢复后它们将无效）
            try {
                const diffManager = getDiffManager();
                await diffManager.cancelAllPending();
            } catch (err) {
                console.warn('[CheckpointManager] Failed to cancel pending diffs:', err);
            }

            // 拒绝所有未响应的工具调用并持久化
            try {
                await this.conversationManager.rejectAllPendingToolCalls(conversationId);
            } catch (err) {
                console.warn('[CheckpointManager] Failed to reject pending tool calls:', err);
            }

            // 当前工作区的 ignore 视图是 restore 的真实边界。
            const workspaceIgnoreResolver = this.createIgnoreResolver(workspaceRoot.fsPath);

            // 先用当前规则裁剪目标状态，再进行 diff / restore。
            const targetState = checkpoint.fileHashes
                ? await this.filterRestoreTarget(
                    workspaceIgnoreResolver,
                    checkpoint.fileHashes,
                    checkpoint.emptyDirs || []
                )
                : undefined;

            // 如果没有 fileHashes（旧版本检查点），回退到原来的逻辑
            if (!checkpoint.fileHashes) {
                const legacyResult = await this.restoreCheckpointLegacy(conversationId, checkpointId, checkpoint);
                return {
                    ...legacyResult,
                    missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                    autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                };
            }

            const targetHashes = targetState!.fileHashes;

            // #30: 收集恢复失败的项
            const failures: RestoreFailure[] = [];

            // 获取增量链（从基准点到目标点）
            const { chain, broken } = this.getIncrementalChain(checkpoints, checkpoint);

            // #28: 增量链断裂时显式失败，不静默降级
            if (broken) {
                return {
                    success: false,
                    restored: 0,
                    deleted: 0,
                    skipped: 0,
                    error: t('modules.checkpoint.restore.chainBroken'),
                    failures,
                    missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                    autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                };
            }

            if (chain.length === 0) {
                return {
                    success: false,
                    restored: 0,
                    deleted: 0,
                    skipped: 0,
                    error: 'Cannot build checkpoint chain',
                    missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                    autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                };
            }

            // 验证链的完整性（确保所有备份目录都存在）
            const chainMissingBackupDirs: string[] = [];
            for (const cp of chain) {
                if (!(await this.backupDirectoryExists(cp.backupDir))) {
                    chainMissingBackupDirs.push(cp.backupDir);
                }
            }
            if (chainMissingBackupDirs.length > 0) {
                const chainMissingSet = new Set(chainMissingBackupDirs);
                // 裁剪在链内基于最新列表重算：并发创建/删除时不会互相覆盖
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
                return {
                    success: false,
                    restored: 0,
                    deleted: 0,
                    skipped: 0,
                    error: `Backup directory not found: ${allMissingBackupDirs.join(', ')}`,
                    missingBackupDirs: allMissingBackupDirs,
                    autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                };
            }

            // 工作区当前状态也必须通过同一个 resolver 收集，才能与 targetState 对齐比较。
            const { files: workspaceFiles } = await workspaceIgnoreResolver.collectEntries();
            const currentHashes: Record<string, string> = {};
            for (const file of workspaceFiles) {
                const relativePath = normalizeCheckpointPath(path.relative(workspaceRoot.fsPath, file));
                const hash = await this.getFileHash(file);
                if (hash) {
                    currentHashes[relativePath] = hash;
                }
            }

            let deleted = 0;
            let restored = 0;
            let skipped = 0;
            const modifiedFiles: string[] = [];
            const deletedFiles: string[] = [];

            // 计算需要的变更
            const { added, modified, deleted: toDelete } = this.computeChanges(currentHashes, targetHashes);

            // 删除多余的文件
            // #29: 只删除检查点 fileHashes 中记录的路径，不删快照时被 ignore 或快照后创建的文件
            const checkpointFileHashes = checkpoint.fileHashes;
            for (const relativePath of toDelete) {
                if (!(relativePath in checkpointFileHashes)) {
                    continue;  // #29: 该路径不在快照记录中，跳过删除
                }
                const fullPath = path.join(workspaceRoot.fsPath, relativePath);
                try {
                    await fs.unlink(fullPath);
                    deleted++;
                    deletedFiles.push(fullPath);
                } catch (err) {
                    console.warn(`[CheckpointManager] Failed to delete ${relativePath}:`, err);
                    // #30: 记录删除失败
                    failures.push({ path: relativePath, reason: 'delete_failed' });
                }
            }

            // 删除文件后统一清理由当前规则可见的空目录。
            await workspaceIgnoreResolver.removeEmptyDirectories();

            // 恢复需要添加/修改的文件
            const filesToRestore = [...added, ...modified];
            for (const relativePath of filesToRestore) {
                // 在增量链中查找这个文件
                const srcPath = await this.findFileInChain(chain, relativePath);

                if (!srcPath) {
                    console.warn(`[CheckpointManager] Cannot find ${relativePath} in backup chain`);
                    // #30: 文件在备份链中缺失
                    // #31: fileHashes 声称有但备份文件实际缺失，也归为 missing_in_chain
                    failures.push({ path: relativePath, reason: 'missing_in_chain' });
                    continue;
                }

                const destPath = path.join(workspaceRoot.fsPath, relativePath);

                try {
                    // 验证文件哈希是否匹配目标
                    const srcHash = await this.getFileHash(srcPath);
                    if (srcHash !== targetHashes[relativePath]) {
                        console.warn(`[CheckpointManager] Hash mismatch for ${relativePath}`);
                        // #30: 哈希不匹配
                        failures.push({ path: relativePath, reason: 'hash_mismatch' });
                        continue;
                    }

                    await fs.mkdir(path.dirname(destPath), { recursive: true });
                    await fs.copyFile(srcPath, destPath);
                    restored++;
                    modifiedFiles.push(destPath);
                } catch (err) {
                    console.warn(`[CheckpointManager] Failed to restore ${relativePath}:`, err);
                    // #30: 复制失败
                    failures.push({ path: relativePath, reason: 'copy_failed' });
                }
            }

            // 跳过的文件数量（当前哈希与目标哈希相同的文件）
            skipped = Object.keys(targetHashes).length - added.length - modified.length;

            // 恢复空目录时使用已经过滤后的目标集合，避免重建当前已忽略目录。
            const targetEmptyDirs = targetState!.emptyDirs;
            for (const relativePath of targetEmptyDirs) {
                try {
                    const destPath = path.join(workspaceRoot.fsPath, relativePath);
                    await fs.mkdir(destPath, { recursive: true });
                } catch (err) {
                    console.warn(`[CheckpointManager] Failed to restore empty dir ${relativePath}:`, err);
                }
            }

            // 刷新 VSCode 中被修改的文档
            await this.refreshAffectedDocuments(modifiedFiles, deletedFiles);

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
            if (restored > 0) details.push(t('modules.checkpoint.restore.filesUpdated', { count: restored }));
            if (deleted > 0) details.push(t('modules.checkpoint.restore.filesDeleted', { count: deleted }));
            if (skipped > 0) details.push(t('modules.checkpoint.restore.filesUnchanged', { count: skipped }));
            if (details.length > 0) {
                message += `（${details.join('，')}）`;
            }
            vscode.window.setStatusBarMessage(message, 5000);

            log.info('restore_from_chain', { chainLength: chain.length, restored, deleted, skipped, failureCount: failures.length });

            return {
                success: !hasFailures,
                restored,
                deleted,
                skipped,
                failures: hasFailures ? failures : undefined,
                missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
            };

        } catch (err) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            console.error('[CheckpointManager] Failed to restore checkpoint:', err);
            return { success: false, restored: 0, deleted: 0, skipped: 0, error };
        }
    }
    
    /**
     * 在增量链中查找文件
     * 从最新的检查点向前查找，返回第一个包含该文件的备份路径
     */
    private async findFileInChain(
        chain: CheckpointRecord[],
        relativePath: string
    ): Promise<string | null> {
        // 从链的末尾（最新）向前查找
        for (let i = chain.length - 1; i >= 0; i--) {
            const cp = chain[i];
            const filePath = path.join(this.checkpointsDir, cp.backupDir, relativePath);
            
            try {
                await fs.access(filePath);
                return filePath;  // 找到了
            } catch {
                // 文件不在这个备份中，继续向前查找
            }
        }
        
        return null;
    }
    
    /**
     * 旧版本恢复逻辑（用于不包含 fileHashes 的检查点）
     */
    private async restoreCheckpointLegacy(
        conversationId: string,
        checkpointId: string,
        checkpoint: CheckpointRecord
    ): Promise<{ success: boolean; restored: number; deleted: number; skipped: number; error?: string }> {
        const workspaceRoot = this.getWorkspaceRoot()!;
        const backupPath = path.join(this.checkpointsDir, checkpoint.backupDir);
        
        // 检查备份目录是否存在
        try {
            await fs.access(backupPath);
        } catch {
            return { success: false, restored: 0, deleted: 0, skipped: 0, error: 'Backup directory not found' };
        }
        
        // 旧版检查点没有 fileHashes，只能按备份目录直接恢复；
        // 但“当前哪些路径允许被 restore 触碰”仍然由工作区 resolver 决定。
        const workspaceIgnoreResolver = this.createIgnoreResolver(workspaceRoot.fsPath);

        // 收集备份的文件和目录
        const { files: backupFiles, dirs: backupDirs } = await this.collectSnapshotEntries(backupPath, false);
        const restorableBackupFiles: string[] = [];
        // 先从备份内容里筛出“当前仍允许恢复”的文件集合。
        for (const backupFile of backupFiles) {
            const relativePath = normalizeCheckpointPath(path.relative(backupPath, backupFile));
            if (!(await workspaceIgnoreResolver.isIgnored(relativePath, false))) {
                restorableBackupFiles.push(backupFile);
            }
        }
        const restorableBackupDirs: string[] = [];
        // 空目录也遵循同样规则，避免旧版 restore 重建当前已忽略目录。
        for (const dir of backupDirs) {
            const relativePath = normalizeCheckpointPath(path.relative(backupPath, dir));
            if (!(await workspaceIgnoreResolver.isIgnored(relativePath, true))) {
                restorableBackupDirs.push(dir);
            }
        }

        const backupRelativePaths = new Set(
            restorableBackupFiles.map(f => normalizeCheckpointPath(path.relative(backupPath, f)))
        );
        
        // 收集工作区文件
        const { files: workspaceFiles } = await workspaceIgnoreResolver.collectEntries();
        const workspaceRelativePaths = new Set(
            workspaceFiles.map(f => normalizeCheckpointPath(path.relative(workspaceRoot.fsPath, f)))
        );
        
        let deleted = 0;
        let restored = 0;
        let skipped = 0;
        const modifiedFiles: string[] = [];
        const deletedFiles: string[] = [];
        
        // 删除工作区中不在备份里的文件
        for (const file of workspaceFiles) {
            const relativePath = normalizeCheckpointPath(path.relative(workspaceRoot.fsPath, file));
            if (!backupRelativePaths.has(relativePath)) {
                try {
                    await fs.unlink(file);
                    deleted++;
                    deletedFiles.push(file);
                } catch (err) {
                    console.warn(`[CheckpointManager] Failed to delete ${relativePath}:`, err);
                }
            }
        }
        
        // 清理空目录
        await workspaceIgnoreResolver.removeEmptyDirectories();
        
        // 复制备份中的文件到工作区
        for (const backupFile of restorableBackupFiles) {
            const relativePath = normalizeCheckpointPath(path.relative(backupPath, backupFile));
            const destPath = path.join(workspaceRoot.fsPath, relativePath);
            
            try {
                if (workspaceRelativePaths.has(relativePath)) {
                    const backupHash = await this.getFileHash(backupFile);
                    const workspaceHash = await this.getFileHash(destPath);
                    
                    if (backupHash && workspaceHash && backupHash === workspaceHash) {
                        skipped++;
                        continue;
                    }
                }
                
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                await fs.copyFile(backupFile, destPath);
                restored++;
                modifiedFiles.push(destPath);
            } catch (err) {
                console.warn(`[CheckpointManager] Failed to restore ${backupFile}:`, err);
            }
        }
        
        // 恢复空目录
        for (const dir of restorableBackupDirs) {
            try {
                const relativePath = normalizeCheckpointPath(path.relative(backupPath, dir));
                const destPath = path.join(workspaceRoot.fsPath, relativePath);
                await fs.mkdir(destPath, { recursive: true });
            } catch (err) {
                console.warn(`[CheckpointManager] Failed to restore empty dir ${dir}:`, err);
            }
        }
        
        await this.refreshAffectedDocuments(modifiedFiles, deletedFiles);
        
        const phaseText = checkpoint.phase === 'before'
            ? t('modules.checkpoint.description.before')
            : t('modules.checkpoint.description.after');
        let message = `$(check) ${t('modules.checkpoint.restore.success', { toolName: checkpoint.toolName, phase: phaseText })}`;
        const details: string[] = [];
        if (restored > 0) details.push(t('modules.checkpoint.restore.filesUpdated', { count: restored }));
        if (deleted > 0) details.push(t('modules.checkpoint.restore.filesDeleted', { count: deleted }));
        if (skipped > 0) details.push(t('modules.checkpoint.restore.filesUnchanged', { count: skipped }));
        if (details.length > 0) {
            message += `（${details.join('，')}）`;
        }
        vscode.window.setStatusBarMessage(message, 5000);
        
        return { success: true, restored, deleted, skipped };
    }
    
    /**
     * 清理过期检查点
     */
    private async cleanupOldCheckpoints(conversationId: string): Promise<void> {
        const config = this.settingsManager.getCheckpointConfig();
        
        // -1 表示无上限
        if (config.maxCheckpoints < 0) {
            return;
        }
        
        try {
            const checkpoints = await this.getCheckpoints(conversationId);
            
            // 如果超过限制，删除最旧的
            if (checkpoints.length > config.maxCheckpoints) {
                // 按时间排序（旧的在前）
                const sorted = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp);
                const excess = checkpoints.length - config.maxCheckpoints;
                const deleted = new Set<string>();

                // 增量链依赖检查：检查点总是增量且链到上一个（baseCheckpointId），
                // 直接按时间删最旧会把中间链节点删掉，后续检查点恢复时 chainBroken 100% 失败。
                // 从最旧开始尝试删除：只有不再被任何存活检查点引用为 base 的项才可删；
                // 被引用的项先把备份合并进后继并重挂链（mergeCheckpointIntoSuccessor），
                // 再删除——否则完整链上每一项都被后继引用，cleanup 恒为 no-op，
                // maxCheckpoints 静默失效、检查点无界累积。
                // （处理顺序旧→新是自洽的：更旧的项是否可删取决于更晚存活项的引用。）
                for (let i = 0; i < excess && i < sorted.length; i++) {
                    const cp = sorted[i];
                    const stillAlive = sorted.slice(i + 1).filter(c => !deleted.has(c.id));
                    const dependent = stillAlive.find(c => c.baseCheckpointId === cp.id);
                    if (dependent) {
                        try {
                            await this.mergeCheckpointIntoSuccessor(conversationId, dependent, cp);
                        } catch (err) {
                            // 合并失败（如备份目录不可读）宁可保留也不断链
                            console.warn('[CheckpointManager] Failed to re-link checkpoint chain, keeping checkpoint:', err);
                            continue;
                        }
                    }
                    await this.deleteCheckpoint(conversationId, cp.id);
                    deleted.add(cp.id);
                }
            }
        } catch (err) {
            console.error('[CheckpointManager] Failed to cleanup old checkpoints:', err);
        }
    }
    
    /**
     * 把被删除检查点的备份内容合并进其后继（链重挂），并持久化后继的元数据。
     *
     * 增量链 A → M → B（B.base = M）：直接删除 M 会让 B 的恢复链变成 [A, B]，
     * 而 B 的备份目录只有 B 相对 M 变更的文件——M 独有（B 未改）的文件会从链上
     * 消失，恢复 B 时 findFileInChain 报 missing_in_chain。
     * 合并 = 把 M 的备份文件复制进 B 的目录（force:false 不覆盖 B 已有的更新版本），
     * 把 M.changes 并入 B.changes（B 未涉及的路径保留），B.baseCheckpointId 改指 M.base。
     */
    private async mergeCheckpointIntoSuccessor(
        conversationId: string,
        successor: CheckpointRecord,
        removed: CheckpointRecord
    ): Promise<void> {
        const removedBackupPath = path.join(this.checkpointsDir, removed.backupDir);
        const successorBackupPath = path.join(this.checkpointsDir, successor.backupDir);

        // 1. 文件合并：后继目录优先，不覆盖已存在的更新版本
        try {
            await fs.cp(removedBackupPath, successorBackupPath, { recursive: true, force: false });
        } catch (err) {
            console.warn(`[CheckpointManager] Failed to merge backup ${removed.backupDir} into ${successor.backupDir}:`, err);
            throw err; // 合并失败必须中止删除，否则恢复时链上缺文件
        }

        // 2. changes 合并：后继未涉及的路径保留被删项的变更记录（元数据语义完整）
        const successorPaths = new Set((successor.changes ?? []).map(c => c.path));
        for (const change of removed.changes ?? []) {
            if (!successorPaths.has(change.path)) {
                successor.changes = [...(successor.changes ?? []), change];
                successorPaths.add(change.path);
            }
        }

        // 3. 链重挂
        successor.baseCheckpointId = removed.baseCheckpointId;

        // 4. 持久化更新后的后继元数据（deleteCheckpoint 随后会基于最新列表删除被删项）
        //    替换在链内原子完成：并发删除/创建时不会基于旧列表整体写回互相覆盖
        await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
            const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
            return list.map(cp => (cp.id === successor.id ? successor : cp));
        });
    }

    /**
     * 删除检查点
     */
    async deleteCheckpoint(conversationId: string, checkpointId: string): Promise<boolean> {
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

            // 删除备份目录（写回成功后才删）
            const backupPath = path.join(this.checkpointsDir, backupDirToDelete);
            try {
                await fs.rm(backupPath, { recursive: true, force: true });
            } catch {
                // 忽略删除错误
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
        try {
            // 计算与写回在链内原子完成（基于最新列表），磁盘删除放在写回成功之后
            let toDelete: CheckpointRecord[] = [];
            let backupDirsToDelete: string[] = [];
            await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const checkpoints = Array.isArray(current) ? current as CheckpointRecord[] : [];

                // 需要保留的检查点 ID 集合：目标检查点及其增量基链（否则保留的检查点会因基快照被删而无法恢复）
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

            // 删除备份目录（写回成功后才删）
            for (const backupDir of backupDirsToDelete) {
                const backupPath = path.join(this.checkpointsDir, backupDir);
                try {
                    await fs.rm(backupPath, { recursive: true, force: true });
                } catch {
                    // 忽略删除错误
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

            let deletedCount = 0;
            for (const backupDir of backupDirsToDelete) {
                const backupPath = path.join(this.checkpointsDir, backupDir);
                try {
                    await fs.rm(backupPath, { recursive: true, force: true });
                    deletedCount++;
                } catch {
                    // 忽略删除错误
                }
            }
            
            return { success: true, deletedCount };
            
        } catch (err) {
            console.error('[CheckpointManager] Failed to delete all checkpoints:', err);
            return { success: false, deletedCount: 0 };
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

            try {
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

                    // 收集被「保留的检查点」引用为基快照的待删 ID，这些必须拒绝删除
                    const rejectedIds = new Set<string>();
                    for (const cp of list) {
                        if (!deleteSet.has(cp.id) && cp.baseCheckpointId && deleteSet.has(cp.baseCheckpointId)) {
                            rejectedIds.add(cp.baseCheckpointId);
                        }
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

                // 删除备份目录（写回成功后才删）
                for (const backupDir of backupDirsToDelete) {
                    const backupPath = path.join(this.checkpointsDir, backupDir);
                    try {
                        await fs.rm(backupPath, { recursive: true, force: true });
                    } catch {
                        // 忽略单个目录删除错误
                    }
                }

                result.success = true;
            } catch (err) {
                console.error(`[CheckpointManager] Failed to delete checkpoints batch for ${item.conversationId}:`, err);
            }

            results.push(result);
        }

        return results;
    }
    
    /**
     * 计算目录的总大小（字节）
     */
    private async getDirectorySize(dirPath: string): Promise<number> {
        let totalSize = 0;
        
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                    totalSize += await this.getDirectorySize(fullPath);
                } else if (entry.isFile()) {
                    try {
                        const stat = await fs.stat(fullPath);
                        totalSize += stat.size;
                    } catch {
                        // 忽略无法访问的文件
                    }
                }
            }
        } catch {
            // 忽略无法访问的目录
        }
        
        return totalSize;
    }
    
    /**
     * 获取所有对话的检查点统计信息
     *
     * @returns 对话列表，包含检查点数量和总大小
     */
    async getAllConversationsWithCheckpoints(): Promise<Array<{
        conversationId: string;
        title: string;
        checkpointCount: number;
        totalSize: number;
        createdAt?: number;
        updatedAt?: number;
    }>> {
        const results: Array<{
            conversationId: string;
            title: string;
            checkpointCount: number;
            totalSize: number;
            createdAt?: number;
            updatedAt?: number;
        }> = [];
        
        try {
            // 获取所有对话 ID
            const conversationIds = await this.conversationManager.listConversations();
            
            for (const conversationId of conversationIds) {
                try {
                    const metadata = await this.conversationManager.getMetadata(conversationId);
                    const checkpoints = (metadata?.custom?.checkpoints as CheckpointRecord[]) || [];
                    
                    // 只包含有检查点的对话
                    if (checkpoints.length > 0) {
                        // 计算所有检查点目录的总大小
                        let totalSize = 0;
                        for (const cp of checkpoints) {
                            const backupPath = path.join(this.checkpointsDir, cp.backupDir);
                            totalSize += await this.getDirectorySize(backupPath);
                        }
                        
                        results.push({
                            conversationId,
                            title: metadata?.title || t('modules.checkpoint.defaultConversationTitle', { conversationId: conversationId.slice(0, 8) }),
                            checkpointCount: checkpoints.length,
                            totalSize,
                            createdAt: metadata?.createdAt,
                            updatedAt: metadata?.updatedAt
                        });
                    }
                } catch {
                    // 忽略单个对话的错误
                }
            }
            
            // 按更新时间降序排列
            results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            
        } catch (err) {
            console.error('[CheckpointManager] Failed to get all conversations with checkpoints:', err);
        }
        
        return results;
    }
}
