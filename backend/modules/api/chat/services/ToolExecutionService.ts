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
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { BaseChannelConfig } from '../../../config/configs/base';
import { getAllWorkspaces, getMultimodalCapability, type ChannelType as UtilChannelType, type ToolMode as UtilToolMode } from '../../../../tools/utils';
import type { FunctionCallInfo, ToolExecutionResult } from '../utils';
import type { CheckpointService } from './CheckpointService';
import {
    getOutsideWorkspaceRejectionReason,
    toolCallNeedsOutsideWorkspaceConfirmation
} from '../../../../tools/file/outsideWorkspaceAccess';
import { fileWriteLockManager, getWritePathsForCall, type LockHolder } from '../../../../core/fileWriteLockManager';
import { agentMailbox } from '../../../../tools/subagents/agentMailbox';
import { Logger } from '../../../../core/logger';
import { getGlobalBranchService } from '../../../conversation/branch/BranchService';

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

    /**
     * MED-1：同一 (conversationId, runId) 下并发执行循环的 drain 权收敛。
     *
     * 主会话工具循环存在两个并发生成器：流式边执行早启动路径（executeFunctionCallsWithResults，
     * 流式期间启动）与流式结束后的主循环（executeFunctionCallsWithProgress），两者共享 mailbox
     * 身份 (conversationId, MAIN_SESSION_RUN_ID) 并各自调用 injectInboxMessages。drain 本身同步
     * 互斥，但消息挂在哪个结果上取决于调度顺序——abort 丢弃路径会让消息随被丢弃的结果一起丢失。
     *
     * 收敛规则：每个执行循环启动时领取自增 epoch（key = conversationId + runId）；
     * injectInboxMessages 只允许「最新启动」的循环 drain（它就是最终落盘的执行循环）。
     * 早启动路径在主循环启动后自动失去 drain 权（只执行不 drain），消息统一挂在主循环结果上；
     * 主循环不存在时（全部工具已早启动），早启动路径即最终落盘循环，仍正常 drain。
     */
    private readonly mailboxDrainEpochs = new Map<string, number>();
    private mailboxDrainEpochCounter = 0;
    private readonly log = Logger.get('ToolExec');

    private claimMailboxDrainEpoch(
        mailboxConversationId: string | undefined,
        mailboxRunId: string | undefined
    ): { key: string; epoch: number } | undefined {
        if (!mailboxConversationId || !mailboxRunId) {
            return undefined;
        }
        const key = `${mailboxConversationId}\u0000${mailboxRunId}`;
        const epoch = ++this.mailboxDrainEpochCounter;
        this.mailboxDrainEpochs.set(key, epoch);
        return { key, epoch };
    }

    private isMailboxDrainOwner(key: string, epoch: number): boolean {
        return this.mailboxDrainEpochs.get(key) === epoch;
    }

    private releaseMailboxDrainEpoch(key: string, epoch: number): void {
        if (this.mailboxDrainEpochs.get(key) === epoch) {
            this.mailboxDrainEpochs.delete(key);
        }
    }

    /**
     * E-2：清理指定会话的全部 mailbox drain epoch 条目（对话删除/复用时可调用）。
     *
     * 当前 mailboxDrainEpochs 本身是有界 Map（每 (conversationId, runId) 一条，
     * 下次 claim 覆盖旧条目），配合生成器 finally 兜底释放（见 executeFunctionCallsWithProgress）
     * 后，泄漏面已收敛到「被永久放弃的生成器」与「已删除会话」的少量数字条目。
     * deleteConversation 的 A-COMM 信箱清理（agentMailbox.clearConversation）已由 FIX-G1 接线，
     * 本方法不重复接线，供需要同步清理 epoch 条目的调用点与测试使用。
     */
    clearMailboxDrainEpochsForConversation(conversationId: string): void {
        const prefix = `${conversationId}\u0000`;
        for (const key of this.mailboxDrainEpochs.keys()) {
            if (key.startsWith(prefix)) {
                this.mailboxDrainEpochs.delete(key);
            }
        }
    }

    constructor(
        toolRegistry?: ToolRegistry,
        mcpManager?: McpManager,
        settingsManager?: SettingsManager,
        private checkpointService?: CheckpointService,
        /** BCP-01: 可选的 ConversationManager，用于按消息索引反查稳定节点 ID（未注入时由 CheckpointService 兜底反查） */
        private conversationManager?: ConversationManager
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
     * BCP-02：工具执行存档创建成功后，把存档 id fire-and-forget 绑定到分支节点。
     *
     * - 不阻塞工具循环（调用点以 void 丢弃返回值；失败仅 log.warn——绑定是派生态，
     *   存档记录与主历史才是真源，与 TREE-05 appendHistoryToGraph 同哲学）；
     * - 未注入 BranchService（getGlobalBranchService 未注册，如测试环境）或 nodeId 缺省
     *   （before 存档位置尚无消息等）时直接跳过；
     * - 锁序：createCheckpoint 持工作区存档锁，绑定走会话写锁——绝不在此处 await 绑定
     *   （会形成「存档锁 → 会话锁」的嵌套等待，R1 死锁风险）。
     */
    private bindWorkspaceCheckpointBestEffort(
        conversationId: string,
        nodeId: string | undefined,
        checkpointId: string
    ): void {
        const branchService = getGlobalBranchService();
        if (!branchService || !nodeId || !checkpointId) {
            return;
        }
        void branchService.bindWorkspaceCheckpoint(conversationId, nodeId, checkpointId).catch(error => {
            this.log.warn('bind_workspace_checkpoint_failed', {
                conversationId,
                nodeId,
                checkpointId,
                error: (error as Error)?.message ?? String(error),
            });
        });
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
        progressEmitter?: ToolProgressEmitter,
        mailboxConversationId?: string,
        mailboxRunId?: string,
        nestingDepth?: number
    ): Promise<ContentPart[]> {
        const { responseParts } = await this.executeFunctionCallsWithResults(
            calls,
            conversationId,
            messageIndex,
            config,
            abortSignal,
            promptModeSnapshot,
            progressEmitter,
            undefined,
            undefined,
            mailboxConversationId,
            mailboxRunId,
            nestingDepth
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
        attribution?: LockHolder,
        mailboxConversationId?: string,
        mailboxRunId?: string,
        nestingDepth?: number
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
            attribution,
            mailboxConversationId,
            mailboxRunId,
            nestingDepth
        );

        let next = await generator.next();
        while (!next.done) {
            next = await generator.next();
        }
        return next.value;
    }


    /**
     * 执行函数调用（带进度事件）— 公共入口。
     *
     * 用于：前端“实时排队推进”展示。
     *
     * - 在每个工具开始前 yield {type:'start'}
     * - 在每个工具结束后 yield {type:'end'}（包含该工具的 ToolExecutionResult）
     * - 最终通过 generator return 返回完整 ToolExecutionFullResult（供调用方持久化 / 后续流程使用）
     *
     * MED-1：领取 drain epoch（最新启动的执行循环持有 (conversationId, runId) 的 drain 权）；
     * E-2：try/finally 兜底释放 epoch——覆盖完成、abort 完成、异常抛出与被 return() 提前结束
     * 的路径（旧实现只在完成路径 release，生成器异常/提前放弃会留下 Map 条目）。
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
        attribution?: LockHolder,
        mailboxConversationId?: string,
        mailboxRunId?: string,
        nestingDepth?: number
    ): AsyncGenerator<ToolExecutionProgressEvent, ToolExecutionFullResult, void> {
        // MED-1：领取 drain epoch——最新启动的执行循环持有 (conversationId, runId) 的 drain 权
        const mailboxDrain = this.claimMailboxDrainEpoch(mailboxConversationId, mailboxRunId);
        try {
            return yield* this.executeFunctionCallsWithProgressCore(
                calls,
                conversationId,
                messageIndex,
                config,
                abortSignal,
                promptModeSnapshot,
                executionOptions,
                progressEmitter,
                attribution,
                mailboxConversationId,
                mailboxRunId,
                nestingDepth,
                mailboxDrain
            );
        } finally {
            // E-2：生成器异常/被提前 return() 时兜底释放（正常完成路径由核心 return 后同样
            // 走到这里；release 幂等——非最新持有者不误删他人条目）
            if (mailboxDrain) {
                this.releaseMailboxDrainEpoch(mailboxDrain.key, mailboxDrain.epoch);
            }
        }
    }

    /**
     * 执行函数调用（带进度事件）— 核心实现。
     *
     * 由公共入口 executeFunctionCallsWithProgress 委托驱动（claim/finally 释放集中在入口），
     * 本方法只负责执行与 yield 事件；mailboxDrain 由入口传入。
     */
    private async *executeFunctionCallsWithProgressCore(
        calls: FunctionCallInfo[],
        conversationId?: string,
        messageIndex?: number,
        config?: BaseChannelConfig,
        abortSignal?: AbortSignal,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        executionOptions?: Set<string> | ToolProgressEmitter,
        progressEmitter?: ToolProgressEmitter,
        attribution?: LockHolder,
        mailboxConversationId?: string,
        mailboxRunId?: string,
        nestingDepth?: number,
        mailboxDrain?: { key: string; epoch: number }
    ): AsyncGenerator<ToolExecutionProgressEvent, ToolExecutionFullResult, void> {
        const approvedToolCallIds = executionOptions instanceof Set ? executionOptions : undefined;
        const resolvedProgressEmitter = typeof executionOptions === 'function'
            ? executionOptions
            : progressEmitter;

        // MED-1/E-2：drain epoch 由公共入口领取并经参数传入，核心不再自行 claim（释放统一在入口 finally）

        const responseParts: ContentPart[] = [];
        const toolResults: ToolExecutionResult[] = [];
        const checkpoints: CheckpointRecord[] = [];
        const multimodalAttachments: ContentPart[] = [];

        // 获取工具调用模式
        const toolMode = config?.toolMode || 'function_call';
        const isPromptMode = toolMode === 'xml' || toolMode === 'json';

        // 检查点创建名（CPF-05）：
        // - 单个调用：用工具名（search_in_files 纯 search 模式只读，不创建存档）
        // - 批量调用：只有批内存在「当前已配置的写工具」时才用 tool_batch；
        //   否则纯只读批次（read_file + search_in_files(search)、list_files + find_files、
        //   get_symbols + find_references 等）不创建全工作区存档。
        //   判断基于真实工具名集合（toolNames.some(name => configuredTools.includes(name))），
        //   而不是笼统的「批次存在写工具」或「配置列表非空」。
        const checkpointConfig = this.settingsManager?.getCheckpointConfig();
        const configuredCheckpointTools = checkpointConfig
            ? new Set([...(checkpointConfig.beforeTools ?? []), ...(checkpointConfig.afterTools ?? [])])
            : undefined;
        const toolNameForCheckpoint: string | null = (() => {
            if (calls.length === 1) {
                const single = calls[0];
                if (single.name === 'search_in_files' && single.args?.mode !== 'replace') {
                    return null;
                }
                // 已有设置上下文时，未配置存档的单工具调用应直接跳过。旧实现仍会先反查
                // conversation message node，导致 find_files 等只读工具在会话首次创建窗口里
                // 意外触发 loadHistory 自动建会话，并与显式创建竞争。
                return configuredCheckpointTools && !configuredCheckpointTools.has(single.name)
                    ? null
                    : single.name;
            }
            if (!checkpointConfig || !configuredCheckpointTools) {
                return null;
            }
            const batchHasConfiguredTool = calls.some(call =>
                call.name === 'search_in_files'
                    ? (call.args?.mode === 'replace' && configuredCheckpointTools.has('search_in_files'))
                    : configuredCheckpointTools.has(call.name)
            );
            return batchHasConfiguredTool ? 'tool_batch' : null;
        })();

        // 在所有工具执行前创建一个检查点
        // BCP-01: 由消息索引反查节点 ID（注入 ConversationManager 时；否则 CheckpointService 兜底）
        // PERF：before/after 两个存档点使用同一 (conversationId, messageIndex)，合并为一次反查。
        // 每次 getMessageNodeIdAt 都会全量重读 transcript 文件，工具循环一轮最多 200 次迭代时
        // 该重复查询会放大为数百次全量文件读。
        // PERF-CP：批内全部调用都是 diff-review 工具时，before-checkpoint 与工具前置阶段
        // （读文件 + hunk 规划 + 预览渲染）并发启动；写盘前由 diffManager 强制 await
        // checkpointReady，保证「写入前存档已完成」。该模式下工具入口不持有目标路径锁
        // （checkpoint 根锁与路径锁互斥，入口取锁会死锁/冲突），写盘锁推迟到 diffManager
        // 写盘时获取。混合批（含 search_in_files replace 或其他写工具）保持同步语义，零变化。
        const isDiffReviewOnlyBatch = calls.length > 0 && calls.every(call => isDiffReviewToolCall(call.name));
        let beforeCheckpointPromise: Promise<CheckpointRecord | null> | null = null;
        let resolvedMessageNodeId: string | undefined;
        if (toolNameForCheckpoint && this.checkpointService && conversationId !== undefined && messageIndex !== undefined) {
            resolvedMessageNodeId = this.conversationManager
                ? await this.conversationManager.getMessageNodeIdAt(conversationId, messageIndex)
                : undefined;
            if (isDiffReviewOnlyBatch) {
                beforeCheckpointPromise = this.checkpointService.createToolExecutionCheckpoint(
                    conversationId,
                    messageIndex,
                    toolNameForCheckpoint,
                    'before',
                    resolvedMessageNodeId
                ).catch((error) => {
                    // 保留 reject 语义：写盘点 await 时收敛为失败，与「checkpoint 失败整批失败」对齐
                    this.log.warn('checkpoint.before_deferred_failed', {
                        conversationId,
                        error: (error as Error)?.message ?? String(error)
                    });
                    throw error;
                });
            } else {
                const beforeCheckpoint = await this.checkpointService.createToolExecutionCheckpoint(
                    conversationId,
                    messageIndex,
                    toolNameForCheckpoint,
                    'before',
                    resolvedMessageNodeId
                );
                if (beforeCheckpoint) {
                    checkpoints.push(beforeCheckpoint);
                    // BCP-02：fire-and-forget 绑定（不阻塞工具循环；失败仅 warn）
                    void this.bindWorkspaceCheckpointBestEffort(conversationId, resolvedMessageNodeId, beforeCheckpoint.id);
                }
            }
        }
        const deferWriteLock = isDiffReviewOnlyBatch && !!beforeCheckpointPromise;

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

                // A-COMM：每次工具调用完成后检查当前 run 的 inbox，把 agent 消息追加到该结果之后一起返回
                this.injectInboxMessages(mailboxConversationId, mailboxRunId, responseParts, toolResults, mailboxDrain?.key, mailboxDrain?.epoch);

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
                // A-COMM：拒绝结果同样携带 inbox 消息（若此时已有投递）
                this.injectInboxMessages(mailboxConversationId, mailboxRunId, responseParts, toolResults, mailboxDrain?.key, mailboxDrain?.epoch);

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
                        attribution,
                        mailboxConversationId,
                        mailboxRunId,
                        nestingDepth,
                        beforeCheckpointPromise,
                        deferWriteLock
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
                    // A-COMM：每次工具调用完成后检查当前 run 的 inbox，把 agent 消息追加到该结果之后一起返回
                    this.injectInboxMessages(mailboxConversationId, mailboxRunId, responseParts, toolResults, mailboxDrain?.key, mailboxDrain?.epoch);
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
                attribution,
                mailboxConversationId,
                mailboxRunId,
                nestingDepth,
                beforeCheckpointPromise,
                deferWriteLock
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

            // A-COMM：每次工具调用完成后检查当前 run 的 inbox，把 agent 消息追加到该结果之后一起返回
            this.injectInboxMessages(mailboxConversationId, mailboxRunId, responseParts, toolResults, mailboxDrain?.key, mailboxDrain?.epoch);

            yield { type: 'end', call: executionCall, toolResult };
            index++;
        }


        // PERF-CP：deferred 模式下统一收集 before-checkpoint 结果（工具已并行启动，
        // 写盘点由 diffManager await checkpointReady 保证「写入前存档已完成」）。
        // 返回顺序保持 before → after 与同步模式一致。
        if (beforeCheckpointPromise) {
            const beforeCheckpoint = await beforeCheckpointPromise;
            if (beforeCheckpoint) {
                checkpoints.push(beforeCheckpoint);
                // BCP-02：fire-and-forget 绑定（不阻塞工具循环；失败仅 warn）
                void this.bindWorkspaceCheckpointBestEffort(conversationId!, resolvedMessageNodeId, beforeCheckpoint.id);
            }
        }

        // 在所有工具执行后创建一个检查点
        if (toolNameForCheckpoint && this.checkpointService && conversationId !== undefined && messageIndex !== undefined) {
            // BCP-01: 复用 before 已反查的节点 ID（与 before 同消息，index 不变；
            // 工具执行只在其后追加 functionResponse，不影响该索引位置的节点），
            // 避免同一批次内第二次全量重读 transcript 文件。
            const afterCheckpoint = await this.checkpointService.createToolExecutionCheckpoint(
                conversationId,
                messageIndex,
                toolNameForCheckpoint,
                'after',
                resolvedMessageNodeId
            );
            if (afterCheckpoint) {
                checkpoints.push(afterCheckpoint);
                // BCP-02：fire-and-forget 绑定（不阻塞工具循环；失败仅 warn）
                void this.bindWorkspaceCheckpointBestEffort(conversationId, resolvedMessageNodeId, afterCheckpoint.id);
            }
        }

        // E-2：epoch 释放统一由公共入口的 finally 兜底（此处不再重复 release）

        return {
            responseParts,
            toolResults,
            checkpoints,
            multimodalAttachments: multimodalAttachments.length > 0 ? multimodalAttachments : undefined
        };
    }

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
        attribution?: LockHolder,
        mailboxConversationId?: string,
        mailboxRunId?: string,
        nestingDepth?: number,
        checkpointReady?: Promise<CheckpointRecord | null> | null,
        deferWriteLock?: boolean
    ): Promise<Record<string, unknown>> {
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
                deferWriteLock
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
     * A-COMM：每次工具调用完成后检查当前 run 的 inbox，把 agent 消息追加到
     * 最近一次工具结果之后、与工具结果一起返回给模型（drain 语义，每条只投递一次）。
     *
     * 注入位置说明：
     * - functionResponse.response 顶层与 data 子对象同时注入（覆盖 formatter 的 JSON/文本两条序列化路径）；
     * - toolResult.result 同步注入（前端工具卡片可见）；
     * - 先校验注入目标（最近一次工具结果必须是 functionResponse part）再 drain：
     *   无注入目标时不消费 inbox，消息保留到下一次工具调用（FIX-B 5.2）；
     * - 未传 mailbox 身份或 inbox 为空时零开销直接返回，不影响既有行为。
     */
    private injectInboxMessages(
        mailboxConversationId: string | undefined,
        mailboxRunId: string | undefined,
        responseParts: ContentPart[],
        toolResults: ToolExecutionResult[],
        mailboxDrainKey?: string,
        mailboxDrainEpoch?: number
    ): void {
        if (!mailboxConversationId || !mailboxRunId) {
            return;
        }

        // MED-1：并发执行循环共享 mailbox 身份时，只允许「最新启动」的循环 drain——
        // 早启动路径在主循环启动后只执行不 drain，消息统一挂在最终落盘的执行循环结果上
        if (mailboxDrainKey !== undefined && mailboxDrainEpoch !== undefined
            && !this.isMailboxDrainOwner(mailboxDrainKey, mailboxDrainEpoch)) {
            return;
        }

        // 先校验注入目标再 drain：最近一次工具结果必须是 functionResponse part，
        // 否则消息被消费后无处注入会丢失（FIX-B 5.2，防御性保护）
        const lastPart = responseParts[responseParts.length - 1];
        if (!lastPart?.functionResponse) {
            return;
        }
        const lastResult = toolResults[toolResults.length - 1];

        const messages = agentMailbox.drainMessages(mailboxConversationId, mailboxRunId);
        if (messages.length === 0) {
            return;
        }

        const inboxPayload = messages.map(m => ({
            fromRunId: m.fromRunId,
            ...(m.fromAgentName ? { fromAgentName: m.fromAgentName } : {}),
            text: m.text,
            threadId: m.threadId,
            hopDepth: m.hopDepth,
            createdAt: m.createdAt
        }));

        // 模型可见：追加到最近一次工具结果的 functionResponse.response。
        // 顶层与 data 子对象同时注入（覆盖 formatter 的 JSON/文本两条序列化路径，FIX-B 5.3 对齐注释与实现）
        const base = lastPart.functionResponse.response;
        const enrichedResponse: Record<string, unknown> = {
            ...(base && typeof base === 'object' ? (base as Record<string, unknown>) : {}),
            agentInbox: inboxPayload
        };
        if (enrichedResponse.data && typeof enrichedResponse.data === 'object') {
            enrichedResponse.data = {
                ...(enrichedResponse.data as Record<string, unknown>),
                agentInbox: inboxPayload
            };
        }
        lastPart.functionResponse.response = enrichedResponse;

        // 前端可见：同步注入 toolResult.result（含 data 子对象）
        if (lastResult?.result && typeof lastResult.result === 'object') {
            const result = lastResult.result as Record<string, unknown>;
            result.agentInbox = inboxPayload;
            const data = result.data;
            if (data && typeof data === 'object') {
                (data as Record<string, unknown>).agentInbox = inboxPayload;
            }
        }
    }

    /**
     * E-1：无主循环路径的显式 drain——把指定 (conversationId, runId) 的 inbox 消息
     * 注入给定结果（与 injectInboxMessages 相同的注入格式：functionResponse.response 顶层
     * 与 data 子对象 + toolResult.result）。
     *
     * 供 ToolIterationLoopService 在「流式边执行已完成、无主循环」（autoPrefix 为空）分支调用：
     * 此时早启动生成器不参与 drain（避免 abort 边角把已 drain 消息随被丢弃结果一起丢失，
     * 见 E-1），由本方法在最终落盘前显式消费一次。
     *
     * MED-1 收敛：调用方若持有 claim（mailboxDrainKey/mailboxDrainEpoch）则走与主循环一致的
     * 标准所有权检查；未传 claim 时（本路径无执行循环领取过 epoch）显式校验当前持有者——
     * 若已有并发的执行循环持有该 (conversationId, runId) 的 drain 权（如并发请求新启动的主循环），
     * 跳过本次消费，消息保留给新主循环，避免挂到将被丢弃的结果上；无持有者时本路径即最终落盘点，
     * 正常 drain。无注入目标（非 functionResponse part）时不消费 inbox。
     */
    drainInboxIntoResults(
        mailboxConversationId: string | undefined,
        mailboxRunId: string | undefined,
        responseParts: ContentPart[],
        toolResults: ToolExecutionResult[],
        mailboxDrainKey?: string,
        mailboxDrainEpoch?: number
    ): void {
        if (!mailboxConversationId || !mailboxRunId) {
            return;
        }

        if (mailboxDrainKey !== undefined && mailboxDrainEpoch !== undefined) {
            // 调用方持有 claim：走与主循环一致的所有权检查（injectInboxMessages 内校验）
            this.injectInboxMessages(
                mailboxConversationId,
                mailboxRunId,
                responseParts,
                toolResults,
                mailboxDrainKey,
                mailboxDrainEpoch
            );
            return;
        }

        // 调用方未持有 claim（无主循环路径）：MED-1 收敛——显式校验当前持有者。
        // 已有并发的执行循环持有该 (conversationId, runId) 的 drain 权时跳过本次消费，
        // 消息保留给新主循环（避免挂到将被丢弃的结果上）；无持有者时才正常 drain。
        // 本方法整体同步执行，check 与 drain 之间无 await，事件循环内原子。
        const key = `${mailboxConversationId}\u0000${mailboxRunId}`;
        if (this.mailboxDrainEpochs.has(key)) {
            return;
        }
        this.injectInboxMessages(mailboxConversationId, mailboxRunId, responseParts, toolResults);
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
        deferWriteLock?: boolean
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
     * - Plan 模式 write_file 仅允许写入 .graycode/plans/**.md（多工作区支持 workspaceName/.graycode/plans/**.md）
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

        // 3) Plan 模式 write_file 受控例外：只允许写入 .graycode/plans/**.md
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
                error: `In plan mode, write_file is only allowed to write ".graycode/plans/**.md". Rejected path: ${rawPath}`
            };
        }
        return { ok: true };
    }

    private isPlanModeWriteFilePathAllowed(path: string): boolean {
        // 先尝试单工作区格式：.graycode/plans/...
        if (isPlanPathAllowed(path)) {
            return true;
        }

        // 多工作区：允许 workspaceName/.graycode/plans/...
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
