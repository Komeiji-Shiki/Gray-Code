/**
 * GrayCode - 上下文总结（Summarize）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责总结配置段。
 * SettingsManager 聚合委托本服务。
 */

import type { SummarizeConfig } from './types';
import { DEFAULT_SUMMARIZE_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';
import { upgradeRetiredPrompt } from './retiredPromptDefaults';

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
        const config = this.core.getToolsConfigEntry('summarize', DEFAULT_SUMMARIZE_CONFIG);
        // 仍是旧版默认文本的提示词换成当前默认值；用户改过的内容保持原样。
        return {
            ...config,
            summarizePrompt: upgradeRetiredPrompt(config.summarizePrompt, ['summarize'], DEFAULT_SUMMARIZE_CONFIG.summarizePrompt) as string,
            autoSummarizePrompt: upgradeRetiredPrompt(config.autoSummarizePrompt, ['autoSummarize'], DEFAULT_SUMMARIZE_CONFIG.autoSummarizePrompt) as string
        };
    }

    /**
     * 更新总结配置
     */
    async updateSummarizeConfig(config: Partial<SummarizeConfig>): Promise<void> {
        if (config.method !== undefined && config.method !== 'summary' && config.method !== 'notes') {
            throw new Error('请选择普通总结或笔记管理。');
        }
        if (config.userMessageRetention !== undefined && config.userMessageRetention !== 'first' && config.userMessageRetention !== 'all') {
            throw new Error('请选择保留首条或全部用户消息。');
        }
        // 读-改-写整体入队串行：oldConfig 读取与 newConfig 构造必须在 mutator 内，
        // 否则并发 update 基于队列外旧快照构造的 newConfig 会覆盖前一个变更（静默丢更新）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getSummarizeConfig();
            await this.core.saveToolsConfigEntry('summarize', oldConfig, { ...oldConfig, ...config });
        });
    }
}
