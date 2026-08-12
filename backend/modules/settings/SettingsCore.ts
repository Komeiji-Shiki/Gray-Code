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
import { deepEqual } from '../../core/deepEqual';
import { deepMerge } from '../../core/deepMerge';

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
 *
 * 已收敛为 core/deepMerge.ts 参数化 deepMerge 的薄封装，不再保留本地递归实现。
 * 对非循环输入与历史本地实现逐字节等价（另额外获得循环引用防护）：
 * - nullMode: 'write'：覆盖值为 null 时显式写入 null（updateSettings 接收 webview 消息，
 *   null 清空字段语义依赖此行为；core.deepMerge 默认 'keep' 会保留目标值）；
 * - conflictMode: 'reuse-source'：类型冲突（目标非纯对象、源为纯对象）时直接复用源引用
 *   （getToolsConfigEntry 已用 cloneConfig 兜底拷贝）；
 * - undefinedMode: 'skip'：覆盖值为 undefined 时跳过该键、不创建 own 属性（对齐 deepMergeConfig
 *   语义），避免 toolsConfig: undefined 等顶层键整体置空删除全部配置。
 * 原型污染键防护（__proto__/constructor/prototype）与循环引用防护由 core 统一提供。
 */
export function deepMergeToolsConfig<T extends object>(base: T, override: Partial<T>): T {
    return deepMerge(base, override, {
        nullMode: 'write',
        conflictMode: 'reuse-source',
        undefinedMode: 'skip'
    }) as T;
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
    /**
     * serializeMutation 重入标志：mutator 执行期间为 true。
     * mutator 内嵌套调用 serializeMutation（如服务级 update*Config 在 mutator 内调用
     * 底层写入口 saveToolsConfigEntry，后者也整体入队）时据此内联执行，避免
     * 「内层 run 链在外层 tail 之后才启动、外层 mutator 又 await 内层 run」的队列死锁。
     *
     * 已知边界：标志跨 await 保持——mutator 等待（storage.save/load 等）期间到达的
     * 并发调用（另一事件循环任务）同样会走内联分支、与当前 mutator 交错执行（与嵌套
     * 调用无法区分）。对「读-改-写」型 mutator，交错写仍基于最新内存状态合并，不丢
     * 更新；唯一需要收口的是 reloadAndNotify 的「load → 整体替换」窄窗口——由
     * mutationGeneration 代际校验 + 重读保护覆盖（见 reloadAndNotify）。
     */
    private inMutation = false;
    /**
     * 变更代际计数：mutator 实际执行（队列运行或内联执行）时递增。
     * 供 reloadAndNotify 检测「load() 等待窗口内是否有并发变更交错」：
     * 有交错则丢弃本次过期快照、重读最新存储，避免整体替换覆盖并发变更。
     */
    private mutationGeneration = 0;

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
        // undefined：保留默认（调用方未设置该键）
        if (storedConfig === undefined) {
            return defaultConfig;
        }

        // 显式 null：清空字段语义（与 deepMergeToolsConfig 一致：updateSettings 收到
        // null 时显式写入 null，此处 merged[key] 同样置 null，由读取方以 null 兜底处理）
        if (storedConfig === null) {
            return null as T;
        }

        const isDefaultPureObject =
            typeof defaultConfig === 'object' && defaultConfig !== null && !Array.isArray(defaultConfig);

        if (!isDefaultPureObject) {
            // default 是原始值/数组：stored 直接覆盖（数组与原始值直接覆盖语义）
            return storedConfig as T;
        }

        // default 是纯对象：stored 也必须是纯对象才能逐键合并
        if (typeof storedConfig !== 'object' || Array.isArray(storedConfig)) {
            // 类型冲突（如 settings.json 被误写为 toolsConfig: 123 等损坏数据）：
            // 直接采用 default 兜底，避免 reloadAndNotify 把 this.settings 整体赋成
            // 非对象后，各主题服务读取字段时崩溃或静默返回错误值。
            return defaultConfig;
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
     *
     * 写-通知整体入队串行：serializeMutation 带重入保护（mutator 内嵌套调用内联执行），
     * 服务级 update*Config 在自身 mutator 内调用本方法时不会死锁；未包 mutator 的直接
     * 调用入口（如 ContextSettingsService.updateContextAwarenessConfig）也自动获得与其它
     * 写操作互斥的串行化——「单次原子写，无并发覆盖风险」的旧注释不成立：直调入口与
     * 入队方法并发时，写回仍可能基于过期旧值覆盖先写，必须统一走同一写队列。
     * 注意：读-改（oldConfig 读取与 newConfig 构造）由调用方负责放入 mutator；本方法只
     * 串行化「写入 + 保存 + 通知」段（见各服务 update*Config 的 serializeMutation 包裹）。
     */
    async saveToolsConfigEntry<T extends object>(key: string, oldConfig: Readonly<T>, newConfig: T): Promise<void> {
        await this.serializeMutation(async () => {
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

            // 事件负载统一深拷贝：oldValue/newValue 可能与存储活对象共享嵌套引用
            // （{ ...oldConfig, ...config } 浅展开），settings 是活对象——监听器原地修改
            // 任一字段都会污染核心状态/未保存配置，统一与活对象解耦（同 full 事件口径）
            this.notifyChange({
                type: 'tools',
                path: `toolsConfig.${key}`,
                oldValue: this.cloneConfig(oldConfig),
                newValue: this.cloneConfig(newConfig),
                settings: this.cloneConfig(this.settings)
            });
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
     *
     * 重入保护：mutator 内嵌套调用本方法（如服务级 update*Config 在 mutator 内调用
     * 底层写入口 saveToolsConfigEntry，后者也整体入队）时，若仍排入 writeQueue 会死锁
     * ——内层 run 链在外层 tail 之后才启动，外层 mutator 又 await 内层 run。此时直接
     * 内联执行 mutator：调用方 await 语义不变，内层与外层在同一执行栈内顺序完成，
     * 等价于串行（项目内全部嵌套调用均为 await 形态，无 fire-and-forget 交错）。
     *
     * 注：标志跨 await 保持，mutator 等待期间到达的并发调用同样走内联分支（与嵌套调用
     * 无法区分）；交错写基于最新内存状态合并不丢更新，唯一需要收口的是 reloadAndNotify
     * 的 load 窗口（代际校验 + 重读，见 reloadAndNotify）。
     */
    serializeMutation<T>(mutator: () => T | Promise<T>): Promise<T> {
        if (this.inMutation) {
            // 已在 mutator 执行栈内：内联执行（mutator 同步 throw 也转为 rejected promise）
            this.mutationGeneration++;
            return Promise.resolve().then(() => mutator());
        }
        const run = this.writeQueue.then(async () => {
            this.inMutation = true;
            this.mutationGeneration++;
            try {
                return await mutator();
            } finally {
                this.inMutation = false;
            }
        });
        // 链尾吞掉本次错误（调用方仍从 run 拿到真实结果），防止单次失败阻塞后续写
        this.writeQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    /**
     * 'full' 事件无 path，现有监听器（ChatHandler 的 PromptManager 缓存失效判定）只识别
     * 'tools' 事件，且要求 newValue/oldValue 顶层含 system_prompt——full 事件里
     * system_prompt 嵌套在 toolsConfig 下永远匹配不到。这里在 system_prompt 实际变化时
     * 补发一条 'tools' 事件，让既有监听器无需改动即可使 PromptManager 缓存失效。
     * 深度比较使用 core/deepEqual（与 VSCodeSettingsStorage.save 的 diff 共用）。
     */
    private notifySystemPromptChangeIfNeeded(oldSettings: GlobalSettings, newSettings: GlobalSettings): void {
        const oldPrompt = oldSettings.toolsConfig?.system_prompt;
        const newPrompt = newSettings.toolsConfig?.system_prompt;
        if (deepEqual(oldPrompt, newPrompt)) {
            return;
        }
        // 事件负载深拷贝（同 full/tools 事件统一口径）：system_prompt 是存储活对象上的
        // 嵌套引用，监听器原地修改会污染核心状态
        this.notifyChange({
            type: 'tools',
            path: 'toolsConfig.system_prompt',
            oldValue: this.cloneConfig(oldPrompt),
            newValue: this.cloneConfig(newPrompt),
            settings: this.cloneConfig(newSettings)
        });
    }

    /**
     * 更新设置（部分更新）
     */
    async updateSettings(updates: Partial<GlobalSettings>): Promise<void> {
        // 读-改-写-通知整体入队串行（与各主题服务的 serializeMutation 共用同一写队列）：
        // 并发调用（如 webview 连发部分更新）基于同一旧快照整体写回时后写会覆盖先写
        await this.serializeMutation(async () => {
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

            // 通知变更（事件负载统一深拷贝：newValue/settings 若传活引用，监听器原地修改
            // 会污染更新后的核心状态，与 reloadAndNotify/reset 的 full 事件口径一致）
            const newSettings = this.cloneConfig(this.settings);
            this.notifyChange({
                type: 'full',
                oldValue: oldSettings,
                newValue: newSettings,
                settings: newSettings
            });
            // full 事件本身无法触发 PromptManager 缓存失效（见 notifySystemPromptChangeIfNeeded）
            this.notifySystemPromptChangeIfNeeded(oldSettings, this.settings);
        });
    }

    /**
     * 从存储重新加载设置并广播变更事件。
     *
     * 用于导入设置后通知 PromptManager 等缓存持有者刷新。
     * 事件形态与 updateSettings 一致，确保现有监听器能识别。
     */
    async reloadAndNotify(): Promise<void> {
        // 读-改-写-通知整体入队串行：与 updateSettings/reset 共用同一写队列，
        // 避免导入流程的 reload 与并发写操作交错（如 reload 读到半旧状态后整体写回覆盖新变更）
        await this.serializeMutation(async () => {
            const oldSettings = this.cloneConfig(this.settings);
            // 代际校验 + 重读：inMutation 标志跨 await 保持，load() 等待窗口内到达的并发
            // 变更会经 serializeMutation 内联分支与本次 reload 交错执行（其变更已写入内存
            // 与存储）。若直接用本次 load 的过期快照整体替换 this.settings，会覆盖该并发
            // 变更（内存回退旧状态、与存储分叉）。比对代际：窗口内有交错则重读最新存储
            // （并发变更的保存已完成，重读即拿到最新状态）；有界重试避免极端高频写入下
            // 饿死，最终一次仍接受结果（与旧行为等价，仅收窄覆盖窗口）。
            const generationBeforeLoad = this.mutationGeneration;
            let stored = await this.storage.load();
            for (let attempt = 0; attempt < 2 && this.mutationGeneration !== generationBeforeLoad; attempt++) {
                stored = await this.storage.load();
            }
            if (!stored) {
                // 存储为空：内存状态无需任何变化，广播 full 事件无意义（old/new 内容相同），
                // 且 newValue 若传 this.settings 是活引用。直接返回，不广播不拷贝。
                return;
            }
            this.settings = this.deepMergeConfig(this.cloneConfig(DEFAULT_GLOBAL_SETTINGS), stored) as GlobalSettings;
            this.settings.lastUpdated = stored.lastUpdated || Date.now();
            // 事件负载统一深拷贝：newValue/settings 若传活引用，监听器原地修改会污染核心状态
            // （与 updateSettings/reset 的 full 事件口径一致）
            const newSettings = this.cloneConfig(this.settings);
            this.notifyChange({
                type: 'full',
                oldValue: oldSettings,
                newValue: newSettings,
                settings: newSettings
            });
            // 导入可能整体替换 toolsConfig（含 system_prompt）：补发 tools 事件使 PromptManager 缓存失效
            this.notifySystemPromptChangeIfNeeded(oldSettings, this.settings);
        });
    }

    /**
     * 重置为默认设置
     */
    async reset(): Promise<void> {
        // 读-改-写-通知整体入队串行：与 updateSettings/reloadAndNotify 共用同一写队列
        await this.serializeMutation(async () => {
            const oldSettings = this.cloneConfig(this.settings);
            // 保留存储路径配置：DEFAULT_GLOBAL_SETTINGS 不含 storagePath（StoragePathSettingsService
            // 字段名），整体重置会让用户自定义数据目录/迁移状态静默回落到默认路径。
            // reset 只重置普通设置项，数据存放位置不属于应被清空的内容。
            const storagePath = this.settings.storagePath ? this.cloneConfig(this.settings.storagePath) : undefined;
            // 深拷贝默认配置：浅展开会让嵌套对象与模块级 DEFAULT_GLOBAL_SETTINGS 共享引用，
            // 后续对 this.settings 嵌套字段的修改会污染全局默认值（与构造器/import 路径一致）。
            this.settings = {
                ...this.cloneConfig(DEFAULT_GLOBAL_SETTINGS),
                ...(storagePath ? { storagePath } : {}),
                lastUpdated: Date.now()
            };

            await this.storage.save(this.settings);

            // 事件负载统一深拷贝（同 updateSettings/reloadAndNotify 的 full 事件口径）
            const newSettings = this.cloneConfig(this.settings);
            this.notifyChange({
                type: 'full',
                oldValue: oldSettings,
                newValue: newSettings,
                settings: newSettings
            });
            // 重置会整体替换 toolsConfig（含 system_prompt）：补发 tools 事件使 PromptManager 缓存失效
            this.notifySystemPromptChangeIfNeeded(oldSettings, this.settings);
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
