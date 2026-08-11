/**
 * CheckpointQueryService - 存档查询 / 磁盘统计 / 缺失记录清理（CPF-12 拆分）。
 *
 * 从 CheckpointManager 抽出的查询侧逻辑：
 * - getCheckpoints：返回轻量 CheckpointSummary（CPF-03），withSize 时优先用
 *   创建时记录的 backupBytes，旧存档缺失时按需懒扫描并写回摘要缓存（CPF-09/CPF-10）
 * - getAllConversationsWithCheckpoints：基于摘要字段聚合，不递归扫描磁盘（CPF-10）
 * - getDirectorySize：有界并发递归统计（CPF-06）
 * - pruneMissingBackupCheckpointRecords / removeOrphanBackupDirs：恢复前的记录裁剪
 *
 * 本服务不持有 CheckpointManager 引用，只依赖 conversationManager（元数据读写）、
 * checkpointsDir 与 manifestRepository。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ConversationManager } from '../conversation';
import { Logger } from '../../core/logger';
import { isSafeRelativePath } from '../../core/idValidation';
import type { CheckpointRecord } from './CheckpointManager';
import type { CheckpointSummary } from './types';
import { CheckpointManifestRepository, CHECKPOINT_MANIFEST_FILENAME, CHECKPOINT_MANIFEST_FILES_FILENAME, isSafeCheckpointDirName } from './CheckpointManifestRepository';
import { DEFAULT_CHECKPOINT_CONCURRENCY, runBounded } from './checkpointConcurrency';

const log = Logger.get('CheckpointQueryService');

/** 无 manifest 目录的 mtime 新鲜度阈值：创建中窗口（目录已建、manifest 未写）内跳过 */
const ORPHAN_MANIFEST_MISSING_FRESH_MS = 5 * 60 * 1000;

/** 对话级存档统计（设置页清理视图使用） */
export interface ConversationCheckpointStats {
    conversationId: string;
    title: string;
    checkpointCount: number;
    totalSize: number;
    createdAt?: number;
    updatedAt?: number;
    /**
     * 存在缺少 backupBytes 字段的旧存档：totalSize 可能不完整。
     * 设置页展开该对话时通过 getCheckpoints(withSize) 懒扫描补齐（CPF-10）。
     */
    sizeIncomplete?: boolean;
}

export type CheckpointSummaryWithSize = CheckpointSummary & { size?: number };

/**
 * getCheckpoints 的返回类型：仍是数组（保持现有调用方兼容），
 * 读取失败时在数组上附带非枚举 `error` 标记（区别于“无记录”返回空数组）。
 * 前端可在 handler 中读取 `checkpoints.error` 并向用户展示错误。
 */
export type CheckpointQueryResult = CheckpointSummaryWithSize[] & { error?: string };

/** 给返回数组附加非枚举 error 标记（不改变数组本身的相等性与序列化） */
function attachError(result: CheckpointQueryResult, error: unknown): CheckpointQueryResult {
    Object.defineProperty(result, 'error', {
        value: error instanceof Error ? error.message : String(error),
        enumerable: false,
        configurable: true,
        writable: true
    });
    return result;
}

export class CheckpointQueryService {
    constructor(
        private readonly conversationManager: ConversationManager,
        private readonly checkpointsDir: string,
        private readonly manifestRepository: CheckpointManifestRepository,
        private readonly defaultTitle: (conversationId: string) => string,
        /** C-2: 孤儿判定前询问该备份目录是否正被进行中 create 使用（跨工作区场景保护） */
        private readonly isBackupDirBeingCreated?: (backupDir: string) => boolean
    ) {}

