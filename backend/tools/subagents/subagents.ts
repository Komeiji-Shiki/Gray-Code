/**
 * SubAgents 工具
 *
 * 允许 AI 调用子代理来处理特定任务
 * 支持动态更新工具定义（根据注册的子代理）
 */

import type { Tool, ToolResult, ToolContext, ToolDeclaration } from '../types';
import { DEFAULT_MAX_RUNTIME_S, MAX_SUBAGENT_NESTING_DEPTH } from './types';
import type { SubAgentConfig, SubAgentExecutor } from './types';
import { subAgentRegistry } from './registry';
import { createDefaultExecutor, getSubAgentExecutorContext, getRunAllowedTools, agentLacksWriteCapability } from './executor';
import { subAgentRunEventBus } from './runEventBus';
import type { SubAgentRunStatus } from './runEventBus';
import { getGlobalToolRegistry, getGlobalMcpManager, getGlobalSettingsManager, getGlobalConfigManager } from '../../core/settingsContext';
import { encodeMcpToolName } from '../../modules/mcp/mcpToolNameCodec';
import { TaskManager } from '../taskManager';
import { MEMORY_TOOL_NAMES } from '../memory';
import { TODO_TOOL_NAMES } from '../todo';

// 修改原因：todo_write/todo_update 依赖主会话 conversationId，子代理执行路径无法使用，
// 不应出现在子代理的工具描述/声明里（P1：避免子代理反复尝试调用报错浪费迭代）。
// F2：不再排除 subagents——子 agent 需要能派生子子 agent（嵌套）；subagents 工具不依赖
// conversationId（General Worker 只依赖 channelConfigId），放开不会引入 todo 类问题，
// 深度上限由 executeSubAgent 在派发前校验。
const SUBAGENT_EXCLUDED_TOOL_NAMES = new Set<string>([...MEMORY_TOOL_NAMES, ...TODO_TOOL_NAMES]);

/**
 * 工具名快照缓存（声明 getter 全量重算优化）。
 *
 * 输入依赖：toolRegistry 工具名集合、mcpManager 各 server 的 tool 集合，均无现成版本号可依赖，
 * 故以「toolRegistry 工具数 + MCP 服务器/工具计数」为键：任一计数变化即失效重算；计数不变时
 * 复用快照，避免每次访问 tool.declaration 都重复 O(全部工具数) 枚举（含 encodeMcpToolName 编码）。
 *
 * 注意：本缓存只缓存「工具名列表」；registry/settings 的内容（agent 名称/描述/限制、
 * generalWorkerEnabled 等）不经过本缓存，声明其余部分仍每次即时生成，配置变更即时生效。
 *
 * 失效边界：同一计数下工具名集合发生变化（如工具注销后以同数量重新注册、MCP 同数量工具列表
 * 被整体替换）时快照会短暂滞后——工具注册/注销在启动期一次性完成，运行期无此路径。
 */
let toolNameSnapshotCache: { key: string; builtin: string[]; mcp: string[] } | null = null;

function getCachedToolNameSnapshot(): { builtin: string[]; mcp: string[] } {
    const toolRegistry = getGlobalToolRegistry();
    const mcpManager = getGlobalMcpManager();

    // 键：toolRegistry 工具数 + MCP 服务器/工具计数（计数均为 O(1)/O(服务器数) 可算）
    const builtinCount = toolRegistry?.count?.() ?? -1;
    let mcpKeyPart = '-';
    if (mcpManager) {
        const mcpTools = mcpManager.getAllTools();
        mcpKeyPart = mcpTools
            .map(serverTools => `${serverTools.serverId}:${serverTools.tools?.length ?? 0}`)
            .join('|') || '-';
    }
    const key = `${builtinCount}|${mcpKeyPart}`;
    if (toolNameSnapshotCache && toolNameSnapshotCache.key === key) {
        return toolNameSnapshotCache;
    }

    // 获取内置工具名称
    // 使用 getToolNames() 而不是 getAllTools() 以避免触发 subagents 工具的 getter 导致无限递归
    const builtin: string[] = [];
    if (toolRegistry) {
        builtin.push(...toolRegistry.getToolNames().filter(name => !SUBAGENT_EXCLUDED_TOOL_NAMES.has(name)));
    }
    // 获取 MCP 工具名称
    const mcp: string[] = [];
    if (mcpManager) {
        const mcpTools = mcpManager.getAllTools();
        for (const serverTools of mcpTools) {
            for (const tool of serverTools.tools || []) {
                mcp.push(encodeMcpToolName(serverTools.serverId, tool.name));
            }
        }
    }
    toolNameSnapshotCache = { key, builtin, mcp };
    return toolNameSnapshotCache;
}

