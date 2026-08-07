/**
 * SubAgents 执行器
 *
 * 提供子代理的默认执行逻辑
 */

import type {
    SubAgentConfig,
    SubAgentRequest,
    SubAgentResult,
    SubAgentToolCall,
    SubAgentExecutor,
    SubAgentExecutorContext,
    SubAgentExecutorFactory,
    SubAgentToolsConfig
} from './types';
import { DEFAULT_MAX_RUNTIME_S } from './types';
import type { ToolDeclaration } from '../types';
import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import { WRITE_TOOLS } from './presets';
import { MEMORY_TOOL_NAMES } from '../memory';
import { TODO_TOOL_NAMES } from '../todo';
import { StreamResponseProcessor, isAsyncGenerator } from '../../modules/api/chat/handlers';
import { ToolCallParserService } from '../../modules/api/chat/services/ToolCallParserService';
import type { Content, ContentPart } from '../../modules/conversation/types';
import type { ToolExecutionResult } from '../../modules/api/chat/utils';
import type { GenerateRequest } from '../../modules/channel/types';
import type { BaseChannelConfig } from '../../modules/config/configs/base';
import { extractMessageTokens, type UsageIndexMessage } from '../../modules/conversation/usageStats';
import { subAgentRunEventBus } from './runEventBus';
import type { SubAgentRunStatus } from './runEventBus';
import { subAgentRunController } from './runController';
import { subAgentConcurrencyLimiter, SubAgentQueueCancelledError } from './concurrencyLimiter';
import { fileWriteLockManager } from '../../core/fileWriteLockManager';
import { agentMailbox } from './agentMailbox';
import { markAiActive } from '../../modules/activity';

/**
 * 子代理内部工具执行结果。
 *
 * 修改原因：SubAgent 历史需要写入主 ToolExecutionService 生成的 functionResponse parts，不能只保存简化的 success/result/error。
 * 修改方式：在原有 result/success/error 外，携带 responseParts、toolResults 和 prompt 模式多模态附件。
 * 修改目的：让 read_file 图片、MCP 多模态和后续工具结果格式升级能被 SubAgent 自动继承。
 */
interface SubAgentExecutedToolCall {
    result: unknown;
    success: boolean;
    error?: string;
    responseParts?: ContentPart[];
    toolResults?: ToolExecutionResult[];
    multimodalAttachments?: ContentPart[];
}

/** 不响应 AbortSignal 的工具最多允许用于清理的时间；超时后 SubAgent 必须收敛终态。 */
export const SUBAGENT_TOOL_ABORT_GRACE_MS = 500;

type AbortableOperationOutcome<T> =
    | { status: 'completed'; value: T }
    | { status: 'failed'; error: unknown }
    | { status: 'aborted' };

async function waitForAbortableOperation<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    graceMs: number
): Promise<AbortableOperationOutcome<T>> {
    const settled = operation.then<AbortableOperationOutcome<T>, AbortableOperationOutcome<T>>(
        value => ({ status: 'completed', value }),
        error => ({ status: 'failed', error })
    );
    if (!signal) return await settled;

    let releaseAbortListener: () => void = () => undefined;
    const aborted = new Promise<AbortableOperationOutcome<T>>(resolve => {
        const onAbort = () => resolve({ status: 'aborted' });
        if (signal.aborted) {
            resolve({ status: 'aborted' });
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        releaseAbortListener = () => signal.removeEventListener('abort', onAbort);
    });

    const first = await Promise.race([settled, aborted]);
    releaseAbortListener();
    if (first.status !== 'aborted') return first;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = new Promise<AbortableOperationOutcome<T>>(resolve => {
        timer = setTimeout(() => resolve({ status: 'aborted' }), Math.max(0, graceMs));
    });
    const afterGrace = await Promise.race([settled, graceExpired]);
    if (timer) clearTimeout(timer);
    return afterGrace;
}

/**
 * F2：追加到子 agent system prompt 的中文说明。
 *
 * 修改原因：子 agent 现在可以使用 subagents 工具派生子子 agent，但大多数任务不需要；
 * 直接写进 executor 组装 prompt 的位置，所有子 agent（含 General Worker 与自定义提示词）统一生效。
 * 修改目的：引导模型只在真正需要独立复查或主模型明确指示时才嵌套派发，避免滥用。
 * 仅在本次 run 的工具集实际包含 subagents 时追加，白名单不含 subagents 的 agent 不收到该说明。
 */
const SUBAGENT_NESTING_PROMPT_NOTICE = [
    '',
    '你可以使用 subagents 工具派生子 agent 协助工作，但一般不需要——仅当你的代码或输出需要另一个 agent 独立复查，或主模型明确下达指令时才使用。子 agent 的最终结果会汇总到你的输出，并最终返回给主模型。'
].join('\n');

/**
 * 工具调用纪律（一句话提示，无条件追加到所有子代理 systemPrompt）。
 *
 * 修改原因：模型可能在工具结果返回前输出基于猜测的内容断言（幻觉预生成），
 * 代码层已忽略"工具调用之后的尾巴文本"兜底；提示词从源头约束降低触发概率。
 * 修改目的：一句话轻量引导，不越俎代庖——详细的工具纪律交给用户自定义 systemPrompt。
 */
const SUBAGENT_TOOL_DISCIPLINE_NOTICE = [
    '',
    'Before tool results return, do not state content facts you have not verified — plan first, call tools, then describe what the results actually show.'
].join('\n');

/**
 * 写/执行类工具集合（H-1 / M-7 共享口径）。
 *
 * subagents 工具派发的 General Worker 是 mode='all'（全量非 memory 工具），
 * 若父代理自身缺少任一写/执行工具，嵌套派发会让子代理获得父代理没有的能力
 * （绕过只读沙箱）。因此只有「完整拥有本集合全部工具」的子代理才允许持有
 * subagents 工具；不具备的代理直接把 subagents 从可用工具集中移除。
 */
export const WRITE_CAPABILITY_TOOLS = [...WRITE_TOOLS, 'execute_command'];

/**
 * H1-4：子代理发给子模型的 history 剥离已投递的 agentInbox，防重放。
 *
 * 背景：子代理本地 history 直进 formatter（不经 formatHistoryForAPI），工具结果里的
 * agentInbox（本 run 信箱已 drain 的消息）会被原样发给子模型。同 run 后续迭代与
 * continueFromRunId 续跑都会重放这些已投递消息（prompt 膨胀、模型可能重复响应）。
 *
 * 语义（与主路径 formatHistoryForAPI「当轮保留、跨轮剥离」对齐）：只保留**最后一条**
 * 消息中尚未投递过的 agentInbox——工具结果入 history 后第一次发给子模型的请求即是投递；
 * 更早条目中的 agentInbox 一律剥离。只做浅拷贝（functionResponse.response 内其余字段
 * 原样引用），不改写持久化 transcript。
 */
export function stripReplayedAgentInboxForModel(history: Content[]): Content[] {
    const lastIndex = history.length - 1;
    let changed = false;
    const stripped = history.map((message, index) => {
        if (index === lastIndex || !message.parts?.some(part => part.functionResponse)) {
            return message;
        }
        const newParts: ContentPart[] = [];
        let partsChanged = false;
        for (const part of message.parts) {
            if (!part.functionResponse) {
                newParts.push(part);
                continue;
            }
            const response = part.functionResponse.response;
            if (!response || typeof response !== 'object' || Array.isArray(response)) {
                newParts.push(part);
                continue;
            }
            const cleaned = { ...(response as Record<string, unknown>) };
            delete cleaned.agentInbox;
            if (cleaned.data && typeof cleaned.data === 'object' && !Array.isArray(cleaned.data)) {
                cleaned.data = { ...(cleaned.data as Record<string, unknown>) };
                delete (cleaned.data as Record<string, unknown>).agentInbox;
            }
            newParts.push({
                ...part,
                functionResponse: {
                    ...part.functionResponse,
                    response: cleaned
                }
            });
            partsChanged = true;
        }
        if (!partsChanged) {
            return message;
        }
        changed = true;
        return { ...message, parts: newParts };
    });
    return changed ? stripped : history;
}

/**
 * 判断子代理工具配置是否「不具备完整写/执行能力」（H-1，R4 复查）。
 *
 * - mode 'all' / 'builtin'：内置工具含全部写/执行工具 → 具备
 * - mode 'mcp'：无内置写/执行工具 → 不具备
 * - mode 'whitelist'：白名单必须包含全部写/执行工具才具备
 * - mode 'blacklist'：黑名单命中任一写/执行工具即不具备
 *
 * M-7（R4 复查）：本函数是 subagents.ts getAgentAvailableTools（同步声明路径）与
 * resolveSubAgentAvailableTools（本文件，异步 resolver 路径）共用的裁剪口径，
 * 两侧对 subagents 工具的去留保持一致，避免声明描述与实际工具集分叉。
 */
export function agentLacksWriteCapability(toolsConfig: SubAgentToolsConfig): boolean {
    switch (toolsConfig.mode) {
        case 'all':
        case 'builtin':
            return false;
        case 'mcp':
            return true;
        case 'whitelist': {
            const whitelist = new Set(toolsConfig.whitelist || toolsConfig.list || []);
            return !WRITE_CAPABILITY_TOOLS.every(tool => whitelist.has(tool));
        }
        case 'blacklist': {
            const blacklist = new Set(toolsConfig.blacklist || toolsConfig.list || []);
            return WRITE_CAPABILITY_TOOLS.some(tool => blacklist.has(tool));
        }
        default:
            return true;
    }
}

/**
 * 父 run 可用工具注册表（H-1，R4 复查）。
 *
 * 嵌套派发时，subagents handler 需要把「父 run 实际允许的工具集」传播给子 run：
 * 子 run 最终可用工具 = 子配置解析结果 ∩ 父 run 可用工具，避免子代理（尤其是
 * mode='all' 的 General Worker）获得父代理自身没有的写/执行权限。
 * 由于 ToolExecutionService 的 toolContext 无法携带额外字段（文件边界限制），
 * 这里用 runId 索引父 run 的可用工具集：executor 在解析出工具后注册（
 * setRunAllowedTools），run 结束时在最外层 finally 清理（clearRunAllowedTools）；
 * 主模型直接派发（无 mailboxRunId）不走此表。
 */
const runAllowedToolsRegistry = new Map<string, Set<string>>();

/** 注册某个 run 实际允许的工具名集合（供嵌套派发时继承） */
export function setRunAllowedTools(runId: string, tools: Set<string>): void {
    runAllowedToolsRegistry.set(runId, tools);
}

/** 读取某个 run 实际允许的工具名集合（不存在时返回 undefined） */
export function getRunAllowedTools(runId: string): Set<string> | undefined {
    return runAllowedToolsRegistry.get(runId);
}

/** run 结束时清理其工具限制登记，避免内存残留 */
export function clearRunAllowedTools(runId: string): void {
    runAllowedToolsRegistry.delete(runId);
}

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

    // 危险工具防护：子代理是无人值守的（没有逐工具确认层），execute_command /
    // delete_file 默认对子代理不可用——除非用户在 whitelist 模式下显式列出它们。
    // 这保证「主会话需确认才执行」的危险操作不会被子代理静默执行
    // （如恶意仓库内容诱导主模型派发子代理后直接跑任意命令）。
    const SUBAGENT_DEFAULT_BLOCKED_TOOLS = ['execute_command', 'delete_file'];
    const blockedByDefault = SUBAGENT_DEFAULT_BLOCKED_TOOLS.filter(
        toolName => !(mode === 'whitelist' && (allowlist || []).includes(toolName))
    );

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
        // 放开不会引入 todo 类的"声明了但必然失败"问题；深度上限由 subagents handler 在派发前校验。
        // 安全加固：危险工具（execute_command/delete_file）默认排除，whitelist 显式列出时放行。
        excludeToolNames: [...MEMORY_TOOL_NAMES, ...TODO_TOOL_NAMES, ...blockedByDefault]
    }) || [];

    // H-1：resolver 生命周期由 getSharedToolResolver 的 LRU 缓存管理
    // （容量淘汰 / clearSharedToolResolvers 时 dispose），解析后不得释放，
    // 否则共享缓存失效、监听器随每次 run 重新累积。

    // H-1（R4 复查）：对不具备完整写/执行能力的代理，从可用工具集中移除 subagents——
    // 防止只读/受限代理（blacklist 排除写工具、whitelist 缺写工具、mcp 等）派发
    // mode='all' 的 General Worker 获得自身没有的写/执行权限（权限逃逸）。
    // M-7：与 subagents.ts getAgentAvailableTools 共用 agentLacksWriteCapability 口径。
    if (agentLacksWriteCapability(toolsConfig)) {
        return resolved.filter(decl => decl.name !== 'subagents');
    }
    return resolved;
}

