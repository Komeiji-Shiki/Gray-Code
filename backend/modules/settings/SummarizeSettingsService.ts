/**
 * GrayCode - 上下文总结（Summarize）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责总结配置段。
 * SettingsManager 聚合委托本服务。
 */

import type { SummarizeConfig } from './types';
import { DEFAULT_SUMMARIZE_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * 总结配置服务
 *
 * 对应原 SettingsManager 的「总结配置管理」段。
 */
export class SummarizeSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取总结配置
     */
    getSummarizeConfig(): Readonly<SummarizeConfig> {
        return this.core.getToolsConfigEntry('summarize', DEFAULT_SUMMARIZE_CONFIG);
    }

    /**
     * 更新总结配置
     */
    async updateSummarizeConfig(config: Partial<SummarizeConfig>): Promise<void> {
        const oldConfig = this.getSummarizeConfig();
        await this.core.saveToolsConfigEntry('summarize', oldConfig, { ...oldConfig, ...config });
    }
}
