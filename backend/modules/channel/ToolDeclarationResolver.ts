/**
 * GrayCode - 工具声明解析器
 *
 * 修改原因：ChannelManager 和 SubAgent 过去各自生成工具声明，导致 read_file 多模态描述、图片工具过滤、MCP schema 清理等逻辑容易漏同步。
 * 修改方式：把原 ChannelManager.getFilteredTools 的核心逻辑抽成共享解析器，并提供工具来源、白名单、黑名单等通用过滤选项。
 * 修改目的：主会话和 SubAgent 都从同一个入口获取工具声明，避免以后主工具声明升级但 SubAgent 没有升级。
 *
 * 本地化接入点：本文件是主会话与 SubAgent 共用的模型工具声明入口，中英文国际化在此统一接入——
 * builtin 声明在 buildDynamicBuiltinDeclaration 返回前经 localizeToolDeclaration 应用目录覆盖
 * （zh-CN 中文说明 / en、ja 映射英文说明），MCP 缺省说明与受限模式 search_in_files 只读说明按语言生成。
 * 声明缓存键包含 resolveLocalizationLanguage(getActualLanguage())：语言是进程级且对话期间不变，
 * 语言切换后不得命中旧语言缓存，同语言同配置下连续 resolve 全部命中缓存，保证单次对话内
 * 工具定义绝不因任何原因二次修改。
 */

import type { ToolDeclaration } from '../../tools/types';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { SettingsManager } from '../settings';
import { isSearchInFilesReplaceForbidden } from '../settings';
import type { ResolvedPromptModeSnapshot } from '../settings';
import type { McpManager } from '../mcp';
import { encodeMcpToolName } from '../mcp';
import { getToolDeclarationFactory, type ToolDeclarationFactoryArgs } from '../../tools/toolDeclarationRegistry';
import { hasAvailableSubAgentSafe } from '../../core/subAgentAvailabilityBridge';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../../tools/localization/types';
import { getToolDescriptionLocalization } from '../../tools/localization/catalogs';
import { localizeToolDeclaration } from '../../tools/localization/localizeToolDeclaration';

export type DeclarationChannelType = 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
export type DeclarationToolMode = 'function_call' | 'xml' | 'json';

export interface ToolDeclarationResolveOptions {
    multimodalEnabled?: boolean;
    channelType?: DeclarationChannelType;
    toolMode?: DeclarationToolMode;
    promptModeSnapshot?: ResolvedPromptModeSnapshot;
    includeBuiltins?: boolean;
    includeMcp?: boolean;
    allowlist?: string[];
    denylist?: string[];
    excludeToolNames?: string[];
}

// ==================== 工具声明缓存 ====================
// 工具循环每迭代都会经 ChannelManager.getFilteredTools → resolve() 重建全部声明
// （遍历工具注册表 + 逐工具递归 cleanJsonSchema + 遍历全部 MCP 工具），同一回合内
// 解析输入几乎不变。按「解析选项 + 设置指纹 + MCP 工具列表版本」缓存结果：
// - 设置指纹取影响工具声明的配置切片（toolsEnabled / toolAutoExec / imageTools /
//   memory / subagents），任何相关设置变更都会改变指纹 → 自动失效；
// - MCP 连接/断开/能力刷新事件递增版本号（getAllTools 只返回已连接且有能力缓存的
//   服务器，这三个事件覆盖工具列表的全部变化点）；
// - 命中返回浅克隆（数组层）：声明对象是解析时的私有快照，调用方（formatter）只读使用。
const TOOL_DECLARATION_CACHE_CAPACITY = 32;

export class ToolDeclarationResolver {
    private readonly declarationCache = new Map<string, ToolDeclaration[]>();
    /** MCP 工具列表版本：服务器连接/断开/能力刷新事件时递增（工具列表变化的可靠失效信号） */
    private mcpToolsVersion = 0;
    /** 已注册的 MCP 事件解绑句柄：dispose() 时逐一移除，防止一次性实例向 McpManager 单例泄漏监听器 */
    private readonly mcpEventDisposers: Array<() => void> = [];

    constructor(
        private readonly toolRegistry?: ToolRegistry,
        private readonly settingsManager?: SettingsManager,
        private readonly mcpManager?: McpManager
    ) {
        if (this.mcpManager && typeof (this.mcpManager as any).addEventListener === 'function') {
            const bumpToolsVersion = (): void => {
                this.mcpToolsVersion += 1;
            };
            for (const eventType of ['server:connected', 'server:disconnected', 'server:capabilities_updated'] as const) {
                this.mcpManager.addEventListener(eventType, bumpToolsVersion);
                this.mcpEventDisposers.push(() => {
                    this.mcpManager?.removeEventListener?.(eventType, bumpToolsVersion);
                });
            }
        }
    }

