/**
 * SubAgents 注册器
 *
 * 管理所有可用的子代理
 */

import type {
    SubAgentType,
    SubAgentConfig,
    SubAgentRegistryEntry,
    SubAgentExecutor
} from './types';

/**
 * 子代理注册器
 */
export class SubAgentRegistry {
    private agents = new Map<SubAgentType, SubAgentRegistryEntry>();
    
    /**
     * 注册子代理
     * 
     * @param config 代理配置
     * @param executor 代理执行器（可选，不提供则使用默认执行器）
     */
    register(config: SubAgentConfig, executor?: SubAgentExecutor): void {
        if (this.agents.has(config.type)) {
            console.warn(`SubAgent "${config.type}" already registered, overwriting...`);
        }
        
        this.agents.set(config.type, { config, executor });
    }
    
    /**
     * 从配置注册子代理
     * 
     * 简化版本，只需提供配置，自动使用默认执行器
     * 
     * @param config 代理配置
     */
    registerFromConfig(config: SubAgentConfig): void {
        this.register(config);
    }
    
    /**
     * 批量注册子代理
     * 
     * @param configs 代理配置数组
     */
    registerBatch(configs: SubAgentConfig[]): void {
        for (const config of configs) {
            this.registerFromConfig(config);
        }
    }
    
    /**
     * 获取子代理
     * 
     * @param type 代理类型
     * @returns 代理注册项，不存在则返回 undefined
     */
    get(type: SubAgentType): SubAgentRegistryEntry | undefined {
        // 修改原因：以前 get() 会隐式创建默认 executor 并写回 Registry，
        // 导致「显式注册的自定义 executor」和「临时创建的默认 executor」无法区分，
        // 且缓存的默认 executor 缺少每次调用的动态会话上下文（F-08）。
        // 修改方式：查询方法只返回注册项本身；默认 executor 由正式工具调用路径
        // 按每次请求动态创建。
        return this.agents.get(type);
    }
    
    /**
     * 获取子代理执行器
     * 
     * @param type 代理类型
     * @returns 执行器，不存在则返回 undefined
     */
    getExecutor(type: SubAgentType): SubAgentExecutor | undefined {
        // 只返回显式注册的 executor，不隐式创建默认 executor（F-08）
        return this.agents.get(type)?.executor;
    }
    
    /**
     * 获取所有已注册的子代理类型
     * 
     * @returns 代理类型数组
     */
    getTypes(): SubAgentType[] {
        return Array.from(this.agents.keys()).filter(type => {
            const entry = this.agents.get(type);
            return entry?.config.enabled !== false;
        });
    }
    
    /**
     * 获取所有子代理配置
     * 
     * @returns 代理配置数组（仅启用的）
     */
    getAllConfigs(): SubAgentConfig[] {
        return Array.from(this.agents.values())
            .filter(entry => entry.config.enabled !== false)
            .map(entry => entry.config);
    }
    
    /**
     * 获取所有子代理配置（包括禁用的）
     * 
     * @returns 所有代理配置数组
     */
    getAllConfigsIncludingDisabled(): SubAgentConfig[] {
        return Array.from(this.agents.values()).map(entry => entry.config);
    }
    
    /**
     * 获取所有启用的子代理名称
     * 
     * @returns 代理名称数组
     */
    getNames(): string[] {
        return Array.from(this.agents.values())
            .filter(entry => entry.config.enabled !== false)
            .map(entry => entry.config.name);
    }
    
    /**
     * 根据名称获取子代理
     * 
     * @param name 代理名称
     * @returns 代理注册项，不存在则返回 undefined
     */
    getByName(name: string): SubAgentRegistryEntry | undefined {
        // 同 get()：不再隐式创建默认 executor（F-08）
        for (const entry of this.agents.values()) {
            if (entry.config.name === name && entry.config.enabled !== false) {
                return entry;
            }
        }
        return undefined;
    }
    
    /**
     * 检查子代理是否已注册
     * 
     * @param type 代理类型
     * @returns 是否已注册
     */
    has(type: SubAgentType): boolean {
        return this.agents.has(type);
    }
    
    /**
     * 检查子代理是否启用
     * 
     * @param type 代理类型
     * @returns 是否启用
     */
    isEnabled(type: SubAgentType): boolean {
        // 修改原因：未注册代理的 entry 为 undefined 时，
        // `undefined !== false` 恒为 true，把不存在的代理误判为已启用（F-05）。
        const entry = this.agents.get(type);
        return entry !== undefined && entry.config.enabled !== false;
    }
    
    /**
     * 启用/禁用子代理
     * 
     * @param type 代理类型
     * @param enabled 是否启用
     * @returns 是否成功
     */
    setEnabled(type: SubAgentType, enabled: boolean): boolean {
        const entry = this.agents.get(type);
        if (!entry) {
            return false;
        }
        entry.config.enabled = enabled;
        return true;
    }
    
    /**
     * 更新子代理配置
     * 
     * @param type 代理类型
     * @param updates 要更新的配置字段
     * @returns 是否成功
     */
    updateConfig(type: SubAgentType, updates: Partial<SubAgentConfig>): boolean {
        const entry = this.agents.get(type);
        if (!entry) {
            return false;
        }
        
        // 不允许更改 type
        const { type: _, ...safeUpdates } = updates;
        const oldChannel = entry.config.channel;
        Object.assign(entry.config, safeUpdates);
        // channel 为嵌套对象：字段级合并，避免部分更新（如只改 channelId）静默丢
        // modelId/syncWithCurrentModel（与 SubAgentsSettingsService.updateSubAgent 口径一致）
        if (safeUpdates.channel && oldChannel) {
            entry.config.channel = { ...oldChannel, ...safeUpdates.channel };
        }
        
        // 清除缓存的执行器（以便下次使用时重新创建）
        entry.executor = undefined;
        
        return true;
    }
    
    /**
     * 注销子代理
     * 
     * @param type 代理类型
     * @returns 是否成功注销
     */
    unregister(type: SubAgentType): boolean {
        return this.agents.delete(type);
    }
    
    /**
     * 清空所有子代理
     */
    clear(): void {
        this.agents.clear();
    }
    
    /**
     * 获取已注册的子代理数量
     */
    count(): number {
        return this.agents.size;
    }
    
    /**
     * 获取启用的子代理数量
     */
    countEnabled(): number {
        return this.getTypes().length;
    }
}

/**
 * 全局子代理注册器实例
 */
export const subAgentRegistry = new SubAgentRegistry();
