/**
 * GrayCode - Token 计数设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责 Token 计数配置段。
 * SettingsManager 聚合委托本服务。
 */

import type { TokenCountConfig } from './types';
import { DEFAULT_TOKEN_COUNT_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * Token 计数配置服务
 *
 * 对应原 SettingsManager 的「Token 计数配置管理」段。
 */
export class TokenCountSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取 Token 计数配置
     */
    getTokenCountConfig(): Readonly<TokenCountConfig> {
        return this.core.getToolsConfigEntry('token_count', DEFAULT_TOKEN_COUNT_CONFIG);
    }

    /**
     * 更新 Token 计数配置
     */
    async updateTokenCountConfig(config: Partial<TokenCountConfig>): Promise<void> {
        const oldConfig = this.getTokenCountConfig();
        await this.core.saveToolsConfigEntry('token_count', oldConfig, { ...oldConfig, ...config });
    }

    /**
     * 检查指定渠道的 Token 计数是否已启用
     *
     * @param channelType 渠道类型 (gemini, openai, anthropic, openai-responses)
     * @returns 是否启用
     */
    isTokenCountEnabled(channelType: 'gemini' | 'openai' | 'anthropic' | 'openai-responses'): boolean {
        const config = this.getTokenCountConfig();
        return config[channelType]?.enabled ?? false;
    }
}