/**
 * 执行单个工具调用
 */
async function executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SubAgentExecutorContext,
    abortSignal?: AbortSignal,
    allowedToolNames?: Set<string>,
    agentConfig?: SubAgentConfig,
    callId?: string,
    runId?: string,
    agentName?: string,
    mailboxConversationId?: string,
    nestingDepth?: number
): Promise<SubAgentExecutedToolCall> {
    const executionCall = {
        id: callId || `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        args
    };
    const actualRunId = runId || executionCall.id;
    const emitToolFailure = (error: string, payload?: Record<string, unknown>) => {
        // 修改原因：Monitor 工具卡现在会消费 tool_started/tool_failed 事件；异常或早退路径不能只返回 functionResponse 后再等窗口刷新。
        // 修改方式：在所有已知失败路径统一发 tool_failed，payload 保持轻量，只带错误和必要状态字段。
        // 修改目的：工具执行失败时 UI 能立即进入 error，不会长期卡在 executing/queued。
        subAgentRunEventBus.emit({
            runId: actualRunId,
            agentName,
            type: 'tool_failed',
            toolId: executionCall.id,
            toolName,
            payload: { success: false, error, ...(payload || {}) }
        });
    };

    try {
        // 检查是否取消
        if (abortSignal?.aborted) {
            emitToolFailure('Cancelled', { cancelled: true });
            return {
                result: null,
                success: false,
                error: 'Cancelled'
            };
        }

        // 校验子代理自身的工具白名单
        // 即使 AI 不应该调用不在列表里的工具，这里做防御性校验。
        // M-6（R4 复查）：allowedToolNames 为空 Set 时语义是「本 run 无任何可用工具」，
        // 必须拒绝一切工具调用；旧实现 `size > 0` 才校验会把空集错误地当成「不校验」。
        if (allowedToolNames) {
            if (!allowedToolNames.has(toolName)) {
                const error = `Tool not allowed for this sub-agent: ${toolName}`;
                emitToolFailure(error);
                return {
                    result: null,
                    success: false,
                    error
                };
            }
        }

        if (!context.toolExecutionService || !context.configManager || !agentConfig) {
            const error = 'SubAgent shared ToolExecutionService/configManager is missing. Refusing to use legacy fallback execution.';
            emitToolFailure(error);
            return {
                result: null,
                success: false,
                error
            };
        }

        // 修改原因（SEC）：子代理过去无条件执行工具，用户配置需要确认的工具（delete_file /
        // execute_command 等 toolAutoExec=false）被直接执行，绕过主链路的确认门。
        // 修改方式：与主链路共用 toolNeedsConfirmation 判定——子代理执行时没有与用户交互的
        // 确认通道，需要确认的工具直接拒绝并把明确原因回给子模型（模型会转达主模型代为执行）。
        // fail-closed：共享执行服务缺少确认门（异常注入/不完整实现）时同样拒绝执行，
        // 不允许静默放行造成安全门缺失。
        // 修改目的：子代理不再能绕过用户的危险工具确认设置。
        // 注意：必须以方法形式调用（toolExecutionService.toolNeedsConfirmation(...)）——
        // 该方法内部依赖 this（getToolRejectionReason/settingsManager），解绑为裸函数调用
        // 会让 this 为 undefined，抛 "Cannot read properties of undefined (reading 'getToolRejectionReason')"。
        const toolExecutionService = context.toolExecutionService;
        const confirmationRefusal = typeof toolExecutionService.toolNeedsConfirmation === 'function'
            ? (toolExecutionService.toolNeedsConfirmation(toolName, args, context.promptModeSnapshot)
                ? `Tool "${toolName}" requires user confirmation and cannot be executed automatically by a sub-agent. `
                + `Ask the main model to perform this action.`
                : undefined)
            : `Tool "${toolName}" cannot be executed: the shared tool execution service does not provide a `
            + `confirmation gate. Ask the main model to perform this action.`;
        if (confirmationRefusal) {
            emitToolFailure(confirmationRefusal);
            return {
                result: null,
                success: false,
                error: confirmationRefusal
            };
        }

        const channelConfig = await context.configManager.getConfig(agentConfig.channel.channelId);
        if (!channelConfig) {
            const error = `SubAgent channel config not found: ${agentConfig.channel.channelId}`;
            emitToolFailure(error);
            return {
                result: null,
                success: false,
                error
            };
        }

            subAgentRunEventBus.emit({
                runId: actualRunId,
                agentName,
                type: 'tool_started',
                toolId: executionCall.id,
                toolName,
                payload: { args }
            });

            // 修改原因：SubAgent 不能再复制主工具执行逻辑，否则多模态、MCP、工具配置和参数校验会继续分叉。
            // 修改方式：优先调用 ChatHandler 注入的 ToolExecutionService，并传入 SubAgent 自己的 provider config。
            // 修改目的：让 SubAgent 内部工具调用和主会话工具调用共享同一套执行、校验和 functionResponse 打包逻辑。
            const toolExecution = context.toolExecutionService.executeFunctionCallsWithResults(
                [executionCall],
                undefined,
                undefined,
                channelConfig || undefined,
                abortSignal,
                context.promptModeSnapshot,
                (event) => subAgentRunEventBus.emit({
                    ...event,
                    runId: actualRunId,
                    agentName
                }),
                undefined,
                // 修改原因：文件写锁需要知道执行归属，才能在撞车提示中告知对方是哪个 agent 在占用。
                // 修改方式：SubAgent 链路显式传入 subagent 归属（runId + agent 名称）。
                // 修改目的：主会话与各 SubAgent 在同一把全局锁上互斥，提示文案可追溯到具体持有者。
                { kind: 'subagent', id: actualRunId, label: agentName || 'sub-agent' },
                // A-COMM：子代理信箱按主会话 conversationId + 本 run runId 挂载（conversationId 参数保持 undefined，
                // 避免子代理工具调用意外获得主会话 conversationId 而改变既有工具行为）。
                mailboxConversationId,
                actualRunId,
                // F2：把本 run 的嵌套深度随工具上下文透传（ToolExecutionService 注入 toolContext.subagentDepth），
                // 子代理内部的 subagents 工具调用据此得知父 run 深度（见 subagents.ts executeSubAgent）。
                nestingDepth,
                // 多工作区支持：子代理继承主会话绑定的工作区，路径解析/终端 cwd 与主会话保持一致
                context.activeWorkspaceUri
            );
            const executionOutcome = await waitForAbortableOperation(
                toolExecution,
                abortSignal,
                SUBAGENT_TOOL_ABORT_GRACE_MS
            );
            if (executionOutcome.status === 'aborted') {
                const error = 'Cancelled (tool did not stop within the abort grace period)';
                emitToolFailure(error, { cancelled: true });
                return {
                    result: { success: false, cancelled: true, error },
                    success: false,
                    error
                };
            }
            if (executionOutcome.status === 'failed') {
                throw executionOutcome.error;
            }
            const fullResult = executionOutcome.value;

            const toolResult = fullResult.toolResults?.[0];
            const resultPayload: Record<string, unknown> = toolResult?.result ?? { success: false, error: `Tool produced no result: ${toolName}` };
            const success = !(
                resultPayload.success === false ||
                resultPayload.error ||
                resultPayload.cancelled ||
                resultPayload.rejected
            );
            const error = typeof resultPayload.error === 'string'
                ? resultPayload.error
                : undefined;

            subAgentRunEventBus.emit({
                runId: actualRunId,
                agentName,
                type: success ? 'tool_completed' : 'tool_failed',
                toolId: executionCall.id,
                toolName,
                payload: toolResult
            });

            return {
                result: resultPayload,
                success,
                error,
                responseParts: fullResult.responseParts,
                toolResults: fullResult.toolResults,
                multimodalAttachments: fullResult.multimodalAttachments
            };
    } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        emitToolFailure(error);
        return {
            result: null,
            success: false,
            error
        };
    }
}

/**
 * 提取 AI 响应的文本内容（排除思考内容）
 * 
 * 支持标准化的 GenerateResponse 格式
 */
function extractTextContent(response: any): string {
    // 标准化格式: response.content.parts
    if (response?.content?.parts) {
        const textParts = response.content.parts
            // 过滤掉思考内容（thought: true）和非文本内容
            .filter((part: any) => part.text && !part.thought)
            .map((part: any) => part.text);
        if (textParts.length > 0) {
            return textParts.join('\n');
        }
    }
    
    // Gemini 原始格式
    if (response?.candidates?.[0]?.content?.parts) {
        const textParts = response.candidates[0].content.parts
            .filter((part: any) => part.text && !part.thought)
            .map((part: any) => part.text);
        return textParts.join('\n');
    }
    
    // OpenAI 格式
    if (response?.choices?.[0]?.message?.content) {
        return response.choices[0].message.content;
    }
    
    // Anthropic 格式
    if (response?.content && Array.isArray(response.content)) {
        const textBlocks = response.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text);
        return textBlocks.join('\n');
    }
    
    return '';
}

/**
 * 把本轮 LLM 调用的 usageMetadata 转换为 UsageIndexMessage（source='subagent'），
 * 归集到发起它的主会话用量索引。
 *
 * 修改原因：子代理消耗的 token 此前不进入任何用量统计，UsagePage 看不到子代理开销。
 * 修改方式：从 response.content.usageMetadata 提取 token（复用主链路 extractMessageTokens
 *           同一套语义），经上下文注入的 usageIndexAppend 追加到主会话索引；
 *           无主会话归属或未注入回调时跳过（不写索引）。
 * 修改目的：主会话用量统计包含其派发的所有子代理消耗，且可通过 source 细分。
 */
async function reportUsageToMainConversation(
    response: any,
    conversationId: string | undefined,
    usageIndexAppend: SubAgentExecutorContext['usageIndexAppend']
): Promise<void> {
    if (!conversationId) {
        // 子代理无主会话归属：跳过归集（不写索引）
        console.debug('[SubAgent] Usage attribution skipped: no main conversation id for this run.');
        return;
    }
    if (typeof usageIndexAppend !== 'function') return;
    const usage = response?.content?.usageMetadata as Content['usageMetadata'] | undefined;
    if (!usage) return;
    const tokens = extractMessageTokens({ role: 'model', parts: [], usageMetadata: usage } as Content);
    if (!tokens) return;
    const entry: UsageIndexMessage = {
        timestamp: Date.now(),
        modelVersion: (response?.content?.modelVersion || '').trim(),
        ...tokens,
        source: 'subagent'
    };
    try {
        await usageIndexAppend(conversationId, [entry]);
    } catch (e) {
        // 归集失败不打断子代理主流程
        console.debug(`[SubAgent] Failed to attribute usage to conversation ${conversationId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * 识别「上下文超限」类错误。
 *
 * 子代理没有接主链路的 ContextTrimService，历史上只增不减会撞上模型上下文上限。
 * 现在发送前有请求级防御性裁剪（trimSubAgentHistoryForContext），但识别错误仍是
 * 兜底防线（模型/上游措辞不同，裁剪不可能覆盖全部场景）。各家 provider 措辞不同
 * 但都认得出来。不做识别的话，用户只能看到一句原样透传的 `AI call failed: ...`，
 * 既不知道是撞了上下文，也不知道该去调哪个配置。
 */
function isContextLengthError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes('context length')
        || message.includes('context_length')
        || message.includes('maximum context')
        || message.includes('context window')
        || message.includes('too many tokens')
        || message.includes('prompt is too long')
        || message.includes('reduce the length of the messages');
}

/**
 * 子代理请求级上下文裁剪（SEC：子代理无 ContextTrimService，history 只增不减，
 * 长任务会撞上模型上下文上限直接失败；裁剪在发送前对本次请求生效，不改动
 * run 内部持有的原 history，也不影响事件总线/续跑记录）。
 *
 * 策略：
 * - 预算 = 渠道 maxContextTokens（缺省 128000）× 0.8，为模型输出与工具声明留余量；
 * - 超预算时从最旧开始整轮丢弃：functionResponse 必须与其配对的 model 消息一起移除
 *   （单独丢会留下孤儿 functionResponse，部分 provider 直接报错）；首条用户任务
 *   消息与末尾两轮始终保留；
 * - 仍超预算（单条巨型工具结果/文本）时，对超大字符串原地截断并标记截断，保留结构。
 */
const SUBAGENT_CONTEXT_BUDGET_DEFAULT_TOKENS = 128000;
const SUBAGENT_CONTEXT_BUDGET_RATIO = 0.8;
/** 单条字符串保留上限（约 5 万 token），超过即截断并标记 */
const SUBAGENT_MAX_SINGLE_STRING_CHARS = 200000;

function hasFunctionResponseParts(message: Content): boolean {
    return (message.parts || []).some(part => !!part.functionResponse);
}

/**
 * 本地 token 估算：口径与主链路对齐——
 * - 文本按「4 字符 ≈ 1 token」计算（主链路 TokenEstimationService 同口径）；
 * - 估算含 1.5× 安全系数（主链路 applyLocalEstimateSafetyFactor 同系数），
 *   多模态 part 按主链路 estimateMultimodalTokens 的近似下界折算
 *   （inlineData 图片 ≥500 token、fileData 引用按 300 token），避免图像/视频密集
 *   的工具结果被低估导致裁剪触发过晚；
 * - 序列化失败（工具结果含 BigInt 等不可 JSON 序列化对象）不抛错，按固定开销兜底——
 *   估算只服务于裁剪决策，不能因估算失败打断整个 run。
 */
const SUBAGENT_TOKEN_SAFETY_FACTOR = 1.5;

function estimateMessageTokens(message: Content): number {
    let tokens = 4; // 消息级开销（role 等）
    for (const part of message.parts || []) {
        if (part.text) {
            tokens += Math.ceil(part.text.length / 4) + 1;
        } else if (part.functionResponse) {
            tokens += safeStringifyTokens(part.functionResponse);
        } else if (part.functionCall) {
            tokens += safeStringifyTokens(part.functionCall);
        } else if (part.inlineData?.data) {
            tokens += 500 + Math.ceil(part.inlineData.data.length / 4); // base64 数据按 4 字符/token 折算
        } else if (part.fileData?.fileUri) {
            tokens += 300;
        } else {
            tokens += 8; // 未知 part 固定开销
        }
    }
    return Math.ceil(tokens * SUBAGENT_TOKEN_SAFETY_FACTOR);
}

/** 序列化 part 估算 token；不可序列化（BigInt/循环引用等）按固定开销兜底，不抛错 */
function safeStringifyTokens(value: unknown): number {
    try {
        return Math.ceil(JSON.stringify(value).length / 4) + 1;
    } catch {
        return 64; // 序列化失败兜底：按一条中等大小消息的开销估算
    }
}

/** 深度截断超过上限的字符串（保留 JSON 结构，最大递归深度 3 层） */
function truncateOversizedStrings(value: unknown, depth: number): unknown {
    if (typeof value === 'string') {
        if (value.length > SUBAGENT_MAX_SINGLE_STRING_CHARS) {
            return value.slice(0, SUBAGENT_MAX_SINGLE_STRING_CHARS)
                + `…[sub-agent context trim: truncated ${value.length} chars]`;
        }
        return value;
    }
    if (depth <= 0) return value;
    if (Array.isArray(value)) {
        return value.map(item => truncateOversizedStrings(item, depth - 1));
    }
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = truncateOversizedStrings(item, depth - 1);
        }
        return result;
    }
    return value;
}