    /** 释放 MCP 事件监听（一次性实例用完后调用，避免向单例 McpManager 无界累积监听器） */
    dispose(): void {
        for (const disposer of this.mcpEventDisposers.splice(0)) {
            disposer();
        }
    }

    private touchDeclarationCache(key: string): void {
        const value = this.declarationCache.get(key);
        if (value !== undefined) {
            this.declarationCache.delete(key);
            this.declarationCache.set(key, value);
        }
        if (this.declarationCache.size > TOOL_DECLARATION_CACHE_CAPACITY) {
            const oldest = this.declarationCache.keys().next().value;
            if (oldest !== undefined) {
                this.declarationCache.delete(oldest);
            }
        }
    }

    /** 设置指纹：只序列化影响工具声明的配置切片（值都很小，序列化成本可忽略） */
    private settingsFingerprint(): string {
        const settings = this.settingsManager
            && typeof (this.settingsManager as any).getSettings === 'function'
            ? (this.settingsManager as any).getSettings() as { toolsEnabled?: unknown; toolAutoExec?: unknown; toolsConfig?: Record<string, unknown> }
            : undefined;
        if (!settings) {
            return '';
        }
        const toolsConfig = settings.toolsConfig ?? {};
        return JSON.stringify([
            settings.toolsEnabled ?? {},
            settings.toolAutoExec ?? null,
            toolsConfig.memory ?? null,
            toolsConfig.generate_image ?? null,
            toolsConfig.remove_background ?? null,
            toolsConfig.crop_image ?? null,
            toolsConfig.resize_image ?? null,
            toolsConfig.rotate_image ?? null,
            toolsConfig.subagents ?? null,
        ]);
    }

    private buildCacheKey(options: ToolDeclarationResolveOptions): string {
        const toolPolicy = Array.isArray(options.promptModeSnapshot?.toolPolicy)
            && options.promptModeSnapshot.toolPolicy.length > 0
            ? options.promptModeSnapshot.toolPolicy
            : undefined;
        return JSON.stringify([
            // 实际语言进入缓存键：语言是进程级且对话期间不变，语言切换后不得命中旧语言缓存；
            // zh-CN/en/ja 经 resolveLocalizationLanguage 归并为 zh-CN/en 两档，同语言内保持稳定命中。
            resolveLocalizationLanguage(getActualLanguage()),
            options.channelType ?? '',
            options.toolMode ?? '',
            options.multimodalEnabled ?? false,
            options.includeBuiltins !== false,
            options.includeMcp !== false,
            options.allowlist ?? null,
            options.denylist ?? null,
            options.excludeToolNames ?? null,
            toolPolicy ?? null,
            this.settingsFingerprint(),
            this.mcpToolsVersion,
            hasAvailableSubAgentSafe(),
        ]);
    }

    resolve(options: ToolDeclarationResolveOptions = {}): ToolDeclaration[] | undefined {
        const cacheKey = this.buildCacheKey(options);
        const cached = this.declarationCache.get(cacheKey);
        if (cached !== undefined) {
            this.touchDeclarationCache(cacheKey);
            return cached.length > 0 ? cached.slice() : undefined;
        }

        const includeBuiltins = options.includeBuiltins !== false;
        const includeMcp = options.includeMcp !== false;
        const tools: ToolDeclaration[] = [];

        if (includeBuiltins) {
            tools.push(...this.resolveBuiltinDeclarations(options));
        }

        if (includeMcp) {
            tools.push(...this.resolveMcpDeclarations());
        }

        const filtered = this.applyFinalFilters(tools, options);
        this.declarationCache.set(cacheKey, filtered);
        this.touchDeclarationCache(cacheKey);
        return filtered.length > 0 ? filtered : undefined;
    }

    private resolveBuiltinDeclarations(options: ToolDeclarationResolveOptions): ToolDeclaration[] {
        if (!this.toolRegistry) {
            return [];
        }

        const builtinTools = this.settingsManager
            ? this.toolRegistry.getDeclarationsBy(toolName => this.settingsManager!.isToolEnabled(toolName))
            : this.toolRegistry.getAllDeclarations();

        const declarations: ToolDeclaration[] = [];
        for (const tool of builtinTools) {
            const declaration = this.buildDynamicBuiltinDeclaration(tool, options);
            if (!declaration) {
                continue;
            }
            declarations.push({
                ...declaration,
                parameters: this.cleanJsonSchema(declaration.parameters)
            });
        }
        return declarations;
    }

