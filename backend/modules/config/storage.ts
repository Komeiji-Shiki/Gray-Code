/**
 * LimCode - 配置存储适配器接口
 * 
 * 定义配置存储的抽象接口，支持不同的存储实现
 */

import type { ChannelConfig } from './types';
import { deepClone } from '../../core/deepClone';

/**
 * 配置存储适配器接口
 * 
 * 实现此接口以支持不同的存储后端：
 * - 内存存储（Memory）
 * - 文件系统存储（FileSystem）
 * - 数据库存储（Database）
 * - 云存储（Cloud）
 */
export interface ConfigStorageAdapter {
    /**
     * 保存配置
     * 
     * @param config 要保存的配置
     */
    save(config: ChannelConfig): Promise<void>;
    
    /**
     * 加载配置
     * 
     * @param configId 配置 ID
     * @returns 配置对象，如果不存在返回 null
     */
    load(configId: string): Promise<ChannelConfig | null>;
    
    /**
     * 删除配置
     * 
     * @param configId 配置 ID
     */
    delete(configId: string): Promise<void>;
    
    /**
     * 列出所有配置 ID
     * 
     * @returns 配置 ID 列表
     */
    list(): Promise<string[]>;
    
    /**
     * 检查配置是否存在
     * 
     * @param configId 配置 ID
     * @returns 是否存在
     */
    exists(configId: string): Promise<boolean>;
}

/**
 * 内存存储适配器
 * 
 * 用于测试和临时存储，数据不持久化
 */
export class MemoryStorageAdapter implements ConfigStorageAdapter {
    private configs: Map<string, ChannelConfig> = new Map();
    
    async save(config: ChannelConfig): Promise<void> {
        this.configs.set(config.id, deepClone(config));
    }
    
    async load(configId: string): Promise<ChannelConfig | null> {
        const config = this.configs.get(configId);
        return config ? deepClone(config) : null;
    }
    
    async delete(configId: string): Promise<void> {
        this.configs.delete(configId);
    }
    
    async list(): Promise<string[]> {
        return Array.from(this.configs.keys());
    }
    
    async exists(configId: string): Promise<boolean> {
        return this.configs.has(configId);
    }
}

/**
 * 文件系统存储适配器
 * 
 * 使用 VSCode 的 Memento API 存储配置
 * 
 * @example
 * ```typescript
 * import * as vscode from 'vscode';
 * 
 * const storage = new MementoStorageAdapter(
 *     context.globalState,
 *     'limcode.configs'
 * );
 * ```
 */
export class MementoStorageAdapter implements ConfigStorageAdapter {
    constructor(
        private memento: any,  // vscode.Memento
        private key: string = 'limcode.configs'
    ) {}

    /**
     * 写队列：把「读 → 改 → 整体写回」串行化。Memento 没有 per-key 原子更新，
     * 并发 save/delete（如 SettingsExporter.importChannelConfigs 循环导入与设置页
     * 并发编辑）基于同一旧 map 整体写回时，后写会覆盖先写，渠道配置静默丢失。
     */
    private writeQueue: Promise<void> = Promise.resolve();

    private serializeMutation<T>(mutator: (all: Record<string, ChannelConfig>) => T | Promise<T>): Promise<T> {
        const run = this.writeQueue.then(async () => {
            const all = await this.getAll();
            return await mutator(all);
        });
        // 链尾吞掉本次错误（调用方仍从 run 拿到真实结果），防止单次失败阻塞后续写
        this.writeQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private async getAll(): Promise<Record<string, ChannelConfig>> {
        return this.memento.get(this.key, {});
    }
    
    private async setAll(configs: Record<string, ChannelConfig>): Promise<void> {
        await this.memento.update(this.key, configs);
    }
    
    async save(config: ChannelConfig): Promise<void> {
        return this.serializeMutation(async all => {
            all[config.id] = config;
            await this.setAll(all);
        });
    }
    
    async load(configId: string): Promise<ChannelConfig | null> {
        const all = await this.getAll();
        return all[configId] || null;
    }
    
    async delete(configId: string): Promise<void> {
        return this.serializeMutation(async all => {
            delete all[configId];
            await this.setAll(all);
        });
    }
    
    async list(): Promise<string[]> {
        const all = await this.getAll();
        return Object.keys(all);
    }
    
    async exists(configId: string): Promise<boolean> {
        const all = await this.getAll();
        return configId in all;
    }
}

/**
 * 混合存储适配器
 * 
 * 组合多个存储适配器，提供缓存和持久化
 * 
 * @example
 * ```typescript
 * const storage = new HybridStorageAdapter(
 *     new MemoryStorageAdapter(),  // 缓存层
 *     new MementoStorageAdapter(context.globalState)  // 持久层
 * );
 * ```
 */
export class HybridStorageAdapter implements ConfigStorageAdapter {
    constructor(
        private cache: ConfigStorageAdapter,
        private persistent: ConfigStorageAdapter
    ) {}
    
    async save(config: ChannelConfig): Promise<void> {
        // 同时保存到缓存和持久层
        await Promise.all([
            this.cache.save(config),
            this.persistent.save(config)
        ]);
    }
    
    async load(configId: string): Promise<ChannelConfig | null> {
        // 先从缓存读取
        let config = await this.cache.load(configId);
        
        if (!config) {
            // 缓存未命中，从持久层读取
            config = await this.persistent.load(configId);
            
            // 如果找到，写入缓存
            if (config) {
                await this.cache.save(config);
            }
        }
        
        return config;
    }
    
    async delete(configId: string): Promise<void> {
        // 同时从缓存和持久层删除
        await Promise.all([
            this.cache.delete(configId),
            this.persistent.delete(configId)
        ]);
    }
    
    async list(): Promise<string[]> {
        // 从持久层获取列表
        return this.persistent.list();
    }
    
    async exists(configId: string): Promise<boolean> {
        // 先检查缓存
        if (await this.cache.exists(configId)) {
            return true;
        }
        
        // 缓存未命中，检查持久层
        return this.persistent.exists(configId);
    }
}