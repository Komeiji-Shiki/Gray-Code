/**
 * GrayCode - 代理（Proxy）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责代理设置段。
 * SettingsManager 聚合委托本服务。
 */

import type { ProxySettings } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * 代理设置服务
 *
 * 对应原 SettingsManager 的「代理设置管理」段。
 */
export class ProxySettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取代理设置
     */
    getProxySettings(): Readonly<ProxySettings> {
        return this.core.settings.proxy || { enabled: false };
    }

    /**
     * 获取有效的代理 URL
     *
     * 仅当代理启用且 URL 有效时返回代理地址
     * @returns 代理 URL 或 undefined
     */
    getEffectiveProxyUrl(): string | undefined {
        const proxy = this.core.settings.proxy;
        if (proxy?.enabled && proxy.url && proxy.url.trim()) {
            return proxy.url.trim();
        }
        return undefined;
    }

    /**
     * 更新代理设置
     */
    async updateProxySettings(proxySettings: Partial<ProxySettings>): Promise<void> {
        const oldValue = this.core.settings.proxy;
        this.core.settings.proxy = {
            // 不再强制默认 enabled:true（首次只设置 URL 会隐式启用代理）。
            // 展开顺序保证：proxySettings.enabled ?? 原值 ?? false。
            enabled: false,
            ...this.core.settings.proxy,
            ...proxySettings
        } as ProxySettings;
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'proxy',
            path: 'proxy',
            oldValue,
            newValue: this.core.settings.proxy,
            settings: this.core.settings
        });
    }

    /**
     * 设置代理启用状态
     */
    async setProxyEnabled(enabled: boolean): Promise<void> {
        await this.updateProxySettings({ enabled });
    }

    /**
     * 设置代理 URL
     */
    async setProxyUrl(url: string | undefined): Promise<void> {
        await this.updateProxySettings({ url });
    }
}
