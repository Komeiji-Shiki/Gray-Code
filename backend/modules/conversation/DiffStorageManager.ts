/**
 * Diff 内容存储管理器
 * 
 * 将 apply_diff 工具的 originalContent 和 newContent 抽离到单独文件存储
 * 避免对话历史 JSON 过大，只在需要查看差异时按需加载
 * 
 * 存储结构：
 * {dataPath}/diffs/{conversationId}/{diffId}.json
 * 
 * 每个 diff 文件内容（gzip 无损压缩后的 JSON）：
 * {
 *   originalContent: string,
 *   newContent: string,
 *   filePath: string,
 *   createdAt: number
 * }
 * 
 * 绑定关系：saveGlobalDiff 支持传入 conversationId，把 diff 落盘到对应对话目录，
 * 删除对话时 deleteConversationDiffs 会一并清理，避免 __global__ 无限增长；
 * 为兼容旧数据，loadGlobalDiff 先查索引，再回退 __global__ 目录。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { isSafeId } from '../../core/idValidation';
import { Logger } from '../../core/logger';

const log = Logger.get('DiffStorageManager');
const MAX_GLOBAL_DIFF_CACHE_ENTRIES = 16;
const MAX_GLOBAL_DIFF_CACHE_BYTES = 32 * 1024 * 1024;

// gzip 魔数（0x1f 0x8b）：读取时用于识别压缩文件，兼容旧版明文 JSON
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Diff 内容记录
 */
export interface DiffContent {
    /** 原始文件内容 */
    originalContent: string;
    /** 修改后的内容 */
    newContent: string;
    /** 文件路径 */
    filePath: string;
    /** 创建时间 */
    createdAt: number;
}

/**
 * Diff 引用（保存在对话历史中的轻量引用）
 */
export interface DiffReference {
    /** Diff ID */
    diffId: string;
    /** 文件路径 */
    filePath: string;
    /** 是否有 diff 内容可查看 */
    hasDiffContent: true;
}

/**
 * Diff 存储管理器
 */
export class DiffStorageManager {
    private static instance: DiffStorageManager | null = null;
    
    /** 数据存储基础路径 */
    private basePath: string;
    /** apply_diff 最近内容的有界内存缓存：预览无需等待 JSON 落盘后再读回。 */
    private readonly globalDiffCache = new Map<string, { content: DiffContent; bytes: number }>();
    private globalDiffCacheBytes = 0;
    /** diffId -> conversationId 索引（懒加载，从 diffs/index.json 读入） */
    private diffIndex: Map<string, string> | null = null;
    /** 索引写入串行化（防并发写互相覆盖） */
    private indexWriteChain: Promise<void> = Promise.resolve();
    /** 已删除对话墓碑：对话 ID 永不复用，deferred 落盘在删除后不再写回 */
    private readonly deletedConversationTombstones = new Set<string>();
    
    private constructor(basePath: string) {
        this.basePath = basePath;
    }
    
    /**
     * 初始化单例实例
     */
    public static initialize(basePath: string): DiffStorageManager {
        if (!DiffStorageManager.instance) {
            DiffStorageManager.instance = new DiffStorageManager(basePath);
        } else {
            // 更新路径（可能因为存储路径迁移）
            DiffStorageManager.instance.basePath = basePath;
            // 旧路径下加载的索引不得带入新路径（否则 persistDiffIndex 会把旧条目
            // 写到新路径的 index.json，跨路径污染）；新路径索引由懒加载重新读入。
            DiffStorageManager.instance.diffIndex = null;
        }
        return DiffStorageManager.instance;
    }
    
    /**
     * 获取单例实例
     */
    public static getInstance(): DiffStorageManager | null {
        return DiffStorageManager.instance;
    }
    
    /**
     * 更新基础路径（存储路径迁移时使用）
     */
    public updateBasePath(newBasePath: string): void {
        this.basePath = newBasePath;
        // 同 initialize：路径变更必须重置索引缓存，防止旧条目写入新路径
        this.diffIndex = null;
    }
    
