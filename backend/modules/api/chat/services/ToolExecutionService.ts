/**
 * LimCode - 工具执行服务
 *
 * 负责执行工具调用、处理 MCP 工具、管理工具确认逻辑
 */

import { t } from '../../../../i18n';
import type { ToolRegistry } from '../../../../tools/ToolRegistry';
import type { ConversationStore, ToolProgressEmitter } from '../../../../tools/types';
import { normalizeToolArgs } from '../../../../tools/coerceToolArgs';

import { validateToolArgs } from '../../../../tools/validateToolArgs';
import { TOOL_CALL_PARSE_ERROR_ARG_KEY } from '../../../../tools/promptToolParser';
import { REPEATED_CALL_GUARD_ARG_KEY } from './repeatedCallGuard';
import { isDiffReviewToolCall } from './diffReviewTools';
import type { CheckpointRecord } from '../../../checkpoint';
import type { SettingsManager } from '../../../settings/SettingsManager';
import type { ResolvedPromptModeSnapshot } from '../../../settings/types';
import { isPlanPathAllowed } from '../../../settings/modeToolsPolicy';
import type { McpManager } from '../../../mcp/McpManager';
import { mcpResultToToolResult } from '../../../mcp/toolAdapter';
import { isMcpToolName, decodeMcpToolName } from '../../../mcp/mcpToolNameCodec';
import type { ContentPart } from '../../../conversation/types';
import type { BaseChannelConfig } from '../../../config/configs/base';
import { getAllWorkspaces, getMultimodalCapability, type ChannelType as UtilChannelType, type ToolMode as UtilToolMode } from '../../../../tools/utils';
import type { FunctionCallInfo, ToolExecutionResult } from '../utils';
import type { CheckpointService } from './CheckpointService';
import {
    getOutsideWorkspaceRejectionReason,
    toolCallNeedsOutsideWorkspaceConfirmation
} from '../../../../tools/file/outsideWorkspaceAccess';
import { fileWriteLockManager, getWritePathsForCall, type LockHolder } from '../../../../core/fileWriteLockManager';

/**
 * 工具执行完整结果
 */
export type ToolExecutionProgressEvent =
    | {
          type: 'start';
          call: FunctionCallInfo;
      }
    | {
          type: 'end';
          call: FunctionCallInfo;
          toolResult: ToolExecutionResult;
      };

export interface ToolExecutionFullResult {
    /** 函数响应 parts（用于添加到历史） */
    responseParts: ContentPart[];
    /** 工具执行结果（用于前端显示） */
    toolResults: ToolExecutionResult[];
    /** 创建的检查点 */
    checkpoints: CheckpointRecord[];
    /** 多模态附件（仅 xml/json 模式时使用） */
    multimodalAttachments?: ContentPart[];
}

/**
 * 深拷贝工具响应，用于历史记录与前端展示的数据隔离。
 *
 * structuredClone 比 JSON 序列化往返快得多（大文本 / 多模态 base64 场景尤其明显）；
 * 遇到不可结构化克隆的值（如函数）时回退到 JSON 方式，保持与旧行为一致。
 */
function cloneToolResponse(response: Record<string, unknown>): Record<string, unknown> {
    try {
        return structuredClone(response);
    } catch {
        return JSON.parse(JSON.stringify(response));
    }
}

/**
 * 工具执行服务
 *
 * 职责：
 * 1. 执行内置工具和 MCP 工具
 * 2. 处理工具确认逻辑
 * 3. 创建工具执行前后的检查点
 * 4. 处理多模态工具返回数据
 */
export class ToolExecutionService {
    private settingsManager?: SettingsManager;
    private mcpManager?: McpManager;
    private toolRegistry?: ToolRegistry;
    private conversationStore?: ConversationStore;

    constructor(
        toolRegistry?: ToolRegistry,
        mcpManager?: McpManager,
        settingsManager?: SettingsManager,
        private checkpointService?: CheckpointService
    ) {
        this.toolRegistry = toolRegistry;
        this.mcpManager = mcpManager;
        this.settingsManager = settingsManager;
    }

    /**
     * 设置设置管理器
     */
    setSettingsManager(settingsManager: SettingsManager): void {
        this.settingsManager = settingsManager;
    }

    /**
     * 设置 MCP 管理器
     */
    setMcpManager(mcpManager: McpManager): void {
        this.mcpManager = mcpManager;
    }

