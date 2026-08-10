/**
 * LimCode - 配置管理器
 *
 * 核心配置管理类，提供完整的 CRUD 和管理功能
 */

import { t } from '../../i18n';
import type {
    ChannelConfig,
    ChannelType,
    BaseChannelConfig,
    CreateConfigInput,
    UpdateConfigInput,
    ConfigStats,
    ValidationResult,
    ExportOptions,
    ImportOptions,
    ConfigFilter,
    ConfigSortOptions,
    GeminiConfig,
    OpenAIConfig,
    AnthropicConfig
} from './types';
import { CHANNEL_TYPES } from './types';
import { deepMerge } from './configs/base';
import type { ModelInfo } from '../channel/modelList';
import type { ConfigStorageAdapter } from './storage';
import { randomBytes } from 'crypto';

/**
 * 运行时渠道类型守卫
 *
 * 配置来源可能绕过 TypeScript 类型（webview 消息、设置导入），
 * 非法 type 会让 getDefaultConfig 落入 default 分支、getStats 的 byType 计数产生 NaN。
 * 类型列表与 ChannelType 同源（configs/base.ts 的 CHANNEL_TYPES）。
 */
function isChannelType(value: unknown): value is ChannelType {
    return typeof value === 'string' && (CHANNEL_TYPES as ReadonlyArray<string>).includes(value);
}

/**
 * 渠道类型变更时保留的跨类型通用字段（白名单）
 *
 * 切换渠道类型时，配置以新类型的默认配置为基底重建，仅保留此列表中的通用字段；
 * 类型特有字段（models、model、options、optionsEnabled、useAuthorizationHeader、
 * deepSeekUserIdEnabled、pdfAttachmentEnabled 等）重置为新类型默认值，避免旧类型字段残留
 * 污染新类型请求（例如 Gemini 的 thinkingConfig 残留到 Anthropic 配置上）。
 * url 属例外：它是「半通用」字段——用户自定义端点（中转站/代理）跨类型通常仍有效，
 * 切换时保留；但若旧 url 只是旧类型的默认端点（用户未自定义），则跟随新类型默认端点
 * （见 updateConfig 的 typeChanged 分支）。
 */
const COMMON_CHANNEL_FIELDS: ReadonlyArray<keyof BaseChannelConfig | 'apiKey' | 'url'> = [
    'name',
    'enabled',
    'description',
    'tags',
    'systemInstruction',
    'timeout',
    'maxContextTokens',
    'preferStream',
    'toolMode',
    'customHeaders',
    'customHeadersEnabled',
    'customBody',
    'customBodyEnabled',
    'sendHistoryThoughtSignatures',
    'sendCurrentThoughtSignatures',
    'sendHistoryThoughts',
    'historyThinkingRounds',
    'sendCurrentThoughts',
    'retryEnabled',
    'retryCount',
    'retryInterval',
    'contextManagementEnabled',
    'contextManagementMode',
    'contextThresholdEnabled',
    'contextThreshold',
    'contextTrimExtraCut',
    'autoSummarizeEnabled',
    'multimodalToolsEnabled',
    'toolOptions',
    'tokenCountMethod',
    'tokenCountApiConfig',
    'strictToolsEnabled',
    // apiKey 跨类型保留：OpenAI 与 OpenAI Responses 等转换场景下密钥通常仍有效，
    // 无效时用户可在表单中直接覆盖
    'apiKey',
    // url（API 端点）跨类型保留：自定义端点（中转站/代理）通常对多种类型通用；
    // 旧类型默认端点的特殊情况在 updateConfig 中剔除
    'url'
];

/**
 * 从配置中抽取跨类型通用字段（仅保留存在且非 undefined 的字段）
 */
function pickCommonFields(config: BaseChannelConfig): Record<string, unknown> {
    const common: Record<string, unknown> = {};
    const source = config as unknown as Record<string, unknown>;
    for (const field of COMMON_CHANNEL_FIELDS) {
        if (source[field] !== undefined) {
            common[field] = source[field];
        }
    }
    return common;
}

/**
 * 判断字段名是否属于敏感字段（API Key、Token、密钥等）
 */
function isSensitiveFieldName(name: string): boolean {
    return /^(api[-_]?key|apikey|authorization|x-api-key|access[-_]?token|auth[-_]?token|secret|password|token)$/i.test(name);
}

