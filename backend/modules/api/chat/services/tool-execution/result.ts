/**
 * LimCode - 工具执行服务：单工具执行 / 结果加工 / 多模态 / 活动统计
 *
 * ToolExecutionService.ts 职责拆分（第二批）的 ResultCore 基类。
 * 继承链：ToolExecutionService → ExecutionCore → ResultCore → PreflightCore → MailboxCore。
 *
 * 本文件承载：
 * - 单工具执行（runSingleToolCall / executeMcpTool / executeBuiltinTool / addToolSpecificConfig）
 * - 工具准备（prepareToolCallForExecution / isParallelSafeTool）
 * - 结果加工（finalizeToolResponse / cloneToolResponse / processMultimodalData）
 * - 活动统计（beginAiWork / endAiWork，在 runSingleToolCall 内）
 *
 * 逻辑与拆分前逐字一致；仅可见性从 private 调整为 protected（跨继承类调用所需，
 * 编译期属性，零运行时影响）。
 */
import { t } from '../../../../../i18n';
import type { ToolRegistry } from '../../../../../tools/ToolRegistry';
import type { ConversationStore, ToolProgressEmitter } from '../../../../../tools/types';
import { normalizeToolArgs } from '../../../../../tools/coerceToolArgs';
import { validateToolArgs } from '../../../../../tools/validateToolArgs';
import { TOOL_CALL_PARSE_ERROR_ARG_KEY } from '../../../../../core/parsers/promptToolParser';
import { REPEATED_CALL_GUARD_ARG_KEY } from '../repeatedCallGuard';
import type { McpManager } from '../../../../mcp/McpManager';
import { mcpResultToToolResult } from '../../../../mcp/toolAdapter';
import { isMcpToolName, decodeMcpToolName } from '../../../../mcp/mcpToolNameCodec';
import type { ContentPart } from '../../../../conversation/types';
import type { BaseChannelConfig } from '../../../../config/configs/base';
import { getMultimodalCapability, type ChannelType as UtilChannelType, type ToolMode as UtilToolMode } from '../../../../../tools/utils';
import type { FunctionCallInfo, ToolExecutionResult } from '../../utils';
import type { CheckpointRecord } from '../../../../checkpoint';
import type { ResolvedPromptModeSnapshot } from '../../../../settings/types';
import { fileWriteLockManager, getWritePathsForCall, type LockHolder } from '../../../../../core/fileWriteLockManager';
import { beginAiWork, endAiWork } from '../../../../activity';
import { PreflightCore } from './preflight';

/**
 * 浅拷贝工具响应，用于历史记录与前端展示的数据隔离。
 *
 * 工具响应是扁平可序列化结构（success/error/result/parameterWarnings 等顶层标量字段），
 * 浅拷贝即可隔离顶层字段的后续变更：finalizeToolResponse 的 parameterWarnings 注入与
 * processMultimodalData 的 delete response.multimodal 都发生在拷贝之后，浅拷贝不受影响；
 * 嵌套 result 对象与历史 functionResponse 共享引用——下游 cleanFunctionResponseForAPI /
 * mergeResponseWithCleanup 均以解构/展开生成新对象，无就地深层变更，隔离语义保持。
 * 遇到不可拷贝的异常值（如带抛错 getter 的代理）时回退 JSON 深拷贝；两者都失败时
 * 返回失败结果，避免异常逃逸丢整批工具结果。
 */
export function cloneToolResponse(response: Record<string, unknown>): Record<string, unknown> {
    try {
        return { ...response };
    } catch {
        try {
            return JSON.parse(JSON.stringify(response));
        } catch {
            // C-11：JSON 回退同样可能失败（循环引用/非序列化值）——返回失败结果，
            // 避免异常逃逸丢整批工具结果。
            return {
                success: false,
                error: 'tool result serialization failed (circular reference or non-serializable value)',
            };
        }
    }
}

/**
 * 单工具执行 / 结果加工 / 多模态 / 活动统计基类
 */
export class ResultCore extends PreflightCore {
    protected mcpManager?: McpManager;
    protected toolRegistry?: ToolRegistry;
    protected conversationStore?: ConversationStore;

