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
        return this.core.getToolsConfigEntry('memory', DEFAULT_MEMORY_TOOL_CONFIG);
    }

    /**
     * 更新记忆工具配置
     */
    async updateMemoryConfig(config: Partial<MemoryToolConfig>): Promise<void> {
        const oldConfig = this.getMemoryConfig();
        await this.core.saveToolsConfigEntry('memory', oldConfig, { ...oldConfig, ...config });
    }
}