/** 通用 Worker 虚拟子代理的标识常量 */
const GENERAL_WORKER_NAME = 'General Worker';
const GENERAL_WORKER_TYPE = 'general-worker';

/**
 * 获取可用的子代理名称列表（包含动态 General Worker）
 */
function getAvailableAgentNames(): string[] {
    const names = subAgentRegistry.getNames();
    const settings = getSubAgentsSettings();
    if (settings.generalWorkerEnabled !== false && !names.includes(GENERAL_WORKER_NAME)) {
        names.push(GENERAL_WORKER_NAME);
    }
    return names;
}

/**
 * 判断是否为 General Worker 虚拟子代理
 */
function isGeneralWorker(agentName: string): boolean {
    return agentName === GENERAL_WORKER_NAME;
}

/**
 * 获取子代理可用的工具列表（用于工具声明描述）。
 *
 * M-7（R4 复查）：本函数（同步，直接读 registry/MCP 拼名字）与 executor.ts 的
 * resolveSubAgentAvailableTools（异步，经 ToolDeclarationResolver 生成完整声明）
 * 存在口径分叉：
 * - 分叉原因：工具声明生成是同步路径（getSubAgentsToolDeclaration →
 *   generateAgentNameDescription），无法直接复用异步 resolver；resolver 侧还额外
 *   做 schema 清理、多模态过滤等声明级处理。
 * - 当前对齐手段：两侧共用 agentLacksWriteCapability + WRITE_CAPABILITY_TOOLS，
 *   保证「subagents 工具去留」的裁剪口径一致（H-1）。
 * - 后续方案（如需彻底合一）：把声明生成改为异步或缓存 resolver 结果，
 *   让 getAgentAvailableTools 直接消费 resolveSubAgentAvailableTools 的输出。
 */
function getAgentAvailableTools(config: SubAgentConfig): string[] {
    // 修改原因：旧实现每次访问 tool.declaration getter 都全量重算「内置工具名 + MCP 工具名」
    //          （遍历 toolRegistry 全部工具名 + mcpManager 全部 server/tool），一个请求多次访问
    //          声明即重复 O(全部工具数) 枚举。
    // 修改方式：枚举结果按（toolRegistry 工具数 + MCP 服务器/工具计数）为键缓存为快照，
    //          计数变化即失效重算；registry/settings 的内容变更不经过本缓存（声明其余部分
    //          仍每次即时生成，见 getCachedToolNameSnapshot），配置变更即时生效。
    const { builtin: builtinToolNames, mcp: mcpToolNames } = getCachedToolNameSnapshot();

    const toolsConfig = config.tools;
    let availableTools: string[] = [];
    
    switch (toolsConfig.mode) {
        case 'all':
            availableTools = [...builtinToolNames, ...mcpToolNames];
            break;
        case 'builtin':
            availableTools = builtinToolNames;
            break;
        case 'mcp':
            availableTools = mcpToolNames;
            break;
        case 'whitelist':
            const whitelist = new Set(toolsConfig.whitelist || toolsConfig.list || []);
            availableTools = [...builtinToolNames, ...mcpToolNames].filter(t => whitelist.has(t));
            break;
        case 'blacklist':
            const blacklist = new Set(toolsConfig.blacklist || toolsConfig.list || []);
            availableTools = [...builtinToolNames, ...mcpToolNames].filter(t => !blacklist.has(t));
            break;
    }
    // H-1（R4 复查）：与 executor 的 resolveSubAgentAvailableTools 共用同一裁剪口径——
    // 不具备完整写/执行能力的代理（blacklist 排除写工具、whitelist 缺写工具、mcp 等）
    // 自动从可用集移除 subagents，防止其派发 mode='all' 的 General Worker 越权。
    if (agentLacksWriteCapability(toolsConfig)) {
        availableTools = availableTools.filter(name => name !== 'subagents');
    }
    
    return availableTools;
}

