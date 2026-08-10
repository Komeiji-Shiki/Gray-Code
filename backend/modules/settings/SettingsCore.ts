/**
 * GrayCode - 设置核心（共享状态与基础设施）
 *
 * 从 SettingsManager.ts 拆分而来：集中管理设置状态、持久化与变更通知，
 * 以及各主题服务共用的工具方法（深合并、toolsConfig 读写等）。
 * SettingsManager 聚合委托各主题服务，本文件不对外导出（除 SettingsStorage 类型）。
 */

import type {
    GlobalSettings,
    SettingsChangeEvent,
    SettingsChangeListener
} from './types';
import { DEFAULT_GLOBAL_SETTINGS } from './types';

/**
 * 合并键黑名单：webview 消息直接透传进 updateSettings（SettingsHandler 无键白名单），
 * `JSON.parse('{"__proto__":{...}}')` 会产出 own 属性，Object.entries 会遍历到它；
 * 当目标对象无 own `__proto__` 时 `out['__proto__'] = value` 会触发原型 setter，
 * 把合并结果的原型链替换成攻击者对象（后续 settings.xxx 读取可被原型属性遮蔽/伪造）。
 * constructor/prototype 一并过滤（标准防护集）。
 */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeMergeKey(key: string): boolean {
    return !UNSAFE_MERGE_KEYS.has(key);
}

/**
 * 递归深合并纯对象（数组与原始值直接覆盖），用于工具配置与默认配置合并。
 * 浅合并会让用户手写的部分配置整体替换嵌套默认对象（如只写一个子字段时
 * 其它子字段全部丢失），这里对纯对象逐层合并。
 */
export function deepMergeToolsConfig<T extends object>(base: T, override: Partial<T>): T {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override)) {
        if (!isSafeMergeKey(key)) {
            continue;
        }
        const baseValue = (base as Record<string, unknown>)[key];
        if (
            value !== null && typeof value === 'object' && !Array.isArray(value) &&
            baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)
        ) {
            out[key] = deepMergeToolsConfig(baseValue as object, value as object);
        } else {
            out[key] = value;
        }
    }
    return out as T;
}

/**
 * 设置存储接口
 *
 * 抽象存储层，支持不同的存储实现
 */
export interface SettingsStorage {
    /**
     * 加载设置
     */
    load(): Promise<GlobalSettings | null>;
    
    /**
     * 保存设置
     */
    save(settings: GlobalSettings): Promise<void>;
}

/**
 * 设置核心
 *
 * 持有全局设置状态、存储与变更监听器，并提供各主题服务共用的辅助方法。
 * 主题服务（CheckpointSettingsService / PromptSettingsService 等）共享同一个
 * SettingsCore 实例，保证状态与通知行为完全一致。
 */
export class SettingsCore {
    /** 全局设置状态（主题服务直接读写） */
    settings: GlobalSettings;
    /** 设置存储 */
    readonly storage: SettingsStorage;
    /** 变更监听器集合 */
    private listeners: Set<SettingsChangeListener> = new Set();
    /**
     * 串行写队列：把「读 → 改 → 整体写回」串行化（参考 config/storage.ts
     * MementoStorageAdapter 的 writeQueue）。主题服务的更新方法基于同一旧列表
     * 整体写回，并发调用时后写会覆盖先写，必须整段入队串行执行。
     */
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(storage: SettingsStorage) {
        this.storage = storage;
        this.settings = this.cloneConfig(DEFAULT_GLOBAL_SETTINGS);
    }

    /** 递归深拷贝配置对象 */
    cloneConfig<T>(value: T): T {
        if (value === undefined || value === null) return value;
        if (typeof value !== 'object') return value;
        if (Array.isArray(value)) {
            return value.map(item => this.cloneConfig(item)) as T;
        }

        const cloned: Record<string, any> = {};
        for (const key of Object.keys(value as Record<string, any>)) {
            cloned[key] = this.cloneConfig((value as Record<string, any>)[key]);
        }

        return cloned as T;
    }

