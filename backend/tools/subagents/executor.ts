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
    SubAgentExecutorFactory
} from './types';
import type { ToolDeclaration } from '../types';
import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import { StreamResponseProcessor, isAsyncGenerator } from '../../modules/api/chat/handlers';
import { ToolCallParserService } from '../../modules/api/chat/services/ToolCallParserService';
import type { Content, ContentPart } from '../../modules/conversation/types';
import type { ToolExecutionResult } from '../../modules/api/chat/utils';
import type { GenerateRequest } from '../../modules/channel/types';
import { subAgentRunEventBus } from './runEventBus';
import type { SubAgentRunStatus } from './runEventBus';
import { subAgentRunController } from './runController';
import { subAgentConcurrencyLimiter, SubAgentQueueCancelledError } from './concurrencyLimiter';
import { fileWriteLockManager } from '../../core/fileWriteLockManager';

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

/**
 * 子代理执行器上下文存储
 */
let executorContext: SubAgentExecutorContext | null = null;

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
async function getAvailableTools(
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
    const resolver = new ToolDeclarationResolver(
        context.toolRegistry,
        context.settingsManager,
        context.mcpManager
    );

    return resolver.resolve({
        multimodalEnabled: channelConfig.multimodalToolsEnabled,
        channelType: channelConfig.type,
        toolMode: channelConfig.toolMode,
        promptModeSnapshot: context.promptModeSnapshot,
        includeBuiltins,
        includeMcp,
        allowlist,
        denylist,
        excludeToolNames: ['subagents']
    }) || [];
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
    agentName?: string
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
        // 即使 AI 不应该调用不在列表里的工具，这里做防御性校验
        if (allowedToolNames && allowedToolNames.size > 0) {
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
            const fullResult = await context.toolExecutionService.executeFunctionCallsWithResults(
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
                { kind: 'subagent', id: actualRunId, label: agentName || 'sub-agent' }
            );

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
 * 识别「上下文超限」类错误。
 *
 * 子代理没有接主链路的 ContextTrimService，它的 history 只增不减：工具结果一大、迭代一多就会撞上
 * 模型的上下文上限。各家 provider 措辞不同但都认得出来。不做识别的话，用户只能看到一句原样透传的
 * `AI call failed: ...`，既不知道是撞了上下文，也不知道该去调哪个配置。
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
        const runId = subAgentRunEventBus.allocateRunId(
            requestedRunId || `subagent_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        );

        // 修改原因：子代理对话延续——允许新子代理继承旧 run 的完整 transcript，实现跨调用的对话接力。
        // 修改方式：从 runEventBus 读取旧 run 的 contents 作为 baseContents；校验旧 run 已处于终态。
        // 修改目的：主模型可通过 continueFromRunId 参数指定延续目标，避免每次从零开始。
        const terminalStatuses: SubAgentRunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];
        let baseContents: Content[] = [];
        if (request.continueFromRunId) {
            const oldSnapshot = subAgentRunEventBus.getSnapshot(request.continueFromRunId);
            if (!oldSnapshot) {
                return {
                    success: false,
                    runId,
                    error: `Cannot continue from run "${request.continueFromRunId}": run not found. It may have been cleared or never existed.`
                };
            }
            if (!terminalStatuses.includes(oldSnapshot.status)) {
                return {
                    success: false,
                    runId,
                    error: `Cannot continue from run "${request.continueFromRunId}": the run is still ${oldSnapshot.status}. Only terminal runs (completed / failed / cancelled) can be continued.`
                };
            }
            baseContents = oldSnapshot.contents || [];
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
        subAgentRunEventBus.createRun(runId, config.name, {
            agentType: request.agentType,
            prompt: request.prompt,
            context: request.context
        }, {
            conversationId: context.conversationId,
            conversationStore: context.conversationStore,
            initialContents: [...baseContents, initialPromptContent]
        });
        // 修改原因：Monitor 顶部控制按钮只能控制仍在等待主窗口工具结果的活跃 run。
        // 修改方式：默认 executor 创建 run 后立即注册到 SubAgentRunController，完成/失败时在 finally 中注销。
        // 修改目的：让 Monitor 可以区分“可中止/退出”的活跃 run 和只能查看的历史 run。
        subAgentRunController.register(runId, config.name);

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
        try {
            await subAgentConcurrencyLimiter.acquire(runId, abortSignal);
        } catch (queueError) {
            subAgentRunController.unregister(runId);
            const message = queueError instanceof SubAgentQueueCancelledError
                ? 'User cancelled the sub-agent while it was waiting in the concurrency queue.'
                : `SubAgent failed to acquire a concurrency slot: ${queueError instanceof Error ? queueError.message : String(queueError)}`;
            subAgentRunEventBus.emit({
                runId,
                agentName: config.name,
                type: 'run_cancelled',
                payload: { error: message }
            });
            return {
                success: false,
                runId,
                error: message,
                cancelled: true
            };
        }
        subAgentRunEventBus.emit({
            runId,
            agentName: config.name,
            type: 'run_started'
        });

        const maxIterations = config.maxIterations ?? 50;
        const maxRuntime = config.maxRuntime ?? 1800; // 默认 30 分钟
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
            if (abortSignal) {
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
        }

        const createOperationSignal = (): OperationSignalHandle => {
            const signals = [abortSignal, timeoutController?.signal, subAgentRunController.getAbortSignal(runId)]
                .filter((signal): signal is AbortSignal => !!signal);
            if (signals.length === 0) return { signal: undefined, release: () => undefined };
            const controller = new AbortController();
            const abort = () => controller.abort();
            const attached: AbortSignal[] = [];
            for (const signal of signals) {
                if (signal.aborted) {
                    controller.abort();
                    break;
                }
                signal.addEventListener('abort', abort, { once: true });
                attached.push(signal);
            }
            return {
                signal: controller.signal,
                release: () => {
                    for (const signal of attached) {
                        signal.removeEventListener('abort', abort);
                    }
                    attached.length = 0;
                }
            };
        };

        let lastResponse: string = '';

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
            // 检查是否取消
            if (abortSignal?.aborted || timeoutController?.signal.aborted) {
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

            // 获取可用工具
            const availableTools = await getAvailableTools(config, context);
            
            // 构建允许的工具名称集合，用于执行时的防御性校验
            const allowedToolNames = new Set(availableTools.map(t => t.name));
            
            // 构建系统提示词
            const systemPrompt = config.systemPrompt;
            
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

                // 检查是否取消或超时
                if (abortSignal?.aborted || timeoutController?.signal.aborted) {
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
                const generateRequest: GenerateRequest = {
                    configId: config.channel.channelId,
                    history: history,
                    dynamicSystemPrompt: systemPrompt,
                    abortSignal: operationSignal,
                    toolOverrides: availableTools.length > 0 ? availableTools : undefined,
                    suppressRetryNotification: true,
                    // 修改原因：DeepSeek KVCache 按 user_id 隔离、Anthropic metadata.user_id 区分运行域都依赖请求携带稳定标识。
                    // 修改方式：SubAgent 用 runId 作为 conversationId，每个 run 拥有独立缓存域（formatter 会哈希，不泄露原始 ID）。
                    // 修改目的：主会话与各 SubAgent、SubAgent 彼此之间的 provider 侧缓存互不污染。
                    conversationId: runId,
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
                    promptModeSnapshot: context.promptModeSnapshot
                };
                
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
                            + `Sub-agents do not trim their context: lower this agent's maxIterations, narrow the task, `
                            + `avoid tools that return very large results, or split the work across several sub-agent calls. `
                            + `Original error: ${failureMessage}`
                            : `AI call failed: ${failureMessage}`
                    });
                } finally {
                    // 本轮 LLM 调用结束，摘除组合信号挂在父信号上的 abort 监听器
                    operation.release();
                }
                
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

                // 记录子代理实际运行的模型版本（优先 content.modelVersion，其次 response.model）
                const mvCandidate =
                    (response as any)?.content?.modelVersion
                    || (response as any)?.modelVersion
                    || (response as any)?.model;
                if (typeof mvCandidate === 'string' && mvCandidate.trim()) {
                    modelVersion = mvCandidate.trim();
                }
                
                if (textContent) {
                    lastResponse = textContent;
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
                    if (timeoutCheck.exceeded || abortSignal?.aborted || timeoutController?.signal.aborted) {
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
                            context,
                            toolOperation.signal,
                            allowedToolNames,
                            config,
                            call.id,
                            runId,
                            config.name
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
            subAgentRunController.unregister(runId);
            subAgentConcurrencyLimiter.release(runId);
            // 修改原因：run 异常退出时可能残留未释放的文件写锁（正常路径已在工具执行 finally 中释放）。
            // 修改方式：按 runId 兜底清理该 run 持有的全部锁。
            // 修改目的：避免锁泄漏导致其他 agent 永久无法修改相关文件。
            fileWriteLockManager.releaseAllByHolder(runId);
        }
    };
}

/**
 * 默认执行器工厂
 */
export const defaultExecutorFactory: SubAgentExecutorFactory = createDefaultExecutor;