    /** 读取对话元数据中的原始存档记录（内部使用，含旧格式完整字段） */
    async getCheckpointRecords(conversationId: string): Promise<CheckpointRecord[]> {
        const conversationManager = this.conversationManager;
        // CP-TYPE-1: 收敛为类型化接口（不再 as any）。getCustomMetadata 是 ConversationManager 的
        // 正式接口，优先使用；对不支持它的旧实现/测试桩做类型安全的结构性回退（读完整元数据）。
        let checkpoints: CheckpointRecord[];
        if (typeof conversationManager.getCustomMetadata === 'function') {
            const records = await conversationManager.getCustomMetadata(conversationId, 'checkpoints');
            checkpoints = Array.isArray(records) ? records as CheckpointRecord[] : [];
        } else {
            const metadata = await conversationManager.getMetadata(conversationId);
            const legacy = metadata?.custom?.checkpoints;
            checkpoints = Array.isArray(legacy) ? legacy as CheckpointRecord[] : [];
        }
        return checkpoints;
    }

    /**
     * 获取对话的轻量存档摘要（CPF-03）。
     *
     * - 默认返回 CheckpointSummary（不含完整哈希映射）；
     * - withSize=true 时附加 size 字段：优先用创建时记录的 backupBytes；
     *   旧存档没有该字段时按需扫描备份目录一次，并把结果写回摘要缓存（CPF-09/CPF-10）。
     *
     * CP-QUERY-2：区分“无记录”与“读取失败”——无记录返回空数组；
     * 元数据损坏/读取失败时同样返回数组（保持调用方兼容）但附加非枚举 `error` 标记，
     * 前端可读取 `result.error` 展示错误，而不是误显示“无存档”。
     */
    async getCheckpoints(
        conversationId: string,
        options?: { withSize?: boolean }
    ): Promise<CheckpointQueryResult> {
        const result: CheckpointQueryResult = [];
        try {
            const records = await this.getCheckpointRecords(conversationId);
            for (const record of records) {
                const summary = await this.toSummary(record);
                if (!options?.withSize) {
                    result.push(summary);
                    continue;
                }

                let backupBytes = record.backupBytes;
                if (typeof backupBytes !== 'number') {
                    // CP-PATH-1: 读取侧与删除侧同一校验口径——损坏/恶意 backupDir（如 ../../victim）
                    // 绝不拼进路径扫描（getDirectorySize 会对该目录递归 readdir/stat，可能越过
                    // checkpointsDir 读取外部目录）。处理方式与删除路径一致：跳过该操作、记录保留、告警。
                    if (!isSafeCheckpointDirName(record.backupDir)) {
                        console.warn(`[CheckpointQueryService] Refusing to scan unsafe backupDir ${record.backupDir} for checkpoint ${record.id}`);
                        backupBytes = 0;
                    } else {
                        backupBytes = await this.getDirectorySize(
                            path.join(this.checkpointsDir, record.backupDir)
                        );
                        // 写回摘要缓存：下次不再扫描（旧存档一次性迁移）
                        await this.writeBackBackupBytes(conversationId, record.id, backupBytes);
                    }
                }
                result.push({ ...summary, backupBytes, size: backupBytes });
            }
            return result;
        } catch (err) {
            log.warn('get_checkpoints_failed', {
                conversationId,
                error: err instanceof Error ? err.message : String(err)
            });
            return attachError(result, err);
        }
    }

    /** 把记录映射为摘要；excludedCount 优先读记录字段（Agent A 的 excludedCount），缺失时从 manifest 元数据统计（CPF-LAZY-1：不加载 files 映射） */
    private async toSummary(record: CheckpointRecord): Promise<CheckpointSummary> {
        let excludedCount = (record as CheckpointRecord & { excludedCount?: number }).excludedCount;
        if (typeof excludedCount !== 'number') {
            const manifest = await this.manifestRepository.loadManifest(record.id, record);
            excludedCount = manifest ? manifest.excluded.length : 0;
        }
        return {
            id: record.id,
            conversationId: record.conversationId,
            messageNodeId: record.messageNodeId,
            messageIndex: record.messageIndex,
            toolName: record.toolName,
            phase: record.phase,
            timestamp: record.timestamp,
            type: record.type ?? 'full',
            baseCheckpointId: record.baseCheckpointId,
            contentHash: record.contentHash,
            fileCount: record.fileCount,
            backupBytes: typeof record.backupBytes === 'number' ? record.backupBytes : 0,
            excludedCount,
            manifestVersion: typeof record.manifestVersion === 'number' ? record.manifestVersion : 0
        };
    }