    /**
     * 动态声明替换：优先使用组合根注册的工厂重建动态声明（read_file 多模态描述、
     * 图片工具参数随解析选项/设置变化）。工厂未注册时保持静态声明（回退行为，
     * 与工厂直连时代码路径等价：不替换任何字段）。
     *
     * 本地化：工厂重建完成后、返回前统一应用模型声明本地化目录（zh-CN 中文说明 /
     * en、ja 映射英文说明）。动态工具目录只配置参数说明（顶层说明保留工厂动态产物），
     * 静态工具目录配置 description + parameters；未配置的工具保留原文（零拷贝）。
     */
    private buildDynamicBuiltinDeclaration(
        tool: ToolDeclaration,
        options: ToolDeclarationResolveOptions
    ): ToolDeclaration | null {
        let declaration: ToolDeclaration = { ...tool };
        const multimodalEnabled = options.multimodalEnabled;
        const channelType = options.channelType;
        const toolMode = options.toolMode;
        let shouldExclude = false;
        let buildArgs: ToolDeclarationFactoryArgs = {};

        // read_file：多模态/渠道/工具模式决定描述与参数形态（仅文本 / 文本+图片 / 文本+图片+PDF）
        if (tool.name === 'read_file') {
            buildArgs = { multimodalEnabled, channelType, toolMode };
        }

        // 图片工具：多模态关闭或 OpenAI function_call 渠道不对外暴露（排除逻辑保留）
        if (tool.name === 'generate_image') {
            shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            buildArgs = {
                maxBatchTasks: imageConfig?.maxBatchTasks || 5,
                maxImagesPerTask: imageConfig?.maxImagesPerTask || 1,
                paramsConfig: {
                    enableAspectRatio: imageConfig?.enableAspectRatio ?? false,
                    forcedAspectRatio: imageConfig?.defaultAspectRatio || undefined,
                    enableImageSize: imageConfig?.enableImageSize ?? false,
                    forcedImageSize: imageConfig?.defaultImageSize || undefined
                }
            };
        }

        if (tool.name === 'remove_background') {
            shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            buildArgs = { maxBatchTasks: imageConfig?.maxBatchTasks || 5 };
        }

        if (tool.name === 'crop_image') {
            shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            buildArgs = { maxBatchTasks: imageConfig?.maxBatchTasks || 10 };
        }

        if (tool.name === 'resize_image') {
            shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            buildArgs = { maxBatchTasks: imageConfig?.maxBatchTasks || 10 };
        }

        if (tool.name === 'rotate_image') {
            shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            buildArgs = { maxBatchTasks: imageConfig?.maxBatchTasks || 10 };
        }

        if (tool.name === 'subagents' && !hasAvailableSubAgentSafe()) {
            return null;
        }

        // 泛化工厂调用：任何已注册工厂的工具都经此重建动态声明（read_file/图片工具由
        // 上面分支构建参数；其余已注册工厂——execute_command、history_search、read_skill、
        // subagents、agent_send_message、write_file/list_files/apply_diff 等文件搜索类——
        // 传空对象 {}，工厂忽略参数自行生成）。工厂未注册时保持静态声明回退（不替换任何字段）。
        const factory = getToolDeclarationFactory(tool.name);
        if (factory && !shouldExclude) {
            const dynamicTool = factory(buildArgs);
            declaration = {
                ...declaration,
                description: dynamicTool.declaration.description,
                parameters: dynamicTool.declaration.parameters
            };
        }

        // 模型声明本地化：语言进入缓存键（见 buildCacheKey），此处按进程级实际语言
        // （zh-CN → 中文目录；en/ja → 英文目录）应用目录覆盖。动态工具目录只配置
        // 参数说明（顶层说明保留工厂动态产物），静态工具目录配置 description + parameters，
        // 未配置的工具保留原文（零拷贝返回原对象）。
        const lang = resolveLocalizationLanguage(getActualLanguage());
        return localizeToolDeclaration(declaration, getToolDescriptionLocalization(lang, tool.name));
    }