    /**
     * 设置工具注册表
     */
    setToolRegistry(toolRegistry: ToolRegistry): void {
        this.toolRegistry = toolRegistry;
    }

    /**
     * 注入对话存储（用于工具持久化对话元数据）
     */
    setConversationStore(store: ConversationStore): void {
        this.conversationStore = store;
    }

    /**
     * 执行函数调用并返回函数响应 parts
     *
     * @param calls 函数调用列表
     * @param conversationId 对话 ID（用于创建检查点）
     * @param messageIndex 消息索引（用于创建检查点）
     * @returns 函数响应 parts
     */
    async executeFunctionCalls(
        calls: FunctionCallInfo[],
        conversationId?: string,
        messageIndex?: number,
        config?: BaseChannelConfig,
        abortSignal?: AbortSignal,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        progressEmitter?: ToolProgressEmitter
    ): Promise<ContentPart[]> {
        const { responseParts } = await this.executeFunctionCallsWithResults(
            calls,
            conversationId,
            messageIndex,
            config,
            abortSignal,
            promptModeSnapshot,
            progressEmitter
        );
        return responseParts;
    }

    /**
     * 执行函数调用并返回完整结果
     *
     * 实现说明：内部直接驱动 executeFunctionCallsWithProgress 到完成并丢弃进度事件，
     * 与带进度版本共享同一份执行逻辑（检查点、参数规范化、策略过滤、多模态处理），
     * 避免两处几乎相同的实现各自漂移。
     *
     * 检查点策略与多模态处理的具体说明见 executeFunctionCallsWithProgress。
     *
     * @param calls 函数调用列表
     * @param conversationId 对话 ID（用于创建检查点）
     * @param messageIndex 消息索引（用于创建检查点）
     * @param config 渠道配置（用于获取多模态工具设置和工具模式）
     * @param abortSignal 取消信号（用于中断工具执行）
     * @returns 完整执行结果
     */
    async executeFunctionCallsWithResults(
        calls: FunctionCallInfo[],
        conversationId?: string,
        messageIndex?: number,
        config?: BaseChannelConfig,
        abortSignal?: AbortSignal,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        executionOptions?: Set<string> | ToolProgressEmitter,
        progressEmitter?: ToolProgressEmitter,
        attribution?: LockHolder
    ): Promise<ToolExecutionFullResult> {
        const generator = this.executeFunctionCallsWithProgress(
            calls,
            conversationId,
            messageIndex,
            config,
            abortSignal,
            promptModeSnapshot,
            executionOptions,
            progressEmitter,
            attribution
        );

        let next = await generator.next();
        while (!next.done) {
            next = await generator.next();
        }
        return next.value;
    }


