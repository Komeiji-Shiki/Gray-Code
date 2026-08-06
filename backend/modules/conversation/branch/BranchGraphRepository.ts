/**
 * 分支图 sidecar 存储（第五阶段 BR-04）。
 *
 * 文件布局（沿用 FileSystemStorageAdapter 的会话目录约定）：
 *   {baseDir}/conversations/{conversationId}/branches.json
 *
 * - 原子写：tmp + rename（参考 storage.ts writeSegmentedHistory / renameOverwrite 的
 *   「先写临时文件 → 原子替换」模式；tmp 文件名带 pid + 时间 + 随机后缀避免并发冲突）
 * - 损坏处理：JSON 解析失败或结构不符返回 { graph: null, errorCode: 'BRANCH_STORAGE_CORRUPT' }，
 *   由调用方降级「线性模式」（把主历史视为单路径图），不阻塞读取
 * - 写入按会话串行化（Promise 链），与 storage.ts 的 runSegmentedHistoryWriteSerialized 同模式
 * - 本仓储是纯存储层，不做图一致性校验（validate 是 BranchGraph 纯函数的职责）
 *
 * 注入 baseDir 以便测试用内存 / 临时目录。
 */

import * as fsp from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { ConversationBranchGraph, BranchRetentionConfig, isBranchGraphShape } from './types';
import { BranchError } from './types';
import { migrateBranchGraph } from './BranchMigration';

/** 读取结果：损坏或不可读时 graph 为 null 并带 errorCode，由调用方降级线性模式 */
export interface BranchGraphReadResult {
    graph: ConversationBranchGraph | null;
    errorCode?: 'BRANCH_STORAGE_CORRUPT';
    errorMessage?: string;
}

/** migrate 的返回：graph 为 null 表示无 sidecar 可迁（线性模式） */
export interface BranchGraphMigrateResult {
    graph: ConversationBranchGraph | null;
    fromVersion: number;
    toVersion: number;
    /** 是否实际执行了版本升级 */
    migrated: boolean;
    /** 是否发生了落盘写（迁移成功时 true；无图/已最新时 false） */
    saved: boolean;
}

// 同一会话的 sidecar 写入串行化（防 tmp 写交错；rename 本身原子，串行保证最后写者确定）
const writeQueues = new Map<string, Promise<void>>();

function runWriteSerialized<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = writeQueues.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(() => undefined, () => undefined);
    writeQueues.set(conversationId, tail);
    void tail.then(() => {
        if (writeQueues.get(conversationId) === tail) {
            writeQueues.delete(conversationId);
        }
    });
    return current;
}

/**
 * Windows 上 rename 偶发 EPERM（文件锁/杀软竞态）：短暂重试后仍失败才抛出。
 * 仅重试「可恢复」错误码（EPERM/EACCES/EBUSY）；其他错误（ENOENT 等）立即抛出。
 */
async function renameWithRetry(src: string, dest: string, attempts = 3, delayMs = 50): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await fsp.rename(src, dest);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
            if (!retryable || attempt >= attempts) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

/** 轻量结构校验已提升至 branch/types.ts 共享（R8b-L3：isBranchGraphShape），此处不再重复实现 */

/**
 * 会话 ID 路径安全校验（路径穿越防护）。
 * conversationId 可能来自 webview 消息或元数据等不可信输入，直接拼进 path.join
 * 会被 node:path 解析 `..`，从而把 branches.json 读写到 conversations/ 之外；
 * 规则为「单层目录名」白名单：非空且仅 [a-zA-Z0-9_-]（与现有 ID 生成规则
 * conv_{timestamp}_{rand} 及测试用 c1 / conv-a 等全部兼容）。非法时抛 BranchError。
 */
function assertSafeConversationId(conversationId: string): void {
    if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
        throw new BranchError(
            'INVALID_CONVERSATION_ID',
            `Unsafe conversation id: ${String(conversationId)} (must be a plain directory name)`
        );
    }
}

export class BranchGraphRepository {
    /**
     * @param baseDir 存储根目录（与 FileSystemStorageAdapter 的 baseDir 同约定，
     *                其下 conversations/{id}/branches.json）
     */
    constructor(private readonly baseDir: string) {}

    /** branches.json 的完整路径（路径规则单一来源）；conversationId 非法时抛 BranchError */
    getBranchesFilePath(conversationId: string): string {
        assertSafeConversationId(conversationId);
        return path.join(this.baseDir, 'conversations', conversationId, 'branches.json');
    }