/**
 * 格式化工具列表为简洁的字符串
 */
function formatToolsList(tools: string[], maxDisplay: number = 10): string {
    if (tools.length === 0) {
        return 'None';
    }
    
    if (tools.length <= maxDisplay) {
        return tools.join(', ');
    }
    
    const displayTools = tools.slice(0, maxDisplay);
    return `${displayTools.join(', ')} ... and ${tools.length - maxDisplay} more`;
}

/**
 * 获取子代理配置
 */
function getSubAgentsSettings() {
    const settingsManager = getGlobalSettingsManager();
    if (settingsManager) {
        return settingsManager.getSubAgentsConfig();
    }
    return { agents: [], maxConcurrentAgents: 3 };
}

/**
 * 全局默认迭代次数（P2）：未单独配置的 agent 与 General Worker 使用该值。
 */
function getGlobalDefaultMaxIterations(): number {
    return getSubAgentsSettings().defaultMaxIterations ?? 80;
}

/**
 * 统一判断是否存在可用子代理（含动态 General Worker）。
 *
 * 修改原因：工具声明过滤只看 Registry 已启用计数，General Worker 是运行时
 * 虚拟代理不在计数内，全部配置代理被禁用时 subagents 工具会被整体隐藏（F-10）。
 * 修改方式：配置代理计数与 General Worker 启用状态取并集，所有声明过滤位置共用。
 */
export function hasAvailableSubAgent(): boolean {
    const settings = getSubAgentsSettings();
    return subAgentRegistry.countEnabled() > 0 || settings.generalWorkerEnabled !== false;
}

/**
 * 格式化限制数值（-1 表示无限制）
 */
function formatLimit(value: number | undefined, defaultValue: number): string {
    const v = value ?? defaultValue;
    return v === -1 ? 'unlimited' : String(v);
}

/**
 * 生成 agentName 参数的描述（包含各子代理的描述、可用工具和限制）
 */
function generateAgentNameDescription(): string {
    const configs = subAgentRegistry.getAllConfigs();
    const settings = getSubAgentsSettings();
    const hasGeneralWorker = settings.generalWorkerEnabled !== false;

    if (configs.length === 0 && !hasGeneralWorker) {
        return 'The name of sub-agent to invoke. Currently no sub-agents available.';
    }

    const entries: string[] = [];

    // 静态注册的子代理
    for (const config of configs) {
        const tools = getAgentAvailableTools(config);
        const toolsStr = formatToolsList(tools, 8);
        const maxIterStr = formatLimit(config.maxIterations, getGlobalDefaultMaxIterations());
        const maxRuntimeStr = formatLimit(config.maxRuntime, DEFAULT_MAX_RUNTIME_S);
        entries.push(`  - "${config.name}": ${config.description || 'No description'}\n    Tools (${tools.length}): ${toolsStr}\n    Limits: max ${maxIterStr} iterations, max ${maxRuntimeStr}s runtime`);
    }

    // 动态 General Worker（启用时追加）
    if (hasGeneralWorker) {
        // 与 getAgentAvailableTools 共用同一份工具名快照缓存，不再重复枚举 registry/MCP
        const { builtin: builtinToolNames, mcp: mcpToolNames } = getCachedToolNameSnapshot();
        const allTools = [...builtinToolNames, ...mcpToolNames];
        const toolsStr = formatToolsList(allTools, 8);
        const globalMaxIterations = getGlobalDefaultMaxIterations();
        entries.push(`  - "${GENERAL_WORKER_NAME}": Zero-config general-purpose worker that inherits the current session's channel and all available non-memory tool permissions; when invoked from another sub-agent its tools are limited to the dispatching agent's own tool set\n    Tools (${allTools.length}): ${toolsStr}\n    Limits: max ${globalMaxIterations} iterations, max ${DEFAULT_MAX_RUNTIME_S}s runtime`);
    }

    return `The name of sub-agent to invoke. Available options:\n${entries.join('\n')}`;
}