    /**
     * 执行函数调用（带进度事件）
     *
     * 用于：前端“实时排队推进”展示。
     *
     * - 在每个工具开始前 yield {type:'start'}
     * - 在每个工具结束后 yield {type:'end'}（包含该工具的 ToolExecutionResult）
     * - 最终通过 generator return 返回完整 ToolExecutionFullResult（供调用方持久化 / 后续流程使用）
     */
    async *executeFunctionCallsWithProgress(
        calls: FunctionCallInfo[],
        conversationId?: string,
        messageIndex?: number,
        config?: BaseChannelConfig,
        abortSignal?: AbortSignal,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        executionOptions?: Set<string> | ToolProgressEmitter,
        progressEmitter?: ToolProgressEmitter,
        attribution?: LockHolder
    ): AsyncGenerator<ToolExecutionProgressEvent, ToolExecutionFullResult, void> {
        const approvedToolCallIds = executionOptions instanceof Set ? executionOptions : undefined;
        const resolvedProgressEmitter = typeof executionOptions === 'function'
            ? executionOptions
            : progressEmitter;

        const responseParts: ContentPart[] = [];
        const toolResults: ToolExecutionResult[] = [];
        const checkpoints: CheckpointRecord[] = [];
        const multimodalAttachments: ContentPart[] = [];

        // 获取工具调用模式
        const toolMode = config?.toolMode || 'function_call';
        const isPromptMode = toolMode === 'xml' || toolMode === 'json';

        const toolNameForCheckpoint = calls.length === 1 ? calls[0].name : 'tool_batch';

        // 在所有工具执行前创建一个检查点
        if (this.checkpointService && conversationId !== undefined && messageIndex !== undefined) {
            const beforeCheckpoint = await this.checkpointService.createToolExecutionCheckpoint(
                conversationId,
                messageIndex,
                toolNameForCheckpoint,
                'before'
            );
            if (beforeCheckpoint) {
                checkpoints.push(beforeCheckpoint);
            }
        }

        // 执行工具。
        // 相邻的纯只读工具（declaration.readOnly === true）会被并行执行，
        // 降低“一次响应携带多个读取/搜索调用”时的累计延迟；
        // 相邻的 subagents 调用同样并行执行（实际并发由全局信号量控制，超出上限的排队）；
        // 写类工具、被策略过滤的调用和 MCP 工具保持严格串行。
        const preparedList = calls.map(call => {
            const prepared = this.prepareToolCallForExecution(call);
            const rejectionReason = prepared.error
                ? null
                : this.getToolRejectionReason(prepared.call.name, prepared.call.args, promptModeSnapshot);
            const runnable = !prepared.error && !rejectionReason;
            return {
                executionCall: prepared.call,
                warnings: prepared.warnings,
                error: prepared.error,
                rejectionReason,
                parallelSafe: runnable && this.isParallelSafeTool(prepared.call.name),
                // 修改原因：多个 subagents 调用过去严格串行，模型一次派发多个子代理无法真正并行。
                // 修改方式：把连续的 subagents 调用识别为专用并行组，与 readOnly 并行组互不混合。
                // 修改目的：一次响应内的多个子代理同时执行，并发上限交给 SubAgentConcurrencyLimiter 排队控制。
                isSubAgentCall: runnable && prepared.call.name === 'subagents'
            };
        });

        let index = 0;
        while (index < preparedList.length) {
            if (abortSignal?.aborted) {
                break;
            }

            const current = preparedList[index];
            const executionCall = current.executionCall;

            // 参数错误（含解析失败/护栏拦截的合成错误）：直接回传错误结果
            if (current.error) {
                const response: Record<string, unknown> = {
                    success: false,
                    error: current.error,
                    ...(current.warnings.length > 0 ? { parameterWarnings: current.warnings } : {})
                };

                const toolResult: ToolExecutionResult = {
                    id: executionCall.id,
                    name: executionCall.name,
                    args: executionCall.args,
                    result: cloneToolResponse(response)
                };
                toolResults.push(toolResult);
                responseParts.push({
                    functionResponse: {
                        id: executionCall.id,
                        name: executionCall.name,
                        response
                    }
                });

                yield { type: 'end', call: executionCall, toolResult };
                index++;
                continue;
            }

            // 执行前强制过滤（模式 toolPolicy / 全局 toolsEnabled / Plan write_file 路径限制）
            if (current.rejectionReason) {
                const response: Record<string, unknown> = {
                    success: false,
                    error: current.rejectionReason,
                    rejected: true
                };

                const toolResult: ToolExecutionResult = {
                    id: executionCall.id,
                    name: executionCall.name,
                    args: executionCall.args,
                    result: cloneToolResponse(response)
                };
                toolResults.push(toolResult);
                responseParts.push({
                    functionResponse: {
                        id: executionCall.id,
                        name: executionCall.name,
                        response
                    }
                });

                // 被策略拒绝的工具：直接给 end 事件（不发 start，避免 UI 把它当作“执行中”）
                yield { type: 'end', call: executionCall, toolResult };
                index++;
                continue;
            }

            // 收集从当前位置开始的连续可并行段：
            // - subagents 段：同一响应中的多个子代理并行执行（信号量负责限流与排队）；
            // - 只读工具段：维持原有 readOnly 并行规则。两类分组互不混合。
            let groupEnd = index;
            if (current.isSubAgentCall) {
                while (groupEnd < preparedList.length && preparedList[groupEnd].isSubAgentCall) {
                    groupEnd++;
                }
            } else {
                while (groupEnd < preparedList.length && preparedList[groupEnd].parallelSafe) {
                    groupEnd++;
                }
            }

            if (groupEnd - index > 1) {
                const group = preparedList.slice(index, groupEnd);

                for (const item of group) {
                    yield { type: 'start', call: item.executionCall };
                }

                const responses = await Promise.all(group.map(item =>
                    this.runSingleToolCall(
                        item.executionCall,
                        conversationId,
                        config,
                        abortSignal,
                        promptModeSnapshot,
                        approvedToolCallIds,
                        resolvedProgressEmitter,
                        attribution
                    )
                ));

                for (let k = 0; k < group.length; k++) {
                    const toolResult = this.finalizeToolResponse(
                        group[k].executionCall,
                        responses[k],
                        group[k].warnings,
                        config,
                        toolMode,
                        isPromptMode,
                        responseParts,
                        toolResults,
                        multimodalAttachments
                    );
                    yield { type: 'end', call: group[k].executionCall, toolResult };
                }

                index = groupEnd;
                continue;
            }

            // 串行执行
            yield { type: 'start', call: executionCall };

            const response = await this.runSingleToolCall(
                executionCall,
                conversationId,
                config,
                abortSignal,
                promptModeSnapshot,
                approvedToolCallIds,
                resolvedProgressEmitter,
                attribution
            );

            const toolResult = this.finalizeToolResponse(
                executionCall,
                response,
                current.warnings,
                config,
                toolMode,
                isPromptMode,
                responseParts,
                toolResults,
                multimodalAttachments
            );

            yield { type: 'end', call: executionCall, toolResult };
            index++;
        }


        // 在所有工具执行后创建一个检查点
        if (this.checkpointService && conversationId !== undefined && messageIndex !== undefined) {
            const afterCheckpoint = await this.checkpointService.createToolExecutionCheckpoint(
                conversationId,
                messageIndex,
                toolNameForCheckpoint,
                'after'
            );
            if (afterCheckpoint) {
                checkpoints.push(afterCheckpoint);
            }
        }

        return {
            responseParts,
            toolResults,
            checkpoints,
            multimodalAttachments: multimodalAttachments.length > 0 ? multimodalAttachments : undefined
        };
    }