    private resolveMcpDeclarations(): ToolDeclaration[] {
        if (!this.mcpManager) {
            return [];
        }

        const lang = resolveLocalizationLanguage(getActualLanguage());
        const tools: ToolDeclaration[] = [];
        const mcpTools = this.mcpManager.getAllTools();
        for (const serverTools of mcpTools) {
            for (const tool of serverTools.tools || []) {
                const toolName = encodeMcpToolName(serverTools.serverId, tool.name);
                const rawSchema = tool.inputSchema || { type: 'object', properties: {} };
                const schema = serverTools.cleanSchema
                    ? this.cleanJsonSchema(rawSchema)
                    : rawSchema;

                tools.push({
                    name: toolName,
                    // 服务端提供的 description 一律原样保留（不翻译）；仅缺省兜底文本按语言生成
                    description: tool.description ||
                        (lang === 'zh-CN' ? `MCP 工具：${tool.name}` : `MCP tool: ${tool.name}`),
                    parameters: schema
                });
            }
        }
        return tools;
    }

    private applyFinalFilters(
        tools: ToolDeclaration[],
        options: ToolDeclarationResolveOptions
    ): ToolDeclaration[] {
        let filtered = tools;

        if (options.excludeToolNames && options.excludeToolNames.length > 0) {
            const excludeSet = new Set(options.excludeToolNames);
            filtered = filtered.filter(tool => !excludeSet.has(tool.name));
        }

        if (options.allowlist && options.allowlist.length > 0) {
            const allowlistSet = new Set(options.allowlist);
            filtered = filtered.filter(tool => allowlistSet.has(tool.name));
        }

        if (options.denylist && options.denylist.length > 0) {
            const denylistSet = new Set(options.denylist);
            filtered = filtered.filter(tool => !denylistSet.has(tool.name));
        }

        const promptAllowlist = Array.isArray(options.promptModeSnapshot?.toolPolicy) && options.promptModeSnapshot.toolPolicy.length > 0
            ? options.promptModeSnapshot.toolPolicy
            : undefined;
        if (promptAllowlist && promptAllowlist.length > 0) {
            const promptAllowlistSet = new Set(promptAllowlist);
            filtered = filtered.filter(tool => promptAllowlistSet.has(tool.name));
        }

        // 受限模式（allowlist 授予 search_in_files 但未授予通用写工具）下，收敛
        // search_in_files 声明为只读：移除 replace 枚举与 replace 专属参数，
        // 让模型在声明层就看不到替换能力（运行时门 getToolRejectionReason 兜底）。
        // 声明缓存键含 toolPolicy，各模式声明互不污染。
        if (isSearchInFilesReplaceForbidden(promptAllowlist)) {
            // 只读说明按语言生成：zh-CN 中文，en/ja 英文（ja 映射 en）
            const readOnlyModeDescription = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN'
                ? '操作模式。当前模式只允许只读搜索，不可使用替换功能。'
                : 'Operation mode. This mode only permits read-only search; replace is not available in the current mode.';
            filtered = filtered.map(tool => {
                if (tool.name !== 'search_in_files') {
                    return tool;
                }
                const properties: Record<string, any> = { ...tool.parameters.properties };
                const modeProperty = properties.mode as { type?: string; enum?: string[]; description?: string; default?: string } | undefined;
                if (modeProperty && typeof modeProperty === 'object') {
                    properties.mode = {
                        ...modeProperty,
                        enum: ['search'],
                        description: readOnlyModeDescription
                    };
                }
                // replace 专属参数（replace 串、替换上限）一并移除
                delete properties.replace;
                delete properties.maxFiles;
                return { ...tool, parameters: { type: 'object', properties, required: tool.parameters.required } };
            });
        }

        return filtered;
    }

    /**
     * 清理 JSON Schema，移除目标模型普遍不接受的字段。
     *
     * 修改原因：主会话和 SubAgent 都会把工具声明发送给模型，schema 清理不能各写一份。
     * 修改方式：递归移除 `$schema` 和 `additionalProperties`。
     * 修改目的：避免 SubAgent 通过 toolOverrides 发送未经清理的 schema，导致 Gemini 等接口 400。
     */
    private cleanJsonSchema(schema: any): any {
        if (!schema || typeof schema !== 'object') {
            return schema;
        }

        if (Array.isArray(schema)) {
            return schema.map(item => this.cleanJsonSchema(item));
        }

        const cleaned: Record<string, any> = {};
        for (const [key, value] of Object.entries(schema)) {
            if (key === '$schema' || key === 'additionalProperties') {
                continue;
            }
            cleaned[key] = this.cleanJsonSchema(value);
        }
        return cleaned;
    }
}

