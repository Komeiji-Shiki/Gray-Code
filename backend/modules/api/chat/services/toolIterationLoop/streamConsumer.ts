/**
 * GrayCode - 工具迭代循环 · 流式消费切面
 *
 * 从 ToolIterationLoopService 拆出：流式响应处理器构造、流式早启动工具状态排水、
 * 以及「流式边输出边执行」工具的启动编排。行为与拆分前逐字一致。
 */

import type { BaseChannelConfig } from '../../../../config/configs/base';
import type { ConversationManager } from '../../../../conversation/ConversationManager';
import type { DynamicRuntimeContext } from '../../../../prompt/PromptManager';
import type { ResolvedPromptModeSnapshot } from '../../../../settings/types';
import type { Logger } from '../../../../../core/logger';
import type { ChatStreamToolStatusData } from '../../types';
import type { FunctionCallInfo } from '../../utils';
import { StreamResponseProcessor } from '../../handlers/StreamResponseProcessor';
import type { ToolExecutionService, ToolExecutionFullResult } from '../ToolExecutionService';
import { createChatToolStatusUpdate, EarlyStreamingToolProgressQueue } from '../streamingToolProgress';
import { RepeatedCallGuard } from '../repeatedCallGuard';
import type { CheckpointService } from '../CheckpointService';
import {
    collectAffectedPaths,
    ensureStreamBatchBeforeCheckpoint,
    type StreamToolBatchCheckpointState,
    type TurnBatchCheckpointState
} from './checkpointCoordinator';
import { shouldStartToolDuringModelStream } from './confirmationGate';

/**
 * 按统一口径构造流式响应处理器（流式/非流式两个分支共用同一份参数口径）。
 */
export function createStreamResponseProcessor(
    requestStartTime: number,
    config: Pick<BaseChannelConfig, 'type' | 'toolMode'>,
    abortSignal: AbortSignal | undefined,
    conversationId: string
): StreamResponseProcessor {
    return new StreamResponseProcessor({
        requestStartTime,
        providerType: config.type as 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
        toolMode: config.toolMode || 'function_call',
        abortSignal,
        conversationId
    });
}

/**
 * 构造「早启动工具已落定状态」排水函数：把已完成工具逐条翻译为前端 toolStatus 事件。
 */
export function makeEarlyToolStatusDrainer(
    earlyToolProgressQueue: EarlyStreamingToolProgressQueue,
    conversationId: string
): () => ChatStreamToolStatusData[] {
    return () => earlyToolProgressQueue
        .drainSettled()
        .flatMap(settlement => settlement.fullResult.toolResults.map(toolResult => ({
            conversationId,
            toolStatus: true as const,
            tool: createChatToolStatusUpdate(toolResult)
        })));
}

/**
 * 流式早启动工具编排参数。
 */
export interface StartEarlyStreamingToolsParams {
    conversationId: string;
    iteration: number;
    newCalls: FunctionCallInfo[];
    config: BaseChannelConfig;
    abortSignal?: AbortSignal;
    promptModeSnapshot?: ResolvedPromptModeSnapshot;
    modelOverride?: string;
    runtimeContext?: DynamicRuntimeContext;
    repeatedCallGuard: RepeatedCallGuard;
    streamingToolPromises: Map<string, Promise<ToolExecutionFullResult>>;
    streamingToolResults: Map<string, ToolExecutionFullResult>;
    earlyToolProgressQueue: EarlyStreamingToolProgressQueue;
    streamBatchCheckpoint: StreamToolBatchCheckpointState;
    turnBatch: TurnBatchCheckpointState;
    toolExecutionService: ToolExecutionService;
    checkpointService: CheckpointService;
    conversationManager: ConversationManager;
    log: Logger;
}

/**
 * 流式边执行工具：检测 StreamAccumulator 中新完成的 functionCall。
 * 对不需要确认且不需要模式策略拒绝的工具，立即启动异步执行，并逐条 yield
 * 「executing」状态（yield 时机与拆分前完全一致，避免改变对外可见的时序）。
 *
 * 需要确认的工具跳过（仍走现有的暂停等待路径）。
 */