    /**
     * 执行 MCP 工具
     */
    private async executeMcpTool(call: FunctionCallInfo): Promise<Record<string, unknown>> {
        const decoded = decodeMcpToolName(call.name);
        if (decoded) {
            const { serverId, toolName } = decoded;

            const result = await this.mcpManager!.callTool({
                serverId,
                toolName,
                arguments: call.args
            });

            // 统一转换 MCP 结果（支持 text / image / resource）
            const toolResult = mcpResultToToolResult(result);

            if (toolResult.success) {
                const textContent = typeof toolResult.data === 'string' ? toolResult.data : '';
                const response: Record<string, unknown> = {
                    success: true,
                    content: textContent || t('modules.api.chat.errors.toolExecutionSuccess')
                };

                // 保留多模态数据，后续由 processMultimodalData 统一处理
                if (toolResult.multimodal && toolResult.multimodal.length > 0) {
                    response.multimodal = toolResult.multimodal.map(item => ({
                        mimeType: item.mimeType,
                        data: item.data,
                        name: item.name
                    }));
                }

                return response;
            } else {
                return {
                    success: false,
                    error:
                        toolResult.error ||
                        result.error ||
                        t('modules.api.chat.errors.mcpToolCallFailed')
                };
            }
        } else {
            return {
                success: false,
                error: t('modules.api.chat.errors.invalidMcpToolName', { toolName: call.name })
            };
        }
    }

    private prepareToolCallForExecution(
        call: FunctionCallInfo
    ): { call: FunctionCallInfo; error: string | null; warnings: string[] } {
        // 合成错误调用拦截：
        // - prompt 模式（JSON/XML）下解析失败的块（携带解析错误）
        // - 重复失败调用护栏拦截的调用（携带护栏提示）
        // 这些调用不进入真实执行，直接把错误作为工具结果回传给模型
        for (const syntheticErrorKey of [TOOL_CALL_PARSE_ERROR_ARG_KEY, REPEATED_CALL_GUARD_ARG_KEY]) {
            const syntheticError = call.args && typeof call.args[syntheticErrorKey] === 'string'
                ? call.args[syntheticErrorKey] as string
                : null;
            if (syntheticError) {
                return { call, error: syntheticError, warnings: [] };
            }
        }

        if (isMcpToolName(call.name)) {
            return { call, error: null, warnings: [] };
        }

        const tool = this.toolRegistry?.getTool(call.name);
        if (!tool) {
            return { call, error: null, warnings: [] };
        }

        const schema = tool.declaration?.parameters;

        // 1. 规范化：单数别名提升（path→paths）、递归类型容错（"true"→true 等）、
        //    未知参数剥离（含 update_plan 的 carry-over 字段等）。
        //    所有自动纠正都会生成警告，随工具结果回传给模型。
        const { args: preparedArgs, warnings } = normalizeToolArgs(call.name, call.args, schema, {
            paramAliases: tool.declaration?.paramAliases,
            compatParams: tool.declaration?.compatParams
        });

        // 2. schema 校验：必需字段缺失、类型不匹配（规范化后仍无法修复的才报错）
        const schemaError = validateToolArgs(call.name, preparedArgs, schema);

        return {
            call: preparedArgs === call.args ? call : { ...call, args: preparedArgs },
            error: schemaError,
            warnings
        };
    }