    /**
     * 执行 MCP 工具
     *
     * @param abortSignal 外部取消信号（可选），透传给 mcpManager.callTool 的请求对象
     */
    private async executeMcpTool(call: FunctionCallInfo, abortSignal?: AbortSignal): Promise<Record<string, unknown>> {
        const decoded = decodeMcpToolName(call.name);
        if (decoded) {
            const { serverId, toolName } = decoded;

            const result = await this.mcpManager!.callTool({
                serverId,
                toolName,
                arguments: call.args,
                signal: abortSignal
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

    protected prepareToolCallForExecution(
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
    protected isParallelSafeTool(toolName: string): boolean {
        if (isMcpToolName(toolName)) {
            return false;
        }
        return this.toolRegistry?.getTool(toolName)?.declaration?.readOnly === true;
    }

    /**
     * 执行单个工具调用（MCP 或内置），异常统一转为错误响应。
     */
    protected async runSingleToolCall(
        executionCall: FunctionCallInfo,
        conversationId: string | undefined,
        config: BaseChannelConfig | undefined,
        abortSignal: AbortSignal | undefined,
        promptModeSnapshot: ResolvedPromptModeSnapshot | undefined,
        approvedToolCallIds: Set<string> | undefined,
        progressEmitter: ToolProgressEmitter | undefined,
        attribution?: LockHolder,
        mailboxConversationId?: string,
        mailboxRunId?: string,
        nestingDepth?: number,
        checkpointReady?: Promise<CheckpointRecord | null> | null,
        deferWriteLock?: boolean,
        activeWorkspaceUri?: string,
        modelOverride?: string
    ): Promise<Record<string, unknown>> {
        // AI 正在执行工具：工具执行期间算用户在场（主人在等待/查看结果）
        beginAiWork();
        try {
            if (isMcpToolName(executionCall.name) && this.mcpManager) {
                return await this.executeMcpTool(executionCall, abortSignal);
            }
            return await this.executeBuiltinTool(
                executionCall,
                conversationId,
                config,
                abortSignal,
                promptModeSnapshot,
                approvedToolCallIds?.has(executionCall.id) === true,
                progressEmitter,
                attribution,
                mailboxConversationId,
                mailboxRunId,
                nestingDepth,
                checkpointReady,
                deferWriteLock,
                activeWorkspaceUri,
                modelOverride
            );
        } catch (error) {
            const err = error as Error;
            return {
                success: false,
                error: err.message || t('modules.api.chat.errors.toolExecutionFailed')
            };
        } finally {
            endAiWork();
        }
    }

    /**
     * 把工具响应落入 toolResults / responseParts / multimodalAttachments，
     * 并附加参数规范化警告。返回构造好的 ToolExecutionResult。
     */
    protected finalizeToolResponse(
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
        attribution?: LockHolder,
        mailboxConversationId?: string,
        mailboxRunId?: string,
        nestingDepth?: number,
        checkpointReady?: Promise<CheckpointRecord | null> | null,
        deferWriteLock?: boolean,
        activeWorkspaceUri?: string,
        modelOverride?: string
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
            if (deferWriteLock) {
                // PERF-CP：checkpoint 并发模式下入口不取路径锁（checkpoint 根锁与路径锁互斥），
                // 写盘锁由 diffManager 在写盘前获取（PendingDiff.lockHolder，同 holder 身份），
                // 写盘后立即释放；审阅期间本文件对并行写入者不可见，写盘瞬间才成为持有者。
            } else {
                const lockResult = fileWriteLockManager.tryAcquire(writePaths, lockHolder);
                if (!lockResult.acquired) {
                    // 修改原因（P4）：旧文案“Do NOT wait or retry this file immediately”易被 LLM 误解为放弃该文件，
                    // 且未告知冲突持有者身份之外的协作方式。
                    // 修改方式：明确持有者（子代理 run / 主会话 / 存档操作）、建议先做其他工作后重试、
                    //          持续冲突时在最终回复中上报主会话协调；lockConflict 标志保留供预设 prompt 识别。
                    const conflictText = lockResult.conflicts
                        .map(c => {
                            const holderName = c.holder.kind === 'subagent'
                                ? `agent "${c.holder.label}"`
                                : (c.holder.kind === 'checkpoint' ? 'a checkpoint operation' : c.holder.label);
                            return `'${c.path}' is currently being modified by ${holderName}`;
                        })
                        .join('; ');
                    return {
                        success: false,
                        error: `File write conflict: ${conflictText}. `
                            + `Do not loop on this file. Work on other parts of your task first, `
                            + `then retry after the current holder finishes (the lock is released automatically). `
                            + `If it is still locked on retry, mention it in your final response so the main session can coordinate.`,
                        lockConflict: true
                    };
                }
                lockedPaths = writePaths;
            }
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
            // PERF-CP：diff-review 工具在写盘前 await checkpointReady（写入前存档屏障）
            checkpointReady,
            // 注入对话上下文（供 todo_write 等工具使用）
            conversationId,
            conversationStore: this.conversationStore,
            // 当前对话绑定的工作区 URI（记忆隔离：memory_* 工具按工作区路由记忆存储）
            activeWorkspaceUri,
            // 修改原因：General Worker 虚拟子代理需要继承主会话当前渠道，而渠道 id 只在这一层可见。
            // 修改方式：把当前请求渠道配置 id 注入 toolContext，供 subagents handler 构造动态 worker 配置。
            // 修改目的：用户零配置即可让主模型派发与自己同渠道同权限的 worker。
            channelConfigId: config?.id,
            // 修改原因：General Worker 虚拟子代理需要继承主会话当前模型（modelOverride），
            // 只传渠道 id 会让它落到渠道默认模型上，与主模型不一致（默认模型配额/权限不同时报错）。
            // 修改方式：把当前请求的模型覆盖 id 注入 toolContext。
            // 修改目的：用户零配置派发的 worker 与主模型使用同一模型。
            channelModelId: modelOverride,
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

        // A-COMM：注入信箱身份（会话 + runId），供 agent_send_message 识别发送方与会话边界；
        // 子代理路径的 conversationId 参数为 undefined，信箱会话必须单独注入。
        if (mailboxConversationId) {
            toolContext.mailboxConversationId = mailboxConversationId;
        }
        if (mailboxRunId) {
            toolContext.mailboxRunId = mailboxRunId;
        }
        // PERF-CP：deferred 模式下把写盘锁持有者身份交给 diffManager（写盘前 acquire 用）
        if (deferWriteLock) {
            toolContext.lockHolder = lockHolder;
        }

        // F2：注入嵌套深度（子代理 run 上下文的一部分），供 subagents 工具在派生子子 agent 时
        // 计算 child depth = parent depth + 1 并做超限校验；主会话调用不传该值，深度按 0 处理。
        if (typeof nestingDepth === 'number') {
            toolContext.subagentDepth = nestingDepth;
        }

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
                this.log.warn('multimodal_function_call_unsupported', { channelType });
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
}
