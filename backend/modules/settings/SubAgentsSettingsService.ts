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
        return this.core.getToolsConfigEntry('subagents', DEFAULT_SUBAGENTS_CONFIG);
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
        // 读-改-写整体入队串行：并发调用基于同一旧列表写回时后写会覆盖先写
        await this.core.serializeMutation(async () => {
            const config = this.getSubAgentsConfig();
            // type 判重：同类型子代理已存在时抛错，避免重复项静默入库（更新请走 updateSubAgent）
            if (config.agents.some(a => a.type === agent.type)) {
                throw new Error(`SubAgent with type "${agent.type}" already exists`);
            }
            const agents = [...config.agents, agent];
            
            await this.updateSubAgentsConfig({ agents });
        });
    }

    /**
     * 更新子代理
     */
    async updateSubAgent(type: string, updates: Partial<SubAgentConfigItem>): Promise<boolean> {
        return this.core.serializeMutation(async () => {
            const config = this.getSubAgentsConfig();
            const index = config.agents.findIndex(a => a.type === type);
            
            if (index === -1) {
                return false;
            }
            
            // 修改原因：updates 可把 type 改成已存在的其它子代理 type，静默产生重复项。
            // 修改方式：更新前按新 type 查重（排除自身），已存在则抛错（与 addSubAgent 一致）。
            const newType = updates.type;
            if (newType !== undefined && config.agents.some((a, i) => i !== index && a.type === newType)) {
                throw new Error(`SubAgent with type "${newType}" already exists`);
            }
            
            const agents = [...config.agents];
            agents[index] = { ...agents[index], ...updates };
            
            await this.updateSubAgentsConfig({ agents });
            return true;
        });
    }

    /**
     * 删除子代理
     */
    async deleteSubAgent(type: string): Promise<boolean> {
        return this.core.serializeMutation(async () => {
            const config = this.getSubAgentsConfig();
            const agents = config.agents.filter(a => a.type !== type);
            
            if (agents.length === config.agents.length) {
                return false;
            }
            
            await this.updateSubAgentsConfig({ agents });
            return true;
        });
    }

    /**
     * 更新子代理配置
     */
    async updateSubAgentsConfig(config: Partial<SubAgentsConfig>): Promise<void> {
        const oldConfig = this.getSubAgentsConfig();
        await this.core.saveToolsConfigEntry('subagents', oldConfig, { ...oldConfig, ...config });
    }
}