function truncateOversizedParts(history: Content[]): void {
    for (const message of history) {
        for (const part of message.parts || []) {
            if (part.text) {
                part.text = truncateOversizedStrings(part.text, 0) as string;
            }
            if (part.functionCall) {
                part.functionCall = {
                    ...part.functionCall,
                    args: truncateOversizedStrings(part.functionCall.args, 3) as Record<string, unknown>
                };
            }
            if (part.functionResponse) {
                part.functionResponse = {
                    ...part.functionResponse,
                    response: truncateOversizedStrings(part.functionResponse.response, 3) as Record<string, unknown>
                };
            }
        }
    }
}

export function trimSubAgentHistoryForContext(history: Content[], channelConfig: BaseChannelConfig): Content[] {
    const maxContextTokens = typeof channelConfig.maxContextTokens === 'number' && channelConfig.maxContextTokens > 0
        ? channelConfig.maxContextTokens
        : SUBAGENT_CONTEXT_BUDGET_DEFAULT_TOKENS;
    const budget = Math.floor(maxContextTokens * SUBAGENT_CONTEXT_BUDGET_RATIO);
    if (budget <= 0 || history.length <= 1) {
        return history;
    }
    const perMessageTokens = history.map(estimateMessageTokens);
    const total = perMessageTokens.reduce((sum, tokens) => sum + tokens, 0);
    if (total <= budget) {
        return history;
    }

    // 从最旧开始整轮丢弃：函数响应必须与其配对的 model 消息一起移除（不产生孤儿，
    // 部分 provider 对孤立 functionResponse 直接报错）。前提：executor 的 history 形态
    // 不变量是「model 调用消息与其 functionResponse 消息严格相邻」（见下方 push 逻辑），
    // dropPair 只检查相邻下一条；若未来形态变化，防御性 break 会保守地停止丢弃。
    // 循环从 index 1 开始，首条任务消息（index 0）在裁剪后重新前置、始终保留；
    // 末尾两轮（含配对）由 i < history.length - 2 保证不进入丢弃范围。
    // 停止条件：再丢一轮就会低于预算时停止（尽量保留内容），结果可能仍略超预算——
    // 由超大字符串截断与 isContextLengthError 兜底文案继续收敛，不追求精确填满预算。
    let keepFrom = 0;
    let remaining = total;
    for (let i = 1; i < history.length - 2 && remaining > budget; ) {
        const message = history[i];
        if (message.role === 'user' && hasFunctionResponseParts(message)) {
            break; // 防御：函数响应不应单独出现在丢弃位（配对总是整轮消费）
        }
        const next = history[i + 1];
        const dropPair = !!next && next.role === 'user' && hasFunctionResponseParts(next);
        const cost = perMessageTokens[i] + (dropPair ? perMessageTokens[i + 1] : 0);
        if (remaining - cost <= budget) {
            break;
        }
        remaining -= cost;
        i += dropPair ? 2 : 1;
        keepFrom = i;
    }

    // 裁剪结果深拷贝后截断：不修改 run 内后续轮继续使用的原 history 引用。
    // 深拷贝失败（工具结果含 BigInt 等不可序列化内容）时放弃截断、仅做引用裁剪：
    // 裁剪决策与请求发送都不应被序列化能力限制打断。
    let trimmed: Content[];
    try {
        trimmed = JSON.parse(JSON.stringify(
            keepFrom > 0 ? [history[0], ...history.slice(keepFrom)] : history
        )) as Content[];
        truncateOversizedParts(trimmed);
    } catch {
        trimmed = keepFrom > 0 ? [history[0], ...history.slice(keepFrom)] : history;
    }
    return trimmed;
}

