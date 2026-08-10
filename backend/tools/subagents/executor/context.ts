/**
 * 子代理执行器上下文存储与共享 ToolDeclarationResolver（按依赖引用身份缓存）。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

import type { SubAgentConfig, SubAgentExecutorContext } from '../types';
import type { ToolDeclaration } from '../../types';
import { ToolDeclarationResolver } from '../../../modules/channel/ToolDeclarationResolver';
import { MEMORY_TOOL_NAMES } from '../../memory';
import { TODO_TOOL_NAMES } from '../../todo';
import { agentLacksWriteCapability } from './capability';

/**
 * 子代理执行器上下文存储
 */
let executorContext: SubAgentExecutorContext | null = null;

/**
 * 子代理路径共享的 ToolDeclarationResolver（按依赖引用身份缓存）：
 * - 生产环境依赖（toolRegistry/settingsManager/mcpManager）是全局单例，同一依赖组合只建一个
 *   实例 → 注册到 McpManager 的事件监听器只有 3 个常驻，不再随每次 run 无界累积（H-1）；
 * - 同配置多次 run 复用同一实例的声明缓存（缓存键含 promptModeSnapshot 等 per-call 输入，
 *   配置变化自动命中不同条目，无陈旧风险）；
 * - 容量上限兜底：不同依赖组合（测试等场景）最多保留 TOOL_RESOLVER_CACHE_CAPACITY 个实例，
 *   超限 dispose 最久未用实例，释放其 MCP 监听器。
 */
const TOOL_RESOLVER_CACHE_CAPACITY = 4;
const sharedToolResolvers = new Map<string, ToolDeclarationResolver>();
/** 依赖对象 → 自增 id（WeakMap 不阻止 GC；对象销毁后条目自动消失，无泄漏） */
const resolverDepIds = new WeakMap<object, number>();
let resolverDepIdCounter = 0;

function toolResolverCacheKey(context: SubAgentExecutorContext): string {
    return `${refIdentity(context.toolRegistry)}|${refIdentity(context.settingsManager)}|${refIdentity(context.mcpManager)}`;
}

function refIdentity(value: unknown): string {
    if (!value || typeof value !== 'object') return String(value ?? '');
    let id = resolverDepIds.get(value);
    if (id === undefined) {
        id = ++resolverDepIdCounter;
        resolverDepIds.set(value, id);
    }
    return `#${id}`;
}

function getSharedToolResolver(context: SubAgentExecutorContext): ToolDeclarationResolver {
    const key = toolResolverCacheKey(context);
    const cached = sharedToolResolvers.get(key);
    if (cached) {
        // LRU 触碰
        sharedToolResolvers.delete(key);
        sharedToolResolvers.set(key, cached);
        return cached;
    }
    const resolver = new ToolDeclarationResolver(
        context.toolRegistry,
        context.settingsManager,
        context.mcpManager
    );
    sharedToolResolvers.set(key, resolver);
    if (sharedToolResolvers.size > TOOL_RESOLVER_CACHE_CAPACITY) {
        const oldestKey = sharedToolResolvers.keys().next().value;
        if (oldestKey !== undefined) {
            const oldest = sharedToolResolvers.get(oldestKey);
            // 注意：dispose 可能是 undefined（mock/旧实现），需用双重可选链
            oldest?.dispose?.();
            sharedToolResolvers.delete(oldestKey);
        }
    }
    return resolver;
}

/** 仅供测试/诊断：清理共享 resolver 缓存并释放全部 MCP 监听器 */
export function clearSharedToolResolvers(): void {
    for (const resolver of sharedToolResolvers.values()) {
        resolver.dispose?.();
    }
    sharedToolResolvers.clear();
}

/**
 * 设置执行器上下文
 * 
 * 应在应用启动时调用，注入所需的依赖
 */
export function setSubAgentExecutorContext(context: SubAgentExecutorContext): void {
    executorContext = context;
}

/**
 * 获取执行器上下文
 */
export function getSubAgentExecutorContext(): SubAgentExecutorContext | null {
    return executorContext;
}

/**
 * 根据配置获取可用工具列表
 */
export async function resolveSubAgentAvailableTools(
    config: SubAgentConfig,
    context: SubAgentExecutorContext
): Promise<ToolDeclaration[]> {
    if (!context.configManager) {
        throw new Error('SubAgent shared ToolDeclarationResolver requires configManager in executor context.');
    }

    const channelConfig = await context.configManager.getConfig(config.channel.channelId);
    if (!channelConfig) {
        throw new Error(`SubAgent channel config not found: ${config.channel.channelId}`);
    }

    const toolsConfig = config.tools;
    const mode = toolsConfig.mode;
    const includeBuiltins = mode !== 'mcp';
    const includeMcp = mode === 'all' || mode === 'mcp' || toolsConfig.includeMcp === true;
    const allowlist = mode === 'whitelist' ? (toolsConfig.whitelist || toolsConfig.list || []) : undefined;
    const denylist = mode === 'blacklist' ? (toolsConfig.blacklist || toolsConfig.list || []) : undefined;

    // 修改原因：SubAgent 过去直接读取 toolRegistry/MCP 并自己清理 schema，导致工具声明与主会话动态声明分叉。
    // 修改方式：统一委托 ToolDeclarationResolver，并把 SubAgent 自己的 provider config、工具白名单和黑名单作为输入。
    // 修改目的：read_file 多模态说明、图片工具过滤、MCP schema 清理等以后只需要升级一个入口。
    // H-1（修复）：不再每次 run 新建实例——构造函数会向 McpManager 单例注册监听器，
    // 无界新建会累积永久监听器；改用按依赖引用共享的实例（见 getSharedToolResolver）。
    const resolver = getSharedToolResolver(context);

    const resolved = resolver.resolve({
        multimodalEnabled: channelConfig.multimodalToolsEnabled,
        channelType: channelConfig.type,
        toolMode: channelConfig.toolMode,
        promptModeSnapshot: context.promptModeSnapshot,
        includeBuiltins,
        includeMcp,
        allowlist,
        denylist,
        // 修改原因：todo_write/todo_update 依赖主会话 ToolContext.conversationId 读写会话元数据，
        // 子代理执行路径不注入该值，声明了也必然失败并浪费迭代。
        // 修改方式：与 memory 工具一起从子代理可用工具中排除，主会话 todo 功能不受影响。
        // F2：不再排除 subagents——子 agent 需要能派生子子 agent（嵌套）；
        // subagents 工具不依赖 conversationId（General Worker 只依赖 channelConfigId），
        // 放开不会引入 todo 类的“声明了但必然失败”问题；深度上限由 subagents handler 在派发前校验。
        excludeToolNames: [...MEMORY_TOOL_NAMES, ...TODO_TOOL_NAMES]
    }) || [];

    // H-1（R4 复查）：对不具备完整写/执行能力的代理，从可用工具集中移除 subagents——
    // 防止只读/受限代理（blacklist 排除写工具、whitelist 缺写工具、mcp 等）派发
    // mode='all' 的 General Worker 获得自身没有的写/执行权限（权限逃逸）。
    // M-7：与 subagents.ts getAgentAvailableTools 共用 agentLacksWriteCapability 口径。
    if (agentLacksWriteCapability(toolsConfig)) {
        return resolved.filter(decl => decl.name !== 'subagents');
    }
    return resolved;
}
