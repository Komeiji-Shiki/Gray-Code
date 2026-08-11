/**
 * GrayCode - 固定文件（Pinned Files）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责固定文件配置段。
 * SettingsManager 聚合委托本服务。
 */

import type { PinnedFilesConfig, PinnedFileItem } from './types';
import { DEFAULT_PINNED_FILES_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * 固定文件配置服务
 *
 * 对应原 SettingsManager 的「固定文件配置管理」段。
 */
export class PinnedFilesSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取固定文件配置
     */
    getPinnedFilesConfig(): Readonly<PinnedFilesConfig> {
        return this.core.getToolsConfigEntry('pinned_files', DEFAULT_PINNED_FILES_CONFIG);
    }

    /**
     * 更新固定文件配置
     */
    async updatePinnedFilesConfig(config: Partial<PinnedFilesConfig>): Promise<void> {
        // 读-改-写整体入队串行：oldConfig 读取与 newConfig 构造必须在 mutator 内，
        // 否则并发 update 基于队列外旧快照构造的 newConfig 会覆盖前一个变更（静默丢更新）；
        // 本方法亦被 addPinnedFile/clearPinnedFiles 等已入队方法在 mutator 内调用，
        // serializeMutation 重入保护（内联执行）保证不产生嵌套死锁
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getPinnedFilesConfig();
            await this.core.saveToolsConfigEntry('pinned_files', oldConfig, { ...oldConfig, ...config });
        });
    }

    /**
     * 获取固定文件列表
     */
    getPinnedFiles(): PinnedFileItem[] {
        return this.getPinnedFilesConfig().files || [];
    }

    /**
     * 获取启用的固定文件列表
     */
    getEnabledPinnedFiles(): PinnedFileItem[] {
        return this.getPinnedFiles().filter(file => file.enabled);
    }

    /**
     * 添加固定文件
     * @param path 文件路径（相对于工作区）
     * @param workspaceUri 工作区 URI
     * @returns 新添加的文件项
     */
    async addPinnedFile(path: string, workspaceUri: string): Promise<PinnedFileItem> {
        // 读-改-写整体入队串行：并发添加基于同一旧列表写回时后写会覆盖先写
        return this.core.serializeMutation(async () => {
            const files = [...this.getPinnedFiles()];
            
            // 检查是否已存在（同一工作区同一路径）
            if (files.some(f => f.path === path && f.workspaceUri === workspaceUri)) {
                throw new Error(`File already pinned: ${path}`);
            }
            
            const newFile: PinnedFileItem = {
                id: `pinned_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                path,
                workspaceUri,
                enabled: true,
                addedAt: Date.now()
            };
            
            files.push(newFile);
            await this.updatePinnedFilesConfig({ files });
            
            return newFile;
        });
    }

    /**
     * 获取当前工作区的固定文件列表
     * @param workspaceUri 当前工作区 URI
     */
    getPinnedFilesForWorkspace(workspaceUri: string): PinnedFileItem[] {
        return this.getPinnedFiles().filter(f => f.workspaceUri === workspaceUri);
    }

    /**
     * 获取当前工作区启用的固定文件列表
     * @param workspaceUri 当前工作区 URI
     */
    getEnabledPinnedFilesForWorkspace(workspaceUri: string): PinnedFileItem[] {
        return this.getPinnedFilesForWorkspace(workspaceUri).filter(f => f.enabled);
    }

    /**
     * 移除固定文件
     * @param id 文件 ID
     */
    async removePinnedFile(id: string): Promise<void> {
        await this.core.serializeMutation(async () => {
            const files = this.getPinnedFiles().filter(f => f.id !== id);
            await this.updatePinnedFilesConfig({ files });
        });
    }

    /**
     * 切换固定文件的启用状态
     * @param id 文件 ID
     * @param enabled 是否启用
     */
    async setPinnedFileEnabled(id: string, enabled: boolean): Promise<void> {
        await this.core.serializeMutation(async () => {
            const files = this.getPinnedFiles().map(f =>
                f.id === id ? { ...f, enabled } : f
            );
            await this.updatePinnedFilesConfig({ files });
        });
    }

    /**
     * 更新固定文件路径
     * @param id 文件 ID
     * @param newPath 新路径
     */
    async updatePinnedFilePath(id: string, newPath: string): Promise<void> {
        await this.core.serializeMutation(async () => {
            const files = this.getPinnedFiles().map(f =>
                f.id === id ? { ...f, path: newPath } : f
            );
            await this.updatePinnedFilesConfig({ files });
        });
    }

    /**
     * 清空所有固定文件
     */
    async clearPinnedFiles(): Promise<void> {
        await this.core.serializeMutation(async () => {
            await this.updatePinnedFilesConfig({ files: [] });
        });
    }

    /**
     * 检查文件是否已固定
     * @param path 文件路径
     * @param workspaceUri 工作区 URI（可选；提供时与 addPinnedFile 的判重口径一致，
     *                     同时比较路径与工作区，避免跨工作区同名路径误判为已固定）
     */
    isFilePinned(path: string, workspaceUri?: string): boolean {
        return this.getPinnedFiles().some(f =>
            f.path === path && (workspaceUri === undefined || f.workspaceUri === workspaceUri)
        );
    }

    /**
     * 获取固定文件段落标题
     */
    getPinnedFilesSectionTitle(): string {
        return this.getPinnedFilesConfig().sectionTitle || 'PINNED FILES CONTENT';
    }
}