/**
 * 生成工具的主描述
 */
function generateToolDescription(): string {
    const configs = subAgentRegistry.getAllConfigs();
    const settings = getSubAgentsSettings();
    const hasGeneralWorker = settings.generalWorkerEnabled !== false;
    const maxConcurrent = settings.maxConcurrentAgents ?? 3;
    const maxConcurrentStr = formatLimit(maxConcurrent, 3);

    if (configs.length === 0 && !hasGeneralWorker) {
        return `Invoke a specialized sub-agent to handle a specific task.

**Note:** No sub-agents are currently configured. Please configure sub-agents in settings first.`;
    }

    const limitsSection = maxConcurrent === -1
        ? '- Each sub-agent has its own max iterations limit (see agent descriptions)'
        : `- Maximum ${maxConcurrentStr} sub-agent(s) can be invoked in a single response\n- Each sub-agent has its own max iterations limit (see agent descriptions)`;

    return `Invoke a specialized sub-agent to handle a specific task. The sub-agent has its own tools and can perform complex operations autonomously.

**Limits:**
${limitsSection}

**Usage Notes:**
- Choose the appropriate agent based on the task
- Provide a clear and detailed prompt for the sub-agent
- The sub-agent will execute the task and return the result
- Sub-agents have their own tool access and can make multiple tool calls
- Use sub-agents for complex, multi-step tasks that require focused attention
- For long-running tasks (batch review/research), pass \`background: true\` to start the sub-agent non-blocking: the tool returns immediately with a taskId, and the final result arrives later as a [Background task completed] message. Do NOT wait for it or poll. Background tasks keep running even if the current stream is stopped — cancel them explicitly via the background task bar.`;
}

/**
 * 动态获取工具声明
 * 
 * 每次调用时根据当前注册的子代理生成最新的工具定义
 */
export function getSubAgentsToolDeclaration(): ToolDeclaration {
    const agentNames = getAvailableAgentNames();
    
    return {
        name: 'subagents',
        category: 'agents',
        description: generateToolDescription(),
        parameters: {
            type: 'object',
            properties: {
                agentName: {
                    type: 'string',
                    description: generateAgentNameDescription(),
                    ...(agentNames.length > 0 ? { enum: agentNames } : {})
                },
                prompt: {
                    type: 'string',
                    description: 'The task prompt/instruction for the sub-agent. Be specific and detailed about what you want the sub-agent to accomplish.'
                },
                context: {
                    type: 'string',
                    description: 'Optional additional context or background information for the sub-agent. Include relevant file paths, code snippets, or requirements.'
                },
                continueFromRunId: {
                    type: 'string',
                    description: 'Optional completed Sub-Agent run ID to continue from. The new run inherits that run\'s complete transcript. Running or unknown run IDs are rejected.'
                },
                background: {
                    type: 'boolean',
                    description: 'Set to true to start the sub-agent in the background (non-blocking). Use ONLY for long-running tasks (e.g. batch review/research). The tool returns immediately with a taskId; the final result will arrive later as a "[Background task completed]" user message — do NOT wait for it or poll. Background tasks are NOT cancelled when the current stream stops; cancel them explicitly via the background task bar.'
                }
            },
            required: ['agentName', 'prompt']
        }
    };
}

/**
 * 工具处理器
 */
function normalizeToolIdForRunId(toolId: string): string {
    return toolId.trim().replace(/[^A-Za-z0-9_-]/g, '_');
}

