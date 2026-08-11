/**
 * GrayCode - UI 设置与公告版本服务
 *
 * 从 SettingsManager.ts 拆分而来：负责 UI 设置段与公告版本段。
 * SettingsManager 聚合委托本服务。
 */

import type { GlobalSettings } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * UI 设置服务
 *
 * 对应原 SettingsManager 的「UI 设置管理 / 公告版本管理」段。
 */
export class UISettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    // ========== UI 设置管理 ==========

    /**
     * 获取 UI 设置
     */
    getUISettings() {
        // 深拷贝返回：直接返回活引用会让调用方原地修改污染未保存的设置状态
        return this.core.settings.ui ? this.core.cloneConfig(this.core.settings.ui) : {};
    }

    /**
     * 更新 UI 设置
     */
    async updateUISettings(uiSettings: Partial<NonNullable<GlobalSettings['ui']>>): Promise<void> {
        // 读-改-写-通知整体入队串行（与 SettingsCore 写队列共用）：并发调用基于同一
        // 旧 ui 快照合并后整体写回时后写覆盖先写；oldValue 读取必须在 mutator 内
        await this.core.serializeMutation(async () => {
            const oldValue = this.core.settings.ui;
            // 深合并：避免仅更新 ui.sound.cues 等子字段时覆盖整个对象
            const currentUI = (this.core.settings.ui || {}) as NonNullable<GlobalSettings['ui']>;
            this.core.settings.ui = this.core.deepMergeConfig(currentUI, uiSettings) as NonNullable<GlobalSettings['ui']>;
            this.core.settings.lastUpdated = Date.now();
            
            await this.core.storage.save(this.core.settings);
            
            this.core.notifyChange({
                type: 'ui',
                path: 'ui',
                oldValue,
                newValue: this.core.settings.ui,
                settings: this.core.cloneConfig(this.core.settings)
            });
        });
    }

    // ========== 公告版本管理 ==========

    /**
     * 获取用户上次查看的公告版本
     */
    getLastReadAnnouncementVersion(): string | undefined {
        return this.core.settings.lastReadAnnouncementVersion;
    }

    /**
     * 设置用户上次查看的公告版本
     */
    async setLastReadAnnouncementVersion(version: string): Promise<void> {
        // 读-改-写-通知整体入队串行（同 updateUISettings）
        await this.core.serializeMutation(async () => {
            const oldValue = this.core.settings.lastReadAnnouncementVersion;
            this.core.settings.lastReadAnnouncementVersion = version;
            this.core.settings.lastUpdated = Date.now();
            
            await this.core.storage.save(this.core.settings);
            
            this.core.notifyChange({
                type: 'full',
                path: 'lastReadAnnouncementVersion',
                oldValue: oldValue,
                newValue: version,
                settings: this.core.cloneConfig(this.core.settings)
            });
        });
    }
}
