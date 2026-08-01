/**
 * SubAgents 工具
 *
 * 允许 AI 调用子代理来处理特定任务
 * 支持动态更新工具定义（根据注册的子代理）
 */

import type { Tool, ToolResult, ToolContext, ToolDeclaration } from '../types';
import type { SubAgentConfig, SubAgentExecutor } from './types';
import { subAgentRegistry } from './registry';
import { createDefaultExecutor, getSubAgentExecutorContext } from './executor';
import { getGlobalToolRegistry, getGlobalMcpManager, getGlobalSettingsManager, getGlobalConfigManager } from '../../core/settingsContext';
import { encodeMcpToolName } from '../../modules/mcp/mcpToolNameCodec';
import { TaskManager } from '../taskManager';
import { MEMORY_TOOL_NAMES } from '../memory';

const SUBAGENT_EXCLUDED_TOOL_NAMES = new Set<string>(['subagents', ...MEMORY_TOOL_NAMES]);

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
 * 获取子代理可用的工具列表
 */
function getAgentAvailableTools(config: SubAgentConfig): string[] {
    const toolRegistry = getGlobalToolRegistry();
    const mcpManager = getGlobalMcpManager();
    
    let builtinToolNames: string[] = [];
    const mcpToolNames: string[] = [];
    
    // 获取内置工具名称
    // 使用 getToolNames() 而不是 getAllTools() 以避免触发 subagents 工具的 getter 导致无限递归
    if (toolRegistry) {
        builtinToolNames = toolRegistry.getToolNames().filter(name => !SUBAGENT_EXCLUDED_TOOL_NAMES.has(name));
    }
    
    // 获取 MCP 工具名称
    if (mcpManager) {
        const mcpTools = mcpManager.getAllTools();
        for (const serverTools of mcpTools) {
            for (const tool of serverTools.tools || []) {
                mcpToolNames.push(encodeMcpToolName(serverTools.serverId, tool.name));
            }
        }
    }
    
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
        const maxIterStr = formatLimit(config.maxIterations, 50);
        const maxRuntimeStr = formatLimit(config.maxRuntime, 1800);
        entries.push(`  - "${config.name}": ${config.description || 'No description'}\n    Tools (${tools.length}): ${toolsStr}\n    Limits: max ${maxIterStr} iterations, max ${maxRuntimeStr}s runtime`);
    }

    // 动态 General Worker（启用时追加）
    if (hasGeneralWorker) {
        const builtinToolNames: string[] = [];
        const toolRegistry = getGlobalToolRegistry();
        if (toolRegistry) {
            builtinToolNames.push(...toolRegistry.getToolNames().filter(name => !SUBAGENT_EXCLUDED_TOOL_NAMES.has(name)));
        }
        const mcpToolNames: string[] = [];
        const mcpManager = getGlobalMcpManager();
        if (mcpManager) {
            const mcpTools = mcpManager.getAllTools();
            for (const serverTools of mcpTools) {
                for (const tool of serverTools.tools || []) {
                    mcpToolNames.push(encodeMcpToolName(serverTools.serverId, tool.name));
                }
            }
        }
        const allTools = [...builtinToolNames, ...mcpToolNames];
        const toolsStr = formatToolsList(allTools, 8);
        entries.push(`  - "${GENERAL_WORKER_NAME}": Zero-config general-purpose worker that inherits the current session's channel and all available non-memory tool permissions\n    Tools (${allTools.length}): ${toolsStr}\n    Limits: max 80 iterations, max 2400s runtime`);
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

    // General Worker 虚拟子代理：运行时动态构造配置，无需用户手动创建
    if (isGeneralWorker(agentName)) {
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
            description: 'Zero-config general-purpose worker that inherits the current session channel and all available non-memory tool permissions.',
            systemPrompt: 'You are a general-purpose worker sub-agent. Complete the task given in the prompt using all available tools. Be thorough and self-directed. Your final response is the deliverable — make it complete and self-contained.',
            channel: { channelId: channelConfigId },
            tools: { mode: 'all' },
            maxIterations: 80,
            maxRuntime: 2400,
            enabled: true
        };

        return executeSubAgent(dynamicConfig, agentName, prompt, additionalContext, continueFromRunId, runId, context, background);
    }

    const agentEntry = subAgentRegistry.getByName(agentName);
    if (!agentEntry) {
        const availableNames = getAvailableAgentNames();
        return { success: false, error: `SubAgent "${agentName}" not found. Available agents: ${availableNames.length > 0 ? availableNames.join(', ') : 'none'}` };
    }

    // F-08：显式注册的自定义 executor 优先；未注册时由 executeSubAgent 动态创建默认 executor
    return executeSubAgent(
        agentEntry.config,
        agentName,
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
    const baseExecutorContext = getSubAgentExecutorContext();
    // F-08：显式注册的自定义 executor 优先；否则按每次调用动态创建默认 executor，
    // 不再把缺少动态会话上下文的默认 executor 缓存在 Registry。
    const runtimeExecutor = customExecutor
        ? customExecutor
        : baseExecutorContext
            ? createDefaultExecutor(config, {
                ...baseExecutorContext,
                conversationId: context?.conversationId as string | undefined,
                conversationStore: context?.conversationStore as any,
                promptModeSnapshot: promptModeSnapshot || baseExecutorContext.promptModeSnapshot
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
            conversationId: context?.conversationId as string | undefined,
            agentName,
            runId,
            continueFromRunId,
            promptPreview: prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt
        });

        runtimeExecutor({
            agentType: config.type,
            prompt,
            context: additionalContext,
            continueFromRunId,
            runId,
            conversationId: context?.conversationId as string | undefined,
            conversationStore: context?.conversationStore as any,
            promptModeSnapshot: promptModeSnapshot
        }, backgroundAbortController.signal).then(result => {
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
            conversationId: context?.conversationId as string | undefined,
            conversationStore: context?.conversationStore as any,
            promptModeSnapshot: promptModeSnapshot
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