/**
 * 判断对象是否为 { key, value, enabled } 形态的键值条目
 *
 * customHeaders 与 customBody.items 中的条目都符合此形态
 */
function isKeyValueItem(obj: Record<string, unknown>): boolean {
    return typeof obj.key === 'string' && 'enabled' in obj;
}

/**
 * 递归脱敏配置中的敏感信息（不修改原对象，返回新对象）
 *
 * 仅用于 exportConfig 的 includeSensitive=false 路径：
 * - 任意层级的 apiKey / token / secret / authorization 等字段 → '***REDACTED***'
 * - customHeaders / customBody.items 条目（{ key, value, enabled }）的 value（可能为 Authorization）→ '***REDACTED***'
 * - customBody advanced 模式的 json（可能内嵌密钥）→ '***REDACTED***'
 * - url 查询参数中疑似密钥（?key=/?token= 等）→ '***REDACTED***'
 *
 * 脱敏按上下文精准触发：只有进入 customHeaders / customBody 子树后，条目 value
 * 与 json 字段才脱敏；其它含 key/enabled 字段的对象（如工具配置）不受影响。
 */
function redactSensitiveConfig(value: unknown, inCustomContext = false): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitiveConfig(item, inCustomContext));
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    
    for (const [key, val] of Object.entries(source)) {
        if (isSensitiveFieldName(key)) {
            result[key] = '***REDACTED***';
        } else if (key === 'url' && typeof val === 'string') {
            // URL 查询参数可能内嵌密钥（?key=/?token= 等）
            result[key] = redactUrlQuerySecrets(val);
        } else if (key === 'value' && typeof val === 'string' && inCustomContext && isKeyValueItem(source)) {
            // 仅在 customHeaders / customBody.items 条目上下文中脱敏 value：
            // 其它含 key/enabled 字段的对象（如工具配置）的 value 不脱敏
            result[key] = '***REDACTED***';
        } else if (key === 'json' && typeof val === 'string' && inCustomContext) {
            // customBody advanced 模式：整个 JSON 字符串可能内嵌密钥
            result[key] = '***REDACTED***';
        } else if (key === 'customHeaders' || key === 'customBody') {
            // 进入 customHeaders / customBody 上下文：条目 value 与 advanced json 可能含密钥
            result[key] = redactSensitiveConfig(val, true);
        } else {
            result[key] = redactSensitiveConfig(val, inCustomContext);
        }
    }
    
    return result;
}

/** URL 查询参数中可能携带密钥的参数名（不区分大小写） */
const SENSITIVE_URL_PARAM_NAMES: ReadonlySet<string> = new Set([
    'key', 'apikey', 'api_key', 'api-key', 'token', 'access_token',
    'auth_token', 'secret', 'password', 'authorization', 'signature', 'sig'
]);

/**
 * 脱敏 URL 查询参数中疑似密钥的值（如 https://host/v1?key=sk-xxx）
 *
 * 仅用于 exportConfig 的 includeSensitive=false 路径；无法解析的 URL 原样返回。
 */
function redactUrlQuerySecrets(url: string): string {
    try {
        const parsed = new URL(url);
        let changed = false;
        for (const [name, value] of Array.from(parsed.searchParams.entries())) {
            if (value && SENSITIVE_URL_PARAM_NAMES.has(name.toLowerCase())) {
                parsed.searchParams.set(name, '***REDACTED***');
                changed = true;
            }
        }
        return changed ? parsed.toString() : url;
    } catch {
        // 无法解析的 URL 不猜测改写，原样返回
        return url;
    }
}

/**
 * 配置管理器
 * 
 * 提供统一的配置管理接口，支持多种 LLM API 格式
 */
export class ConfigManager {
    /** 配置缓存（用于快速访问） */
    private configCache: Map<string, ChannelConfig> = new Map();
    
    /** 是否已加载 */
    private loaded: boolean = false;
    
    /** 加载中的 Promise（ensureLoaded 并发去重：避免并发调用重复 list/load） */
    private loadingPromise: Promise<void> | null = null;
    
