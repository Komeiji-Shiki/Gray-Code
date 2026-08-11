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
        // 深拷贝返回：直接返回活引用会让调用方原地修改污染未保存的设置状态
        return this.core.settings.proxy ? this.core.cloneConfig(this.core.settings.proxy) : { enabled: false };
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
     * 是否跳过 TLS 证书校验（仅用于自签名证书调试）
     *
     * 默认 false：校验证书；只有用户显式开启时才跳过。
     */
    getProxyInsecureSkipVerify(): boolean {
        return this.core.settings.proxy?.insecureSkipVerify === true;
    }

    /**
     * 更新代理设置
     */
    async updateProxySettings(proxySettings: Partial<ProxySettings>): Promise<void> {
        // 读-改-写-通知整体入队串行（与 SettingsCore 写队列共用）：并发调用（如
        // setProxyEnabled/setProxyUrl 交错）基于同一旧 proxy 合并后整体写回时后写覆盖先写；
        // oldValue 读取必须在 mutator 内，保证排队后读到前一个变更的结果
        await this.core.serializeMutation(async () => {
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
                settings: this.core.cloneConfig(this.core.settings)
            });
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
