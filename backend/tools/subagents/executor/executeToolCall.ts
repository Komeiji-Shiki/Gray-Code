/**
 * 子代理单个工具调用的执行（含确认门 / 事件上报 / 优雅中止宽限）。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

import type { SubAgentConfig, SubAgentExecutorContext } from '../types';
import { SUBAGENT_TOOL_ABORT_GRACE_MS, waitForAbortableOperation } from './abort';
import type { SubAgentExecutedToolCall } from './types';
import { subAgentRunEventBus } from '../runEventBus';

/**
 * 执行单个工具调用
 */
export async function executeToolCall(
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
        // 注意：必须经 service 实例调用（toolNeedsConfirmation 内部依赖 this），
        // 解构为独立函数会丢失 this 绑定导致 TypeError（Cannot read properties of undefined
        // (reading 'getToolRejectionReason')）——用 bind 保持实例调用。
        const toolExecutionService = context.toolExecutionService;
        const confirmationGate = typeof toolExecutionService.toolNeedsConfirmation === 'function'
            ? toolExecutionService.toolNeedsConfirmation.bind(toolExecutionService)
            : undefined;
        const confirmationRefusal = confirmationGate
            ? (confirmationGate(toolName, args, context.promptModeSnapshot)
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
                // 模型继承：子代理内部再派发 General Worker 时继承本 run 的模型（config.channel.modelId），
                // 与主会话路径注入 channelModelId 的口径一致（无则走渠道默认模型）。
                undefined,
                agentConfig.channel.modelId
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