    /**
     * 辅助方法：深度合并配置对象（递归）
     *
     * 用于处理复杂的嵌套配置结构。
     * 确保如果在 DEFAULT_CONFIG 中存在，而在 STORED_CONFIG 中不存在（或只有部分属性）时，
     * 能够完整保留默认配置的子属性。
     */
    deepMergeConfig<T>(defaultConfig: T, storedConfig: any): T {
        // 基本类型或数组/null/undefined，直接使用 stored 的值（如果存在），否则回退到 default
        if (storedConfig === undefined) {
            return defaultConfig;
        }

        // 处理基础类型或特殊对象类型
        if (
            typeof defaultConfig !== 'object' || defaultConfig === null ||
            typeof storedConfig !== 'object' || storedConfig === null ||
            Array.isArray(defaultConfig) || Array.isArray(storedConfig)
        ) {
            return storedConfig as T;
        }

        const merged = { ...defaultConfig } as Record<string, any>;

        // 遍历 default 的所有 key
        for (const key of Object.keys(defaultConfig)) {
            const defaultValue = (defaultConfig as Record<string, any>)[key];
            const storedValue = storedConfig[key];

            if (storedValue !== undefined) {
                // 递归深合并
                merged[key] = this.deepMergeConfig(defaultValue, storedValue);
            }
        }

        // 保留 stored 中独有的 key（用户可能新增了我们当前版本未知但应该保留的配置）
        for (const key of Object.keys(storedConfig)) {
            if (!(key in defaultConfig)) {
                if (!isSafeMergeKey(key)) {
                    continue; // 原型链污染防护：__proto__/constructor/prototype 不并入
                }
                merged[key] = storedConfig[key];
            }
        }

        return merged as T;
    }

    /**
     * 读取 toolsConfig.<key> 配置，并与默认配置深合并。
     *
     * 与默认配置 merge 可避免历史配置缺少后续版本新增的字段。
     * 浅合并会让用户手写的部分配置整体替换嵌套默认对象（如只写一个子字段时
     * 其它子字段全部丢失），这里对纯对象递归深合并，数组与原始值仍直接覆盖。
     */
    getToolsConfigEntry<T extends object>(key: string, defaults: Readonly<T>): Readonly<T> {
        const cfg = this.settings.toolsConfig?.[key] as unknown as Partial<T> | undefined;
        // 深拷贝返回：deepMergeToolsConfig 对数组/原始值直接赋值，返回结果与存储活对象
        // 或模块级默认对象共享嵌套引用，调用方原地修改会污染全局默认/未保存状态。
        return this.cloneConfig(deepMergeToolsConfig(defaults, cfg || {}));
    }

    /**
     * 写回 toolsConfig.<key> 配置并广播变更事件。
     *
     * 所有 toolsConfig 下的配置保存/通知逻辑统一收口于此。
     */
    async saveToolsConfigEntry<T extends object>(key: string, oldConfig: Readonly<T>, newConfig: T): Promise<void> {
        if (!this.settings.toolsConfig) {
            this.settings.toolsConfig = {};
        }
        // 整体替换 toolsConfig 对象（而非原地改 toolsConfig[key]）：任何存储实现的
        // diff 快照都不会因「同对象引用复用」而漏写嵌套配置（同 setToolsEnabled 约定）
        this.settings.toolsConfig = {
            ...this.settings.toolsConfig,
            [key]: newConfig as unknown as Record<string, unknown>
        };
        this.settings.lastUpdated = Date.now();

        await this.storage.save(this.settings);

        this.notifyChange({
            type: 'tools',
            path: `toolsConfig.${key}`,
            oldValue: oldConfig,
            newValue: newConfig,
            settings: this.settings
        });
    }

    /**
     * 获取完整设置
     */
    getSettings(): Readonly<GlobalSettings> {
        // 深拷贝返回：浅展开只保护顶层，嵌套对象（toolsConfig/toolsEnabled 等）仍是活引用。
        return this.cloneConfig(this.settings);
    }