function getPreallocatedRunId(context?: ToolContext): string | undefined {
    const toolId = typeof context?.toolId === 'string' ? normalizeToolIdForRunId(context.toolId) : '';
    return toolId ? `subagent_run_${toolId}` : undefined;
}

/**
 * 续跑身份解析：continueFromRunId 必须沿用旧 run 的 agent 身份。
 *
 * 修改原因：旧实现续跑时仍用本次调用传入的 agentName 创建新 run，模型常把续跑
 *          传成 General Worker，Monitor 里出现两个不同身份的子代理；且系统提示/工具集
 *          变化会让 provider 前缀缓存（DeepSeek KVCache / Anthropic user_id 域）失效。
 * 修改方式：先校验旧 run（存在 / 同对话 / 终态），再返回旧 run 的 agentName 作为
 *          有效身份；本次传入的 agentName 只用于「身份一致」时的快速路径参考。
 * 修改目的：续跑 = 同一条 run 同一种身份继续，工具集/系统提示不变，缓存命中条件不变。
 */
async function resolveContinuationIdentity(
    continueFromRunId: string,
    currentAgentName: string,
    context?: ToolContext
): Promise<{ ok: true; agentName: string } | { ok: false; error: string }> {
    const conversationId = (context?.conversationId as string | undefined)
        ?? (context?.mailboxConversationId as string | undefined);
    const conversationStore = context?.conversationStore as any;

    // 与 executor 续跑校验同口径：先查内存快照；未命中且当前调用可提供对话 store 时，
    // 只加载当前对话的持久化快照（不扫描其他对话，避免 runId 跨对话碰撞）。
    let oldSnapshot = subAgentRunEventBus.getSnapshot(continueFromRunId);
    if (!oldSnapshot && conversationId && conversationStore) {
        await subAgentRunEventBus.loadConversationSnapshots(conversationId, conversationStore);
        oldSnapshot = subAgentRunEventBus.getSnapshot(continueFromRunId);
    }
    if (!oldSnapshot) {
        return { ok: false, error: `Cannot continue from run "${continueFromRunId}": run not found. It may have been cleared or never existed.` };
    }
    if (oldSnapshot.conversationId && conversationId && oldSnapshot.conversationId !== conversationId) {
        return { ok: false, error: `Cannot continue from run "${continueFromRunId}": the run belongs to a different conversation.` };
    }
    const terminalStatuses: SubAgentRunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];
    if (!terminalStatuses.includes(oldSnapshot.status)) {
        return { ok: false, error: `Cannot continue from run "${continueFromRunId}": the run is still ${oldSnapshot.status}. Only terminal runs (completed / failed / cancelled) can be continued.` };
    }

    // 身份继承：旧 run 未记录 agentName 时（极旧数据）回退为本次传入值
    const oldAgentName = oldSnapshot.agentName?.trim() || currentAgentName;
    return { ok: true, agentName: oldAgentName };
}

