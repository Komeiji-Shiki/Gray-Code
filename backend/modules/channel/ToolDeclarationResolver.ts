/**
 * LimCode - 工具声明解析器
 *
 * 修改原因：ChannelManager 和 SubAgent 过去各自生成工具声明，导致 read_file 多模态描述、图片工具过滤、MCP schema 清理等逻辑容易漏同步。
 * 修改方式：把原 ChannelManager.getFilteredTools 的核心逻辑抽成共享解析器，并提供工具来源、白名单、黑名单等通用过滤选项。
 * 修改目的：主会话和 SubAgent 都从同一个入口获取工具声明，避免以后主工具声明升级但 SubAgent 没有升级。
 */

import type { ToolDeclaration } from '../../tools/types';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { SettingsManager } from '../settings/SettingsManager';
import type { ResolvedPromptModeSnapshot } from '../settings/types';
import type { McpManager } from '../mcp/McpManager';
import { encodeMcpToolName } from '../mcp/mcpToolNameCodec';
import { createReadFileTool } from '../../tools/file/read_file';
import { createGenerateImageTool, createRemoveBackgroundTool, createCropImageTool, createResizeImageTool, createRotateImageTool } from '../../tools/media';
import { hasAvailableSubAgent } from '../../tools/subagents';

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
            hasAvailableSubAgent(),
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

    private buildDynamicBuiltinDeclaration(
        tool: ToolDeclaration,
        options: ToolDeclarationResolveOptions
    ): ToolDeclaration | null {
        let declaration: ToolDeclaration = { ...tool };
        const multimodalEnabled = options.multimodalEnabled;
        const channelType = options.channelType;
        const toolMode = options.toolMode;

        if (tool.name === 'read_file') {
            const dynamicTool = createReadFileTool(multimodalEnabled, channelType, toolMode);
            declaration = {
                ...declaration,
                description: dynamicTool.declaration.description,
                parameters: dynamicTool.declaration.parameters
            };
        }

        if (tool.name === 'generate_image') {
            const shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            const maxBatchTasks = imageConfig?.maxBatchTasks || 5;
            const maxImagesPerTask = imageConfig?.maxImagesPerTask || 1;
            const paramsConfig = {
                enableAspectRatio: imageConfig?.enableAspectRatio ?? false,
                forcedAspectRatio: imageConfig?.defaultAspectRatio || undefined,
                enableImageSize: imageConfig?.enableImageSize ?? false,
                forcedImageSize: imageConfig?.defaultImageSize || undefined
            };
            const dynamicTool = createGenerateImageTool(maxBatchTasks, maxImagesPerTask, paramsConfig);
            declaration = {
                ...declaration,
                description: dynamicTool.declaration.description,
                parameters: dynamicTool.declaration.parameters
            };
        }

        if (tool.name === 'remove_background') {
            const shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            const maxBatchTasks = imageConfig?.maxBatchTasks || 5;
            const dynamicTool = createRemoveBackgroundTool(maxBatchTasks);
            declaration = { ...declaration, description: dynamicTool.declaration.description };
        }

        if (tool.name === 'crop_image') {
            const shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            const maxBatchTasks = imageConfig?.maxBatchTasks || 10;
            const dynamicTool = createCropImageTool(maxBatchTasks);
            declaration = { ...declaration, description: dynamicTool.declaration.description };
        }

        if (tool.name === 'resize_image') {
            const shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            const maxBatchTasks = imageConfig?.maxBatchTasks || 10;
            const dynamicTool = createResizeImageTool(maxBatchTasks);
            declaration = { ...declaration, description: dynamicTool.declaration.description };
        }

        if (tool.name === 'rotate_image') {
            const shouldExclude = !multimodalEnabled ||
                (channelType === 'openai' && toolMode === 'function_call');
            if (shouldExclude) return null;

            const imageConfig = this.settingsManager?.getGenerateImageConfig();
            const maxBatchTasks = imageConfig?.maxBatchTasks || 10;
            const dynamicTool = createRotateImageTool(maxBatchTasks);
            declaration = { ...declaration, description: dynamicTool.declaration.description };
        }

        if (tool.name === 'subagents' && !hasAvailableSubAgent()) {
            return null;
        }

        return declaration;
    }

    private resolveMcpDeclarations(): ToolDeclaration[] {
        if (!this.mcpManager) {
            return [];
        }

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
                    description: tool.description || `MCP tool: ${tool.name}`,
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
