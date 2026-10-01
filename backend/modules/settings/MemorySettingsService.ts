/**
 * GrayCode - 记忆（Memory）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责记忆工具配置段的读写。
 * SettingsManager 聚合委托本服务；ToolsSettingsService 依赖本服务
 * 判断记忆工具是否可用。
 */

import type { MemoryToolConfig } from './types';
import { DEFAULT_MEMORY_TOOL_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';
import { retiredPromptKind } from './retiredPromptDefaults';

/**
 * 记忆配置服务
 *
 * 对应原 SettingsManager 的「记忆配置管理」段。
 */
export class MemorySettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 长期记忆总开关。
     */
    isMemoryEnabled(): boolean {
        return this.getMemoryConfig().enabled !== false;
    }

    /**
     * 获取记忆工具配置
     */
    getMemoryConfig(): Readonly<MemoryToolConfig> {
        const config = this.core.getToolsConfigEntry('memory', DEFAULT_MEMORY_TOOL_CONFIG);
        // 保存下来的旧版默认记忆提示词视为未自定义，改用内置默认值（空串即使用内置文本）。
        return retiredPromptKind(config.systemPrompt) === 'memory' ? { ...config, systemPrompt: '' } : config;
    }

    /**
     * 更新记忆工具配置
     */
    async updateMemoryConfig(config: Partial<MemoryToolConfig>): Promise<void> {
        // 读-改-写整体入队串行：oldConfig 读取与 newConfig 构造必须在 mutator 内，
        // 否则并发 update 基于队列外旧快照构造的 newConfig 会覆盖前一个变更（静默丢更新）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getMemoryConfig();
            await this.core.saveToolsConfigEntry('memory', oldConfig, { ...oldConfig, ...config });
        });
    }
}
