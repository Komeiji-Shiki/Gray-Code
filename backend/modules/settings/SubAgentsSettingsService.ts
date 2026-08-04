/**
 * GrayCode - 子代理（SubAgents）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责子代理配置段。
 * SettingsManager 聚合委托本服务。
 */

import type { SubAgentsConfig, SubAgentConfigItem } from './types';
import { DEFAULT_SUBAGENTS_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * 子代理配置服务
 *
 * 对应原 SettingsManager 的「子代理管理」段。
 */
export class SubAgentsSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取子代理配置
     */
    getSubAgentsConfig(): SubAgentsConfig {
        return {
            ...DEFAULT_SUBAGENTS_CONFIG,
            ...(this.core.settings.toolsConfig?.subagents || {})
        };
    }

    /**
     * 获取所有子代理
     */
    getSubAgents(): SubAgentConfigItem[] {
        return this.getSubAgentsConfig().agents || [];
    }

    /**
     * 获取单个子代理
     */
    getSubAgent(type: string): SubAgentConfigItem | undefined {
        return this.getSubAgents().find(a => a.type === type);
    }

    /**
     * 添加子代理
     */
    async addSubAgent(agent: SubAgentConfigItem): Promise<void> {
        const config = this.getSubAgentsConfig();
        const agents = [...config.agents, agent];
        
        await this.updateSubAgentsConfig({ agents });
    }

    /**
     * 更新子代理
     */
    async updateSubAgent(type: string, updates: Partial<SubAgentConfigItem>): Promise<boolean> {
        const config = this.getSubAgentsConfig();
        const index = config.agents.findIndex(a => a.type === type);
        
        if (index === -1) {
            return false;
        }
        
        const agents = [...config.agents];
        agents[index] = { ...agents[index], ...updates };
        
        await this.updateSubAgentsConfig({ agents });
        return true;
    }

    /**
     * 删除子代理
     */
    async deleteSubAgent(type: string): Promise<boolean> {
        const config = this.getSubAgentsConfig();
        const agents = config.agents.filter(a => a.type !== type);
        
        if (agents.length === config.agents.length) {
            return false;
        }
        
        await this.updateSubAgentsConfig({ agents });
        return true;
    }

    /**
     * 更新子代理配置
     */
    async updateSubAgentsConfig(config: Partial<SubAgentsConfig>): Promise<void> {
        const oldConfig = this.getSubAgentsConfig();
        await this.core.saveToolsConfigEntry('subagents', oldConfig, { ...oldConfig, ...config });
    }
}