    /**
     * 串行执行读-改-写操作
     *
     * 多个主题服务的更新方法（addPinnedFile / setSkillEnabled 等）基于同一旧列表
     * 整体写回，并发调用基于同一旧快照写回时后写覆盖先写、静默丢更新。
     * 将 mutator 整体入队串行执行，保证每次「读 → 改 → 写」期间没有其它写操作交错。
     */
    serializeMutation<T>(mutator: () => T | Promise<T>): Promise<T> {
        const run = this.writeQueue.then(async () => mutator());
        // 链尾吞掉本次错误（调用方仍从 run 拿到真实结果），防止单次失败阻塞后续写
        this.writeQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    /**
     * 更新设置（部分更新）
     */
    async updateSettings(updates: Partial<GlobalSettings>): Promise<void> {
        // 深拷贝旧值快照：浅展开只保护顶层，嵌套对象（toolsConfig 等）仍是活引用，
        // 事件监听器拿到 oldValue 后原地修改会污染更新后的 settings
        const oldSettings = this.cloneConfig(this.settings);

        // 修改原因：旧实现为浅合并，传入嵌套部分对象（如 { toolsConfig: {...} }）会整体
        // 替换该键并抹掉同层其它配置，与 getToolsConfigEntry 的深合并行为不一致。
        // 修改方式：复用 deepMergeToolsConfig 做纯对象深合并（数组与原始值仍直接覆盖），
        // 保持与其它服务方法一致的合并语义。
        this.settings = {
            ...deepMergeToolsConfig(this.settings, updates),
            lastUpdated: Date.now()
        };
        
        // 保存到存储
        await this.storage.save(this.settings);
        
        // 通知变更
        this.notifyChange({
            type: 'full',
            oldValue: oldSettings,
            newValue: this.settings,
            settings: this.settings
        });
    }

    /**
     * 从存储重新加载设置并广播变更事件。
     *
     * 用于导入设置后通知 PromptManager 等缓存持有者刷新。
     * 事件形态与 updateSettings 一致，确保现有监听器能识别。
     */
    async reloadAndNotify(): Promise<void> {
        const oldSettings = this.cloneConfig(this.settings);
        const stored = await this.storage.load();
        if (stored) {
            this.settings = this.deepMergeConfig(this.cloneConfig(DEFAULT_GLOBAL_SETTINGS), stored) as GlobalSettings;
            this.settings.lastUpdated = stored.lastUpdated || Date.now();
        }
        this.notifyChange({
            type: 'full',
            oldValue: oldSettings,
            newValue: this.settings,
            settings: this.settings
        });
    }

    /**
     * 重置为默认设置
     */
    async reset(): Promise<void> {
        const oldSettings = this.cloneConfig(this.settings);
        // 深拷贝默认配置：浅展开会让嵌套对象与模块级 DEFAULT_GLOBAL_SETTINGS 共享引用，
        // 后续对 this.settings 嵌套字段的修改会污染全局默认值（与构造器/import 路径一致）。
        this.settings = {
            ...this.cloneConfig(DEFAULT_GLOBAL_SETTINGS),
            lastUpdated: Date.now()
        };
        
        await this.storage.save(this.settings);
        
        this.notifyChange({
            type: 'full',
            oldValue: oldSettings,
            newValue: this.settings,
            settings: this.settings
        });
    }

    /**
     * 添加设置变更监听器
     */
    addChangeListener(listener: SettingsChangeListener): void {
        this.listeners.add(listener);
    }

    /**
     * 移除设置变更监听器
     */
    removeChangeListener(listener: SettingsChangeListener): void {
        this.listeners.delete(listener);
    }

    /**
     * 比较两个数组是否相等（用于 toolPolicy 比较）
     */
    arraysEqual(a?: string[], b?: string[]): boolean {
        if (!a && !b) return true;
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        const sortedA = [...a].sort();
        const sortedB = [...b].sort();
        return sortedA.every((v, i) => v === sortedB[i]);
    }

    /**
     * 通知设置变更
     */
    notifyChange(event: SettingsChangeEvent): void {
        for (const listener of this.listeners) {
            // listener(event) 在 Promise.resolve 之前同步求值：监听器同步 throw 会
            // 中断整条通知链，且调用方已保存成功却收到异常。这里把求值也包进 try/catch。
            try {
                // 异步执行，避免阻塞
                Promise.resolve(listener(event)).catch(error => {
                    console.error('Settings change listener error:', error);
                });
            } catch (error) {
                console.error('Settings change listener error:', error);
            }
        }
    }
}
