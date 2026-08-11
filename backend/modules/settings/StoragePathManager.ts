/**
 * GrayCode - 存储路径管理器
 *
 * 负责管理自定义数据存储路径和数据迁移
 * 支持将大文件（对话历史、检查点、依赖等）存储到用户自定义目录
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import type { SettingsManager } from './SettingsManager';
import type { StorageStats } from './types';

/**
 * 存储路径管理器
 */
// 记忆目录随自定义存储路径一起迁移/清理/统计：memory 为全局记忆，memory-workspaces 下每个 <hash>/ 子目录对应一个工作区记忆
const STORAGE_SUBDIRS = ['conversations', 'snapshots', 'checkpoints', 'mcp', 'dependencies', 'diffs', 'skills', 'activity', 'tokenizers', 'memory', 'memory-workspaces'];

export class StoragePathManager {
    private defaultDataPath: string;
    private migrationInProgress = false;
    
    constructor(
        private settingsManager: SettingsManager,
        private context: vscode.ExtensionContext
    ) {
        // 默认路径是 globalStorageUri
        this.defaultDataPath = context.globalStorageUri.fsPath;
    }
    
    /**
     * 获取有效的数据存储路径
     * 如果配置了自定义路径且该路径当前有效（迁移完成，或失败后已回滚到原路径），返回自定义路径
     * 否则返回默认路径
     */
    getEffectiveDataPath(): string {
        const config = this.settingsManager.getStoragePathConfig();
        
        // 迁移失败路径会把 customDataPath 回写为迁移前的原值；该目录仍是有效数据源。
        // 若原来使用默认目录，customDataPath 为空，仍自然回退默认路径。
        if (config.customDataPath && (config.migrationStatus === 'completed' || config.migrationStatus === 'failed')) {
            return config.customDataPath;
        }
        
        return this.defaultDataPath;
    }
    
    /**
     * 获取默认数据存储路径
     */
    getDefaultDataPath(): string {
        return this.defaultDataPath;
    }
    
    /**
     * 获取对话历史存储目录
     */
    getConversationsPath(): string {
        return path.join(this.getEffectiveDataPath(), 'conversations');
    }
    
    /**
     * 获取检查点存储目录
     */
    getCheckpointsPath(): string {
        return path.join(this.getEffectiveDataPath(), 'checkpoints');
    }
    
    /**
     * 获取 MCP 配置存储目录
     */
    getMcpPath(): string {
        return path.join(this.getEffectiveDataPath(), 'mcp');
    }
    
    /**
     * 获取依赖存储目录
     */
    getDependenciesPath(): string {
        return path.join(this.getEffectiveDataPath(), 'dependencies');
    }
    
    /**
     * 获取存储目录的 URI（用于 FileSystemStorageAdapter）
     */
    getEffectiveDataUri(): string {
        return vscode.Uri.file(this.getEffectiveDataPath()).toString();
    }
    
    /**
     * 获取 Diff 存储目录
     */
    getDiffsPath(): string {
        return path.join(this.getEffectiveDataPath(), 'diffs');
    }
    
    /**
     * 获取活动统计存储目录
     */
    getActivityPath(): string {
        return path.join(this.getEffectiveDataPath(), 'activity');
    }
    
    /**
     * 获取 tokenizer 词表缓存目录（运行时下载的词表，见 modules/tokenizer）
     */
    getTokenizerPath(): string {
        return path.join(this.getEffectiveDataPath(), 'tokenizers');
    }
    
    /**
     * 确保所有存储目录存在
     * 注意：settings 目录只在默认路径创建，不在自定义路径创建
     */
    async ensureDirectories(): Promise<void> {
        const basePath = this.getEffectiveDataPath();
        const dirs = [
            basePath,
            path.join(basePath, 'conversations'),
            path.join(basePath, 'snapshots'),
            path.join(basePath, 'checkpoints'),
            path.join(basePath, 'mcp'),
            path.join(basePath, 'dependencies'),
            path.join(basePath, 'diffs'),
            // skills 目录参与迁移/统计（STORAGE_SUBDIRS / getStorageStats），此处补齐创建
            path.join(basePath, 'skills'),
            path.join(basePath, 'activity'),
            path.join(basePath, 'tokenizers'),
            // 记忆目录：全局记忆 memory/，工作区记忆 memory-workspaces/（各 <hash>/ 子目录惰性创建）
            path.join(basePath, 'memory'),
            path.join(basePath, 'memory-workspaces')
        ];
        
        // settings 目录只在默认路径创建
        if (basePath === this.defaultDataPath) {
            dirs.push(path.join(basePath, 'settings'));
        }
        
        // 并行创建：12 个目录串行 await 在慢盘（HDD/冷缓存）上可达数百 ms，
        // 且每次 await 之间还有事件循环调度成本；mkdir recursive 本身幂等，
        // 并行无副作用，冷启动路径收益明显。
        await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
    }
    