    /** 分支保留期配置文件的完整路径（TREE-09；数据目录根下，与会话 sidecar 分开） */
    getBranchConfigFilePath(): string {
        return path.join(this.baseDir, 'branches.config.json');
    }

    /**
     * TREE-09：列出存在 branches.json sidecar 的全部会话 id（prune / getDeletedBranchCount 全量扫描用）。
     * 目录缺失 / 无子目录时返回空数组；只认真实的 branches.json 文件（忽略残留 tmp）。
     */
    async listConversationIds(): Promise<string[]> {
        const conversationsDir = path.join(this.baseDir, 'conversations');
        let entries: import('fs').Dirent[];
        try {
            entries = await fsp.readdir(conversationsDir, { withFileTypes: true });
        } catch {
            return [];
        }
        const ids: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            try {
                await fsp.access(path.join(conversationsDir, entry.name, 'branches.json'));
                ids.push(entry.name);
            } catch {
                // 无 sidecar 的会话目录跳过
            }
        }
        return ids.sort();
    }

    /**
     * TREE-09：读取分支保留期配置（branches.config.json）。
     * - 文件缺失 / 损坏 / 字段非法 → 返回空对象（retentionDays 为 undefined，上层取构造默认值）
     *   （R8c-P5：此前缺失/损坏恒返回 DEFAULT_BRANCH_RETENTION_DAYS，导致 BranchService 构造选项
     *   options.retentionDays 成为死代码——上层永远拿不到 undefined 来触发构造默认）；
     * - retentionDays 必须为 >=0 的整数（0 = 不自动清理）。
     */
    async loadBranchRetentionConfig(): Promise<{ retentionDays?: number }> {
        const filePath = this.getBranchConfigFilePath();
        let raw: string;
        try {
            raw = await fsp.readFile(filePath, 'utf8');
        } catch {
            return {};
        }
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const days = parsed?.retentionDays;
            if (typeof days === 'number' && Number.isFinite(days) && days >= 0 && Number.isInteger(days)) {
                return { retentionDays: days };
            }
        } catch {
            // 损坏配置按缺省处理（写路径 saveBranchRetentionConfig 会覆盖）
        }
        return {};
    }

    /**
     * TREE-09：持久化分支保留期配置（原子写 tmp + rename）。
     * retentionDays 非法（非整数 / 负数）抛 INVALID_BRANCH_RELATION，不落盘。
     */
    async saveBranchRetentionConfig(config: BranchRetentionConfig): Promise<void> {
        if (
            typeof config.retentionDays !== 'number'
            || !Number.isFinite(config.retentionDays)
            || !Number.isInteger(config.retentionDays)
            || config.retentionDays < 0
        ) {
            throw new BranchError(
                'INVALID_BRANCH_RELATION',
                `invalid retentionDays: ${String(config.retentionDays)} (must be a non-negative integer, 0 = never auto-prune)`
            );
        }
        const filePath = this.getBranchConfigFilePath();
        await fsp.mkdir(this.baseDir, { recursive: true });
        const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        try {
            await fsp.writeFile(tmpPath, JSON.stringify({ retentionDays: config.retentionDays }, null, 2), 'utf8');
            await renameWithRetry(tmpPath, filePath);
        } catch (error) {
            try {
                await fsp.unlink(tmpPath);
            } catch {
                // tmp 清理失败忽略
            }
            throw error;
        }
    }

    /** sidecar 是否存在 */
    async exists(conversationId: string): Promise<boolean> {
        try {
            await fsp.access(this.getBranchesFilePath(conversationId));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 读取分支图。
     * - 文件不存在：{ graph: null }（尚无分支，线性模式）
     * - 解析失败 / 结构不符：{ graph: null, errorCode: 'BRANCH_STORAGE_CORRUPT' }（降级线性模式）
     */
    async load(conversationId: string): Promise<BranchGraphReadResult> {
        const filePath = this.getBranchesFilePath(conversationId);
        let raw: string;
        try {
            raw = await fsp.readFile(filePath, 'utf8');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') {
                return { graph: null };
            }
            return {
                graph: null,
                errorCode: 'BRANCH_STORAGE_CORRUPT',
                errorMessage: `read failed: ${String((error as Error)?.message ?? error)}`,
            };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            return {
                graph: null,
                errorCode: 'BRANCH_STORAGE_CORRUPT',
                errorMessage: `JSON parse failed: ${String((error as Error)?.message ?? error)}`,
            };
        }
        if (!isBranchGraphShape(parsed)) {
            return { graph: null, errorCode: 'BRANCH_STORAGE_CORRUPT', errorMessage: 'branches.json has invalid shape' };
        }
        return { graph: parsed as ConversationBranchGraph };
    }

    /**
     * 原子写入（tmp + rename）。
     * 失败时清理 tmp 并抛出；成功后目录内不残留 tmp 文件。
     * 调用方负责会话级写串行化（save / migrate 已包 runWriteSerialized）。
     */
    private async writeGraphFile(conversationId: string, graph: ConversationBranchGraph): Promise<void> {
        const filePath = this.getBranchesFilePath(conversationId);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        try {
            await fsp.writeFile(tmpPath, JSON.stringify(graph, null, 2), 'utf8');
            await renameWithRetry(tmpPath, filePath);
        } catch (error) {
            try {
                await fsp.unlink(tmpPath);
            } catch {
                // tmp 清理失败忽略（rename 成功后无 tmp）
            }
            throw error;
        }
    }

    /**
     * 原子写入（tmp + rename）。
     * 失败时清理 tmp 并抛出；成功后目录内不残留 tmp 文件。
     */
    async save(conversationId: string, graph: ConversationBranchGraph): Promise<void> {
        await runWriteSerialized(conversationId, () => this.writeGraphFile(conversationId, graph));
    }

    /**
     * 在修复/重建 sidecar 前保存原文件的逐字节备份。
     *
     * - 与 save/delete 共用会话写队列，避免复制过程与单次写入本身交错；上层仍须在同一会话锁内
     *   连续执行 backup + save，保证中间没有其它业务写入；
     * - 使用 COPYFILE_EXCL，绝不覆盖已有备份；
     * - 源文件不存在返回 null，其它错误直接抛出，调用方必须停止重建。
     */
    async backup(conversationId: string, reason = 'recovery'): Promise<string | null> {
        return await runWriteSerialized(conversationId, async () => {
            const filePath = this.getBranchesFilePath(conversationId);
            const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'recovery';
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
                const backupPath = path.join(path.dirname(filePath), `branches.backup-${safeReason}-${suffix}.json`);
                try {
                    await fsp.copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
                    return backupPath;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException)?.code;
                    if (code === 'ENOENT') {
                        return null;
                    }
                    if (code !== 'EEXIST' || attempt === 4) {
                        throw error;
                    }
                }
            }
            return null;
        });
    }

    /**
     * 版本迁移（MIG-04）：读取 sidecar → migrateBranchGraph 链式升级 → 原子保存。
     *
     * - 文件不存在：{ migrated: false, saved: false }（无图可迁）
     * - 损坏：抛 BranchError('BRANCH_STORAGE_CORRUPT')，不覆盖原文件（保留可恢复数据）
     * - 版本已是最新：{ migrated: false, saved: false }（幂等，不重写文件）
     * - 迁移失败（step 抛错 / 未知版本）：migrateBranchGraph 已回滚内存态并抛错，
     *   本方法不落盘任何中间态，原 sidecar 保持原版本（可恢复中间状态）
     *
     * 整个读改写包在同一会话写串行队列内（不嵌套调用 save，避免写队列自等死锁）。
     */
    async migrate(
        conversationId: string,
        options: { targetVersion?: number } = {}
    ): Promise<BranchGraphMigrateResult> {
        return await runWriteSerialized(conversationId, async () => {
            const loaded = await this.load(conversationId);
            if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `cannot migrate corrupt branches.json for ${conversationId} (${loaded.errorMessage ?? 'unknown error'})`
                );
            }
            if (!loaded.graph) {
                return { graph: null, fromVersion: -1, toVersion: -1, migrated: false, saved: false };
            }
            const result = migrateBranchGraph(loaded.graph, options);
            if (!result.migrated) {
                return { ...result, saved: false };
            }
            await this.writeGraphFile(conversationId, result.graph);
            return { ...result, saved: true };
        });
    }

    /**
     * 删除会话的 sidecar 文件（deleteConversation 清理接口；
     * 会话目录与主历史 / 元数据的清理由 ConversationManager 的既有路径负责）。
     * 文件不存在时不抛错（幂等）。
     *
     * M-5：删除与 save/migrate 共用同一会话写串行队列——并发「写→删」时先写后删
     * （无 sidecar 残留）；「删→写」时写排在后（配合 BranchService 的已删除会话检查
     * 阻止迟到写重建 sidecar）。
     */
    async deleteConversation(conversationId: string): Promise<void> {
        await runWriteSerialized(conversationId, async () => {
            const filePath = this.getBranchesFilePath(conversationId);
            try {
                await fsp.unlink(filePath);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException)?.code;
                if (code !== 'ENOENT') {
                    throw error;
                }
            }
        });
    }
}
