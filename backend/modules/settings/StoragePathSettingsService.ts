/**
 * GrayCode - 存储路径（Storage Path）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责存储路径配置段与数据迁移标记。
 * SettingsManager 聚合委托本服务。
 */

import type { StoragePathConfig } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * 存储路径配置服务
 *
 * 对应原 SettingsManager 的「存储路径管理」段。
 */
export class StoragePathSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取存储路径配置
     */
    getStoragePathConfig(): Readonly<StoragePathConfig> {
        // 深拷贝返回：直接返回活引用会让调用方原地修改污染未保存的设置状态
        return this.core.settings.storagePath ? this.core.cloneConfig(this.core.settings.storagePath) : {};
    }

    /**
     * 获取自定义数据存储路径
     * 如果未设置返回 undefined
     */
    getCustomDataPath(): string | undefined {
        return this.core.settings.storagePath?.customDataPath;
    }

    /**
     * 更新存储路径配置
     */
    async updateStoragePathConfig(config: Partial<StoragePathConfig>): Promise<void> {
        const oldConfig = this.getStoragePathConfig();
        const newConfig = {
            ...oldConfig,
            ...config
        };
        
        this.core.settings.storagePath = newConfig;
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'storagePath',
            path: 'storagePath',
            oldValue: oldConfig,
            newValue: newConfig,
            settings: this.core.settings
        });
    }

    /**
     * 设置自定义数据存储路径
     * 设置后需要迁移数据
     */
    async setCustomDataPath(path: string | undefined): Promise<void> {
        await this.updateStoragePathConfig({
            customDataPath: path,
            migrationStatus: path ? 'pending' : 'none'
        });
    }

    /**
     * 标记迁移开始
     */
    async markMigrationStarted(): Promise<void> {
        await this.updateStoragePathConfig({
            migrationStatus: 'in_progress'
        });
    }

    /**
     * 标记迁移完成
     */
    async markMigrationCompleted(): Promise<void> {
        await this.updateStoragePathConfig({
            migrationStatus: 'completed',
            lastMigrationAt: Date.now(),
            migrationError: undefined
        });
    }

    /**
     * 标记迁移失败
     */
    async markMigrationFailed(error: string): Promise<void> {
        await this.updateStoragePathConfig({
            migrationStatus: 'failed',
            migrationError: error
        });
    }
}