    /**
     * 验证路径是否可用（可写入）
     */
    async validatePath(targetPath: string): Promise<{ valid: boolean; error?: string }> {
        try {
            let existingPath = targetPath;
            let exists = true;

            try {
                await fs.access(targetPath);
            } catch {
                exists = false;
                while (true) {
                    const parent = path.dirname(existingPath);
                    if (parent === existingPath) {
                        throw new Error('No writable parent directory found');
                    }
                    existingPath = parent;
                    try {
                        await fs.access(existingPath);
                        break;
                    } catch {
                        // 继续查找最近的已有父目录。
                    }
                }
            }

            // 已有存储数据的无关目录不接受重复迁移；与当前路径重叠的目标由迁移中转流程处理。
            if (exists && !(await this.pathsOverlap(this.getEffectiveDataPath(), targetPath))) {
                const entries = await fs.readdir(targetPath);
                if (entries.some((entry) => STORAGE_SUBDIRS.includes(entry))) {
                    return { valid: false, error: '目标目录已包含扩展数据（conversations/checkpoints 等），请选择其他目录' };
                }
            }

            const testDir = await fs.mkdtemp(path.join(existingPath, '.limcode-test-'));
            await fs.rmdir(testDir);

            return { valid: true };
        } catch (error: any) {
            return {
                valid: false,
                error: error.message || 'Path is not writable'
            };
        }
    }
    