    /**
     * 工具是否可以与相邻只读工具并行执行。
     * 仅内置工具且声明 readOnly: true 的才允许；MCP 工具行为未知，一律串行。
     */
    private isParallelSafeTool(toolName: string): boolean {
        if (isMcpToolName(toolName)) {
            return false;
        }
        return this.toolRegistry?.getTool(toolName)?.declaration?.readOnly === true;
    }

    /**
     * 执行单个工具调用（MCP 或内置），异常统一转为错误响应。
     */
    private async runSingleToolCall(
        executionCall: FunctionCallInfo,
        conversationId: string | undefined,
        config: BaseChannelConfig | undefined,
        abortSignal: AbortSignal | undefined,
        promptModeSnapshot: ResolvedPromptModeSnapshot | undefined,
        approvedToolCallIds: Set<string> | undefined,
        progressEmitter: ToolProgressEmitter | undefined,
        attribution?: LockHolder
    ): Promise<Record<string, unknown>> {
        try {
            if (isMcpToolName(executionCall.name) && this.mcpManager) {
                return await this.executeMcpTool(executionCall);
            }
            return await this.executeBuiltinTool(
                executionCall,
                conversationId,
                config,
                abortSignal,
                promptModeSnapshot,
                approvedToolCallIds?.has(executionCall.id) === true,
                progressEmitter,
                attribution
            );
        } catch (error) {
            const err = error as Error;
            return {
                success: false,
                error: err.message || t('modules.api.chat.errors.toolExecutionFailed')
            };
        }
    }

    /**
     * 把工具响应落入 toolResults / responseParts / multimodalAttachments，
     * 并附加参数规范化警告。返回构造好的 ToolExecutionResult。
     */
    private finalizeToolResponse(
        executionCall: FunctionCallInfo,
        response: Record<string, unknown>,
        warnings: string[],
        config: BaseChannelConfig | undefined,
        toolMode: string,
        isPromptMode: boolean,
        responseParts: ContentPart[],
        toolResults: ToolExecutionResult[],
        multimodalAttachments: ContentPart[]
    ): ToolExecutionResult {
        // 参数规范化警告随结果回传，帮助模型在后续调用中修正参数写法
        if (warnings.length > 0 && response.parameterWarnings === undefined) {
            response.parameterWarnings = warnings;
        }

        const toolResult: ToolExecutionResult = {
            id: executionCall.id,
            name: executionCall.name,
            args: executionCall.args,
            // 深拷贝：保留完整数据供前端显示
            result: cloneToolResponse(response)
        };
        toolResults.push(toolResult);

        // 处理多模态数据
        const multimodalData = (response as any).multimodal as Array<{
            mimeType: string;
            data: string;
            name?: string;
        }> | undefined;

        if (multimodalData && multimodalData.length > 0) {
            this.processMultimodalData(
                multimodalData,
                response,
                executionCall,
                config,
                toolMode,
                isPromptMode,
                responseParts,
                multimodalAttachments
            );
        } else {
            responseParts.push({
                functionResponse: {
                    name: executionCall.name,
                    response,
                    id: executionCall.id
                }
            });
        }

        return toolResult;
    }