async function subAgentsHandler(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    const agentName = args.agentName as string;
    const prompt = args.prompt as string;
    const additionalContext = args.context as string | undefined;
    const continueFromRunId = typeof args.continueFromRunId === 'string' && args.continueFromRunId.trim()
        ? args.continueFromRunId.trim()
        : undefined;
    const background = args.background === true;
    const runId = getPreallocatedRunId(context);

    if (!agentName || !prompt) {
        return { success: false, error: `${!agentName ? 'agentName' : 'prompt'} is required` };
    }

    const settings = getSubAgentsSettings();

    // 续跑身份继承：有效身份以旧 run 为准（系统提示/工具集不变，provider 前缀缓存才能命中），
    // 本次传入的 agentName 仅作为「身份一致」时的快速路径参考。
    let effectiveAgentName = agentName;
    if (continueFromRunId) {
        const resolution = await resolveContinuationIdentity(continueFromRunId, agentName, context);
        if (!resolution.ok) {
            return { success: false, error: resolution.error };
        }
        effectiveAgentName = resolution.agentName;
    }

    // General Worker 虚拟子代理：运行时动态构造配置，无需用户手动创建
    if (isGeneralWorker(effectiveAgentName)) {
        if (settings.generalWorkerEnabled === false) {
            return { success: false, error: 'General Worker is disabled. Enable it in SubAgents settings.' };
        }

        const channelConfigId = context?.channelConfigId as string | undefined;
        if (!channelConfigId) {
            return { success: false, error: 'General Worker requires an active channel (no channelConfigId in tool context).' };
        }

        const dynamicConfig: SubAgentConfig = {
            type: GENERAL_WORKER_TYPE,
            name: GENERAL_WORKER_NAME,
            // H-1（R4 复查）：嵌套派发时 General Worker 的工具受父 run 限制（executor 取交集），
            // 描述文案同步说明，避免误导模型以为嵌套 worker 拥有全量权限。
            description: 'Zero-config general-purpose worker that inherits the current session channel and all available non-memory tool permissions. When invoked from another sub-agent, its tools are limited to the dispatching agent\'s own tool set.',
            systemPrompt: 'You are a general-purpose worker sub-agent. Complete the task given in the prompt using all available tools. Be thorough and self-directed. Your final response is the deliverable — make it complete and self-contained.',
            channel: { channelId: channelConfigId },
            tools: { mode: 'all' },
            // P2：General Worker 是零配置虚拟代理，迭代次数跟随全局默认配置（executor 会再回退到 50）
            maxIterations: getGlobalDefaultMaxIterations(),
            maxRuntime: DEFAULT_MAX_RUNTIME_S,
            enabled: true
        };

        return executeSubAgent(dynamicConfig, effectiveAgentName, prompt, additionalContext, continueFromRunId, runId, context, background);
    }

    const agentEntry = subAgentRegistry.getByName(effectiveAgentName);
    if (!agentEntry) {
        const availableNames = getAvailableAgentNames();
        return { success: false, error: `SubAgent "${effectiveAgentName}" not found. Available agents: ${availableNames.length > 0 ? availableNames.join(', ') : 'none'}` };
    }

    // F-08：显式注册的自定义 executor 优先；未注册时由 executeSubAgent 动态创建默认 executor
    return executeSubAgent(
        agentEntry.config,
        effectiveAgentName,
        prompt,
        additionalContext,
        continueFromRunId,
        runId,
        context,
        background,
        agentEntry.executor
    );
}

/**
 * 执行子代理（抽取为独立函数，供静态注册和动态构造的 agent 共用）
 */