    /**
     * 计算目录大小
     */
    private async getDirectorySize(dirPath: string): Promise<{ size: number; count: number }> {
        let totalSize = 0;
        let fileCount = 0;
        
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                    const subResult = await this.getDirectorySize(fullPath);
                    totalSize += subResult.size;
                    fileCount += subResult.count;
                } else if (entry.isFile()) {
                    try {
                        const stat = await fs.stat(fullPath);
                        totalSize += stat.size;
                        fileCount++;
                    } catch {
                        // 忽略无法访问的文件
                    }
                }
            }
        } catch {
            // 目录不存在或无法访问
        }
        
        return { size: totalSize, count: fileCount };
    }
    
    /**
     * 获取存储统计信息
     */
    async getStorageStats(targetPath?: string): Promise<StorageStats> {
        const basePath = targetPath || this.getEffectiveDataPath();
        
        const [conversations, checkpoints, snapshots, mcp, dependencies, diffs, skills, activity, tokenizers, memory, memoryWorkspaces] = await Promise.all([
            this.getDirectorySize(path.join(basePath, 'conversations')),
            this.getDirectorySize(path.join(basePath, 'checkpoints')),
            this.getDirectorySize(path.join(basePath, 'snapshots')),
            this.getDirectorySize(path.join(basePath, 'mcp')),
            this.getDirectorySize(path.join(basePath, 'dependencies')),
            this.getDirectorySize(path.join(basePath, 'diffs')),
            this.getDirectorySize(path.join(basePath, 'skills')),
            this.getDirectorySize(path.join(basePath, 'activity')),
            this.getDirectorySize(path.join(basePath, 'tokenizers')),
            // 记忆目录纳入统计：全局记忆与工作区记忆（含各 <hash>/ 子目录）
            this.getDirectorySize(path.join(basePath, 'memory')),
            this.getDirectorySize(path.join(basePath, 'memory-workspaces'))
        ]);

        const allStats = [conversations, checkpoints, snapshots, mcp, dependencies, diffs, skills, activity, tokenizers, memory, memoryWorkspaces];
        const totalSize = allStats.reduce((sum, stat) => sum + stat.size, 0);
        const fileCount = allStats.reduce((sum, stat) => sum + stat.count, 0);
        
        return {
            path: basePath,
            totalSize,
            fileCount,
            subDirs: {
                conversations: conversations,
                checkpoints: checkpoints,
                snapshots: snapshots,
                mcp: mcp,
                dependencies: dependencies,
                diffs: diffs,
                skills: skills,
                activity: activity,
                tokenizers: tokenizers,
                memory: memory,
                memoryWorkspaces: memoryWorkspaces
            }
        };
    }
    
    /**
     * 复制目录（递归）
     */
    private async copyDirectory(
        src: string,
        dest: string,
        onProgress?: (copied: number, total: number) => void,
        visited: Set<string> = new Set()
    ): Promise<number> {
        if (await this.isPathInside(src, dest)) {
            throw new Error('Cannot copy a directory into its own subdirectory');
        }

        // 符号链接循环防护：fs.stat 跟随符号链接后按真实类型复制，若符号链接指向祖先目录
        // （循环引用），递归会无限展开直到栈溢出、迁移中断。以真实路径为链去重：每个子目录
        // 只携带自己的祖先链（兄弟目录互不可见），指向祖先的循环随即被截断，而同一真实目录
        // 经多个符号链接复制时仍各自复制，不丢数据。
        let srcRealPath = src;
        try {
            srcRealPath = await fs.realpath(src);
        } catch {
            // realpath 失败（目录刚被删除等竞态）：退化为未解析路径，交由后续 readdir 处理
        }
        if (visited.has(srcRealPath)) {
            console.warn(`[StoragePathManager] Skipping symlink loop: ${src}`);
            return 0;
        }
        const childVisited = new Set(visited);
        childVisited.add(srcRealPath);

        let copiedCount = 0;
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(src, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);

            // 符号链接的 isDirectory()/isFile() 恒为 false，会被旧逻辑静默跳过，
            // 迁移丢失符号链接数据。用 fs.stat（跟随链接）判断真实类型后按目标复制。
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (!isDir && !isFile) {
                try {
                    const stat = await fs.stat(srcPath);
                    isDir = stat.isDirectory();
                    isFile = stat.isFile();
                } catch {
                    // 悬空符号链接等无法 stat：跳过并告警，不静默丢失
                    console.warn(`[StoragePathManager] Skipping unreadable entry during copy: ${srcPath}`);
                    continue;
                }
            }

            if (isDir) {
                copiedCount += await this.copyDirectory(srcPath, destPath, onProgress, childVisited);
            } else if (isFile) {
                await fs.copyFile(srcPath, destPath);
                copiedCount++;
                onProgress?.(copiedCount, -1);
            } else {
                // 其它特殊文件类型（socket/fifo 等）无法复制：跳过并告警
                console.warn(`[StoragePathManager] Skipping special file during copy: ${srcPath}`);
            }
        }

        return copiedCount;
    }
    
    private async resolvePathForComparison(targetPath: string): Promise<string> {
        try {
            return await fs.realpath(targetPath);
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }

            const parent = path.dirname(targetPath);
            if (parent === targetPath) {
                return path.normalize(targetPath);
            }

            return path.join(await this.resolvePathForComparison(parent), path.basename(targetPath));
        }
    }

    private async isPathInside(parentPath: string, childPath: string): Promise<boolean> {
        const parent = await this.resolvePathForComparison(parentPath);
        const child = await this.resolvePathForComparison(childPath);
        const relative = path.relative(parent, child);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    private async pathsOverlap(first: string, second: string): Promise<boolean> {
        const firstResolved = await this.resolvePathForComparison(first);
        const secondResolved = await this.resolvePathForComparison(second);
        const relative = path.relative(firstResolved, secondResolved);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
            return true;
        }

        const reverse = path.relative(secondResolved, firstResolved);
        return !reverse.startsWith('..') && !path.isAbsolute(reverse);
    }

    private async copyStorageData(
        sourcePath: string,
        targetPath: string,
        copiedFiles: number,
        totalFiles: number,
        phase: 'Copying' | 'Restoring',
        onProgress?: (status: { phase: string; current: number; total: number }) => void
    ): Promise<number> {
        let totalCopied = copiedFiles;

        for (const subDir of STORAGE_SUBDIRS) {
            const srcDir = path.join(sourcePath, subDir);
            const destDir = path.join(targetPath, subDir);

            onProgress?.({ phase: `${phase} ${subDir}...`, current: totalCopied, total: totalFiles });

            try {
                await fs.access(srcDir);
            } catch (error: any) {
                if (error?.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }

            const copiedBefore = totalCopied;
            totalCopied += await this.copyDirectory(srcDir, destDir, (copied) => {
                onProgress?.({
                    phase: `${phase} ${subDir}...`,
                    current: copiedBefore + copied,
                    total: totalFiles
                });
            });
        }

        return totalCopied;
    }

    private async removeStorageData(storagePath: string, preservedSubDirs: string[] = []): Promise<void> {
        for (const subDir of STORAGE_SUBDIRS) {
            // 目标路径位于源路径内部（迁移到源路径的子目录）时，包含目标路径的源子目录
            // 必须保留，否则清理源数据会连带删除刚迁移到目标路径的数据
            if (preservedSubDirs.includes(subDir)) {
                continue;
            }
            // skills 目录始终保留：SkillsManager/SettingsExporter 在启动时以当时的
            // effectiveDataPath 固定扫描/写入路径，运行中迁移后仍指向旧路径——
            // 清理旧路径删除 skills 会让当前实例技能消失、新导入落点与新路径不一致
            if (subDir === 'skills') {
                continue;
            }
            await fs.rm(path.join(storagePath, subDir), { recursive: true, force: true });
        }
    }

    /**
     * 找出源路径中「包含目标路径」的存储子目录。
     * 目标位于源路径内部（staging 迁移）时，这些子目录在清理源数据时必须保留。
     */
    private async findPreservedSubDirs(storagePath: string, targetPath: string): Promise<string[]> {
        const preserved: string[] = [];
        for (const subDir of STORAGE_SUBDIRS) {
            if (await this.isPathInsideOrEqual(path.join(storagePath, subDir), targetPath)) {
                preserved.push(subDir);
            }
        }
        return preserved;
    }

    /**
     * childPath 是否等于或位于 parentPath 内部（解析符号链接后比较）
     */
    private async isPathInsideOrEqual(parentPath: string, childPath: string): Promise<boolean> {
        const parent = await this.resolvePathForComparison(parentPath);
        const child = await this.resolvePathForComparison(childPath);
        const relative = path.relative(parent, child);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    /**
     * 迁移数据到新路径
     *
     * @param newPath 新的存储路径
     * @param onProgress 进度回调
     * @returns 迁移结果
     */
    async migrateData(
        newPath: string,
        onProgress?: (status: { phase: string; current: number; total: number }) => void
    ): Promise<{ success: boolean; error?: string; copiedFiles: number }> {
        const sourcePath = this.getEffectiveDataPath();
        const originalConfig = { ...this.settingsManager.getStoragePathConfig() };

        if (path.normalize(sourcePath) === path.normalize(newPath)) {
            return { success: true, copiedFiles: 0 };
        }

        if (this.migrationInProgress) {
            return { success: false, error: 'A storage migration is already in progress', copiedFiles: 0 };
        }

        this.migrationInProgress = true;
        let stagingRoot: string | undefined;
        let sourceMutationStarted = false;
        let preserveStaging = false;
        let preservedSubDirs: string[] = [];

        try {
            const validation = await this.validatePath(newPath);
            if (!validation.valid) {
                return { success: false, error: validation.error, copiedFiles: 0 };
            }

            await this.settingsManager.markMigrationStarted();

            const stats = await this.getStorageStats(sourcePath);
            const totalFiles = stats.fileCount;
            const destinationPath = await this.resolvePathForComparison(newPath);
            const requiresStaging = await this.pathsOverlap(sourcePath, destinationPath);
            let copiedFiles = 0;

            if (requiresStaging) {
                // 目标在源路径内部（如迁移到默认路径下的子目录）时，清理源数据不能删除
                // 包含目标路径的源子目录，否则会连带删除刚迁移到目标路径的数据
                preservedSubDirs = await this.findPreservedSubDirs(sourcePath, destinationPath);
                stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-storage-'));
                copiedFiles = await this.copyStorageData(sourcePath, stagingRoot, 0, totalFiles, 'Copying', onProgress);
                await this.copyStorageData(stagingRoot, destinationPath, 0, totalFiles, 'Copying', onProgress);
            } else {
                copiedFiles = await this.copyStorageData(sourcePath, destinationPath, 0, totalFiles, 'Copying', onProgress);
            }

            // 先持久化配置切换（指向新路径），再删除源数据：
            // 旧顺序在删除源数据后、配置落盘前崩溃，配置仍指向源路径而数据已被删，造成数据丢失
            await this.settingsManager.updateStoragePathConfig({
                customDataPath: newPath,
                migrationStatus: 'completed',
                lastMigrationAt: Date.now(),
                migrationError: undefined
            });

            if (requiresStaging) {
                sourceMutationStarted = true;
                await this.removeStorageData(sourcePath, preservedSubDirs);
            }

            onProgress?.({ phase: 'Cleaning up old storage...', current: copiedFiles, total: copiedFiles });

            if (!requiresStaging) {
                const cleanup = await this.cleanupOldStorageInternal(sourcePath);
                if (!cleanup.success) {
                    console.warn(`[StoragePathManager] Migration completed, but failed to clean ${sourcePath}`);
                }
            }

            onProgress?.({ phase: 'Migration completed', current: copiedFiles, total: copiedFiles });
            return { success: true, copiedFiles };
        } catch (error: any) {
            let errorMessage = error.message || 'Unknown error during migration';

            if (stagingRoot && sourceMutationStarted) {
                try {
                    await this.removeStorageData(sourcePath, preservedSubDirs);
                    await this.copyStorageData(stagingRoot, sourcePath, 0, 0, 'Restoring');
                } catch (rollbackError) {
                    preserveStaging = true;
                    errorMessage += `; recovery data kept at ${stagingRoot}`;
                    console.error('[StoragePathManager] Failed to restore storage after migration error:', rollbackError);
                }
            }

            // 恢复失败状态时 updateStoragePathConfig 再次失败会替换原始错误，且配置卡在
            // markMigrationStarted 写入的 'in_progress' 永远回退默认路径。
            // 这里保留 'failed' 终态并把恢复失败原因拼进原始错误。
            try {
                await this.settingsManager.updateStoragePathConfig({
                    customDataPath: originalConfig.customDataPath,
                    migrationStatus: 'failed',
                    lastMigrationAt: originalConfig.lastMigrationAt,
                    migrationError: errorMessage
                });
            } catch (configSaveError: any) {
                const reason = configSaveError?.message || String(configSaveError);
                errorMessage += `; failed to persist recovery status: ${reason}`;
                console.error('[StoragePathManager] Failed to persist migration failure status:', configSaveError);
            }
            return { success: false, error: errorMessage, copiedFiles: 0 };
        } finally {
            if (stagingRoot && !preserveStaging) {
                await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
            }
            this.migrationInProgress = false;
        }
    }
    
    /**
     * 内部清理方法（指定路径）
     * 注意：只清理数据目录，不清理 settings 目录
     */
    private async cleanupOldStorageInternal(oldPath: string): Promise<{ success: boolean; freedBytes: number }> {
        try {
            const stats = await this.getStorageStats(oldPath);
            
            // settings 仅保存在默认路径，不参与清理。
            await this.removeStorageData(oldPath);

            // skills 目录始终保留（removeStorageData 跳过它），其大小不计入实际释放量；
            // 目录不存在时 getDirectorySize 返回 0，不受影响。
            const preservedSkillsSize = stats.subDirs.skills.size;
            
            return { success: true, freedBytes: Math.max(0, stats.totalSize - preservedSkillsSize) };
        } catch (error) {
            console.error('[StoragePathManager] Failed to cleanup old storage:', error);
            return { success: false, freedBytes: 0 };
        }
    }
    
    /**
     * 清理旧的存储目录（手动调用）
     * 只删除数据子目录，保留设置目录
     */
    async cleanupOldStorage(): Promise<{ success: boolean; freedBytes: number }> {
        const config = this.settingsManager.getStoragePathConfig();
        
        // 只有迁移完成且有自定义路径时才清理默认路径
        if (config.migrationStatus !== 'completed' || !config.customDataPath) {
            return { success: false, freedBytes: 0 };
        }
        
        return await this.cleanupOldStorageInternal(this.defaultDataPath);
    }
    
    /**
     * 重置为默认存储路径
     * 会将数据迁移回默认路径，并清理自定义路径中的数据
     */
    async resetToDefault(onProgress?: (status: { phase: string; current: number; total: number }) => void): Promise<{ success: boolean; error?: string }> {
        const config = this.settingsManager.getStoragePathConfig();

        if (!config.customDataPath) {
            return { success: true };
        }

        if (this.migrationInProgress) {
            return { success: false, error: 'A storage migration is already in progress' };
        }

        this.migrationInProgress = true;
        const customPath = config.customDataPath;
        let stagingRoot: string | undefined;
        let sourceMutationStarted = false;
        let preserveStaging = false;
        let preservedSubDirs: string[] = [];

        try {
            const stats = await this.getStorageStats(customPath);
            const requiresStaging = await this.pathsOverlap(customPath, this.defaultDataPath);
            let copiedFiles = 0;

            if (requiresStaging) {
                // 默认路径位于自定义路径内部时同理：清理自定义路径数据时保留包含默认路径的子目录
                preservedSubDirs = await this.findPreservedSubDirs(customPath, this.defaultDataPath);
                stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-storage-'));
                copiedFiles = await this.copyStorageData(customPath, stagingRoot, 0, stats.fileCount, 'Restoring', onProgress);
                await this.copyStorageData(stagingRoot, this.defaultDataPath, 0, stats.fileCount, 'Restoring', onProgress);
            } else {
                copiedFiles = await this.copyStorageData(customPath, this.defaultDataPath, 0, stats.fileCount, 'Restoring', onProgress);
            }

            // 先持久化配置（回退到默认路径），再删除源数据：
            // 与 migrateData 修复一致——旧顺序在删除源数据后、配置落盘前崩溃，
            // 配置仍指向自定义路径而数据已被删，造成数据丢失
            await this.settingsManager.updateStoragePathConfig({
                customDataPath: undefined,
                migrationStatus: 'none',
                lastMigrationAt: undefined,
                migrationError: undefined
            });

            if (requiresStaging) {
                sourceMutationStarted = true;
                await this.removeStorageData(customPath, preservedSubDirs);
            }

            onProgress?.({ phase: 'Cleaning up custom storage...', current: copiedFiles, total: copiedFiles });

            if (!requiresStaging) {
                const cleanup = await this.cleanupOldStorageInternal(customPath);
                if (!cleanup.success) {
                    console.warn(`[StoragePathManager] Storage restored, but failed to clean ${customPath}`);
                }
            }

            return { success: true };
        } catch (error: any) {
            let errorMessage = error.message || 'Unknown error while restoring default storage';

            // 先恢复配置指向（customDataPath/migrationStatus 回写为 resetToDefault 前的原值），
            // 再执行数据回滚：与 migrateData 的 catch 一致——若配置切换已成功（customDataPath
            // 已清空）而后续清理失败，配置指向默认路径但默认路径数据被回滚删除，会造成数据丢失。
            // 先恢复配置保证任何时刻配置与数据指向一致。
            try {
                await this.settingsManager.updateStoragePathConfig({
                    customDataPath: config.customDataPath,
                    migrationStatus: config.migrationStatus,
                    lastMigrationAt: config.lastMigrationAt,
                    migrationError: config.migrationError
                });
            } catch (configSaveError: any) {
                const reason = configSaveError?.message || String(configSaveError);
                errorMessage += `; failed to persist recovery status: ${reason}`;
                console.error('[StoragePathManager] Failed to persist reset failure status:', configSaveError);
            }

            if (stagingRoot && sourceMutationStarted) {
                try {
                    // 回滚删除默认路径数据时保留「包含自定义路径」的子目录：
                    // 自定义路径位于默认路径内部时，误删会让刚恢复的自定义路径数据连带丢失
                    // （与 migrateData 的 preservedSubDirs 语义一致）
                    const rollbackPreservedSubDirs = await this.findPreservedSubDirs(this.defaultDataPath, customPath);
                    await this.removeStorageData(this.defaultDataPath, rollbackPreservedSubDirs);
                    await this.copyStorageData(stagingRoot, customPath, 0, 0, 'Restoring');
                } catch (rollbackError) {
                    preserveStaging = true;
                    errorMessage += `; recovery data kept at ${stagingRoot}`;
                    console.error('[StoragePathManager] Failed to restore custom storage after reset error:', rollbackError);
                }
            }

            return { success: false, error: errorMessage };
        } finally {
            if (stagingRoot && !preserveStaging) {
                await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
            }
            this.migrationInProgress = false;
        }
    }
}

