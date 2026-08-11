/**
 * GrayCode - 系统提示词（Prompt）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责 system_prompt 配置段的读取、
 * 模式规范化、模式管理（增删改查/重命名/迁移）等。
 * SettingsManager 聚合委托本服务。
 */

import type {
    SystemPromptConfig,
    PromptMode,
    PromptEntry,
    PromptAssemblyMode,
    PromptEntryRole,
    PromptEntryType,
    ResolvedPromptModeSnapshot,
    DynamicContextStrategy
} from './types';
import {
    DEFAULT_SYSTEM_PROMPT_CONFIG,
    DEFAULT_MODE_ID,
    DESIGN_MODE_ID,
    PLAN_MODE_ID,
    ASK_MODE_ID,
    REVIEW_MODE_ID,
    CODE_PROMPT_MODE,
    DESIGN_PROMPT_MODE,
    PLAN_PROMPT_MODE,
    ASK_PROMPT_MODE,
    REVIEW_PROMPT_MODE,
    CHAT_HISTORY_PROMPT_ENTRY_ID,
    BUILTIN_MODE_TOOL_POLICIES
} from './types';
import { SettingsCore } from './SettingsCore';

/**
 * 系统提示词配置服务
 *
 * 对应原 SettingsManager 的「系统提示词配置管理」段。
 */