    /**
     * 执行内置工具
     */
    private async executeBuiltinTool(
        call: FunctionCallInfo,
        conversationId?: string,
        config?: BaseChannelConfig,
        abortSignal?: AbortSignal,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        approvedByToolConfirmation?: boolean,
        progressEmitter?: ToolProgressEmitter,
        attribution?: LockHolder
    ): Promise<Record<string, unknown>> {
        const tool = this.toolRegistry?.getTool(call.name);

        if (!tool) {
            return {
                success: false,
                error: t('modules.api.chat.errors.toolNotFound', { toolName: call.name })
            };
        }

        // 修改原因：SubAgent 并行执行后，多个执行方可能同时写同一文件导致互相覆盖。
        // 修改方式：写类工具执行前按目标路径尝试加全局互斥锁；撞车时立即返回带 lockConflict 标志的失败结果（非阻塞）。
        // 修改目的：后来者的 LLM 收到"先做其他部分，稍后再回来"的提示自行调度；diff 预览确认期间锁保持持有。
        const writePaths = getWritePathsForCall(call.name, call.args as Record<string, unknown>);
        const lockHolder: LockHolder = attribution ?? {
            kind: 'main',
            id: conversationId ? `conversation_${conversationId}` : 'main',
            label: 'main session'
        };
        let lockedPaths: string[] | null = null;
        if (writePaths && writePaths.length > 0) {
            const lockResult = fileWriteLockManager.tryAcquire(writePaths, lockHolder);
            if (!lockResult.acquired) {
                const conflictText = lockResult.conflicts
                    .map(c => `'${c.path}' is currently being modified by ${c.holder.kind === 'subagent' ? `agent "${c.holder.label}"` : c.holder.label}`)
                    .join('; ');
                return {
                    success: false,
                    error: `File write conflict: ${conflictText}. Do NOT wait or retry this file immediately. Work on other parts of your task first, then come back to this file after the current holder finishes.`,
                    lockConflict: true
                };
            }
            lockedPaths = writePaths;
        }

        // 获取渠道多模态能力
        const toolMode = config?.toolMode || 'function_call';
        const channelType = (config?.type || 'custom') as UtilChannelType;
        const currentToolMode = (toolMode || 'function_call') as UtilToolMode;
        const multimodalEnabled = config?.multimodalToolsEnabled ?? false;
        const capability = getMultimodalCapability(channelType, currentToolMode, multimodalEnabled);

        // 构建工具执行上下文，包含多模态配置、能力、取消信号和工具调用 ID
        const toolContext: Record<string, unknown> = {
            multimodalEnabled,
            capability,
            abortSignal,
            toolId: call.id,  // 使用函数调用 ID 作为工具 ID，用于追踪和取消
            toolOptions: config?.toolOptions,  // 传递工具配置
            approvedByToolConfirmation: approvedByToolConfirmation === true,
            // 注入对话上下文（供 todo_write 等工具使用）
            conversationId,
            conversationStore: this.conversationStore,
            // 修改原因：General Worker 虚拟子代理需要继承主会话当前渠道，而渠道 id 只在这一层可见。
            // 修改方式：把当前请求渠道配置 id 注入 toolContext，供 subagents handler 构造动态 worker 配置。
            // 修改目的：用户零配置即可让主模型派发与自己同渠道同权限的 worker。
            channelConfigId: config?.id,
            // 让 SubAgent Monitor 和长耗时工具复用同一工具执行链路上报进度。
            emitProgress: progressEmitter
                ? (event: Parameters<ToolProgressEmitter>[0]) => progressEmitter({
                    ...event,
                    toolId: event.toolId || call.id,
                    toolName: event.toolName || call.name,
                    timestamp: event.timestamp || Date.now()
                })
                : undefined
        };

        toolContext.promptModeSnapshot = promptModeSnapshot;

        // 为特定工具添加配置
        this.addToolSpecificConfig(call.name, toolContext);

        try {
            const result = await tool.handler(call.args, toolContext);
            return result as unknown as Record<string, unknown>;
        } finally {
            if (lockedPaths) {
                fileWriteLockManager.release(lockedPaths, lockHolder);
            }
        }
    }

    /**
     * 为特定工具添加配置
     */
    private addToolSpecificConfig(toolName: string, toolContext: Record<string, unknown>): void {
        if (!this.settingsManager) {
            return;
        }

        // generate_image 工具配置
        if (toolName === 'generate_image') {
            const imageConfig = this.settingsManager.getGenerateImageConfig();
            toolContext.config = {
                ...imageConfig,
                proxyUrl: this.settingsManager.getEffectiveProxyUrl()
            };
        }

        // remove_background 工具复用 generate_image 的 API 配置，但使用自己的返回图片配置
        if (toolName === 'remove_background') {
            const imageConfig = this.settingsManager.getGenerateImageConfig();
            const removeConfig = this.settingsManager.getRemoveBackgroundConfig();
            toolContext.config = {
                ...imageConfig,
                ...removeConfig,
                proxyUrl: this.settingsManager.getEffectiveProxyUrl()
            };
        }

        // crop_image 工具配置
        if (toolName === 'crop_image') {
            const cropConfig = this.settingsManager.getCropImageConfig();
            toolContext.config = {
                ...cropConfig
            };
        }

        // resize_image 工具配置
        if (toolName === 'resize_image') {
            const resizeConfig = this.settingsManager.getResizeImageConfig();
            toolContext.config = {
                ...resizeConfig
            };
        }

        // rotate_image 工具配置
        if (toolName === 'rotate_image') {
            const rotateConfig = this.settingsManager.getRotateImageConfig();
            toolContext.config = {
                ...rotateConfig
            };
        }
    }