    /**
     * 获取所有包含存档的对话统计（CPF-10）。
     *
     * 只基于摘要字段（backupBytes）聚合 totalSize，绝不递归扫描每个存档目录；
     * 旧存档缺 backupBytes 时标记 sizeIncomplete，由设置页展开时按需懒扫描补齐。
     *
     * CP-QUERY-1：元数据读取改为有界并发（runBounded，DEFAULT_CHECKPOINT_CONCURRENCY），
     * 并使用轻量 getMetadataLight（只读 meta.json，不做历史完整性检查），
     * 避免设置页挂载时 O(n) 次顺序读盘/反序列化。
     */
    async getAllConversationsWithCheckpoints(): Promise<ConversationCheckpointStats[]> {
        const results: ConversationCheckpointStats[] = [];
        try {
            const conversationIds = await this.conversationManager.listConversations();
            await runBounded(conversationIds, DEFAULT_CHECKPOINT_CONCURRENCY, async conversationId => {
                try {
                    // 优先轻量读（只读 meta.json）；不支持 getMetadataLight 的旧实现/测试桩回退 getMetadata
                    const metadata = typeof this.conversationManager.getMetadataLight === 'function'
                        ? await this.conversationManager.getMetadataLight(conversationId)
                        : await this.conversationManager.getMetadata(conversationId);
                    const records = (metadata?.custom?.checkpoints as CheckpointRecord[]) || [];
                    if (!Array.isArray(records) || records.length === 0) {
                        return;
                    }
                    let totalSize = 0;
                    let sizeIncomplete = false;
                    for (const cp of records) {
                        if (typeof cp.backupBytes === 'number') {
                            totalSize += cp.backupBytes;
                        } else {
                            sizeIncomplete = true;
                        }
                    }
                    results.push({
                        conversationId,
                        title: metadata?.title || this.defaultTitle(conversationId),
                        checkpointCount: records.length,
                        totalSize,
                        createdAt: metadata?.createdAt,
                        updatedAt: metadata?.updatedAt,
                        sizeIncomplete: sizeIncomplete || undefined
                    });
                } catch {
                    // 忽略单个对话的错误
                }
            });
            results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        } catch (err) {
            log.warn('get_all_conversations_with_checkpoints_failed', {
                error: err instanceof Error ? err.message : String(err)
            });
        }
        return results;
    }