async function executeSubAgent(
    config: SubAgentConfig,
    agentName: string,
    prompt: string,
    additionalContext: string | undefined,
    continueFromRunId: string | undefined,
    runId: string | undefined,
    context?: ToolContext,
    background = false,
    customExecutor?: SubAgentExecutor
): Promise<ToolResult> {
    const promptModeSnapshot = context?.promptModeSnapshot as any;
    // F2：嵌套深度——父 run 深度从工具上下文读取（ToolExecutionService 注入 subagentDepth，
    // 主模型直接派发时缺省 0），子 run 深度 = 父深度 + 1；超过 MAX_SUBAGENT_NESTING_DEPTH 拒绝。
    const rawParentDepth = context?.subagentDepth;
    const parentDepth = typeof rawParentDepth === 'number' && Number.isFinite(rawParentDepth) && rawParentDepth >= 0
        ? Math.floor(rawParentDepth)
        : 0;
    const depth = parentDepth + 1;
    if (depth > MAX_SUBAGENT_NESTING_DEPTH) {
        return {
            success: false,
            error: `Sub-agent nesting depth limit reached: cannot spawn a sub-agent at depth ${depth} `
                + `(maximum allowed depth is ${MAX_SUBAGENT_NESTING_DEPTH}: main model=0, sub-agent=1, sub-sub-agent=2). `
                + `Handle the task at the current level, or break it into fewer nested steps.`
        };
    }
    // F2：父 runId（A-COMM 信箱身份），用于级联清理父子关系；主模型直接派发时缺省。
    const parentRunId = context?.mailboxRunId as string | undefined;
    // H-1（R4 复查）：嵌套派发时继承父 run 的可用工具限制——
    // 子 run 最终可用工具 = 子配置解析结果 ∩ 父 run 可用工具（executor 内取交集）。
    // 父 run 的工具集由 executor 在解析后按 runId 注册（setRunAllowedTools），
    // 主模型直接派发（无 mailboxRunId）时不做继承，General Worker 保持全量权限。
    const inheritedToolFilter = parentRunId ? getRunAllowedTools(parentRunId) : undefined;
    const inheritedToolFilterList = inheritedToolFilter ? Array.from(inheritedToolFilter) : undefined;
    // F2：嵌套 run 的会话归属——子代理内部调用时 context.conversationId 为 undefined，
    // 但信箱会话（mailboxConversationId，即主会话 ID）始终存在，回退使用它，
    // 让嵌套 run 的 transcript 持久化、用量归集和 agent_send_message 寻址都归属主会话。
    const conversationId = (context?.conversationId as string | undefined)
        ?? (context?.mailboxConversationId as string | undefined);
    const baseExecutorContext = getSubAgentExecutorContext();
    // F-08：显式注册的自定义 executor 优先；否则按每次调用动态创建默认 executor，
    // 不再把缺少动态会话上下文的默认 executor 缓存在 Registry。
    const runtimeExecutor = customExecutor
        ? customExecutor
        : baseExecutorContext
            ? createDefaultExecutor(config, {
                ...baseExecutorContext,
                conversationId,
                conversationStore: context?.conversationStore as any,
                promptModeSnapshot: promptModeSnapshot || baseExecutorContext.promptModeSnapshot,
                // 多工作区支持：子代理继承主会话绑定的工作区
                activeWorkspaceUri: context?.activeWorkspaceUri as string | undefined
            })
            : undefined;

    if (!runtimeExecutor) {
        return { success: false, error: `SubAgent "${agentName}" has no runtime executor context.` };
    }

    // 后台模式：独立 AbortController（不挂父轮 abortSignal，用户停止当前对话流不连带取消），
    // 任务注册到 TaskManager（前端 BackgroundTaskBar 展示/取消），executor 启动后不 await，
    // settle 时注销任务并携带完整结果载荷——前端 backgroundTaskStore 据此按混合语义回流给主模型。
    if (background) {
        const backgroundAbortController = new AbortController();
        const taskId = TaskManager.generateTaskId('bgagent');

        TaskManager.registerTask(taskId, 'background_subagent', backgroundAbortController, {
            conversationId,
            agentName,
            runId,
            continueFromRunId,
            promptPreview: prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt
        });

        // 把同步抛错也纳入 Promise 链（runtimeExecutor 若同步 throw，then/catch 无法捕获，
        // registerTask 已登记的任务会永远残留 running）；Promise.resolve().then 保证
        // 同步与异步失败都走同一个 catch 清理路径
        Promise.resolve().then(() => runtimeExecutor({
            agentType: config.type,
            prompt,
            context: additionalContext,
            continueFromRunId,
            runId,
            conversationId,
            conversationStore: context?.conversationStore as any,
            promptModeSnapshot: promptModeSnapshot,
            // F2：嵌套子代理需要把父 runId 向下传给 executor（关联 run + run 元数据）
            depth,
            parentRunId,
            // 转后台（detach）后即为后台模式，executor 据此不再注册 detach 处理器（后台 run 的取消由父级 abort 驱动）
            background: true,
            // H-1：把 run 的工具白名单向下传给 executor（父 run 白名单 = 白名单 ∩ 白名单）
            inheritedToolFilter: inheritedToolFilterList
        }, backgroundAbortController.signal)).then(result => {
            const status = result.cancelled ? 'cancelled' : (result.success ? 'completed' : 'error');
            TaskManager.unregisterTask(taskId, status, {
                runId: result.runId,
                agentName,
                response: result.response,
                steps: result.steps,
                ...(result.error ? { error: result.error } : {})
            });
        }).catch(error => {
            TaskManager.unregisterTask(taskId, 'error', {
                runId,
                agentName,
                error: error instanceof Error ? error.message : String(error)
            });
        });

        return {
            success: true,
            data: {
                background: true,
                taskId,
                runId,
                agentName,
                note: 'Started in background; the result will arrive as a [Background task completed] message. Do NOT wait or poll.'
            }
        };
    }

    const abortSignal = context?.abortSignal;
    if (abortSignal?.aborted) {
        return { success: false, error: 'User cancelled the sub-agent execution. Please wait for user\'s next instruction.', cancelled: true };
    }

    try {
        const result = await runtimeExecutor({
            agentType: config.type,
            prompt,
            context: additionalContext,
            continueFromRunId,
            runId,
            conversationId,
            conversationStore: context?.conversationStore as any,
            promptModeSnapshot: promptModeSnapshot,
            // F2：嵌套深度与父 runId 随请求传给 executor（级联清理 + run 元数据）
            depth,
            parentRunId,
            // H-1：父 run 的工具限制随请求传给 executor（子 run 工具 = 子配置 ∩ 父限制）
            inheritedToolFilter: inheritedToolFilterList
        }, abortSignal);

        if (result.cancelled || abortSignal?.aborted) {
            return { success: false, error: result.error || 'User cancelled the sub-agent execution. Please wait for user\'s next instruction.', cancelled: true };
        }

        // 构建公共 data：子代理运行信息
        // channelName / modelId / steps 仅供前端 UI 展示，cleanFunctionResponseForAPI 会将其过滤掉不发给 AI

        let channelName = '';
        const configManager = getGlobalConfigManager();
        if (configManager) {
            const channelConfig = await configManager.getConfig(config.channel.channelId);
            channelName = channelConfig?.name || config.channel.channelId;
        }

        const data: Record<string, unknown> = {
            agentName,
            runId: result.runId,
            [result.success ? 'response' : 'partialResponse']: result.response,
            channelName,
            modelId: config.channel.modelId,
            steps: result.steps
        };

        return result.success
            ? { success: true, data }
            : { success: false, error: result.error || 'SubAgent execution failed', data };
    } catch (error) {
        return { success: false, error: `SubAgent execution error: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/**
 * 缓存的工具实例
 * 
 * 使用 getter 实现动态声明，每次访问 declaration 时重新生成
 */
let cachedTool: Tool | null = null;

/**
 * 创建动态 SubAgents 工具
 * 
 * 使用 getter 代理，确保每次获取 declaration 时都是最新的
 */
export function createSubAgentsTool(): Tool {
    // 创建一个代理对象，动态获取 declaration
    const tool: Tool = {
        get declaration() {
            return getSubAgentsToolDeclaration();
        },
        handler: subAgentsHandler
    };
    
    return tool;
}

/**
 * 获取 SubAgents 工具（单例）
 * 
 * 返回的工具对象的 declaration 会动态更新
 */
export function getSubAgentsTool(): Tool {
    if (!cachedTool) {
        cachedTool = createSubAgentsTool();
    }
    return cachedTool;
}

/**
 * 强制刷新工具定义
 * 
 * 当子代理配置发生变化时调用，确保下次获取工具定义时是最新的
 * 注意：由于使用了 getter，实际上不需要手动刷新，但保留此方法以备将来使用
 */
export function refreshSubAgentsTool(): void {
    // 使用 getter 后，每次访问 declaration 都会重新生成
    // 这里不需要做任何事情，但保留接口以保持向后兼容
    console.log('[SubAgents] Tool declaration will be refreshed on next access');
}

/**
 * 注册 SubAgents 工具
 * 
 * @deprecated 使用 getSubAgentsTool() 代替
 */
export function registerSubAgents(): Tool {
    return getSubAgentsTool();
}