    /**
     * 处理多模态数据
     */
    private processMultimodalData(
        multimodalData: Array<{ mimeType: string; data: string; name?: string }>,
        response: Record<string, unknown>,
        call: FunctionCallInfo,
        config: BaseChannelConfig | undefined,
        toolMode: string,
        isPromptMode: boolean,
        responseParts: ContentPart[],
        multimodalAttachments: ContentPart[]
    ): void {
        // 获取渠道能力
        const channelType = (config?.type || 'custom') as UtilChannelType;
        const currentToolMode = (toolMode || 'function_call') as UtilToolMode;
        const multimodalEnabled = config?.multimodalToolsEnabled ?? false;
        const capability = getMultimodalCapability(channelType, currentToolMode, multimodalEnabled);

        if (isPromptMode) {
            // XML/JSON 模式：将多模态数据作为用户消息附件
            for (const item of multimodalData) {
                multimodalAttachments.push({
                    inlineData: {
                        mimeType: item.mimeType,
                        data: item.data,
                        displayName: item.name
                    }
                });
            }
            // 从响应中移除 multimodal 数据（因为已经单独处理）
            delete (response as any).multimodal;

            // 构建函数响应 part
            responseParts.push({
                functionResponse: {
                    name: call.name,
                    response,
                    id: call.id
                }
            });
        } else {
            // function_call 模式
            if (capability.supportsImages || capability.supportsDocuments) {
                // Gemini/Anthropic 支持在 functionResponse 中包含多模态数据
                const multimodalParts: ContentPart[] = multimodalData.map(item => ({
                    inlineData: {
                        mimeType: item.mimeType,
                        data: item.data,
                        displayName: item.name
                    }
                }));

                // 从响应中移除 multimodal 数据（将放入 parts 中）
                delete (response as any).multimodal;

                // 构建带 parts 的函数响应
                responseParts.push({
                    functionResponse: {
                        name: call.name,
                        response,
                        id: call.id,
                        parts: multimodalParts
                    }
                });
            } else {
                // 渠道不支持 function_call 模式的多模态（如 OpenAI）
                console.log(`[Multimodal] Channel ${channelType} does not support function_call multimodal, image data will be discarded`);
                delete (response as any).multimodal;

                // 构建函数响应 part
                responseParts.push({
                    functionResponse: {
                        name: call.name,
                        response,
                        id: call.id
                    }
                });
            }
        }
    }

    /**
     * 检查工具是否需要用户确认
     *
     * 使用统一的工具自动执行配置来判断
     * 如果工具被配置为自动执行（autoExec = true），则不需要确认
     * 如果工具被配置为需要确认（autoExec = false），则需要用户确认
     *
     * @param toolName 工具名称
     * @returns 是否需要确认
     */
    toolNeedsConfirmation(toolName: string, args?: Record<string, unknown>, promptModeSnapshot?: ResolvedPromptModeSnapshot): boolean {
        // 如果工具在当前模式被禁用（mode allowlist / Plan write_file 路径限制 / toolsEnabled），则不等待确认
        if (this.getToolRejectionReason(toolName, args, promptModeSnapshot) !== null) {
            return false;
        }

        if (!this.settingsManager) {
            return false;
        }

        if (toolCallNeedsOutsideWorkspaceConfirmation(toolName, args, this.settingsManager)) {
            return true;
        }

        // diff 审阅类调用（write_file/apply_diff/insert_code/delete_code/search_in_files replace）
        // 不走聊天确认：diff 机制本身就是它们的确认层——
        // autoSave 关闭时用户在 diff 视图中手动确认；autoSave 开启时用户已明确选择自动应用。
        // 确认行为的唯一数据源是 apply_diff 工具设置，避免“两个设置页都要配置”的困惑。
        if (isDiffReviewToolCall(toolName, args)) {
            return false;
        }

        // 使用统一的自动执行配置
        // isToolAutoExec 返回 true 表示自动执行，不需要确认
        // isToolAutoExec 返回 false 表示需要确认
        return !this.settingsManager.isToolAutoExec(toolName);
    }