    /**
     * 初始化管理器（加载所有配置到缓存）
     *
     * 并发去重：加载进行中时后续调用直接复用同一 Promise；
     * 各条配置并行加载，单条损坏/读取失败只跳过该条并告警。
     */
    private async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }
        if (this.loadingPromise) {
            return this.loadingPromise;
        }
        
        this.loadingPromise = this.loadAllConfigs().finally(() => {
            this.loadingPromise = null;
        });
        return this.loadingPromise;
    }
    
    private async loadAllConfigs(): Promise<void> {
        const configIds = await this.storageAdapter.list();
        
        // 并行加载 + 逐条容错：单条配置损坏/读取失败只跳过该条并告警，
        // 不影响整个 ConfigManager 初始化
        await Promise.all(configIds.map(async (id) => {
            try {
                const config = await this.storageAdapter.load(id);
                if (config) {
                    this.configCache.set(id, config);
                }
            } catch (error) {
                console.warn(`[ConfigManager] Failed to load config ${id}, skipping:`, error);
            }
        }));
        
        this.loaded = true;
    }
    
    constructor(
        private storageAdapter: ConfigStorageAdapter
    ) {}
    
    // ========== CRUD 操作 ==========
    
    /**
     * 获取指定类型的默认配置
     *
     * @param type 渠道类型
     * @returns 默认配置（不含 id、createdAt、updatedAt）
     */
    getDefaultConfig(type: ChannelType): Record<string, any> {
        const baseDefaults = {
            enabled: true,
            timeout: 120000,
            model: '',
            models: [],
            apiKey: '',
            toolMode: 'function_call' as const,
            retryEnabled: true,
            retryCount: 3,
            retryInterval: 3000,
            contextThresholdEnabled: false,
            contextThreshold: '80%',
            autoSummarizeEnabled: false,
            multimodalToolsEnabled: false,
            customHeadersEnabled: false,
            customHeaders: [],
            customBodyEnabled: false,
            customBody: { mode: 'simple' as const, items: [] },
            sendHistoryThoughts: true,
            sendHistoryThoughtSignatures: false,
            sendCurrentThoughts: true,
            maxContextTokens: 256000,
            options: {
                // 默认流式：实时可见输出、支持流式工具边执行；
                // 显式保存过 options.stream 的已有渠道不受影响（显式值优先）
                stream: true
            }
        };
        
        switch (type) {
            case 'gemini':
                return {
                    ...baseDefaults,
                    url: 'https://generativelanguage.googleapis.com/v1beta',
                    options: {
                        ...baseDefaults.options,
                        temperature: 1.0,
                        maxOutputTokens: 65535,
                        maxImages: 0,
                        // Gemini 思考配置默认值
                        thinkingConfig: {
                            includeThoughts: true,
                            mode: 'default',
                            thinkingLevel: 'low',
                            thinkingBudget: 1024
                        }
                    },
                    optionsEnabled: {
                        temperature: false,
                        maxOutputTokens: false,
                        maxImages: false,
                        thinkingConfig: true
                    }
                };
            
            case 'openai':
                return {
                    ...baseDefaults,
                    url: 'https://api.openai.com/v1',
                    deepSeekUserIdEnabled: false,
                    pdfAttachmentEnabled: false,
                    options: {
                        ...baseDefaults.options,
                        temperature: 1.0,
                        max_tokens: 65535,
                        // OpenAI 思考配置默认值
                        reasoning: {
                            effort: 'high',
                            summaryEnabled: false,
                            summary: 'auto'
                        }
                    },
                    optionsEnabled: {
                        temperature: false,
                        max_tokens: false,
                        top_p: false,
                        frequency_penalty: false,
                        presence_penalty: false,
                        reasoning: false
                    }
                };
            
            case 'anthropic':
                return {
                    ...baseDefaults,
                    url: 'https://api.anthropic.com/v1',
                    options: {
                        ...baseDefaults.options,
                        temperature: 1.0,
                        max_tokens: 65535,
                        // Anthropic 思考配置默认值
                        thinking: {
                            type: 'adaptive',
                            budget_tokens: 10000,
                            effort: 'high'
                        }
                    },
                    optionsEnabled: {
                        temperature: false,
                        max_tokens: false,
                        top_p: false,
                        top_k: false,
                        thinking: false
                    }
                };
            
            case 'openai-responses':
                return {
                    ...baseDefaults,
                    url: 'https://api.openai.com/v1',
                    options: {
                        ...baseDefaults.options,
                        temperature: 1.0,
                        max_output_tokens: 65535,
                        reasoning: {
                            effort: 'medium',
                            summaryEnabled: false,
                            summary: 'auto'
                        }
                    },
                    optionsEnabled: {
                        temperature: false,
                        max_output_tokens: false,
                        top_p: false,
                        reasoning: false
                    }
                };
            
            default:
                return baseDefaults;
        }
    }
    
    /**
     * 创建配置
     *
     * @param input 配置输入（不含 id、createdAt、updatedAt）
     * @returns 创建的配置 ID
     *
     * @example
     * ```typescript
     * const configId = await manager.createConfig({
     *     name: 'Gemini 2.5 Flash',
     *     type: 'gemini',
     *     enabled: true
     * });
     * ```
     */
    async createConfig(input: CreateConfigInput, idOverride?: string): Promise<string> {
        await this.ensureLoaded();

        // 运行时校验渠道类型（webview / 导入等来源不受 TypeScript 约束）
        if (!isChannelType(input.type)) {
            throw new Error(t('modules.channel.errors.unsupportedChannelType', { type: String(input.type) }));
        }

        // idOverride 用于导入等场景：若该 ID 已存在，静默覆盖会丢失原配置；
        // 覆盖现有配置应走 updateConfig / importConfig(overwrite) / replaceConfig 路径
        if (idOverride && this.configCache.has(idOverride)) {
            throw new Error(t('modules.config.errors.configExists', { configId: idOverride }));
        }

        // 生成唯一 ID（允许调用方覆盖，用于导入场景保留原始 id）
        const id = idOverride || randomBytes(16).toString('hex');
        const now = Date.now();
        
        // 获取默认配置并与输入合并
        const defaults = this.getDefaultConfig(input.type);
        
        // 构建完整配置（输入值覆盖默认值）
        const config: ChannelConfig = {
            ...defaults,
            ...input,
            id,
            createdAt: now,
            updatedAt: now
        } as ChannelConfig;
        
        // 保存（不验证配置）
        await this.storageAdapter.save(config);
        this.configCache.set(id, config);
        
        return id;
    }
    
    /**
     * 确保指定 ID 的配置存在。不存在时通过公开 createConfig API 创建，
     * 让调用方不必访问 storageAdapter/loaded 私有实现细节。
     */
    async ensureConfig(configId: string, input: CreateConfigInput): Promise<void> {
        await this.ensureLoaded();
        if (this.configCache.has(configId)) return;
        await this.createConfig(input, configId);
    }
    /**
     * 获取配置
     * 
     * @param configId 配置 ID
     * @returns 配置对象，如果不存在返回 null
     */
    async getConfig(configId: string): Promise<ChannelConfig | null> {
        await this.ensureLoaded();
        
        const config = this.configCache.get(configId);
        return config ? JSON.parse(JSON.stringify(config)) : null;
    }
    
    /**
     * 更新配置
     * 
     * @param configId 配置 ID
     * @param updates 要更新的字段
     * 
     * @example
     * ```typescript
     * await manager.updateConfig('config-123', {
     *     name: '新名称',
     *     options: {
     *         temperature: 0.9
     *     }
     * });
     * ```
     */
    async updateConfig(configId: string, updates: UpdateConfigInput): Promise<ChannelConfig> {
        await this.ensureLoaded();
        
        const existing = this.configCache.get(configId);
        if (!existing) {
            throw new Error(t('modules.config.errors.configNotFound', { configId }));
        }
        
        const newType = updates.type;
        const typeChanged = newType !== undefined && newType !== existing.type;
        
        // 运行时校验渠道类型（webview / 导入等来源不受 TypeScript 约束）
        if (typeChanged && !isChannelType(newType)) {
            throw new Error(t('modules.channel.errors.unsupportedChannelType', { type: String(newType) }));
        }
        
        let updated: ChannelConfig;
        if (typeChanged) {
            // 渠道类型变更：以新类型默认配置为基底重建，仅保留跨类型通用字段，
            // 类型特有字段（options、models 等）重置为新类型默认值；
            // 显式传入的 updates 优先级最高
            const defaults = this.getDefaultConfig(newType);
            const common = pickCommonFields(existing);
            // url 特例：若旧 url 只是旧类型的默认端点（用户未自定义过），
            // 不保留、跟随新类型默认端点；自定义端点（中转站/代理）则跨类型保留，
            // 避免切换类型时要求用户重写 URL
            if (existing.url === this.getDefaultConfig(existing.type).url) {
                delete common.url;
            }
            updated = {
                ...defaults,
                ...common,
                ...updates,
                id: configId,  // 保持 ID 不变
                createdAt: existing.createdAt,  // 保持创建时间
                updatedAt: Date.now()  // 更新时间
            } as ChannelConfig;
        } else {
            // 普通合并更新：嵌套纯对象字段（options/customBody/tokenCountApiConfig 等）
            // 深合并，避免部分嵌套更新（如只改 options.temperature）整体替换 options 丢失兄弟字段；
            // 数组（customHeaders/models/tags 等）与原始值仍按覆盖（复用 base.ts deepMerge
            // 的纯对象合并语义，数组分支在本合并中不会触发）。
            updated = {
                ...existing,
                ...this.mergeNestedUpdates(existing, updates),
                id: configId,  // 保持 ID 不变
                type: existing.type,  // 防御性兜底：防止显式传 undefined 覆盖 type
                createdAt: existing.createdAt,  // 保持创建时间
                updatedAt: Date.now()  // 更新时间
            } as ChannelConfig;
        }
        
        // 保存（不验证配置）
        await this.storageAdapter.save(updated);
        this.configCache.set(configId, updated);
        // 返回更新后的配置（与 getConfig 同样返回深拷贝，调用方可直接消费，避免再次读取）
        return JSON.parse(JSON.stringify(updated)) as ChannelConfig;
    }
    
    /**
     * 整体替换配置（覆盖导入用）
     *
     * 与 updateConfig 的深合并语义不同：以传入配置为最终状态整体替换——
     * 旧配置中导入文件未含有的子字段会被移除、数组会被清空（updateConfig 对纯对象
     * 字段走 deepMerge，旧配置的多余子字段/数组项（如 customBody.items）无法清空）。
     * 保留 id 与 createdAt，updatedAt 更新为当前时间。
     */
    async replaceConfig(configId: string, config: ChannelConfig): Promise<ChannelConfig> {
        await this.ensureLoaded();
        
        const existing = this.configCache.get(configId);
        if (!existing) {
            throw new Error(t('modules.config.errors.configNotFound', { configId }));
        }
        
        // 运行时校验渠道类型（导入来源不受 TypeScript 约束）
        if (!isChannelType(config.type)) {
            throw new Error(t('modules.channel.errors.unsupportedChannelType', { type: String(config.type) }));
        }
        
        const replaced: ChannelConfig = {
            ...config,
            id: configId,
            createdAt: existing.createdAt,
            updatedAt: Date.now()
        } as ChannelConfig;
        
        await this.storageAdapter.save(replaced);
        this.configCache.set(configId, replaced);
        
        return JSON.parse(JSON.stringify(replaced)) as ChannelConfig;
    }
    
    /**
     * 原子合并模型列表（基于最新缓存合并后写回，避免 ModelsHandler 的 check-then-write 竞态）。
     *
     * mergeFn 在 ensureLoaded 之后同步执行、期间无 await，同一时刻只有一个调用能基于最新列表合并。
     *
     * @returns 更新后的配置（深拷贝）
     */
    async updateModels(configId: string, mergeFn: (current: ModelInfo[]) => ModelInfo[]): Promise<ChannelConfig> {
        await this.ensureLoaded();
        const existing = this.configCache.get(configId);
        if (!existing) {
            throw new Error(t('modules.config.errors.configNotFound', { configId }));
        }
        const currentModels = (existing as { models?: ModelInfo[] }).models ?? [];
        const updated = {
            ...existing,
            models: mergeFn(currentModels),
            updatedAt: Date.now()
        } as ChannelConfig;
        await this.storageAdapter.save(updated);
        this.configCache.set(configId, updated);
        return JSON.parse(JSON.stringify(updated)) as ChannelConfig;
    }

    /**
     * 删除配置
     * 
     * @param configId 配置 ID
     */
    async deleteConfig(configId: string): Promise<void> {
        await this.ensureLoaded();
        
        if (!this.configCache.has(configId)) {
            throw new Error(t('modules.config.errors.configNotFound', { configId }));
        }
        
        await this.storageAdapter.delete(configId);
        this.configCache.delete(configId);
    }
    
    /**
     * 列出所有配置
     * 
     * @param filter 过滤条件（可选）
     * @param sort 排序选项（可选）
     * @returns 配置列表
     */
    async listConfigs(
        filter?: ConfigFilter,
        sort?: ConfigSortOptions
    ): Promise<ChannelConfig[]> {
        await this.ensureLoaded();
        
        let configs = Array.from(this.configCache.values());
        
        // 应用过滤
        if (filter) {
            configs = this.applyFilter(configs, filter);
        }
        
        // 应用排序
        if (sort) {
            configs = this.applySort(configs, sort);
        }
        
        // 返回深拷贝
        return JSON.parse(JSON.stringify(configs));
    }
    
    /**
     * 按类型列出配置
     * 
     * @param type 渠道类型
     * @returns 配置列表
     */
    async listConfigsByType(type: ChannelType): Promise<ChannelConfig[]> {
        return this.listConfigs({ type });
    }
    
    /**
     * 列出启用的配置
     * 
     * @returns 配置列表
     */
    async listEnabledConfigs(): Promise<ChannelConfig[]> {
        return this.listConfigs({ enabled: true });
    }
    
    // ========== 配置管理 ==========
    
    /**
     * 启用/禁用配置
     * 
     * @param configId 配置 ID
     * @param enabled 是否启用
     */
    async setConfigEnabled(configId: string, enabled: boolean): Promise<void> {
        await this.updateConfig(configId, { enabled });
    }
    
    /**
     * 验证配置
     * 
     * @param config 要验证的配置
     * @returns 验证结果
     */
    async validateConfig(config: ChannelConfig): Promise<ValidationResult> {
        const errors: string[] = [];
        const warnings: string[] = [];
        
        // 基础字段验证
        // 非字符串 name（webview/导入来源）直接调用 .trim() 会抛 TypeError，先做类型校验
        if (typeof config.name !== 'string' || config.name.trim().length === 0) {
            errors.push(t('modules.config.validation.nameRequired'));
        }
        
        if (!config.type) {
            errors.push(t('modules.config.validation.typeRequired'));
        }
        
        // 根据类型进行特定验证
        switch (config.type) {
            case 'gemini':
                this.validateGeminiConfig(config as GeminiConfig, errors, warnings);
                break;
            
            case 'openai':
                this.validateOpenAIConfig(config as any, errors, warnings);
                break;
            
            case 'openai-responses':
                this.validateOpenAIConfig(config as any, errors, warnings);
                break;
            
            case 'anthropic':
                this.validateAnthropicConfig(config as AnthropicConfig, errors, warnings);
                break;
        }
        
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            warnings: warnings.length > 0 ? warnings : undefined
        };
    }
    
    /**
     * 验证 Gemini 配置
     */
    private validateGeminiConfig(
        config: GeminiConfig,
        errors: string[],
        warnings: string[]
    ): void {
        // URL 验证
        if (!config.url || !this.isValidUrl(config.url)) {
            errors.push(t('modules.config.validation.invalidUrl'));
        }
        
        // API Key 验证 - 仅警告，不阻止创建
        if (!config.apiKey || config.apiKey.trim().length === 0) {
            warnings.push(t('modules.config.validation.apiKeyEmpty'));
        }
        
        // 模型名称验证（允许为空，表示未选择模型）
        // 仅当有模型列表时，才检查是否选择了模型
        const models = (config as any).models || [];
        if (models.length > 0 && (!config.model || config.model.trim().length === 0)) {
            warnings.push(t('modules.config.validation.modelNotSelected'));
        }
        
        // 选项验证
        if (config.options) {
            const opts = config.options;
            
            // 温度参数
            if (opts.temperature !== undefined) {
                if (opts.temperature < 0 || opts.temperature > 2) {
                    errors.push(t('modules.config.validation.temperatureRange'));
                }
            }
            
            // 最大输出 token
            if (opts.maxOutputTokens !== undefined) {
                if (opts.maxOutputTokens < 1) {
                    errors.push(t('modules.config.validation.maxOutputTokensMin'));
                }
                
                // 警告：过大的 token 数
                if (opts.maxOutputTokens > 8192) {
                    warnings.push(t('modules.config.validation.maxOutputTokensHigh'));
                }
            }
        }
    }
    
    /**
     * 验证 OpenAI 配置
     */
    private validateOpenAIConfig(
        config: any,
        errors: string[],
        warnings: string[]
    ): void {
        // URL 验证
        if (!config.url || !this.isValidUrl(config.url)) {
            errors.push(t('modules.config.validation.invalidUrl'));
        }
        
        // API Key 验证
        if (!config.apiKey || config.apiKey.trim().length === 0) {
            warnings.push(t('modules.config.validation.apiKeyEmpty'));
        }
        
        // 模型名称验证
        const models = config.models || [];
        if (models.length > 0 && (!config.model || config.model.trim().length === 0)) {
            warnings.push(t('modules.config.validation.modelNotSelected'));
        }
    }

    /**
     * 验证 Anthropic 配置
     */
    private validateAnthropicConfig(
        config: AnthropicConfig,
        errors: string[],
        warnings: string[]
    ): void {
        // URL 验证
        if (!config.url || !this.isValidUrl(config.url)) {
            errors.push(t('modules.config.validation.invalidUrl'));
        }

        // API Key 验证 - 仅警告，不阻止创建
        if (!config.apiKey || config.apiKey.trim().length === 0) {
            warnings.push(t('modules.config.validation.apiKeyEmpty'));
        }

        // 模型名称验证
        const models = config.models || [];
        if (models.length > 0 && (!config.model || config.model.trim().length === 0)) {
            warnings.push(t('modules.config.validation.modelNotSelected'));
        }

        // 选项验证
        const opts = config.options;
        if (opts) {
            // Anthropic 的 temperature 范围是 0.0 - 1.0
            if (opts.temperature !== undefined && (opts.temperature < 0 || opts.temperature > 1)) {
                errors.push(t('modules.config.validation.temperatureRangeAnthropic'));
            }

            if (opts.max_tokens !== undefined && opts.max_tokens < 1) {
                errors.push(t('modules.config.validation.maxTokensMin'));
            }

            if (opts.top_p !== undefined && (opts.top_p < 0 || opts.top_p > 1)) {
                errors.push(t('modules.config.validation.topPRange'));
            }

            if (opts.top_k !== undefined && opts.top_k < 0) {
                errors.push(t('modules.config.validation.topKMin'));
            }

            // 思考预算：Anthropic 要求 budget_tokens 至少为 1024
            if (opts.thinking?.type === 'enabled' &&
                opts.thinking.budget_tokens !== undefined &&
                opts.thinking.budget_tokens < 1024) {
                warnings.push(t('modules.config.validation.thinkingBudgetMin'));
            }
        }
    }

    /**
     * 获取统计信息
     * 
     * @returns 统计信息
     */
    async getStats(): Promise<ConfigStats> {
        await this.ensureLoaded();
        
        const configs = Array.from(this.configCache.values());
        
        // 计数
        const totalConfigs = configs.length;
        const enabledConfigs = configs.filter(c => c.enabled).length;
        const disabledConfigs = totalConfigs - enabledConfigs;
        
        // 按类型统计
        const byType: Record<ChannelType, number> = {
            gemini: 0,
            openai: 0,
            anthropic: 0,
            'openai-responses': 0
        };
        
        for (const config of configs) {
            // 运行时守卫：配置来源可能绕过 TypeScript 类型（webview/导入），
            // 非法 type 会以字符串键写入 Record<ChannelType, number> 产生 NaN 计数
            if (isChannelType(config.type)) {
                byType[config.type]++;
            }
        }
        
        // 最近创建的配置（缺失 createdAt 的导入配置按 0 参与排序，避免 NaN 比较）
        const sorted = [...configs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        const recentConfigs = sorted.slice(0, 5).map(c => ({
            id: c.id,
            name: c.name,
            type: c.type,
            createdAt: c.createdAt
        }));
        
        return {
            totalConfigs,
            enabledConfigs,
            disabledConfigs,
            byType,
            recentConfigs
        };
    }
    
    /**
     * 导出配置
     * 
     * @param configId 配置 ID
     * @param options 导出选项
     * @returns 导出的 JSON 对象
     */
    async exportConfig(
        configId: string,
        options: ExportOptions = {}
    ): Promise<any> {
        const config = await this.getConfig(configId);
        if (!config) {
            throw new Error(t('modules.config.errors.configNotFound', { configId }));
        }
        
        // 不包含敏感信息：递归脱敏
        // 覆盖 apiKey、customHeaders 的 value（如 Authorization）、
        // customBody 的 value/json、tokenCountApiConfig.apiKey 等嵌套敏感字段
        if (!options.includeSensitive) {
            return redactSensitiveConfig(config);
        }
        
        // 包含敏感信息：原样导出（getConfig 已返回深拷贝，无需再复制）
        return config;
    }
    
    /**
     * 导入配置
     * 
     * @param configData 配置数据
     * @param options 导入选项
     * @returns 导入的配置 ID
     */
    async importConfig(
        configData: any,
        options: ImportOptions = {}
    ): Promise<string> {
        await this.ensureLoaded();
        
        // 检查是否已存在
        if (configData.id && this.configCache.has(configData.id)) {
            if (!options.overwrite) {
                throw new Error(t('modules.config.errors.configExists', { configId: configData.id }));
            }
            
            // 覆盖导入：整体替换语义。updateConfig 对纯对象字段（options/customBody 等）
            // 走深合并，旧配置的多余子字段/数组项（如 customBody.items）无法清空，
            // 与「导入文件即最终状态」的预期不符；replaceConfig 直接以导入配置为准替换
            // （保留原 id 与 createdAt，与 SettingsExporter.importChannelConfigs 一致）
            await this.replaceConfig(configData.id, configData);
            return configData.id;
        }
        
        // 创建新配置（保留原始 id，防止 activeChannelId 悬空）
        const { createdAt, updatedAt, ...input } = configData;
        return this.createConfig(input, configData.id);
    }
    
    /**
     * 检查配置是否存在
     * 
     * @param configId 配置 ID
     * @returns 是否存在
     */
    async exists(configId: string): Promise<boolean> {
        await this.ensureLoaded();
        return this.configCache.has(configId);
    }
    
    // ========== 辅助方法 ==========
    
    /**
     * 应用过滤条件
     */
    private applyFilter(
        configs: ChannelConfig[],
        filter: ConfigFilter
    ): ChannelConfig[] {
        let result = configs;
        
        // 按类型过滤
        if (filter.type) {
            result = result.filter(c => c.type === filter.type);
        }
        
        // 按启用状态过滤
        if (filter.enabled !== undefined) {
            result = result.filter(c => c.enabled === filter.enabled);
        }
        
        // 按标签过滤
        if (filter.tags && filter.tags.length > 0) {
            result = result.filter(c =>
                c.tags && filter.tags!.some(tag => c.tags!.includes(tag))
            );
        }
        
        // 按名称搜索
        if (filter.nameSearch) {
            const search = filter.nameSearch.toLowerCase();
            result = result.filter(c =>
                (c.name || '').toLowerCase().includes(search)
            );
        }
        
        return result;
    }
    
    /**
     * 应用排序
     */
    private applySort(
        configs: ChannelConfig[],
        sort: ConfigSortOptions
    ): ChannelConfig[] {
        const sorted = [...configs];
        
        sorted.sort((a, b) => {
            let aVal: any;
            let bVal: any;
            
            switch (sort.field) {
                case 'name':
                    // name 可能 undefined（createConfig 不校验必填），缺兜底会抛 TypeError
                    aVal = (a.name || '').toLowerCase();
                    bVal = (b.name || '').toLowerCase();
                    break;
                case 'createdAt':
                    aVal = a.createdAt;
                    bVal = b.createdAt;
                    break;
                case 'updatedAt':
                    aVal = a.updatedAt;
                    bVal = b.updatedAt;
                    break;
                case 'type':
                    aVal = a.type;
                    bVal = b.type;
                    break;
            }
            
            if (sort.order === 'asc') {
                return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            } else {
                return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
            }
        });
        
        return sorted;
    }
    
    /**
     * 嵌套字段深合并（用于 updateConfig 普通合并路径）
     *
     * 仅当目标与来源都是纯对象时用 base.ts deepMerge 递归合并（options/customBody/
     * tokenCountApiConfig 等），数组（customHeaders/models/tags）与原始值按覆盖，
     * 保持既有浅合并语义不回归；同时过滤 __proto__/constructor/prototype 键，
     * 防止 webview/导入来源的恶意键触发原型链污染（与 configs/base.ts deepMerge 一致）。
     */
    private mergeNestedUpdates(existing: ChannelConfig, updates: UpdateConfigInput): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        const source = existing as unknown as Record<string, unknown>;
        const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

        for (const [key, value] of Object.entries(updates)) {
            if (unsafeKeys.has(key)) {
                continue;
            }
            const existingValue = source[key];
            if (
                value !== null && typeof value === 'object' && !Array.isArray(value) &&
                existingValue !== null && typeof existingValue === 'object' && !Array.isArray(existingValue)
            ) {
                result[key] = deepMerge(existingValue, value);
            } else {
                result[key] = value;
            }
        }
        return result;
    }

    /**
     * 验证 URL
     */
    private isValidUrl(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }
}
