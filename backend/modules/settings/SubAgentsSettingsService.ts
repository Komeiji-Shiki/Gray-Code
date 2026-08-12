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
            const merged = { ...agents[index], ...updates };
            // channel 为嵌套对象：部分更新（如只改 channelId）整体替换会静默丢
            // modelId/syncWithCurrentModel，做字段级合并（与前端整对象发送兼容）
            if (updates.channel && agents[index].channel) {
                merged.channel = { ...agents[index].channel, ...updates.channel };
            }
            agents[index] = merged;
            
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
        // 读-改-写整体入队串行：oldConfig 读取与 newConfig 构造必须在 mutator 内，
        // 否则并发 update 基于队列外旧快照构造的 newConfig 会覆盖前一个变更（静默丢更新）；
        // 本方法亦被 addSubAgent/updateSubAgent/deleteSubAgent 等已入队方法在 mutator 内调用，
        // serializeMutation 重入保护（内联执行）保证不产生嵌套死锁
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getSubAgentsConfig();
            await this.core.saveToolsConfigEntry('subagents', oldConfig, { ...oldConfig, ...config });
        });
    }

    /**
     * 一次性迁移旧的「强制所有子代理使用当前渠道」全局开关（幂等）。
     *
     * 该全局开关已下放为每个子代理渠道配置上的 syncWithCurrentModel 逐代理开关，
     * 且新 UI 不再提供关闭入口——若不清除，旧配置一旦开启将永久生效且无法全局关闭
     * （连新建的代理也会被静默同步）。迁移规则：
     * - forceUseCurrentChannel === true 时：对每个未显式设置 syncWithCurrentModel 的
     *   代理写入 syncWithCurrentModel: true（保持升级前的继承行为）；显式 false 的代理
     *   保持自身固定渠道。
     * - 清除全局 forceUseCurrentChannel 字段。
     * 重复执行安全：首次迁移后字段已清除，直接返回。
     */
    async migrateForceUseCurrentChannel(): Promise<void> {
        await this.core.serializeMutation(async () => {
            const raw = this.core.settings.toolsConfig?.subagents as SubAgentsConfig | undefined;
            if (!raw || raw.forceUseCurrentChannel !== true) return;

            const agents = (raw.agents || []).map(agent => {
                if (agent.channel?.syncWithCurrentModel !== undefined) return agent;
                return { ...agent, channel: { ...agent.channel, syncWithCurrentModel: true } };
            });
            const { forceUseCurrentChannel: _removed, ...rest } = raw;
            const next: SubAgentsConfig = { ...rest, agents };

            await this.core.saveToolsConfigEntry('subagents', raw, next);
        });
    }
}