    /** 计算目录总大小（有界并发递归，CPF-06）。跳过 manifest 元数据文件（不属于备份内容） */
    async getDirectorySize(dirPath: string): Promise<number> {
        let totalSize = 0;
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            const subDirs: string[] = [];
            for (const entry of entries) {
                // CPF-01: manifest 是元数据，不计入备份占用；
                // CPF-LAZY-1: files.json 同样是元数据（重量级文件映射独立存储），不计入；
                // ATOMIC-PAIR: files.json.prev 是崩溃窗口的旧配对备份（或写失败残留），同样不计入
                if (entry.name === CHECKPOINT_MANIFEST_FILENAME || entry.name === CHECKPOINT_MANIFEST_FILES_FILENAME
                    || entry.name.endsWith('.tmp') || entry.name.endsWith('.prev')) {
                    continue;
                }
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    subDirs.push(fullPath);
                } else if (entry.isFile()) {
                    try {
                        const stat = await fs.stat(fullPath);
                        totalSize += stat.size;
                    } catch {
                        // 忽略无法访问的文件
                    }
                }
            }
            if (subDirs.length > 0) {
                await runBounded(subDirs, DEFAULT_CHECKPOINT_CONCURRENCY, async dir => {
                    totalSize += await this.getDirectorySize(dir);
                });
            }
        } catch {
            // 忽略无法访问的目录
        }
        return totalSize;
    }

    /** 把懒扫描得到的 backupBytes 写回元数据摘要缓存（CPF-09；失败不影响读取） */
    private async writeBackBackupBytes(
        conversationId: string,
        checkpointId: string,
        backupBytes: number
    ): Promise<void> {
        try {
            await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                if (list.some(cp => cp.id === checkpointId && typeof cp.backupBytes === 'number')) {
                    return current; // 已缓存：跳过写回
                }
                return list.map(cp => (cp.id === checkpointId ? { ...cp, backupBytes } : cp));
            });
        } catch (err) {
            console.warn('[CheckpointQueryService] Failed to write back backupBytes:', err);
        }
    }

    /** 判断某个备份目录是否存在 */
    async backupDirectoryExists(backupDir: string): Promise<boolean> {
        // CP-PATH-1: 越界/损坏目录名视为不存在（不触碰文件系统）——
        // 下游 pruneMissingBackupCheckpointRecords 会据此裁剪无法安全恢复的记录，
        // 保证恶意记录不会带着越界目录名继续流入恢复扫描路径。
        if (!isSafeCheckpointDirName(backupDir)) {
            console.warn(`[CheckpointQueryService] Refusing to check unsafe backupDir ${backupDir}`);
            return false;
        }
        try {
            const backupPath = path.join(this.checkpointsDir, backupDir);
            await fs.access(backupPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 清理孤儿备份目录：磁盘上存在但没有任何检查点记录引用的目录。
     * 只在恢复/预览的存档锁内调用（prepareRestore → prune），只处理 `cp_*` 格式目录。
     *
     * CP-ORPHAN-1: 孤儿判定必须基于**全部对话**的存档记录——checkpointsDir 是
     * 所有对话共享的平铺目录，若只拿当前对话的记录做 knownDirs，会把其他对话的
     * 存档目录误判为孤儿并 `fs.rm(recursive)` 删除（跨对话数据丢失）。
     * 汇总用有界并发池（runBounded），对话数多时不串行放大恢复路径耗时。
     */
    async removeOrphanBackupDirs(checkpoints: CheckpointRecord[]): Promise<void> {
        try {
            const knownDirs = new Set(checkpoints.map(cp => cp.backupDir));
            const conversationIds = await this.conversationManager.listConversations();
            await runBounded(conversationIds, DEFAULT_CHECKPOINT_CONCURRENCY, async conversationId => {
                let records: CheckpointRecord[] = [];
                try {
                    records = await this.getCheckpointRecords(conversationId);
                } catch {
                    // 单个对话元数据读取失败：fail-closed——抛出让本次清理整体中止（下方
                    // manifest 守卫兜底），不让无法枚举的对话存档被误删
                    throw new Error(`failed to enumerate checkpoints of conversation ${conversationId}`);
                }
                for (const cp of records) {
                    if (typeof cp?.backupDir === 'string' && cp.backupDir.length > 0) {
                        knownDirs.add(cp.backupDir);
                    }
                }
            });
            const entries = await fs.readdir(this.checkpointsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (knownDirs.has(entry.name)) continue;
                if (!/^cp_[a-z0-9_]+$/i.test(entry.name)) continue;
                // CP-ORPHAN-2（fail-closed）：目录内含 manifest.json 的存档绝不当作孤儿删除。
                // getCustomMetadata 对元数据损坏/瞬时可读失败会降级返回 undefined（fail-open），
                // 该对话的存档目录因此不在 knownDirs 中——manifest 是每个存档创建时必写的
                // 身份文件，存在 manifest 即说明它属于某个（可能暂时无法枚举的）对话。
                try {
                    await fs.access(path.join(this.checkpointsDir, entry.name, 'manifest.json'));
                    continue;
                } catch {
                    // 无 manifest：叠加 mtime 新鲜度守卫——「目录已建、manifest 未写」的
                    // 创建中窗口内跳过（检查点创建流程先建目录后写 manifest），超龄无
                    // manifest 目录才是真孤儿（创建中断残留/无 manifest 的旧格式）。
                    try {
                        const stat = await fs.stat(path.join(this.checkpointsDir, entry.name));
                        if (Date.now() - stat.mtimeMs < ORPHAN_MANIFEST_MISSING_FRESH_MS) {
                            continue;
                        }
                    } catch {
                        continue; // stat 失败（目录刚消失等）：本次跳过，下轮再判
                    }
                    // C-2: 删除前检查「进行中 create」引用——另一工作区正在创建该存档时
                    //（目录已建、manifest 未写，大工作区 mkdir→writeManifest 可能超 5 分钟新鲜度窗口），
                    // 绝不能把它当孤儿删除。
                    if (this.isBackupDirBeingCreated?.(entry.name)) {
                        continue;
                    }
                }
                try {
                    await fs.rm(path.join(this.checkpointsDir, entry.name), { recursive: true, force: true });
                    this.manifestRepository.clearCache(entry.name);
                    log.info('prune_orphan_backup_dir', { backupDir: entry.name });
                } catch (err) {
                    console.warn(`[CheckpointQueryService] Failed to remove orphan backup dir ${entry.name}:`, err);
                }
            }
        } catch {
            // checkpointsDir 不存在或任一对话枚举失败（fail-closed）：忽略，本次不清理
        }
    }

    /**
     * 裁剪缺失备份目录的存档记录（恢复前预检，锁外执行；真实过滤在链内基于最新列表重算）。
     */
    async pruneMissingBackupCheckpointRecords(
        conversationId: string,
        checkpoints: CheckpointRecord[]
    ): Promise<{ checkpoints: CheckpointRecord[]; missingBackupDirs: string[]; prunedCount: number }> {
        if (checkpoints.length === 0) {
            return { checkpoints, missingBackupDirs: [], prunedCount: 0 };
        }

        const backupDirExists = new Map<string, boolean>();
        const missingBackupDirs: string[] = [];
        for (const checkpoint of checkpoints) {
            // CP-PATH-1: 越界/损坏 backupDir 绝不静默删除记录——保留记录 + 告警，
            // 不进入 missingBackupDirs（与删除路径「拒绝删除并告警」口径一致）
            if (!isSafeCheckpointDirName(checkpoint.backupDir)) {
                console.warn(`[CheckpointQueryService] Refusing to prune checkpoint ${checkpoint.id}: unsafe backupDir ${checkpoint.backupDir}`);
                continue;
            }
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
            await this.removeOrphanBackupDirs(checkpoints);
            return { checkpoints, missingBackupDirs: [], prunedCount: 0 };
        }

        try {
            const pruned = await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', async current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const kept: CheckpointRecord[] = [];
                const foundMissing: string[] = [];
                for (const cp of list) {
                    // CP-PATH-1: unsafe backupDir 记录不删除（保留 + 告警，与预检同口径）
                    if (!isSafeCheckpointDirName(cp.backupDir)) {
                        console.warn(`[CheckpointQueryService] Refusing to prune checkpoint ${cp.id}: unsafe backupDir ${cp.backupDir}`);
                        kept.push(cp);
                        continue;
                    }
                    if (backupDirExists.get(cp.backupDir) !== true) {
                        // TOCTOU 复核：预检时缺失/未知的目录在链内现场复核一次
                        //（目录可能已被并发创建/恢复；与未知目录的现场核验对称）
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

            await this.removeOrphanBackupDirs(checkpoints);

            if (Array.isArray(pruned)) {
                // Math.max 兜底：并发新增记录时 pruned.length 可能大于 checkpoints.length
                const prunedCount = Math.max(0, checkpoints.length - pruned.length);
                return { checkpoints: pruned, missingBackupDirs: uniqueMissing, prunedCount };
            }
            // fail-closed：写回被拒（返回非数组）时未删除任何记录——不报告缺失目录，
            // 避免调用方误以为记录已被裁剪（missingBackupDirs 清空）
            return { checkpoints, missingBackupDirs: [], prunedCount: 0 };
        } catch (err) {
            console.warn('[CheckpointQueryService] Failed to prune checkpoint metadata:', err);
            // fail-closed：异常时未删除任何记录——同样清空 missingBackupDirs
            return { checkpoints, missingBackupDirs: [], prunedCount: 0 };
        }
    }
}
