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
        // 读-改-写整体入队串行：oldConfig 读取与 newConfig 构造必须在 mutator 内，
        // 否则并发 update 基于队列外旧快照构造的 newConfig 会覆盖前一个变更（静默丢更新）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getTokenCountConfig();
            await this.core.saveToolsConfigEntry('token_count', oldConfig, { ...oldConfig, ...config });
        });
    }

    /**
     * 检查指定渠道的 Token 计数是否已启用
     *
     * @param channelType 渠道类型 (gemini, openai, anthropic, openai-responses)
     * @returns 是否启用
     */
    isTokenCountEnabled(channelType: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses'): boolean {
        const config = this.getTokenCountConfig();
        return config[channelType]?.enabled ?? false;
    }
}