export class PromptSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取系统提示词配置
     * 
     * 版本迁移：
     * - 老版本：没有 modes 字段 -> 迁移为代码模式 + 设计模式 + 计划模式 + 询问模式 + 审查模式
     * - 新版本：已有 modes 但缺少内置模式 -> 补齐缺失的内置模式（design/plan/ask/review）
     */
    getSystemPromptConfig(): Readonly<SystemPromptConfig> {
        const config = this.core.settings.toolsConfig?.system_prompt || DEFAULT_SYSTEM_PROMPT_CONFIG;

        const normalizeMode = (mode: PromptMode): PromptMode => {
            const normalizedMode = this.normalizePromptModeSnapshot(mode);
            return normalizedMode;
        };
        
        // 情况1：没有 modes 字段（老版本）
        if (!config.modes) {
            return {
                ...config,
                currentModeId: DEFAULT_MODE_ID,
                dynamicContextStrategy: this.normalizeDynamicContextStrategy(config.dynamicContextStrategy),
                modes: {
                    [DEFAULT_MODE_ID]: {
                        ...CODE_PROMPT_MODE,
                        // 保留用户原有的模板配置
                        template: config.template || CODE_PROMPT_MODE.template,
                        dynamicTemplateEnabled: config.dynamicTemplateEnabled ?? CODE_PROMPT_MODE.dynamicTemplateEnabled,
                        dynamicTemplate: config.dynamicTemplate || CODE_PROMPT_MODE.dynamicTemplate,
                        dynamicContextStrategy: this.normalizeDynamicContextStrategy(config.dynamicContextStrategy)
                    },
                    [DESIGN_MODE_ID]: DESIGN_PROMPT_MODE,
                    [PLAN_MODE_ID]: PLAN_PROMPT_MODE,
                    [ASK_MODE_ID]: ASK_PROMPT_MODE,
                    [REVIEW_MODE_ID]: REVIEW_PROMPT_MODE
                }
            };
        }
        
        // 情况2：已有 modes，补齐缺失的内置模式，并同步内置模式的 toolPolicy
        const modes = { ...config.modes };
        let needsUpdate = false;
        
        // 补齐缺失的内置模式（不覆盖已有配置）
        if (!modes[DESIGN_MODE_ID]) {
            modes[DESIGN_MODE_ID] = DESIGN_PROMPT_MODE;
            needsUpdate = true;
        }
        
        if (!modes[PLAN_MODE_ID]) {
            modes[PLAN_MODE_ID] = PLAN_PROMPT_MODE;
            needsUpdate = true;
        }
        
        if (!modes[ASK_MODE_ID]) {
            modes[ASK_MODE_ID] = ASK_PROMPT_MODE;
            needsUpdate = true;
        }

        if (!modes[REVIEW_MODE_ID]) {
            modes[REVIEW_MODE_ID] = REVIEW_PROMPT_MODE;
            needsUpdate = true;
        }

        // 内置模式的 toolPolicy 不再在 getter 中强制回滚。
        // 迁移由 migratePromptModeToolPolicies() 显式处理，
        // 运行时由 normalizePromptModeSnapshot() 按 toolPolicyCustomized 标记回退。
        const builtInModeIds = new Set([
            DESIGN_MODE_ID,
            PLAN_MODE_ID,
            ASK_MODE_ID,
            REVIEW_MODE_ID,
        ]);

        const dynamicContextStrategy = this.normalizeDynamicContextStrategy(config.dynamicContextStrategy);
        for (const [modeId, mode] of Object.entries(modes)) {
            const normalizedMode = this.normalizePromptModeSnapshot(mode);
            if (
                mode.promptAssemblyMode !== normalizedMode.promptAssemblyMode ||
                !this.promptEntriesEqual(normalizedMode.promptEntries, Array.isArray(mode.promptEntries) ? mode.promptEntries : undefined)
            ) {
                modes[modeId] = {
                    ...mode,
                    promptAssemblyMode: normalizedMode.promptAssemblyMode,
                    ...(normalizedMode.promptEntries ? { promptEntries: normalizedMode.promptEntries } : {})
                };
                if (!normalizedMode.promptEntries) delete (modes[modeId] as any).promptEntries;
                needsUpdate = true;
            }
            if (mode.dynamicContextStrategy !== undefined) {
                const normalizedModeStrategy = this.normalizeDynamicContextStrategy(mode.dynamicContextStrategy);
                if (mode.dynamicContextStrategy !== normalizedModeStrategy) {
                    modes[modeId] = {
                        ...modes[modeId],
                        dynamicContextStrategy: normalizedModeStrategy
                    };
                    needsUpdate = true;
                }
            }
        }
        
        if (needsUpdate) {
            // 与 needsUpdate=false 分支同一约定：返回前整体深拷贝。
            // 注意 modes 只是 {...config.modes} 的浅拷贝，未发生归一化的 mode 仍是存储活引用，
            // 不深拷贝的话调用方原地修改同样会污染未保存的设置状态。
            return this.core.cloneConfig({
                ...config,
                modes,
                dynamicContextStrategy
            });
        }

        // 修改原因：浅展开返回的 modes 内 mode 对象仍是存储活引用
        // （this.core.settings.toolsConfig 直接持有），调用方原地修改会污染未保存的设置状态。
        // 修改方式：返回前整体深拷贝，返回结构不变（与 getSettings 的深拷贝约定一致）。
        return this.core.cloneConfig({
            ...config,
            dynamicContextStrategy
        });
    }

    /**
     * 规范化动态上下文策略
     */
    private normalizeDynamicContextStrategy(value: unknown): DynamicContextStrategy {
        return value === 'preserve' ? 'preserve' : 'single';
    }

    /**
     * 规范化提示词组装方式。
     *
     * 默认 legacy，避免旧配置里已有 promptEntries 时被隐式切到预设条目模式。
     */
    private normalizePromptAssemblyMode(value: unknown): PromptAssemblyMode {
        return value === 'entries' ? 'entries' : 'legacy';
    }

    /**
     * 规范化提示词预设条目。
     *
     * 读取配置时只做内存归一化；保存模式时会把归一化结果持久化。
     */
    private normalizePromptEntries(value: unknown, assemblyMode: PromptAssemblyMode = 'legacy'): PromptEntry[] | undefined {
        if (!Array.isArray(value)) {
            return assemblyMode === 'entries' ? [this.createDefaultChatHistoryPromptEntry()] : undefined;
        }

        const normalized: PromptEntry[] = [];
        const usedIds = new Set<string>();

        value.forEach((item, index) => {
            if (!item || typeof item !== 'object') return;
            const raw = item as Partial<PromptEntry> & Record<string, unknown>;

            const fallbackId = `entry_${index}`;
            let id = typeof raw.id === 'string' && raw.id.trim()
                ? raw.id.trim()
                : fallbackId;
            if (usedIds.has(id)) {
                id = `${id}_${index}`;
            }
            usedIds.add(id);

            const type: PromptEntryType = raw.type === 'chat_history' ? 'chat_history' : 'prompt';
            const role: PromptEntryRole = type === 'chat_history'
                ? 'user'
                : raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system'
                ? raw.role
                : 'system';
            const name = typeof raw.name === 'string' && raw.name.trim()
                ? raw.name.trim()
                : type === 'chat_history'
                    ? 'Chat History'
                    : `Prompt ${index + 1}`;
            const order = typeof raw.order === 'number' && Number.isFinite(raw.order)
                ? raw.order
                : index;

            normalized.push({
                id,
                name,
                type,
                enabled: type === 'chat_history' ? true : raw.enabled !== false,
                role,
                content: type === 'chat_history' ? '' : typeof raw.content === 'string' ? raw.content : '',
                fakeThought: type === 'chat_history' ? '' : typeof raw.fakeThought === 'string' ? raw.fakeThought : '',
                order
            });
        });

        if (assemblyMode === 'entries') {
            return this.ensureChatHistoryPromptEntry(normalized);
        }

        return normalized.length > 0 ? normalized : undefined;
    }

    private createDefaultChatHistoryPromptEntry(order = 1000): PromptEntry {
        return {
            id: CHAT_HISTORY_PROMPT_ENTRY_ID,
            name: 'Chat History',
            type: 'chat_history',
            enabled: true,
            role: 'user',
            content: '',
            fakeThought: '',
            order
        };
    }

    private ensureChatHistoryPromptEntry(entries: PromptEntry[]): PromptEntry[] {
        const result: PromptEntry[] = [];
        let hasChatHistory = false;

        for (const entry of entries) {
            if (entry.type !== 'chat_history') {
                result.push(entry);
                continue;
            }

            if (hasChatHistory) {
                continue;
            }

            hasChatHistory = true;
            result.push({
                ...entry,
                id: CHAT_HISTORY_PROMPT_ENTRY_ID,
                name: entry.name.trim() || 'Chat History',
                type: 'chat_history',
                enabled: true,
                role: 'user',
                content: '',
                fakeThought: ''
            });
        }

        if (!hasChatHistory) {
            result.push(this.createDefaultChatHistoryPromptEntry(result.length));
        }

        return result
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((entry, index) => ({ ...entry, order: index }));
    }

    private promptEntriesEqual(a?: PromptEntry[], b?: PromptEntry[]): boolean {
        if (!a && !b) return true;
        if (!a || !b) return false;
        if (a.length !== b.length) return false;

        return a.every((entry, index) => {
            const other = b[index];
            return !!other &&
                entry.id === other.id &&
                entry.name === other.name &&
                (entry.type || 'prompt') === (other.type || 'prompt') &&
                entry.enabled === other.enabled &&
                entry.role === other.role &&
                entry.content === other.content &&
                (entry.fakeThought ?? '') === (other.fakeThought ?? '') &&
                entry.order === other.order;
        });
    }

    /**
     * 解析本次请求应使用的动态上下文策略
     */
    resolveDynamicContextStrategy(
        modeSnapshot?: ResolvedPromptModeSnapshot,
        override?: DynamicContextStrategy
    ): DynamicContextStrategy {
        if (override) {
            return this.normalizeDynamicContextStrategy(override);
        }

        const config = this.getSystemPromptConfig();
        return this.normalizeDynamicContextStrategy(
            modeSnapshot?.dynamicContextStrategy ?? config.dynamicContextStrategy
        );
    }

    /**
     * 更新系统提示词配置
     */
    async updateSystemPromptConfig(config: Partial<SystemPromptConfig>): Promise<void> {
        const oldConfig = this.getSystemPromptConfig();
        await this.core.saveToolsConfigEntry('system_prompt', oldConfig, { ...oldConfig, ...config });
    }

    /**
     * 获取默认提示词模式 ID
     */
    getDefaultPromptModeId(): string {
        return this.getSystemPromptConfig().currentModeId || DEFAULT_MODE_ID;
    }

    /**
     * 获取默认提示词模式
     */
    getDefaultPromptMode(): PromptMode | null {
        const config = this.getSystemPromptConfig();
        const modeId = this.getDefaultPromptModeId();
        return config.modes?.[modeId] || null;
    }

    /**
     * 解析提示词模式快照
     *
     * 优先使用传入的 modeId；如果未提供或无效，则回退到设置中的默认模式。
     */
    resolvePromptMode(modeId?: string): ResolvedPromptModeSnapshot {
        const config = this.getSystemPromptConfig();
        const normalizedModeId = typeof modeId === 'string' ? modeId.trim() : '';

        const fallbackModeId = this.getDefaultPromptModeId();
        const resolvedMode =
            (normalizedModeId ? config.modes?.[normalizedModeId] : undefined)
            || config.modes?.[fallbackModeId]
            || config.modes?.[DEFAULT_MODE_ID];

        if (!resolvedMode) {
            return {
                ...this.normalizePromptModeSnapshot(CODE_PROMPT_MODE)
            };
        }

        return this.normalizePromptModeSnapshot(resolvedMode);
    }

    /**
     * 获取当前激活的模式 ID（向后兼容，语义等同于默认模式 ID）
     */
    getCurrentPromptModeId(): string {
        return this.getDefaultPromptModeId();
    }

    /**
     * 获取当前激活的模式（向后兼容，语义等同于默认模式）
     */
    getCurrentPromptMode(): PromptMode | null {
        return this.getDefaultPromptMode();
    }

    /**
     * 获取所有模式
     */
    getAllPromptModes(): PromptMode[] {
        const config = this.getSystemPromptConfig();
        return Object.values(config.modes || {});
    }

    /**
     * 设置默认提示词模式
     */
    async setCurrentPromptMode(modeId: string): Promise<void> {
        const config = this.getSystemPromptConfig();
        if (!config.modes?.[modeId]) {
            throw new Error(`Mode not found: ${modeId}`);
        }
        await this.updateSystemPromptConfig({ currentModeId: modeId });
    }

    /**
     * 添加或更新模式
     */
    async savePromptMode(mode: PromptMode): Promise<void> {
        // 校验 id 非空字符串：空/undefined id 会写入 "undefined" 键的模式。
        // 返回风格与 renamePromptMode 一致（抛错）。
        if (typeof mode.id !== 'string' || !mode.id.trim()) {
            throw new Error('Mode id is required');
        }
        const config = this.getSystemPromptConfig();
        // 用户显式保存模式时，若传入的 mode 包含 toolPolicy 字段，
        // 先标记为已定制，让 normalizePromptModeSnapshot 能识别并保留用户值。
        // 注意：先拷贝快照再设标记，避免原地修改调用方传入的 mode 对象
        const modeSnapshot = { ...mode };
        if ('toolPolicy' in (modeSnapshot as any)) {
            modeSnapshot.toolPolicyCustomized = true;
        }
        const snapshot = this.normalizePromptModeSnapshot(modeSnapshot);
        const modes = { ...config.modes, [mode.id]: snapshot };
        await this.updateSystemPromptConfig({ modes });
    }

    /**
     * 重命名提示词模式。
     *
     * 只更新模式显示名，不用前端传回的整份模式快照覆盖已保存配置，避免新建模式
     * 在编辑过程中重命名时把模板、条目或工具策略回滚成旧值。
     */
    async renamePromptMode(modeId: string, name: string): Promise<PromptMode> {
        const normalizedModeId = typeof modeId === 'string' ? modeId.trim() : '';
        const normalizedName = typeof name === 'string' ? name.trim() : '';

        if (!normalizedModeId) {
            throw new Error('Mode id is required');
        }
        if (!normalizedName) {
            throw new Error('Mode name is required');
        }

        const config = this.getSystemPromptConfig();
        const existingMode = config.modes?.[normalizedModeId];
        if (!existingMode) {
            throw new Error(`Mode not found: ${normalizedModeId}`);
        }

        const updatedMode = this.normalizePromptModeSnapshot({ ...existingMode, id: normalizedModeId, name: normalizedName });
        const modes = { ...config.modes, [normalizedModeId]: updatedMode };
        await this.updateSystemPromptConfig({ modes });
        return updatedMode;
    }

    private normalizePromptModeSnapshot(mode: PromptMode): PromptMode {
        const promptAssemblyMode = this.normalizePromptAssemblyMode(mode.promptAssemblyMode);
        const promptEntries = this.normalizePromptEntries(mode.promptEntries, promptAssemblyMode);

        // 用户未定制 toolPolicy 的内置模式，运行时回退到内置默认值
        let toolPolicy: string[] | undefined;
        if (mode.toolPolicyCustomized !== true && BUILTIN_MODE_TOOL_POLICIES[mode.id]) {
            toolPolicy = [...BUILTIN_MODE_TOOL_POLICIES[mode.id]];
        } else if (Array.isArray(mode.toolPolicy)) {
            toolPolicy = [...mode.toolPolicy];
        }

        return {
            ...mode,
            promptAssemblyMode,
            toolPolicy,
            ...(promptEntries ? { promptEntries } : {})
        };
    }

    /**
     * 显式迁移内置提示词模式的 toolPolicy（幂等）。
     *
     * 仅对 toolPolicyCustomized !== true 的内置模式生效：
     * 将其 toolPolicy 设置为 BUILTIN_MODE_TOOL_POLICIES 中的默认值，
     * 设置 toolPolicyCustomized = false 标记为「未定制」。
     *
     * 迁移完成后立即落盘。后续 initialize() 调用可重复执行——已定制的模式不会受影响。
     */
    async migratePromptModeToolPolicies(): Promise<void> {
        const config = this.core.settings.toolsConfig?.system_prompt;
        if (!config?.modes) return;

        const modes = { ...config.modes };
        let changed = false;

        const builtInModeIds = new Set([
            DESIGN_MODE_ID,
            PLAN_MODE_ID,
            ASK_MODE_ID,
            REVIEW_MODE_ID,
        ]);

        for (const modeId of builtInModeIds) {
            const mode = modes[modeId];
            if (!mode) continue;
            if (mode.toolPolicyCustomized === true) continue;

            const builtInPolicy = BUILTIN_MODE_TOOL_POLICIES[modeId];
            if (!this.core.arraysEqual(mode.toolPolicy, builtInPolicy as string[])) {
                modes[modeId] = {
                    ...mode,
                    toolPolicy: builtInPolicy ? [...builtInPolicy] : undefined,
                    toolPolicyCustomized: false,
                };
                changed = true;
            } else if (mode.toolPolicyCustomized !== false) {
                // toolPolicy 已匹配但标记未设置，补齐标记
                modes[modeId] = { ...mode, toolPolicyCustomized: false };
                changed = true;
            }
        }

        if (changed) {
            this.core.settings.toolsConfig = {
                ...this.core.settings.toolsConfig,
                system_prompt: { ...config, modes },
            };
            await this.core.storage.save(this.core.settings);
        }
    }

    /**
     * 删除模式
     */
    async deletePromptMode(modeId: string): Promise<void> {
        const config = this.getSystemPromptConfig();
        const modes = { ...config.modes };

        // 不存在/已删除的模式：直接返回，不做无意义的保存广播
        if (!modes[modeId]) {
            return;
        }

        // 至少保留一个模式
        if (Object.keys(modes).length <= 1) {
            throw new Error('Cannot delete the last mode');
        }
        
        delete modes[modeId];
        
        // 如果删除的是当前模式，切换到第一个可用的模式
        let currentModeId = config.currentModeId;
        if (currentModeId === modeId) {
            const remainingModes = Object.keys(modes);
            currentModeId = remainingModes[0] || DEFAULT_MODE_ID;
        }
        await this.updateSystemPromptConfig({ modes, currentModeId });
    }

    /**
     * 获取系统提示词模板（根据当前模式）
     */
    getSystemPromptTemplate(): string {
        const mode = this.getDefaultPromptMode();
        return mode?.template ?? this.getSystemPromptConfig().template;
    }

    /**
     * 获取动态上下文模板（根据当前模式）
     */
    getDynamicContextTemplate(): string {
        const mode = this.getDefaultPromptMode();
        return mode?.dynamicTemplate || this.getSystemPromptConfig().dynamicTemplate || '';
    }

    /**
     * 检查动态上下文是否启用（根据当前模式）
     */
    isDynamicTemplateEnabled(): boolean {
        const mode = this.getDefaultPromptMode();
        return mode?.dynamicTemplateEnabled ?? this.getSystemPromptConfig().dynamicTemplateEnabled;
    }

    /**
     * 获取自定义前缀
     */
    getSystemPromptPrefix(): string {
        return this.getSystemPromptConfig().customPrefix;
    }

    /**
     * 获取自定义后缀
     */
    getSystemPromptSuffix(): string {
        return this.getSystemPromptConfig().customSuffix;
    }
}