export function* startEarlyStreamingTools(
    params: StartEarlyStreamingToolsParams
): Generator<ChatStreamToolStatusData> {
    const {
        conversationId,
        iteration,
        newCalls,
        config,
        abortSignal,
        promptModeSnapshot,
        modelOverride,
        runtimeContext,
        repeatedCallGuard,
        streamingToolPromises,
        streamingToolResults,
        earlyToolProgressQueue,
        streamBatchCheckpoint,
        turnBatch,
        toolExecutionService,
        checkpointService,
        conversationManager,
        log
    } = params;

    for (const fc of newCalls) {
        // 只对不需要确认、且不会创建 pending diff 审阅会话的工具提前执行。
        if (shouldStartToolDuringModelStream(fc, toolExecutionService, promptModeSnapshot)) {
            log.info('stream.early_tool_start', { conversationId, iteration, toolName: fc.name, toolId: fc.id });
            yield {
                conversationId,
                toolStatus: true as const,
                tool: {
                    id: fc.id,
                    name: fc.name,
                    status: 'executing' as const,
                    args: fc.args
                }
            };

            // CPF-07：批次 before 检查点——第一个「已配置 before 存档」的工具启动前创建
            // （纯只读/仅配置 after 的工具不触发；CheckpointManager 内部再按 beforeTools 精确判定，
            // 避免「未勾选执行前存档」的工具也触发批次 before）。创建不阻塞流式循环：before 与工具执行
            // 串在同一 promise 链上（before 完成后才启动工具，保持「写工具执行前已有存档」的既有保证）。
            streamBatchCheckpoint.batchToolNames.add(fc.name);
            // CP-PARTIAL-1：累计受影响路径（当前已知工具；流式期间后续工具到达时继续累计）
            collectAffectedPaths(
                streamBatchCheckpoint,
                [fc],
                streamBatchCheckpoint.workspaceRootFsPath
            );
            // 批次挂载索引惰性计算（首个工具到达时启动一次；模型消息未落盘，
            // history.length = 即将写入位置——与 createModelMessageCheckpoint before 语义一致）。
            // getHistoryRef 失败时索引留空，各消费点在 messageIndex 缺省时直接读取兑底。
            if (!streamBatchCheckpoint.batchIndexPromise) {
                streamBatchCheckpoint.batchIndexPromise = conversationManager
                    .getHistoryRef(conversationId)
                    .then(history => {
                        streamBatchCheckpoint.messageIndex = history.length;
                    })
                    .catch(() => {
                        // 索引留空：ensure/finalize 消费点有独立兑底读取，不再向上传播
                    });
            }
            // needsCheckpoint 按「批内工具命中 afterTools」判定：
            // 仅配置 after（未勾 before）的工具批次仍需在完成后创建 after 存档。
            if (!streamBatchCheckpoint.needsCheckpoint
                && checkpointService?.isToolConfiguredForCheckpoint(fc.name, fc.args, 'after')) {
                streamBatchCheckpoint.needsCheckpoint = true;
            }
            const beforeCheckpointPromise = streamBatchCheckpoint.beforeCreated
                ? null
                : checkpointService?.isToolConfiguredForCheckpoint(fc.name, fc.args, 'before')
                    ? ensureStreamBatchBeforeCheckpoint(
                        { checkpointService, conversationManager, log },
                        conversationId,
                        streamBatchCheckpoint,
                        turnBatch
                    )
                    : null;
            const rawPromise = (beforeCheckpointPromise ?? Promise.resolve())
                .then(() => toolExecutionService.executeFunctionCallsWithResults(
                    [repeatedCallGuard.guardCall({ id: fc.id, name: fc.name, args: fc.args })],
                    conversationId,
                    // CPF-07：不再传 earlyCheckpointIndex——批次检查点已由上方统一创建，
                    // 执行核心以 checkpointMode='skip' 跳过内部检查点（避免每组工具
                    // 各建一组 before/after 物理存档）。
                    undefined,
                    config,
                    abortSignal,
                    promptModeSnapshot,
                    undefined,
                    undefined,
                    undefined,
                    // E-1：早启动生成器一律不参与主会话信箱 drain（不传 mailbox 身份）。
                    undefined,
                    undefined,
                    // 主会话路径无嵌套深度（subagent 工具自行注入子代理深度）
                    undefined,
                    // 当前对话绑定的工作区 URI（用于工具执行的工作区限定/记忆路由）
                    runtimeContext?.workspaceUri,
                    // General Worker 模型继承：把主会话当前模型透传给工具上下文
                    modelOverride,
                    // CPF-07：批次检查点统一由本服务创建，执行核心跳过内部检查点
                    'skip'
                ))
                .catch(err => {
                    // 执行异常时构造一个包含错误信息的 ToolExecutionFullResult，
                    // 确保 toolResults.result 仍是工具业务返回值格式，前端能正确渲染。
                    const errorResponse: Record<string, unknown> = {
                        success: false,
                        error: (err as Error).message
                    };
                    return {
                        responseParts: [{ functionResponse: { id: fc.id, name: fc.name, response: errorResponse } }],
                        toolResults: [{ id: fc.id, name: fc.name, args: fc.args, result: errorResponse }],
                        checkpoints: []
                    } as ToolExecutionFullResult;
                }).then(fullResult => {
                    streamingToolResults.set(fc.id, fullResult);
                    return fullResult;
                });

            const promise = earlyToolProgressQueue.track(fc, rawPromise);
            streamingToolPromises.set(fc.id, promise);
        }
    }
}