/**
 * 创建默认子代理执行器
 */
export function createDefaultExecutor(
    config: SubAgentConfig,
    context: SubAgentExecutorContext
): SubAgentExecutor {
    return async (request: SubAgentRequest, abortSignal?: AbortSignal): Promise<SubAgentResult> => {
        const toolCalls: SubAgentToolCall[] = [];
        let steps = 0;
        let modelVersion: string | undefined;
        // 修改原因：主聊天卡片和 Monitor 需要用稳定 ID 关联同一次 SubAgent 运行，但 pending 阶段前端还拿不到最终 ToolResult。
        // 修改方式：优先使用 handler 根据主工具调用 id 预分配的 runId；没有外部 runId 时才回退为本地随机 runId。
        // 修改目的：让 pending、完成态和历史态的 Open details 都能定位同一次运行，同时兼容非主聊天入口。
        const requestedRunId = typeof request.runId === 'string' && request.runId.trim() ? request.runId.trim() : undefined;
        // 预分配的 runId 可能撞上同一 toolId 上一次仍在运行的 run，交给事件总线判重
        // 修改原因：续跑必须复用旧 runId——run 记录、transcript、provider 缓存域三位一体；
        //          用新 runId 会在 Monitor 里出现第二条记录，续跑退化为「新 run 前置旧 transcript」。
        // 修改方式：continueFromRunId 存在时直接沿用旧 runId（快照存在性已由上方续跑校验保证），
        //          普通新 run 仍走 allocateRunId 判重。
        const runId = request.continueFromRunId
            ? request.continueFromRunId
            : subAgentRunEventBus.allocateRunId(
                requestedRunId || `subagent_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            );

        // F2：嵌套深度——由派发方（subagents handler）按“父深度 + 1”计算后随 request 传入；
        // 缺省按 0（主模型直接派发）处理。深度用于：超限校验已在 handler 完成，这里负责
        // 写入 run 元数据（run_created payload + runController 记录）供 Monitor 展示，
        // 并随工具执行上下文透传给下一层 subagents 工具调用。
        const depth = Number.isInteger(request.depth) && (request.depth ?? 0) >= 0
            ? Math.floor(request.depth!)
            : 0;

        // 修改原因：子代理对话延续——允许新子代理继承旧 run 的完整 transcript，实现跨调用的对话接力。
        // 修改方式：从 runEventBus 读取旧 run 的 contents 作为 baseContents；校验旧 run 已处于终态。
        // 修改目的：主模型可通过 continueFromRunId 参数指定延续目标，避免每次从零开始。
        const terminalStatuses: SubAgentRunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];
        // F-06/F-09：每次调用的动态会话上下文优先于创建 executor 时的静态 context。
        // 修改原因：接续必须限定在同一个主对话内，且重载/内存淘汰后要从当前对话的
        // 持久化元数据恢复 run 快照；这些信息属于每次工具调用，不能固定在 Registry 缓存。
        const currentConversationId = request.conversationId ?? context.conversationId;
        const currentConversationStore = request.conversationStore ?? context.conversationStore;
        const currentPromptModeSnapshot = request.promptModeSnapshot ?? context.promptModeSnapshot;

        let baseContents: Content[] = [];
        if (request.continueFromRunId) {
            // F-09：先查内存快照；未命中且当前调用可提供对话 store 时，
            // 只加载当前对话的持久化快照（不扫描其他对话，避免 runId 跨对话碰撞）。
            let oldSnapshot = subAgentRunEventBus.getSnapshot(request.continueFromRunId);
            if (!oldSnapshot && currentConversationId && currentConversationStore) {
                await subAgentRunEventBus.loadConversationSnapshots(currentConversationId, currentConversationStore);
                oldSnapshot = subAgentRunEventBus.getSnapshot(request.continueFromRunId);
            }
            if (oldSnapshot?.transcriptLoaded === false) {
                oldSnapshot = await subAgentRunEventBus.loadRunTranscript(request.continueFromRunId);
            }
            if (!oldSnapshot) {
                return {
                    success: false,
                    runId,
                    error: `Cannot continue from run "${request.continueFromRunId}": run not found. It may have been cleared or never existed.`
                };
            }
            // F-06：会话归属校验——旧 run 已绑定 conversationId 且与当前不一致时拒绝，
            // 防止跨对话泄漏 transcript（错误信息不包含旧对话 ID 或任何内容）。
            if (oldSnapshot.conversationId && currentConversationId && oldSnapshot.conversationId !== currentConversationId) {
                return {
                    success: false,
                    runId,
                    error: `Cannot continue from run "${request.continueFromRunId}": the run belongs to a different conversation.`
                };
            }
            if (!terminalStatuses.includes(oldSnapshot.status)) {
                return {
                    success: false,
                    runId,
                    error: `Cannot continue from run "${request.continueFromRunId}": the run is still ${oldSnapshot.status}. Only terminal runs (completed / failed / cancelled) can be continued.`
                };
            }
            // 修改原因：续跑必须以「旧 run 最后一次实际发送给 provider 的 history」为前缀，
            //         而不是 Monitor 展示用的 contents——contents 首条是 # SubAgent Invocation 卡片，
            //         从未发给模型；以 contents 续跑会让请求前缀从第 0 条就与旧 run 不同，
            //         provider 前缀缓存（DeepSeek KVCache / Anthropic user_id 域）必然 miss。
            // 修改方式：优先取 oldSnapshot.lastSentHistory（深拷贝，保证与旧 run 实际发送逐条一致）；
            //          旧记录缺该字段时降级为从 contents 过滤掉含 '# SubAgent Invocation' 的
            //          初始卡片消息，其余保留（至少不再把卡片发给模型）。
            // 修改目的：continueFromRunId 续跑能命中旧 run 的 provider 前缀缓存，不浪费首轮 token。
            if (Array.isArray(oldSnapshot.lastSentHistory)) {
                baseContents = JSON.parse(JSON.stringify(oldSnapshot.lastSentHistory)) as Content[];
            } else {
                baseContents = JSON.parse(JSON.stringify(
                    (oldSnapshot.contents || []).filter(
                        content => !(content.parts || []).some(
                            part => typeof part.text === 'string' && part.text.includes('# SubAgent Invocation')
                        )
                    )
                )) as Content[];
            }
        }

        const initialPromptContent: Content = {
            role: 'user',
            parts: [{
                text: [
                    '# SubAgent Invocation',
                    '',
                    '## Agent System Prompt',
                    config.systemPrompt || '(empty)',
                    '',
                    request.context ? '## Context' : '',
                    request.context || '',
                    request.context ? '' : '',
                    '## User Prompt',
                    request.prompt
                ].filter(Boolean).join('\n')
            }],
            isUserInput: true,
            timestamp: Date.now()
        } as Content;
        if (request.continueFromRunId) {
            // 续跑：复用旧快照继续（保留 contents/events/lastSentHistory，不重建 run），
            // 只追加本次的 Invocation 卡片；run_resumed 由 resumeRun 广播，Monitor 记录唯一。
            subAgentRunEventBus.resumeRun(runId, config.name, {
                depth
            }, {
                conversationId: currentConversationId,
                conversationStore: currentConversationStore,
                initialContents: [initialPromptContent]
            });
        } else {
            subAgentRunEventBus.createRun(runId, config.name, {
                agentType: request.agentType,
                prompt: request.prompt,
                context: request.context,
                // F2：深度随 run_created payload 暴露，Monitor 可按需展示嵌套层级。
                depth
            }, {
                conversationId: currentConversationId,
                conversationStore: currentConversationStore,
                initialContents: [...baseContents, initialPromptContent]
            });
        }
        // 修改原因：Monitor 顶部控制按钮只能控制仍在等待主窗口工具结果的活跃 run。
        // 修改方式：默认 executor 创建 run 后立即注册到 SubAgentRunController，完成/失败时在 finally 中注销。
        // 修改目的：让 Monitor 可以区分“可中止/退出”的活跃 run 和只能查看的历史 run。
        // F2：注册时携带嵌套深度；若本 run 由另一个子 agent 派生，同时登记父子关系，
        // 供父 run 结束时级联清理（见最外层 finally 的 cascadeExitChildren）。
        subAgentRunController.register(runId, config.name, depth, !request.background);
        if (request.parentRunId) {
            subAgentRunController.registerChild(request.parentRunId, runId);
        }

        // 转后台（detach）：用户发新消息时 StreamAbortManager 会把该会话前台 SubAgent 转为后台
        // （subAgentRunController.detachFromParent），本回调同步解绑父 abort 信号，run 继续执行；
        // 后续 createOperationSignal 不再组合父信号。后台模式（background:true）不注册——
        // 其 abort 信号本就独立于父轮，detach 不应影响 TaskManager 取消能力。
        let detachedFromParent = false;
        let currentOperationHandle: { detachParent: () => void } | undefined;
        // 转后台（detach）后父 abort 信号对 run 不再有约束力——所有取消检查必须经由
        // 本 helper 读取父信号（detached 后视为无父信号），否则 detach 后旧流 abort
        // 仍会在下一轮迭代/工具执行前杀死 run（R7c E1）。
        const parentAbort = (): AbortSignal | undefined => (detachedFromParent ? undefined : abortSignal);
        // acquire 桥的父信号部分与 run 控制信号部分分开管理（R7c E3）：detach 只摘父信号，
        // 保留 run 控制信号——排队中已转后台的 run 仍能被 Monitor pause/exit 唤醒。
        let releaseParentAcquireListener: (() => void) | undefined;
        if (!request.background) {
            subAgentRunController.registerDetachListener(runId, () => {
                detachedFromParent = true;
                try {
                    currentOperationHandle?.detachParent();
                    releaseParentAcquireListener?.();
                    // 父 abort 还会通过超时桥接器（onParentAbort → timeoutController.abort）传播，
                    // 必须一并摘除，否则 detach 后旧流 abort 仍会中止当前操作。
                    releaseParentAbortBridge?.();
                    releaseParentAbortBridge = undefined;
                } catch (err) {
                    console.warn(`[SubAgentExecutor] Failed to detach run ${runId} from parent signal:`, err);
                }
            });
        }

        // 修改原因：多个 SubAgent 并行派发时需要全局并发上限，超出的 run 必须排队而不是被拒绝。
        // 修改方式：createRun 后先 emit run_queued 进入排队状态，acquire 全局信号量成功后 emit run_started 恢复 running。
        // 修改目的：Monitor 能显示排队中；计时起点在 acquire 之后，排队时间不计入 maxRuntime。
        subAgentRunEventBus.emit({
            runId,
            agentName: config.name,
            type: 'run_queued',
            payload: {
                runningCount: subAgentConcurrencyLimiter.getRunningCount(),
                queueLength: subAgentConcurrencyLimiter.getQueueLength()
            }
        });
        // F2：排队等待席位时除了父 abortSignal，还要监听本 run 自己的控制信号——
        // 这样父 run 级联退出（cascadeExitChildren → exit(childRunId)）能唤醒排队中的子 run，
        // 而不是让它一直等到有席位释放。
        let acquireSignal: AbortSignal | undefined = abortSignal;
        let releaseAcquireSignal: (() => void) | undefined;
        const runControlSignal = subAgentRunController.getAbortSignal(runId);
        if (runControlSignal) {
            const acquireController = new AbortController();
            const onAcquireAbort = () => acquireController.abort();
            if (abortSignal && !detachedFromParent) {
                abortSignal.addEventListener('abort', onAcquireAbort, { once: true });
            }
            runControlSignal.addEventListener('abort', onAcquireAbort, { once: true });
            acquireSignal = acquireController.signal;
            releaseParentAcquireListener = () => {
                if (abortSignal) {
                    abortSignal.removeEventListener('abort', onAcquireAbort);
                }
            };
            const releaseRunControlAcquireListener = () => {
                runControlSignal.removeEventListener('abort', onAcquireAbort);
            };
            releaseAcquireSignal = () => {
                releaseParentAcquireListener?.();
                releaseRunControlAcquireListener();
            };
        }
        /**
         * SubAgent run 的唯一终态出口。
         *
         * 修改原因：超时、超迭代、AI 调用失败等早退路径过去既不发终态事件也不带 runId，
         *          导致 Monitor 里这些 run 永远停留在 running，主聊天卡片也无法定位运行详情。
         * 修改方式：所有返回路径统一经过本函数补齐 runId，并在事件总线尚未进入终态时补发对应终态事件。
         * 修改目的：run 状态机只有一个收敛点，新增早退分支不会再遗漏状态广播。
         */
        const finalizeRun = (result: SubAgentResult): SubAgentResult => {
            const finalized: SubAgentResult = { ...result, runId };
            const snapshot = subAgentRunEventBus.getSnapshot(runId);
            if (!snapshot || !terminalStatuses.includes(snapshot.status)) {
                subAgentRunEventBus.emit({
                    runId,
                    agentName: config.name,
                    type: finalized.cancelled
                        ? 'run_cancelled'
                        : (finalized.success ? 'run_completed' : 'run_failed'),
                    payload: {
                        error: finalized.error,
                        steps: finalized.steps,
                        modelVersion: finalized.modelVersion
                    }
                });
            }
            return finalized;
        };

        try {
            await subAgentConcurrencyLimiter.acquire(runId, acquireSignal);
        } catch (queueError) {
            subAgentRunController.unregister(runId);
            // F2：排队被取消的早退路径也要从父 run 的派生列表里摘除，避免残留孤儿登记
            if (request.parentRunId) {
                subAgentRunController.unregisterChild(request.parentRunId, runId);
            }
            const message = queueError instanceof SubAgentQueueCancelledError
                ? 'User cancelled the sub-agent while it was waiting in the concurrency queue.'
                : `SubAgent failed to acquire a concurrency slot: ${queueError instanceof Error ? queueError.message : String(queueError)}`;
            const finalized = finalizeRun({
                success: false,
                error: message,
                cancelled: true
            });
            await subAgentRunEventBus.flushRun(runId);
            return finalized;
        } finally {
            releaseAcquireSignal?.();
            releaseAcquireSignal = undefined;
        }
        subAgentRunEventBus.emit({
            runId,
            agentName: config.name,
            type: 'run_started'
        });

        // A-COMM：run 真正启动后注册为「本对话下已知」，agent_send_message 才能按 runId/名称寻址到它；
        // 排队被取消/接续校验失败等未真正启动的早退路径不会留下“已知 run”残留；
        // run 结束/取消时在最外层 finally 中注销并清理 inbox。
        agentMailbox.registerRun(currentConversationId, runId, config.name);

        // 修改原因：子代理设置界面新增「默认迭代次数」全局配置，未单独配置的 agent 应继承该默认值。
        // 修改方式：优先取 per-agent maxIterations，其次取全局 defaultMaxIterations，最后回退 50。
        const maxIterations = config.maxIterations
            ?? context.settingsManager?.getSubAgentsConfig?.()?.defaultMaxIterations
            ?? 50;
        // 与 maxIterations 同构：优先取 per-agent maxRuntime，其次取全局 defaultMaxRuntime，
        // 最后回退 DEFAULT_MAX_RUNTIME_S（默认 30 分钟）。
        const maxRuntime = config.maxRuntime
            ?? context.settingsManager?.getSubAgentsConfig?.()?.defaultMaxRuntime
            ?? DEFAULT_MAX_RUNTIME_S;
        const startTime = Date.now();
        const getActiveElapsedMs = (): number => Math.max(0, Date.now() - startTime - subAgentRunController.getInactiveDurationMs(runId));
        
        // 创建超时控制器
        let timeoutController: AbortController | null = null;
        let timeoutId: ReturnType<typeof setInterval> | undefined;
        /**
         * 摘除挂在父 abortSignal 上的超时桥接监听器。
         *
         * 修改原因：父信号（主会话 AbortController）生命周期远长于单个 run，一轮对话里派发 N 个子代理
         *          就会在同一个信号上永久累积 N 个监听器，触发 MaxListenersExceededWarning 且长期驻留内存。
         * 修改方式：保留 handler 引用，run 退出时在最外层 finally 统一摘除。
         * 修改目的：桥接监听器的生命周期与它服务的那次 run 严格对齐。
         */
        let releaseParentAbortBridge: (() => void) | undefined;

        // 检查是否超时的辅助函数
        const checkTimeout = (): { exceeded: boolean; elapsed: number } => {
            const elapsed = Math.floor(getActiveElapsedMs() / 1000);
            if (maxRuntime > 0 && elapsed >= maxRuntime) {
                return { exceeded: true, elapsed };
            }
            return { exceeded: false, elapsed };
        };

        if (maxRuntime > 0) {
            timeoutController = new AbortController();
            // 修改原因：Monitor 暂停和等待用户操作的时间不应计入 maxRuntime，固定 setTimeout 会误把暂停时间算入运行时间。
            // 修改方式：用短间隔轮询 checkTimeout，checkTimeout 会扣除 runController 记录的 inactiveDurationMs。
            // 修改目的：用户暂停查看 Monitor 或等待手动决策时，SubAgent 不会因为真实墙钟时间流逝而超时失败。
            timeoutId = setInterval(() => {
                if (checkTimeout().exceeded) {
                    timeoutController?.abort();
                }
            }, 500);
            if (abortSignal && !detachedFromParent) {
                const onParentAbort = () => {
                    if (timeoutId) {
                        clearInterval(timeoutId);
                        timeoutId = undefined;
                    }
                    timeoutController?.abort();
                };
                abortSignal.addEventListener('abort', onParentAbort, { once: true });
                releaseParentAbortBridge = () => abortSignal.removeEventListener('abort', onParentAbort);
            }
        }

        /**
         * 单次操作（一次 LLM 调用或一次工具调用）的组合中止信号句柄。
         *
         * 修改原因：旧实现每轮迭代都把 abort 监听器永久挂在父 abortSignal 和 run 控制器信号上，
         *          一个 20 轮带工具的 run 会累积上百个监听器，触发 MaxListenersExceededWarning 并长期驻留内存。
         * 修改方式：返回 release 句柄，由调用方在操作结束后摘除监听器。
         * 修改目的：组合信号的生命周期与它服务的那次操作严格对齐。
         */
        interface OperationSignalHandle {
            signal: AbortSignal | undefined;
            release: () => void;
            /** 只解绑父 abort 信号的监听（转后台 detach 用），超时与 controller 信号保持绑定 */
            detachParent: () => void;
        }

        const createOperationSignal = (): OperationSignalHandle => {
            // 转后台（detach）后不再组合父 abort 信号：detachedFromParent 由 detach 回调置位，
            // 新建的组合信号只响应超时与 controller 信号，旧流 abort 不再影响本 run。
            const signals = [detachedFromParent ? undefined : abortSignal, timeoutController?.signal, subAgentRunController.getAbortSignal(runId)]
                .filter((signal): signal is AbortSignal => !!signal);
            if (signals.length === 0) {
                currentOperationHandle = undefined;
                return { signal: undefined, release: () => undefined, detachParent: () => undefined };
            }
            const controller = new AbortController();
            const abort = () => controller.abort();
            const attached: AbortSignal[] = [];
            let parentSignal: AbortSignal | undefined;
            for (const signal of signals) {
                if (signal.aborted) {
                    controller.abort();
                    break;
                }
                signal.addEventListener('abort', abort, { once: true });
                attached.push(signal);
                if (signal === abortSignal) parentSignal = signal;
            }
            const handle: OperationSignalHandle = {
                signal: controller.signal,
                release: () => {
                    for (const signal of attached) {
                        signal.removeEventListener('abort', abort);
                    }
                    attached.length = 0;
                    if (currentOperationHandle === handle) currentOperationHandle = undefined;
                },
                detachParent: () => {
                    if (parentSignal && attached.includes(parentSignal)) {
                        parentSignal.removeEventListener('abort', abort);
                        const idx = attached.indexOf(parentSignal);
                        if (idx >= 0) attached.splice(idx, 1);
                        parentSignal = undefined;
                    }
                }
            };
            currentOperationHandle = handle;
            return handle;
        };

        let lastResponse: string = '';

        const buildCancelledResult = (error: string): SubAgentResult => finalizeRun({
            success: false,
            response: lastResponse,
            modelVersion,
            steps,
            runId,
            toolCalls,
            error,
            cancelled: true
        });

        const waitForControlIfNeeded = async (): Promise<SubAgentResult | null> => {
            const state = subAgentRunController.getState(runId);
            if (!state) return null;
            if (state.status === 'cancelled') {
                return buildCancelledResult(subAgentRunController.getExitReason(runId) || '用户主动终止 SubAgent 执行');
            }
            if (state.status === 'paused' || state.status === 'awaiting_monitor_action') {
                const status = await subAgentRunController.waitUntilRunnable(runId);
                if (status === 'cancelled') {
                    return buildCancelledResult(subAgentRunController.getExitReason(runId) || '用户主动终止 SubAgent 执行');
                }
            }
            return null;
        };

        const isControlInterruption = (): boolean => {
            const state = subAgentRunController.getState(runId);
            return !!state && (state.status === 'paused' || state.status === 'awaiting_monitor_action' || state.status === 'cancelled');
        };
        
        // 检查是否超出迭代次数的辅助函数
        const checkIterations = (): boolean => {
            if (maxIterations === -1) return false; // -1 表示无限制
            return steps >= maxIterations;
        };

        const resolveFailureModeAfterRetries = (): 'fail_parent_tool' | 'wait_for_monitor_action' => {
            // 修改原因：旧 SubAgent 配置可能没有 failureModeAfterRetries，但运行时必须有明确策略。
            // 修改方式：优先使用单个 SubAgent 覆盖值，其次使用全局 SubAgents 默认值，最后回退到 fail_parent_tool。
            // 修改目的：满足“运行时补齐，不主动写回”的兼容策略。
            const own = config.failureModeAfterRetries;
            if (own === 'wait_for_monitor_action' || own === 'fail_parent_tool') return own;
            const global = context.settingsManager?.getSubAgentsConfig?.()?.failureModeAfterRetries;
            return global === 'wait_for_monitor_action' ? 'wait_for_monitor_action' : 'fail_parent_tool';
        };
        
        try {
            // 检查是否取消（detach 后父信号不再约束——转后台的 run 不应在此被旧流 abort 终止）
            if (parentAbort()?.aborted || timeoutController?.signal.aborted) {
                return finalizeRun({
                    success: false,
                    error: 'Cancelled before execution',
                    cancelled: true
                });
            }
            
            if (!context.configManager) {
                throw new Error('SubAgent shared parser/stream path requires configManager in executor context.');
            }
            const channelConfig = await context.configManager.getConfig(config.channel.channelId);
            if (!channelConfig) {
                throw new Error(`SubAgent channel config not found: ${config.channel.channelId}`);
            }
            const toolMode = channelConfig.toolMode || 'function_call';
            const providerType = channelConfig.type || 'custom';
            const toolCallParser = new ToolCallParserService();

            // 获取可用工具（提示词模式快照使用本次调用的动态值）
            const availableTools = await resolveSubAgentAvailableTools(config, {
                ...context,
                promptModeSnapshot: currentPromptModeSnapshot
            });

            // H-1（R4 复查）：嵌套派发时继承父 run 的工具限制——
            // 子 run 最终可用工具 = 自身配置解析结果 ∩ 父 run 可用工具
            // （白名单取交集 / 黑名单取并集在「先按自身配置解析、再取交集」的口径下等价）。
            // inheritedToolFilter 仅由框架注入（subagents handler 从父 run 复制），模型不可控。
            let effectiveTools = availableTools;
            if (request.inheritedToolFilter) {
                const inheritedSet = new Set(request.inheritedToolFilter);
                effectiveTools = availableTools.filter(decl => inheritedSet.has(decl.name));
            }
            
            // 构建允许的工具名称集合，用于执行时的防御性校验（空集 = 无任何可用工具，拒绝一切调用）
            const allowedToolNames = new Set(effectiveTools.map(t => t.name));
            // H-1：把本 run 的最终可用工具按 runId 注册，供内层 subagents 工具派发时继承
            // （run 结束时在最外层 finally 清理）。
            setRunAllowedTools(runId, allowedToolNames);
            
            // 构建系统提示词
            // F2：当本次 run 的工具集实际包含 subagents 工具时，追加中文嵌套说明，
            // 引导模型只在确实需要独立复查或主模型明确指示时才派生子子 agent。
            // L-9（R4 复查）：config.systemPrompt 可能为 undefined，拼接前兜底为空串。
            // 工具纪律一句话提示无条件追加；详细约束由用户自定义 systemPrompt 补充。
            const systemPrompt = `${config.systemPrompt ?? ''}${SUBAGENT_TOOL_DISCIPLINE_NOTICE}${allowedToolNames.has('subagents') ? SUBAGENT_NESTING_PROMPT_NOTICE : ''}`;
            
            // 构建用户提示词
            let userPrompt = request.prompt;
            if (request.context) {
                userPrompt = `Context:\n${request.context}\n\nTask:\n${request.prompt}`;
            }
            
            // 构建对话历史（Content 格式）
            // 修改原因：子代理延续——当 continueFromRunId 指定时，将旧 run 的完整 transcript 前置。
            // 修改方式：展开 baseContents 到 history 数组头部，新 user prompt 追加在末尾。
            // 修改目的：新子代理可以直接看到旧子代理完成了什么，实现跨调用接力。
            const history: Content[] = [
                ...baseContents,
                { role: 'user', parts: [{ text: userPrompt }] }
            ];
            
            // 工具迭代循环
            
            while (true) {
                const controlWaitResult = await waitForControlIfNeeded();
                if (controlWaitResult) {
                    return controlWaitResult;
                }

                // 检查是否取消或超时（detach 后父信号不再约束，转后台的 run 继续执行）
                if (parentAbort()?.aborted || timeoutController?.signal.aborted) {
                    const timeoutCheck = checkTimeout();
                    const isTimeout = timeoutCheck.exceeded;
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: isTimeout
                            ? `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                            : 'Cancelled during execution',
                        cancelled: !isTimeout
                    });
                }

                // 检查超时
                const timeoutCheck = checkTimeout();
                if (timeoutCheck.exceeded) {
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                    });
                }

                // 检查迭代次数
                if (checkIterations()) {
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: `Exceeded maximum iterations (${maxIterations})`
                    });
                }
                
                steps++;
                
                // 调用 AI
                const operation = createOperationSignal();
                const operationSignal = operation.signal;
                let retryFailedInThisCall = false;
                // H1-4：剥离已投递的 agentInbox（只保留最后一条未投递消息的），
                // 防止同 run 后续迭代 / continueFromRunId 续跑重放已 drain 的信箱消息。
                // 剥离结果就是本轮实际发送给 provider 的请求历史，随后立即记录到事件总线
                // （lastSentHistory），供 continueFromRunId 续跑精确复用前缀（见 baseContents 选取逻辑）。
                const sentHistory = stripReplayedAgentInboxForModel(history);
                // 修改原因（SEC）：子代理 history 只增不减，长任务会撞上模型上下文上限直接失败。
                // 修改方式：发送前做请求级上下文裁剪（保留首条任务消息与末尾配对，超长字符串截断），
                //         裁剪结果即为本轮实际发送内容；updateLastSentHistory 同步记录裁剪结果，
                //         保证 continueFromRunId 续跑前缀与实际发送历史一致。
                // 修改目的：子代理长任务在撞上限前自动收敛上下文，不再直接失败。
                const trimmedHistory = trimSubAgentHistoryForContext(sentHistory, channelConfig);
                const generateRequest: GenerateRequest = {
                    configId: config.channel.channelId,
                    history: trimmedHistory,
                    dynamicSystemPrompt: systemPrompt,
                    abortSignal: operationSignal,
                    // H-1：toolOverrides 使用继承过滤后的 effectiveTools（子 run 不向模型暴露
                    // 父 run 不允许的工具），与 allowedToolNames 防御性校验口径一致。
                    // 修改原因（M-6 加固）：空工具集过去被转成 undefined，ChannelManager 会把
                    // undefined 当作「未指定覆盖」回退成渠道全量工具声明——模型反复调用不可用工具
                    // 形成失败循环。空数组为真值，能穿透 ChannelManager 并让 formatter 不注入任何
                    // 工具（formatter 只在 tools.length > 0 时声明），与 allowedToolNames 空集语义一致。
                    toolOverrides: effectiveTools,
                    suppressRetryNotification: true,
                    // 修改原因：DeepSeek KVCache 按 user_id 隔离、Anthropic metadata.user_id 区分运行域都依赖请求携带稳定标识。
                    // 修改方式：SubAgent 用 runId 作为 conversationId，每个 run 拥有独立缓存域（formatter 会哈希，不泄露原始 ID）。
                    // 修改目的：主会话与各 SubAgent、SubAgent 彼此之间的 provider 侧缓存互不污染。
                    // 修改原因：continueFromRunId 续跑时若仍用新 runId 作 conversationId，user_id 按它哈希
                    //          会让续跑落入新缓存域、前缀缓存必 miss。
                    // 修改方式：续跑时 conversationId 直接沿用旧 run 的 runId（request.continueFromRunId），
                    //          user_id 哈希输入与旧 run 完全一致，缓存域天然相同；普通新 run 仍用新 runId。
                    // 修改目的：模型调用 subagents 工具时只需传 continueFromRunId（参数与旧调用一致），
                    //          系统即自动复用旧 run 的 provider 侧缓存域（DeepSeek user_id / Anthropic user_id），无需额外字段。
                    conversationId: request.continueFromRunId || runId,
                    retryStatusCallback: (status) => {
                        if (status.type === 'retryFailed') {
                            retryFailedInThisCall = true;
                        }
                        // 修改原因：SubAgent 内部自动重试状态不能进入主窗口 retryStatus，但用户需要在 Monitor 里看到。
                        // 修改方式：通过 GenerateRequest.retryStatusCallback 把 ChannelManager 的 retrying/retrySuccess/retryFailed 事件路由到 SubAgent runEventBus。
                        // 修改目的：继续复用 Provider 自动重试配置，同时让 Monitor 成为内部重试状态的唯一展示位置。
                        subAgentRunEventBus.emit({
                            runId,
                            agentName: config.name,
                            type: status.type || 'run_updated',
                            payload: status
                        });
                    },
                    // 修改原因：SubAgent 解析 XML/JSON prompt tool mode 时必须和主请求使用同一份模式快照。
                    // 修改方式：把父请求解析好的 promptModeSnapshot 继续传给 ChannelManager。
                    // 修改目的：避免 SubAgent 工具声明和工具调用解析在不同 prompt mode 下再次分叉。
                    promptModeSnapshot: currentPromptModeSnapshot
                };
                // 立即记录本轮实际发送给 provider 的 history：续跑时以此为前缀才能命中旧 run 的 provider 缓存
                subAgentRunEventBus.updateLastSentHistory(runId, trimmedHistory);

                // 如果指定了模型，设置模型覆盖
                if (config.channel.modelId) {
                    generateRequest.modelOverride = config.channel.modelId;
                }
                
                let response: any;
                try {
                    const result = await context.channelManager.generate(generateRequest);
                    const requestStartTime = Date.now();
                    const streamProcessor = new StreamResponseProcessor({
                        requestStartTime,
                        providerType,
                        toolMode,
                        abortSignal: operationSignal,
                        conversationId: runId
                    });
                    
                    if (isAsyncGenerator(result)) {
                        // 修改原因：SubAgent 不应直接 new StreamAccumulator，否则主窗口流式解析升级时 Monitor 不会同步升级。
                        // 修改方式：复用 StreamResponseProcessor，并把处理后的 chunk 原样通过事件总线转给 Monitor。
                        // 修改目的：SubAgent Monitor 与主窗口共享流式解析、contentSnapshot 和取消语义。
                        for await (const chunkData of streamProcessor.processStream(result as AsyncGenerator<any>)) {
                            // 子代理正在生成：视为用户在场（主人在 Monitor/主窗口查看）
                            markAiActive();
                            if (operationSignal?.aborted || checkTimeout().exceeded) {
                                break;
                            }
                            subAgentRunEventBus.emit({
                                runId,
                                agentName: config.name,
                                type: 'llm_delta',
                                payload: chunkData.chunk
                            });
                        }
                        if (operationSignal?.aborted && isControlInterruption()) {
                            // 修改原因：暂停/退出会中止当前 LLM 流，旧逻辑会继续把 partial content 当作成功响应并可能发 run_completed。
                            // 修改方式：流循环结束后立即检查 run control state，交给 waitForControlIfNeeded 处理 pause/resume/exit 语义。
                            // 修改目的：SubAgent pause 不让主工具失败，exit 才按用户意图让主工具失败，避免 partial stream 被误判完成。
                            const controlResult = await waitForControlIfNeeded();
                            if (controlResult) return controlResult;
                            continue;
                        }
                        if (parentAbort()?.aborted || timeoutController?.signal.aborted || checkTimeout().exceeded) {
                            // 修改原因：流式循环因超时/父取消 abort 中断后，partial response 过去仍被
                            //          当作本轮模型输出解析工具调用（可能执行半截工具调用）、写入 history
                            //          与 transcript，超时边界下产生半截工具调用记录。
                            // 修改方式：控制中断（pause/exit/awaiting_monitor_action）已由上方分支处理；
                            //          此处识别「超时或父取消」直接丢弃 partial response 并走终态，
                            //          只有完整流才继续进入下方的工具解析/转录路径。
                            // 修改目的：超时/取消边界下不再产生半截工具调用与转录残留。
                            const timeoutCheck = checkTimeout();
                            const isTimeout = timeoutCheck.exceeded;
                            return finalizeRun({
                                success: false,
                                response: lastResponse,
                                modelVersion,
                                steps,
                                toolCalls,
                                error: isTimeout
                                    ? `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                                    : 'Cancelled during execution',
                                cancelled: !isTimeout
                            });
                        }
                        response = {
                            content: streamProcessor.getContent()
                        };
                    } else {
                        const processed = streamProcessor.processNonStream(result as any);
                        response = {
                            ...(result as any),
                            content: processed.content
                        };
                        subAgentRunEventBus.emit({
                            runId,
                            agentName: config.name,
                            type: 'llm_delta',
                            payload: processed.chunkData.chunk
                        });
                    }
                    // 修改原因：本轮模型输出过去被写入 transcript 三次（流结束一次、裸 content_snapshot 一次、解析后再一次），
                    //          每次都递增 contentRevision、广播事件、入队全量落盘，并让 Monitor 前端强制重拉一次窗口。
                    // 修改方式：删除这里的早写与裸事件，统一由下方"prompt 模式工具调用解析完成后"的唯一写入口落盘。
                    // 修改目的：每轮只产生一次 transcript 修订，且写入的是工具调用已还原为 functionCall 的权威版本。
                } catch (e) {
                    // 检查是否是超时导致的错误
                    const timeoutCheck = checkTimeout();
                    if (timeoutCheck.exceeded) {
                        return finalizeRun({
                            success: false,
                            response: lastResponse,
                            modelVersion,
                            steps,
                            toolCalls,
                            error: `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                        });
                    }
                    if (operationSignal?.aborted && isControlInterruption()) {
                        const controlResult = await waitForControlIfNeeded();
                        if (controlResult) return controlResult;
                        continue;
                    }

                    if (retryFailedInThisCall && resolveFailureModeAfterRetries() === 'wait_for_monitor_action') {
                        const reason = e instanceof Error ? e.message : String(e);
                        subAgentRunController.markAwaitingMonitorAction(runId, reason);
                        const controlResult = await waitForControlIfNeeded();
                        if (controlResult) return controlResult;
                        continue;
                    }

                    const failureMessage = e instanceof Error ? e.message : String(e);
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: isContextLengthError(e)
                            ? `SubAgent ran out of context after ${steps} tool iteration(s) (${history.length} messages accumulated). `
                            + `Requests are trimmed before sending, but the working set still exceeds the model limit: `
                            + `lower this agent's maxIterations, narrow the task, `
                            + `avoid tools that return very large results, or split the work across several sub-agent calls. `
                            + `Original error: ${failureMessage}`
                            : `AI call failed: ${failureMessage}`
                    });
                } finally {
                    // 本轮 LLM 调用结束，摘除组合信号挂在父信号上的 abort 监听器
                    operation.release();
                }

                // 修改原因：子代理的 token 消耗此前不进入主会话用量统计，UsagePage 看不到子代理开销。
                // 修改方式：每轮 generate 成功后从响应 content 提取 usageMetadata，归集到主会话用量索引；
                //          无主会话归属或未注入归集回调时跳过（见 reportUsageToMainConversation）。
                // 修改目的：用量统计页能汇总展示子代理消耗（source='subagent'），且不影响主会话历史。
                await reportUsageToMainConversation(response, currentConversationId, context.usageIndexAppend);
                
                // 修改原因：SubAgent 过去自己解析各 provider 的工具调用，主流程支持 XML/JSON prompt tool mode 后容易漏同步。
                // 修改方式：统一把标准 Content 交给 ToolCallParserService 转换和提取 functionCall。
                // 修改目的：所有工具调用解析能力只维护一个入口。
                if (response?.content) {
                    toolCallParser.convertPromptModeToolCallsToFunctionCalls(response.content, toolMode);
                    toolCallParser.ensureFunctionCallIds(response.content);
                }
                const currentToolCalls = response?.content
                    ? toolCallParser.extractFunctionCalls(response.content, toolMode)
                    : [];
                const textContent = extractTextContent(response);

                // 修改原因：xml/json prompt tool mode 下模型可能在发出工具调用后继续输出文本——
                // 此时工具结果尚未返回，工具调用之后的文本没有依据，属于幻觉尾巴
                // （实测：模型在 read_file 前先编出整页不存在的台词内容）。
                // 修改方式：仅忽略"第一个工具调用 part 之后"的非 thought 文本；工具调用之前的
                //          分析/计划文本完整保留（模型基于用户消息与既有工具结果的分析是有效推理），
                //          工具照常执行，后续轮次基于真实工具结果作答；
                //          幻觉的源头约束由提示词纪律承担（SUBAGENT_TOOL_DISCIPLINE_NOTICE）。
                // 修改目的：只裁真正无依据的输出尾巴，保留模型的分析过程。
                const hasPriorToolResult = history.some(
                    msg => msg.role === 'user' && (msg.parts || []).some(p => (p as any).functionResponse)
                );
                if (textContent && currentToolCalls.length > 0 && toolMode !== 'function_call') {
                    const parts = (response as any)?.content?.parts;
                    if (Array.isArray(parts)) {
                        let seenToolCall = false;
                        (response as any).content.parts = parts.filter((p: any) => {
                            if (p.functionCall) {
                                seenToolCall = true;
                                return true;
                            }
                            // 第一个工具调用之后的非 thought 文本：无工具结果支撑，忽略
                            if (p.text && !p.thought && seenToolCall) return false;
                            return true;
                        });
                    }
                }

                // 记录子代理实际运行的模型版本（优先 content.modelVersion，其次 response.model）
                const mvCandidate =
                    (response as any)?.content?.modelVersion
                    || (response as any)?.modelVersion
                    || (response as any)?.model;
                if (typeof mvCandidate === 'string' && mvCandidate.trim()) {
                    modelVersion = mvCandidate.trim();
                }
                
                // 修改原因：xml/json prompt 模式下模型可能在发起工具调用后继续输出文本——
                // 工具结果尚未返回，这段文本是模型基于文件名与提示词编造的幻觉内容。
                // 旧逻辑无条件把 textContent 写入 lastResponse，一旦后续轮次遇到空响应
                // （上游返回空内容 / 超时 / API 失败），finalizeRun 会把这份幻觉文本
                // 作为 partialResponse 返回给主模型（实测：主模型因此读到全部编造的
                // 台词内容，误判页面内容）。
                // 修改方式：无工具调用轮（代理即将完成、文本才是最终答案）以及
                //          已有工具结果后的中间分析轮（基于真实结果，非幻觉）才更新
                //          lastResponse；首个工具结果之前的"文本+工具调用"轮不更新。
                //          且 lastResponse 使用剥离幻觉尾巴后的文本（cleanedTextContent），
                //          与写入 history 的口径一致。
                // 修改目的：失败/空响应时 partialResponse 不再携带幻觉预生成，
                //          主模型只会看到空内容、上一次真正完成的回答或真实中间分析。
                const cleanedTextContent = extractTextContent(response);
                if (cleanedTextContent && (currentToolCalls.length === 0 || hasPriorToolResult)) {
                    lastResponse = cleanedTextContent;
                }
                
                // 将 AI 响应完整添加到历史（保留思维链）
                if (response?.content) {
                    // 修改原因：主链路对 assistant 历史始终回传思维链（openai formatter 永远携带 reasoning_content，
                    //          anthropic formatter 会把 thought/signature 重建为 thinking block）；旧实现在这里过滤 thought，
                    //          导致 SubAgent 的 DeepSeek 思维链断裂、缓存前缀错乱，Anthropic extended thinking + tool_use 直接报错。
                    // 修改方式：history 保留完整 parts（含 thought/signature/redactedThinking），与主会话请求语义对齐。
                    // 修改目的：SubAgent 的思维链回传与缓存行为和主窗口完全一致。
                    subAgentRunEventBus.updateLastModelContent(runId, response.content);
                    const responseParts = response.content.parts || [];
                    if (responseParts.length > 0) {
                        history.push({
                            role: 'model',
                            parts: responseParts
                        });
                    }
                }
                
                // 如果没有工具调用，说明代理已完成任务
                if (currentToolCalls.length === 0) {
                    return finalizeRun({
                        success: true,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        runId,
                        toolCalls
                    });
                }
                
                // 执行工具调用
                const toolResultParts: ContentPart[] = [];
                
                for (const call of currentToolCalls) {
                    // 执行工具前检查超时
                    const timeoutCheck = checkTimeout();
                    if (timeoutCheck.exceeded || parentAbort()?.aborted || timeoutController?.signal.aborted) {
                        return finalizeRun({
                            success: false,
                            response: lastResponse,
                            modelVersion,
                            steps,
                            toolCalls,
                            error: `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`,
                            cancelled: !timeoutCheck.exceeded
                        });
                    }

                    // 组合信号在早退检查之后创建，避免为不会执行的工具调用注册监听器
                    const toolOperation = createOperationSignal();
                    const toolStartTime = Date.now();
                    let result: SubAgentExecutedToolCall;
                    try {
                        result = await executeToolCall(
                            call.name,
                            call.args,
                            { ...context, promptModeSnapshot: currentPromptModeSnapshot },
                            toolOperation.signal,
                            allowedToolNames,
                            config,
                            call.id,
                            runId,
                            config.name,
                            // A-COMM：子代理信箱会话使用本次调用的动态主会话 ID
                            currentConversationId,
                            // F2：把本 run 的嵌套深度随工具上下文透传，供内层 subagents 工具做深度校验
                            depth
                        );
                    } finally {
                        toolOperation.release();
                    }
                    const duration = Date.now() - toolStartTime;
                    
                    toolCalls.push({
                        tool: call.name,
                        args: call.args,
                        result: result.result,
                        success: result.success,
                        duration
                    });
                    
                    if (result.responseParts && result.responseParts.length > 0) {
                        // 修改原因：主 ToolExecutionService 已经负责构造包含多模态 parts 的 functionResponse，SubAgent 不应再手写简化结果。
                        // 修改方式：优先写入 ToolExecutionService 返回的 responseParts，并在 prompt 模式下带上 multimodalAttachments。
                        // 修改目的：确保图片/PDF/MCP 多模态结果在 SubAgent 内部能按主流程同样的格式回传给子模型。
                        if (result.multimodalAttachments && result.multimodalAttachments.length > 0) {
                            toolResultParts.push(...result.multimodalAttachments);
                        }
                        toolResultParts.push(...result.responseParts);
                    } else {
                        // 回退路径只用于旧上下文缺少 ToolExecutionService 的情况，保留原始 id 以满足 Anthropic/Responses 配对要求。
                        toolResultParts.push({
                            functionResponse: {
                                name: call.name,
                                response: {
                                    success: result.success,
                                    result: result.result,
                                    error: result.error
                                },
                                id: call.id
                            }
                        });
                    }
                }
                
                // 将工具结果添加到历史（作为 user 消息）
                const functionResponseContent = {
                    role: 'user' as const,
                    parts: toolResultParts,
                    isFunctionResponse: true,
                    timestamp: Date.now()
                } as Content;
                history.push({
                    role: 'user',
                    parts: toolResultParts
                });
                // 修改原因：SubAgent 工具结果写入也要经过统一 transcript 仓储接口，避免继续新增“只属于事件总线旧 API”的写路径。
                // 修改方式：通过 runEventBus 暴露的 getTranscriptRepository().appendContent 写入 functionResponse content。
                // 修改目的：让主聊天与 SubAgent 的 transcript append 语义完全对齐，同时不改变 event bus 的广播和持久化效果。
                await subAgentRunEventBus.getTranscriptRepository(runId).appendContent(functionResponseContent);
            }
            
        } catch (e) {
            // 检查是否是超时导致的错误
            const timeoutCheck = checkTimeout();
            const error = timeoutCheck.exceeded
                ? `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                : (e instanceof Error ? e.message : String(e));
            return finalizeRun({
                success: false,
                response: lastResponse,
                modelVersion,
                steps,
                runId,
                toolCalls,
                error
            });
        } finally {
            // 修改原因：超时轮询定时器过去只在父 abortSignal 触发时才清理，正常完成的 run 会永久泄漏一个 500ms 定时器。
            // 修改方式：在最外层 finally 无条件清理，覆盖成功、失败、取消和异常所有退出路径。
            // 修改目的：run 结束后不再有后台定时器持续调用 checkTimeout 并反复 abort 已废弃的控制器。
            if (timeoutId) {
                clearInterval(timeoutId);
                timeoutId = undefined;
            }
            releaseParentAbortBridge?.();
            releaseParentAbortBridge = undefined;
            // 修改原因：run 完成、失败或取消后不能继续显示为可控制的活跃执行，也不能继续占用并发席位。
            // 修改方式：executor 最外层 finally 注销 runController 活跃记录并释放全局信号量席位（release 幂等）。
            // 修改目的：避免历史 run 卡死并发队列或展示会影响主工具的控制按钮。
            // F2：级联清理——本 run 结束时退出其派生的所有子 run（含排队/后台），防止孤儿 run 继续运行；
            // 同时把自己从父 run 的派生列表里摘除（父 run 已结束时会由它的 cascadeExitChildren 清空，这里幂等）。
            subAgentRunController.cascadeExitChildren(
                runId,
                'Parent sub-agent run ended; nested sub-agent runs were cancelled.'
            );
            subAgentRunController.unregister(runId);
            if (request.parentRunId) {
                subAgentRunController.unregisterChild(request.parentRunId, runId);
            }
            subAgentConcurrencyLimiter.release(runId);
            // H-1：run 结束时清理本 run 在 runAllowedToolsRegistry 中的工具限制登记，
            // 避免内存残留；嵌套子 run 在派发时已把父限制复制进自己的 request，不受影响。
            clearRunAllowedTools(runId);
            // A-COMM：run 结束/取消时注销信箱已知记录并清理该 run 的 inbox，避免内存残留与误投递。
            agentMailbox.unregisterRun(currentConversationId, runId);
            // 修改原因：run 异常退出时可能残留未释放的文件写锁（正常路径已在工具执行 finally 中释放）。
            // 修改方式：按 runId 兜底清理该 run 持有的全部锁。
            // 修改目的：避免锁泄漏导致其他 agent 永久无法修改相关文件。
            fileWriteLockManager.releaseAllByHolder(runId);
            // 终态事件必须在工具 Promise 返回主流程前落盘；否则扩展重载会把已完成 run 误判为 interrupted。
            await subAgentRunEventBus.flushRun(runId);
        }
    };
}

/**
 * 默认执行器工厂
 */
export const defaultExecutorFactory: SubAgentExecutorFactory = createDefaultExecutor;