    /**
     * 获取 diff 存储目录
     *
     * 路径穿越防护：conversationId 可能来自不可信输入，直接拼进 path.join 会被解析 `..`
     * 写出到 diffs/ 之外；白名单校验（非空且仅 [a-zA-Z0-9_-]，与现有 ID 生成规则
     * conv_{timestamp}_{rand} 兼容），非法时抛错拒绝读写。
     */
    private getDiffsDir(conversationId: string): string {
        if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
            throw new Error(`Unsafe conversation id for diff storage: ${String(conversationId)}`);
        }
        return path.join(this.basePath, 'diffs', conversationId);
    }
    
    /**
     * 获取 diff 文件路径
     */
    private getDiffFilePath(conversationId: string, diffId: string): string {
        this.assertSafeDiffId(diffId);
        return path.join(this.getDiffsDir(conversationId), `${diffId}.json`);
    }

    private assertSafeDiffId(diffId: unknown): asserts diffId is string {
        if (typeof diffId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(diffId)) {
            throw new Error(`Unsafe diff id: ${String(diffId)}`);
        }
    }
    
    /**
     * 确保目录存在
     */
    private async ensureDir(dirPath: string): Promise<void> {
        try {
            await fs.promises.mkdir(dirPath, { recursive: true });
        } catch (error) {
            // 目录可能已存在
        }
    }
    
    /**
     * 生成唯一的 Diff ID
     */
    public generateDiffId(): string {
        return `diff_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    // ─── 无损压缩（gzip） ─────────────────────────

    /** 无损压缩内容为 Buffer（gzip） */
    private async compressDiff(content: DiffContent): Promise<Buffer> {
        const json = Buffer.from(JSON.stringify(content), 'utf8');
        return await new Promise<Buffer>((resolve, reject) => {
            zlib.gzip(json, { level: 6 }, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    }

    /** 读取 Buffer 并解压/解析：识别 gzip 魔数，兼容旧版明文 JSON */
    private async decompressDiff(data: Buffer): Promise<DiffContent> {
        if (data.length >= 2 && data[0] === GZIP_MAGIC[0] && data[1] === GZIP_MAGIC[1]) {
            const raw = await new Promise<Buffer>((resolve, reject) => {
                zlib.gunzip(data, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
            return JSON.parse(raw.toString('utf8')) as DiffContent;
        }
        return JSON.parse(data.toString('utf8')) as DiffContent;
    }

    private async readDiffFile(filePath: string): Promise<DiffContent | null> {
        try {
            const data = await fs.promises.readFile(filePath);
            return await this.decompressDiff(data);
        } catch (error) {
            console.warn(`[DiffStorageManager] Failed to load diff ${path.basename(filePath)}: ${error}`);
            return null;
        }
    }

    /** 文件是否确定不存在（ENOENT）——自愈只处理真实缺失，避免瞬时读错误删索引 */
    private async isFileMissing(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return false;
        } catch (error: any) {
            return error?.code === 'ENOENT';
        }
    }

    // ─── diffId -> conversationId 索引 ─────────────────

    private get diffIndexPath(): string {
        return path.join(this.basePath, 'diffs', 'index.json');
    }

    private async loadDiffIndex(): Promise<Map<string, string>> {
        if (this.diffIndex) return this.diffIndex;
        this.diffIndex = new Map();
        try {
            const raw = await fs.promises.readFile(this.diffIndexPath, 'utf8');
            const parsed = JSON.parse(raw) as Record<string, string>;
            for (const [diffId, conversationId] of Object.entries(parsed)) {
                if (/^[a-zA-Z0-9_-]+$/.test(diffId) && /^[a-zA-Z0-9_-]+$/.test(conversationId)) {
                    this.diffIndex.set(diffId, conversationId);
                }
            }
        } catch {
            // 索引不存在（首次使用或旧版本数据）：视为空索引
        }
        return this.diffIndex;
    }

    private async persistDiffIndex(): Promise<void> {
        const index = this.diffIndex ?? new Map<string, string>();
        const diffsDir = path.join(this.basePath, 'diffs');
        const payload = Buffer.from(JSON.stringify(Object.fromEntries(index.entries())), 'utf8');
        // 串行化写入 + tmp/rename 原子落盘：并发 save/delete 不互相踩。
        // 前序失败不得永久阻断整条链（否则一次 IO 错误后所有索引写入全部失效）：
        // catch 后链继续，本次失败仍会向调用方抛出（rememberDiffOwner 感知后降级）。
        this.indexWriteChain = this.indexWriteChain
            .catch(() => {})
            .then(async () => {
                await this.ensureDir(diffsDir);
                // 同毫秒多次调用时 tmp 名必须唯一，避免互相覆盖（rename 前被第二次 write 截胡）
                const tmp = `${this.diffIndexPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
                await fs.promises.writeFile(tmp, payload, 'utf8');
                await fs.promises.rename(tmp, this.diffIndexPath);
            });
        await this.indexWriteChain;
    }

    /** 记录 diff 归属（conversationId 非空时写入索引） */
    private async rememberDiffOwner(diffId: string, conversationId: string | undefined): Promise<void> {
        if (!conversationId) return;
        if (this.deletedConversationTombstones.has(conversationId)) return;
        const index = await this.loadDiffIndex();
        index.set(diffId, conversationId);
        try {
            await this.persistDiffIndex();
        } catch (error) {
            // 磁盘写失败：回滚内存条目，保持内存索引与磁盘一致
            // （调用方会回退 __global__ 存储；残留内存条目会在下次成功落盘时
            //  把「指向不存在文件」的幽灵条目写进 index.json，load 时又要靠自愈兜底）
            if (index.get(diffId) === conversationId) {
                index.delete(diffId);
            }
            throw error;
        }
    }

    /** 移除某对话全部索引条目（对话删除时调用） */
    private async forgetConversationDiffs(conversationId: string): Promise<void> {
        const index = await this.loadDiffIndex();
        let changed = false;
        for (const [diffId, owner] of index) {
            if (owner === conversationId) {
                index.delete(diffId);
                changed = true;
            }
        }
        if (changed) await this.persistDiffIndex();
    }

    /**
     * 保存 diff 内容到单独文件
     *
     * @param conversationId 对话 ID
     * @param content Diff 内容
     * @param diffId Diff ID（如果不提供则自动生成）
     * @returns Diff 引用
     */
    public async saveDiffContent(
        conversationId: string,
        content: {
            originalContent: string;
            newContent: string;
            filePath: string;
        },
        diffId?: string
    ): Promise<DiffReference> {
        const id = diffId || this.generateDiffId();
        const diffsDir = this.getDiffsDir(conversationId);
        
        await this.ensureDir(diffsDir);
        
        const diffContent: DiffContent = {
            originalContent: content.originalContent,
            newContent: content.newContent,
            filePath: content.filePath,
            createdAt: Date.now()
        };
        
        const filePath = this.getDiffFilePath(conversationId, id);
        await this.atomicWriteFile(filePath, await this.compressDiff(diffContent));
        
        log.debug('diff_saved', { diffId: id, conversationId });
        
        return {
            diffId: id,
            filePath: content.filePath,
            hasDiffContent: true
        };
    }
    
    /**
     * 保存 diff 内容（优先绑定到对话目录，未传对话时回退 __global__）
     * 用于 apply_diff 工具调用时保存
     *
     * @param content Diff 内容
     * @param diffId Diff ID（如果不提供则自动生成）
     * @param conversationId 对话 ID（可空；非空时落盘到对话目录，删除对话即可清理）
     * @returns Diff 引用
     */
    public async saveGlobalDiff(
        content: {
            originalContent: string;
            newContent: string;
            filePath: string;
        },
        diffId?: string,
        conversationId?: string
    ): Promise<DiffReference> {
        const id = diffId || this.generateDiffId();
        this.assertSafeDiffId(id);
        const diffContent = this.buildGlobalDiffContent(content);
        this.cacheGlobalDiff(id, diffContent);
        // 先写索引、后写文件：崩溃窗口只会留下「索引有、文件无」的陈旧条目
        // （load 时自愈删除），不会留下「文件有、索引无」的永久孤儿文件
        // （旧顺序下 crash 会产生磁盘垃圾且 load 永远找不到）。
        let indexed = true;
        try {
            await this.rememberDiffOwner(id, conversationId);
        } catch (error) {
            // 索引写入失败不阻塞文件保存：回退 __global__（load 路径可经
            // 索引 miss → __global__ 兜底仍找到内容），仅记录告警。
            indexed = false;
            log.warn('global_diff_index_write_failed', {
                diffId: id,
                error: error instanceof Error ? error.message : String(error)
            });
        }
        await this.persistGlobalDiff(id, diffContent, indexed ? conversationId : undefined);
        return this.buildGlobalDiffReference(id, content.filePath);
    }

    /**
     * 立即返回轻量引用，并在后台持久化全文。
     * 当前进程内 loadGlobalDiff 会优先命中内存；落盘完成后扩展重启仍可读取。
     */
    public saveGlobalDiffDeferred(
        content: {
            originalContent: string;
            newContent: string;
            filePath: string;
        },
        diffId?: string,
        conversationId?: string
    ): DiffReference {
        const id = diffId || this.generateDiffId();
        this.assertSafeDiffId(id);
        const diffContent = this.buildGlobalDiffContent(content);
        this.cacheGlobalDiff(id, diffContent);
        void (async () => {
            try {
                // 与 saveGlobalDiff 同序：先索引后文件，崩溃窗口不产生孤儿文件
                let indexed = true;
                try {
                    await this.rememberDiffOwner(id, conversationId);
                } catch (error) {
                    indexed = false;
                    log.warn('global_diff_index_write_failed', {
                        diffId: id,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                await this.persistGlobalDiff(id, diffContent, indexed ? conversationId : undefined);
            } catch (error) {
                log.warn('global_diff_background_save_failed', {
                    diffId: id,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        })();
        return this.buildGlobalDiffReference(id, content.filePath);
    }

    private buildGlobalDiffContent(content: {
        originalContent: string;
        newContent: string;
        filePath: string;
    }): DiffContent {
        return {
            originalContent: content.originalContent,
            newContent: content.newContent,
            filePath: content.filePath,
            createdAt: Date.now()
        };
    }

    private buildGlobalDiffReference(id: string, filePath: string): DiffReference {
        return { diffId: id, filePath, hasDiffContent: true };
    }

    private async persistGlobalDiff(id: string, content: DiffContent, conversationId?: string): Promise<void> {
        this.assertSafeDiffId(id);
        const dirName = conversationId && /^[a-zA-Z0-9_-]+$/.test(conversationId)
            ? conversationId
            : '__global__';
        // 对话已删除：墓碑拦截，避免 deferred 落盘把已清理目录复活
        if (dirName !== '__global__' && this.deletedConversationTombstones.has(dirName)) {
            return;
        }
        const diffsDir = path.join(this.basePath, 'diffs', dirName);
        await this.ensureDir(diffsDir);
        await this.atomicWriteFile(path.join(diffsDir, `${id}.json`), await this.compressDiff(content));
        log.debug('global_diff_saved', { diffId: id, conversationId: conversationId || '__global__' });
    }

    /**
     * 原子写文件：先写 .tmp 再 rename 覆盖（与 storage.ts 同模式），
     * 避免写入中途崩溃留下半截 JSON 被读取侧解析失败。
     * Windows 的 rename 不覆盖已存在目标（EPERM/EEXIST）：先删旧文件再 rename；
     * 其它错误（权限等）原样抛出，保留旧文件（残留 .tmp 由下次写入覆盖，读取侧只认 .json）。
     */
    private async atomicWriteFile(filePath: string, data: string | Buffer): Promise<void> {
        const tmpPath = `${filePath}.tmp`;
        await fs.promises.writeFile(tmpPath, data, 'utf8');
        try {
            await fs.promises.rename(tmpPath, filePath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code !== 'EEXIST' && code !== 'EPERM') {
                throw error;
            }
            try {
                await fs.promises.unlink(filePath);
            } catch {
                // 目标不存在，无需删除
            }
            await fs.promises.rename(tmpPath, filePath);
        }
    }

    private cacheGlobalDiff(id: string, content: DiffContent): void {
        const bytes = Buffer.byteLength(content.originalContent, 'utf8')
            + Buffer.byteLength(content.newContent, 'utf8');
        const previous = this.globalDiffCache.get(id);
        if (previous) {
            this.globalDiffCacheBytes -= previous.bytes;
            this.globalDiffCache.delete(id);
        }
        if (bytes > MAX_GLOBAL_DIFF_CACHE_BYTES) return;

        this.globalDiffCache.set(id, { content, bytes });
        this.globalDiffCacheBytes += bytes;
        while (
            this.globalDiffCache.size > MAX_GLOBAL_DIFF_CACHE_ENTRIES
            || this.globalDiffCacheBytes > MAX_GLOBAL_DIFF_CACHE_BYTES
        ) {
            const oldestId = this.globalDiffCache.keys().next().value as string | undefined;
            if (!oldestId) break;
            const oldest = this.globalDiffCache.get(oldestId);
            if (oldest) this.globalDiffCacheBytes -= oldest.bytes;
            this.globalDiffCache.delete(oldestId);
        }
    }
    
    /**
     * 加载 diff 内容
     *
     * 查找顺序：内存缓存 → 对话目录（索引定位）→ __global__（旧版数据兼容）。
     *
     * @param diffId Diff ID
     * @returns Diff 内容，如果不存在返回 null
     */
    public async loadGlobalDiff(diffId: string): Promise<DiffContent | null> {
        // 防御纵深：diffId 会拼入文件路径，拒绝穿越/绝对路径写法
        if (!isSafeId(diffId)) {
            console.warn(`[DiffStorageManager] Rejected unsafe diff id: ${diffId}`);
            return null;
        }
        const cached = this.globalDiffCache.get(diffId);
        if (cached) {
            // Map 重新插入保持最近访问项在尾部，容量淘汰按 LRU 近似执行。
            this.globalDiffCache.delete(diffId);
            this.globalDiffCache.set(diffId, cached);
            // 命中缓存返回深拷贝：直接返回原始引用会让调用方修改污染缓存
            //（与未命中路径每次解析出新对象同一语义）。
            return JSON.parse(JSON.stringify(cached.content)) as DiffContent;
        }

        // 1) 索引定位对话目录
        const index = await this.loadDiffIndex();
        const owner = index.get(diffId);
        if (owner) {
            const filePath = this.getDiffFilePath(owner, diffId);
            const content = await this.readDiffFile(filePath);
            if (content) return content;
            // 索引有、文件无：写文件前崩溃/文件被外部删除的残留——自愈删除该条目，
            // 避免幽灵索引无限滞留（并让 __global__ 兜底有机会命中旧版数据）。
            // 自愈的索引写失败不阻塞本次读取（预览仍可经 __global__ 兜底）。
            // 仅当文件确定不存在（ENOENT）时自愈，瞬时读错误不删索引。
            if (await this.isFileMissing(filePath)) {
                index.delete(diffId);
                try {
                    await this.persistDiffIndex();
                } catch (error) {
                    log.warn('global_diff_index_selfheal_failed', {
                        diffId,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
        }

        // 2) 回退 __global__（旧版数据 / 未绑定对话的 diff）
        const filePath = path.join(this.basePath, 'diffs', '__global__', `${diffId}.json`);
        return await this.readDiffFile(filePath);
    }
    
    /**
     * 加载对话级 diff 内容
     * 
     * @param conversationId 对话 ID
     * @param diffId Diff ID
     * @returns Diff 内容，如果不存在返回 null
     */
    public async loadDiffContent(
        conversationId: string,
        diffId: string
    ): Promise<DiffContent | null> {
        const filePath = this.getDiffFilePath(conversationId, diffId);
        return await this.readDiffFile(filePath);
    }
    
    /**
     * 删除单个 diff 内容
     * 
     * @param conversationId 对话 ID
     * @param diffId Diff ID
     */
    public async deleteDiffContent(
        conversationId: string,
        diffId: string
    ): Promise<boolean> {
        const filePath = this.getDiffFilePath(conversationId, diffId);
        
        try {
            await fs.promises.unlink(filePath);
            log.debug('diff_deleted', { diffId });
            return true;
        } catch (error) {
            return false;
        }
    }
    
    /**
     * 删除对话的所有 diff 内容
     * 
     * @param conversationId 对话 ID
     */
    public async deleteConversationDiffs(conversationId: string): Promise<void> {
        const diffsDir = this.getDiffsDir(conversationId);
        
        try {
            // 先收集该对话的 diff ID（随后索引会清空，需先记住）
            const index = await this.loadDiffIndex();
            const ownedIds = new Set<string>();
            for (const [diffId, owner] of index) {
                if (owner === conversationId) ownedIds.add(diffId);
            }
            // 标记墓碑：对话 ID 永不复用，拦截 deferred 落盘复活目录
            this.deletedConversationTombstones.add(conversationId);
            // 递归删除目录
            await fs.promises.rm(diffsDir, { recursive: true, force: true });
            // 清理索引条目与内存缓存，避免幽灵引用
            await this.forgetConversationDiffs(conversationId);
            for (const id of ownedIds) {
                const cached = this.globalDiffCache.get(id);
                if (cached) {
                    this.globalDiffCacheBytes -= cached.bytes;
                    this.globalDiffCache.delete(id);
                }
            }
            log.debug('conversation_diffs_deleted', { conversationId });
        } catch (error) {
            // 目录可能不存在
        }
    }
    
    /**
     * 列出对话的所有 diff ID
     * 
     * @param conversationId 对话 ID
     * @returns Diff ID 列表
     */
    public async listDiffIds(conversationId: string): Promise<string[]> {
        const diffsDir = this.getDiffsDir(conversationId);
        
        try {
            const files = await fs.promises.readdir(diffsDir);
            return files
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace('.json', ''));
        } catch (error) {
            return [];
        }
    }
    
    /**
     * 获取存储统计信息
     * 
     * @param conversationId 对话 ID（可选，不提供则统计所有）
     */
    public async getStorageStats(conversationId?: string): Promise<{
        totalDiffs: number;
        totalSize: number;
        conversations: number;
    }> {
        const diffsBaseDir = path.join(this.basePath, 'diffs');
        
        let totalDiffs = 0;
        let totalSize = 0;
        let conversations = 0;
        
        try {
            if (conversationId) {
                // 统计单个对话
                const diffsDir = this.getDiffsDir(conversationId);
                const files = await fs.promises.readdir(diffsDir);
                totalDiffs = files.filter(f => f.endsWith('.json')).length;
                conversations = 1;
                
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        const stat = await fs.promises.stat(path.join(diffsDir, file));
                        totalSize += stat.size;
                    }
                }
            } else {
                // 统计所有对话
                try {
                    const convDirs = await fs.promises.readdir(diffsBaseDir);
                    
                    for (const convDir of convDirs) {
                        const convDirPath = path.join(diffsBaseDir, convDir);
                        const stat = await fs.promises.stat(convDirPath);
                        
                        if (stat.isDirectory()) {
                            // index.json 是索引文件不是会话；__global__ 是未绑定 diff 桶，
                            // 两者都不计入会话数（会话数 = 真实对话目录数）
                            if (convDir !== '__global__' && convDir !== 'index.json') {
                                conversations++;
                            }
                            const files = await fs.promises.readdir(convDirPath);
                            
                            for (const file of files) {
                                if (file.endsWith('.json')) {
                                    totalDiffs++;
                                    const fileStat = await fs.promises.stat(path.join(convDirPath, file));
                                    totalSize += fileStat.size;
                                }
                            }
                        }
                    }
                } catch {
                    // 目录不存在
                }
            }
        } catch (error) {
            // 忽略错误
        }
        
        return { totalDiffs, totalSize, conversations };
    }
    
    /**
     * 清理孤立的 diff 文件（对话已删除但 diff 文件还存在）
     * 
     * @param validConversationIds 有效的对话 ID 列表
     */
    public async cleanupOrphanedDiffs(validConversationIds: Set<string>): Promise<number> {
        const diffsBaseDir = path.join(this.basePath, 'diffs');
        let cleaned = 0;
        
        try {
            const convDirs = await fs.promises.readdir(diffsBaseDir);
            const index = await this.loadDiffIndex();
            let indexChanged = false;
            
            for (const convDir of convDirs) {
                // __global__ 是未绑定对话的 diff 目录（旧版数据），
                // 不按孤儿对话清理——防止历史 diff 被连带删除。
                if (convDir === '__global__' || convDir === 'index.json') {
                    continue;
                }
                if (!validConversationIds.has(convDir)) {
                    const convDirPath = path.join(diffsBaseDir, convDir);
                    await fs.promises.rm(convDirPath, { recursive: true, force: true });
                    // 标记墓碑：拦截在途 deferred 落盘把孤儿目录复活
                    this.deletedConversationTombstones.add(convDir);
                    // 同步清理索引条目
                    for (const [diffId, owner] of index) {
                        if (owner === convDir) {
                            index.delete(diffId);
                            indexChanged = true;
                        }
                    }
                    cleaned++;
                    log.debug('orphaned_diffs_cleaned', { conversationDir: convDir });
                }
            }
            if (indexChanged) await this.persistDiffIndex();
        } catch (error) {
            // 目录可能不存在
        }
        
        return cleaned;
    }
    
    /**
     * 迁移 diff 数据到新路径
     * 
     * @param newBasePath 新的基础路径
     * @param progressCallback 进度回调
     */
    public async migrateTo(
        newBasePath: string,
        progressCallback?: (status: { phase: string; progress: number }) => void
    ): Promise<void> {
        const oldDiffsDir = path.join(this.basePath, 'diffs');
        const newDiffsDir = path.join(newBasePath, 'diffs');

        // 1. 旧目录存在性检查：仅 ENOENT（旧目录不存在 = 无数据可迁移）时静默切换 basePath；
        //    其它错误（权限等）原样抛出且不切换，避免把“复制失败”误当成“无需迁移”。
        try {
            await fs.promises.access(oldDiffsDir);
            
            // 创建新目录
            await fs.promises.mkdir(newDiffsDir, { recursive: true });
            
            // 复制所有 diff 数据（含 index.json；index.json 作为文件被 else 分支复制）
            const convDirs = await fs.promises.readdir(oldDiffsDir);
            const total = convDirs.length;
            let processed = 0;
            
            for (const convDir of convDirs) {
                const oldConvDir = path.join(oldDiffsDir, convDir);
                const newConvDir = path.join(newDiffsDir, convDir);
                
                const stat = await fs.promises.stat(oldConvDir);
                if (stat.isDirectory()) {
                    await fs.promises.mkdir(newConvDir, { recursive: true });
                    
                    const files = await fs.promises.readdir(oldConvDir);
                    for (const file of files) {
                        await fs.promises.copyFile(
                            path.join(oldConvDir, file),
                            path.join(newConvDir, file)
                        );
                    }
                } else {
                    // index.json 等文件直接复制
                    await fs.promises.copyFile(oldConvDir, newConvDir);
                }
                
                processed++;
                progressCallback?.({
                    phase: 'migrating_diffs',
                    progress: processed / total
                });
            }
            
            // 更新基础路径并重置索引缓存（新路径下的索引由新 basePath 懒加载）
            this.basePath = newBasePath;
            this.diffIndex = null;
            
            log.info('diffs_migrated', { processed, newBasePath });
        } catch (error) {
            // 仅「旧目录不存在」（ENOENT）是正常情况：无数据可迁移，直接换路径
            if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                this.basePath = newBasePath;
                return;
            }
            // 迁移过程其他异常：保留旧 basePath 并记录日志，绝不静默切换路径丢数据
            log.error('diffs_migrate_failed', { error: error instanceof Error ? error.message : String(error) });
            throw error;
        }

        // 2. 创建新目录
        await fs.promises.mkdir(newDiffsDir, { recursive: true });

        // 3. 全量复制：任何一步失败都向上抛且不切换 basePath（线上仍指向旧路径，数据完好）
        const convDirs = await fs.promises.readdir(oldDiffsDir);
        const total = convDirs.length;
        let processed = 0;

        for (const convDir of convDirs) {
            const oldConvDir = path.join(oldDiffsDir, convDir);
            const newConvDir = path.join(newDiffsDir, convDir);

            const stat = await fs.promises.stat(oldConvDir);
            if (stat.isDirectory()) {
                await fs.promises.mkdir(newConvDir, { recursive: true });

                const files = await fs.promises.readdir(oldConvDir);
                for (const file of files) {
                    await fs.promises.copyFile(
                        path.join(oldConvDir, file),
                        path.join(newConvDir, file)
                    );
                }
            }

            processed++;
            progressCallback?.({
                phase: 'migrating_diffs',
                progress: processed / total
            });
        }

        // 4. 全量复制成功后切换
        this.basePath = newBasePath;
        log.info('diffs_migrated', { processed, newBasePath });
    }
}

/**
 * 获取 DiffStorageManager 实例
 */
export function getDiffStorageManager(): DiffStorageManager | null {
    return DiffStorageManager.getInstance();
}
