/**
 * Diff 内容存储管理器
 * 
 * 将 apply_diff 工具的 originalContent 和 newContent 抽离到单独文件存储
 * 避免对话历史 JSON 过大，只在需要查看差异时按需加载
 * 
 * 存储结构：
 * {dataPath}/diffs/{conversationId}/{diffId}.json
 * 
 * 每个 diff 文件内容：
 * {
 *   originalContent: string,
 *   newContent: string,
 *   filePath: string,
 *   createdAt: number
 * }
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../../core/logger';

const log = Logger.get('DiffStorageManager');
const MAX_GLOBAL_DIFF_CACHE_ENTRIES = 16;
const MAX_GLOBAL_DIFF_CACHE_BYTES = 32 * 1024 * 1024;

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
        return `diff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
        await fs.promises.writeFile(filePath, JSON.stringify(diffContent, null, 2), 'utf8');
        
        log.debug('diff_saved', { diffId: id, conversationId });
        
        return {
            diffId: id,
            filePath: content.filePath,
            hasDiffContent: true
        };
    }
    
    /**
     * 保存全局 diff 内容（不依赖 conversationId）
     * 用于 apply_diff 工具调用时保存
     *
     * @param content Diff 内容
     * @param diffId Diff ID（如果不提供则自动生成）
     * @returns Diff 引用
     */
    public async saveGlobalDiff(
        content: {
            originalContent: string;
            newContent: string;
            filePath: string;
        },
        diffId?: string
    ): Promise<DiffReference> {
        const id = diffId || this.generateDiffId();
        this.assertSafeDiffId(id);
        const diffContent = this.buildGlobalDiffContent(content);
        this.cacheGlobalDiff(id, diffContent);
        await this.persistGlobalDiff(id, diffContent);
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
        diffId?: string
    ): DiffReference {
        const id = diffId || this.generateDiffId();
        this.assertSafeDiffId(id);
        const diffContent = this.buildGlobalDiffContent(content);
        this.cacheGlobalDiff(id, diffContent);
        void this.persistGlobalDiff(id, diffContent).catch(error => {
            log.warn('global_diff_background_save_failed', {
                diffId: id,
                error: error instanceof Error ? error.message : String(error)
            });
        });
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

    private async persistGlobalDiff(id: string, content: DiffContent): Promise<void> {
        this.assertSafeDiffId(id);
        const diffsDir = path.join(this.basePath, 'diffs', '__global__');
        await this.ensureDir(diffsDir);
        await fs.promises.writeFile(path.join(diffsDir, `${id}.json`), JSON.stringify(content), 'utf8');
        log.debug('global_diff_saved', { diffId: id });
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
     * 加载全局 diff 内容
     *
     * @param diffId Diff ID
     * @returns Diff 内容，如果不存在返回 null
     */
    public async loadGlobalDiff(diffId: string): Promise<DiffContent | null> {
        this.assertSafeDiffId(diffId);
        const cached = this.globalDiffCache.get(diffId);
        if (cached) {
            // Map 重新插入保持最近访问项在尾部，容量淘汰按 LRU 近似执行。
            this.globalDiffCache.delete(diffId);
            this.globalDiffCache.set(diffId, cached);
            return cached.content;
        }

        const filePath = path.join(this.basePath, 'diffs', '__global__', `${diffId}.json`);
        
        try {
            const data = await fs.promises.readFile(filePath, 'utf8');
            return JSON.parse(data) as DiffContent;
        } catch (error) {
            console.warn(`[DiffStorageManager] Failed to load global diff ${diffId}: ${error}`);
            return null;
        }
    }
    
    /**
     * 加载 diff 内容
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
        
        try {
            const data = await fs.promises.readFile(filePath, 'utf8');
            return JSON.parse(data) as DiffContent;
        } catch (error) {
            console.warn(`[DiffStorageManager] Failed to load diff ${diffId}: ${error}`);
            return null;
        }
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
            // 递归删除目录
            await fs.promises.rm(diffsDir, { recursive: true, force: true });
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
                    conversations = convDirs.length;
                    
                    for (const convDir of convDirs) {
                        const convDirPath = path.join(diffsBaseDir, convDir);
                        const stat = await fs.promises.stat(convDirPath);
                        
                        if (stat.isDirectory()) {
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
            
            for (const convDir of convDirs) {
                // __global__ 是全局 diff 目录（非对话，saveGlobalDiff 写入），
                // 不能按孤儿对话清理——否则全局 diff 会被连带删除。
                if (convDir === '__global__') {
                    continue;
                }
                if (!validConversationIds.has(convDir)) {
                    const convDirPath = path.join(diffsBaseDir, convDir);
                    await fs.promises.rm(convDirPath, { recursive: true, force: true });
                    cleaned++;
                    log.debug('orphaned_diffs_cleaned', { conversationDir: convDir });
                }
            }
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
        
        try {
            // 检查旧目录是否存在
            await fs.promises.access(oldDiffsDir);
            
            // 创建新目录
            await fs.promises.mkdir(newDiffsDir, { recursive: true });
            
            // 复制所有 diff 数据
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
            
            // 更新基础路径
            this.basePath = newBasePath;
            
            log.info('diffs_migrated', { processed, newBasePath });
        } catch (error) {
            // 旧目录不存在，只需更新路径
            this.basePath = newBasePath;
        }
    }
}

/**
 * 获取 DiffStorageManager 实例
 */
export function getDiffStorageManager(): DiffStorageManager | null {
    return DiffStorageManager.getInstance();
}