    /**
     * 从函数调用列表中筛选出需要确认的工具
     *
     * @param calls 函数调用列表
     * @returns 需要确认的函数调用列表
     */
    getToolsNeedingConfirmation(calls: FunctionCallInfo[], promptModeSnapshot?: ResolvedPromptModeSnapshot): FunctionCallInfo[] {
        return calls.filter(call => this.toolNeedsConfirmation(call.name, call.args, promptModeSnapshot));
    }

    /**
     * 获取工具在当前模式下的拒绝原因（若允许则返回 null）
     *
     * 强制策略：
     * - 全局 toolsEnabled（SettingsManager.isToolEnabled）
     * - 当前模式 allowlist（mode.toolPolicy 仅当为非空数组时启用过滤）
     * - Plan 模式 write_file 仅允许写入 .limcode/plans/**.md（多工作区支持 workspaceName/.limcode/plans/**.md）
     */
    private getToolRejectionReason(toolName: string, args?: Record<string, unknown>, promptModeSnapshot?: ResolvedPromptModeSnapshot): string | null {
        // 1) 全局 toolsEnabled
        if (this.settingsManager && this.settingsManager.isToolEnabled(toolName) === false) {
            return `Tool "${toolName}" is disabled by settings (toolsEnabled).`;
        }

        // 2) 当前请求模式 allowlist（仅当 toolPolicy 为非空数组时启用过滤）
        const allowlist = Array.isArray(promptModeSnapshot?.toolPolicy) && promptModeSnapshot.toolPolicy.length > 0
            ? promptModeSnapshot.toolPolicy
            : undefined;
        if (allowlist && !allowlist.includes(toolName)) {
            return `Tool "${toolName}" is not allowed in mode "${promptModeSnapshot?.id ?? 'unknown'}".`;
        }

        // 3) Plan 模式 write_file 受控例外：只允许写入 .limcode/plans/**.md
        if (promptModeSnapshot?.id === 'plan' && toolName === 'write_file') {
            const validation = this.validatePlanModeWriteFileArgs(args);
            if (validation.ok === false) {
                return validation.error;
            }
        }

        const outsideWorkspaceRejection = getOutsideWorkspaceRejectionReason(toolName, args, this.settingsManager);
        if (outsideWorkspaceRejection) {
            return outsideWorkspaceRejection;
        }

        return null;
    }

    private validatePlanModeWriteFileArgs(
        args?: Record<string, unknown>
    ): { ok: true } | { ok: false; error: string } {
        // write_file 的 schema 只有单文件 path 形式；旧的 files[] 数组分支是死代码
        //（schema 校验会先拒绝无 path 的调用），这里保持与 schema 一致的单一路径。
        const rawPath = (args as any)?.path;
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
            return { ok: false, error: 'In plan mode, write_file requires a non-empty "path" string.' };
        }
        if (!this.isPlanModeWriteFilePathAllowed(rawPath)) {
            return {
                ok: false,
                error: `In plan mode, write_file is only allowed to write ".limcode/plans/**.md". Rejected path: ${rawPath}`
            };
        }
        return { ok: true };
    }

    private isPlanModeWriteFilePathAllowed(path: string): boolean {
        // 先尝试单工作区格式：.limcode/plans/...
        if (isPlanPathAllowed(path)) {
            return true;
        }

        // 多工作区：允许 workspaceName/.limcode/plans/...
        let isMultiRoot = false;
        try {
            isMultiRoot = getAllWorkspaces().length > 1;
        } catch {
            isMultiRoot = false;
        }

        if (!isMultiRoot) {
            return false;
        }

        const normalized = path.replace(/\\/g, '/');
        const slashIndex = normalized.indexOf('/');
        if (slashIndex <= 0) {
            return false;
        }
        const withoutWorkspacePrefix = normalized.substring(slashIndex + 1);
        return isPlanPathAllowed(withoutWorkspacePrefix);
    }
}
