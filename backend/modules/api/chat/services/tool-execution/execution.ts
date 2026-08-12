/**
 * GrayCode - 工具执行服务：执行编排核心（executeFunctionCalls 系列 + 主循环控制）
 *
 * ToolExecutionService.ts 职责拆分（第二批）的 ExecutionCore 基类。
 * 继承链：ToolExecutionService → ExecutionCore → ResultCore → PreflightCore → MailboxCore。
 *
 * 本文件承载：
 * - 公共入口（executeFunctionCalls / executeFunctionCallsWithResults / executeFunctionCallsWithProgress）
 * - 主循环核心（executeFunctionCallsWithProgressCore：并行分组 / abort 竞速 / 检查点 / 多模态汇聚）
 * - 类型（ToolExecutionProgressEvent / ToolExecutionFullResult）与并行组收尾窗口常量/工具函数
 *
 * checkpointMode 参数（流式早启动批次检查点合并）：
 * - 'auto'（默认）：本批次自行创建 before/after 检查点（工具执行核心既有语义）。
 * - 'skip'：跳过本批次内部检查点创建，由调用方（ToolIterationLoopService 流式路径）按
 *   「一次模型回复 = 一个工具批次」统一创建一组 before/after——早启动路径对每个工具单独
 *   调用本方法，若各自建检查点会产生 N 组物理存档；合并后仅一组（tool_batch）。
 *   非流式主循环 / subagent 等调用点不传该参数，保持既有行为零变化。
 *
 * 逻辑与拆分前逐字一致；仅可见性从 private 调整为 protected（跨继承类调用所需，
 * 编译期属性，零运行时影响），以及 UNBOUND_WARNED_MAX 的引用限定符改为本类名
 * （避免壳文件循环依赖，值不变）。
 */
import { t } from '../../../../../i18n';
import type { CheckpointRecord } from '../../../../checkpoint';
import type { ResolvedPromptModeSnapshot } from '../../../../settings/types';
import type { ContentPart } from '../../../../conversation/types';
import type { ConversationManager } from '../../../../conversation/ConversationManager';
import type { BaseChannelConfig } from '../../../../config/configs/base';
import type { FunctionCallInfo, ToolExecutionResult } from '../../utils';
import type { CheckpointService } from '../CheckpointService';
import type { ToolProgressEmitter } from '../../../../../tools/types';
import type { LockHolder } from '../../../../../core/fileWriteLockManager';
import { isDiffReviewToolCall } from '../diffReviewTools';
import { MAIN_LOOP_ABORT_DRAIN_GRACE_MS, drainToolExecutionGeneratorAfterAbort } from '../abortDrain';
import { cloneToolResponse, ResultCore } from './result';

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
 * 并行工具组 abort 后的收尾窗口（毫秒）。
 *
 * 与 ToolIterationLoopService 的 MAIN_LOOP_ABORT_DRAIN_GRACE_MS 语义一致：
 * abort 先于 Promise.all 落定时，响应 abort 的工具会快速返回已完成部分的真实结果
 * （真实副作用结果不能丢）；窗口结束仍未返回（不响应 abort 且永不结束）的按取消
 * 结算，保证停止按钮不被拖死。
 */
const PARALLEL_GROUP_ABORT_DRAIN_GRACE_MS = 2000;

/**
 * promise 与超时竞速：超时先到返回 undefined。
 *
 * 与 ToolIterationLoopService.drainToolExecutionGeneratorAfterAbort 内部的
 * raceWithTimeout 同构（并行组收尾窗口使用）；竞速双方任意一方先落定都清理 timer，
 * 避免残留 open handle。
 */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
    });
    promise.then(
        () => { if (timer) clearTimeout(timer); },
        () => { if (timer) clearTimeout(timer); }
    );
    return Promise.race([promise, timeoutPromise]);
}

/**
 * 执行编排核心基类（executeFunctionCalls 系列 + 主循环控制）
 */
export class ExecutionCore extends ResultCore {
    protected checkpointService?: CheckpointService;
    /** BCP-01: 可选的 ConversationManager，用于按消息索引反查稳定节点 ID（未注入时由 CheckpointService 兜底反查） */
    protected conversationManager?: ConversationManager;
    /** H4 兜底可观测性：已提示过「会话未绑定工作区」的会话集合（每会话仅告警一次，避免刷屏） */
    /** C-10：带时间戳的 Map 实现，超过上限时淘汰最旧条目，避免无界增长 */
    protected readonly unboundWorkspaceWarned = new Map<string, number>();
    protected static readonly UNBOUND_WARNED_MAX = 500;

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
        nestingDepth?: number,
        modelOverride?: string
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
            nestingDepth,
            undefined,
            modelOverride
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
     * @param checkpointMode 'skip' 时本批次不创建检查点（由调用方统一创建，见文件头说明）
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
        nestingDepth?: number,
        activeWorkspaceUri?: string,
        modelOverride?: string,
        checkpointMode?: 'auto' | 'skip'
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
            nestingDepth,
            activeWorkspaceUri,
            modelOverride,
            checkpointMode
        );

        // abort-race（复用 ToolIterationLoopService 主循环 1433-1503 的模式）：
        // 生成器核心对串行工具调用是裸 await（不响应 abort 且永不结束的工具会让
        // gen.next() 永久挂起，裸泵循环会让整个请求——含停止按钮——卡死）。
        // abort 先到时先给生成器一个收尾窗口：响应 abort 的工具会快速返回已完成部分的
        // 真实结果（不能丢），窗口结束仍未返回则放弃，走下方取消路径。
        let executionResult: ToolExecutionFullResult | undefined;
        while (true) {
            let onAbort: (() => void) | undefined;
            // C-12：创建 abortPromise 前先检查信号已 aborted——
            // 若已中止，立即 resolve 走取消路径，避免注册 listener 后信号永不触发导致挂起。
            const abortPromise = abortSignal?.aborted
                ? Promise.resolve()
                : abortSignal
                    ? new Promise<void>((resolve) => {
                        onAbort = () => resolve();
                        abortSignal.addEventListener('abort', onAbort, { once: true });
                    })
                    : undefined;
            try {
                const nextPromise = generator.next();
                const winner = abortPromise
                    ? await Promise.race([nextPromise, abortPromise])
                    : await nextPromise;
                if (winner === undefined) {
                    // abort 先到：收尾窗口内等生成器返回已完成部分的真实结果；
                    // 窗口结束仍未返回（工具不响应 abort 且永不结束）返回 undefined
                    executionResult = await drainToolExecutionGeneratorAfterAbort(
                        generator,
                        nextPromise,
                        MAIN_LOOP_ABORT_DRAIN_GRACE_MS
                    );
                    break;
                }
                if (winner.done) {
                    executionResult = winner.value as ToolExecutionFullResult;
                    break;
                }
                // 进度事件：本方法只消费最终结果，事件直接丢弃（与旧行为一致）
            } catch (error) {
                // 生成器抛错（工具执行异常/内部错误）：已无法取回真实结果，把失败转换为
                // 每个调用的错误响应（对齐流式早启动路径 .catch 的错误转换模式），保证
                // assistant 的每个 tool_use 都有配对的 tool_result：
                // - 非流式主循环：错误函数响应照常落盘，下一轮 generate 不会因孤儿
                //   tool_calls 触发 Anthropic 400，模型按普通工具错误继续处理；
                // - 流式早启动：错误结果写入 streamingToolResults，tool_use 配对完整，
                //   不再静默丢失 responsePart/toolResult。
                // 注意与 abort 收尾窗口超时的空结果路径区分：那是取消语义（下方兜底保留），
                // 此处是失败语义，必须给调用方可落盘的错误结果。不让异常穿透为 error chunk。
                this.log.warn('tool_gen_next_rejected', {
                    conversationId,
                    messageIndex,
                    error: (error as Error)?.message ?? String(error),
                });
                const errorResponse: Record<string, unknown> = {
                    success: false,
                    error: (error as Error)?.message ?? String(error),
                };
                executionResult = {
                    responseParts: calls.map(call => ({
                        functionResponse: {
                            id: call.id,
                            name: call.name,
                            response: errorResponse
                        }
                    })),
                    toolResults: calls.map(call => ({
                        id: call.id,
                        name: call.name,
                        args: call.args,
                        result: errorResponse
                    })),
                    checkpoints: []
                };
                break;
            } finally {
                if (onAbort && abortSignal) {
                    abortSignal.removeEventListener('abort', onAbort);
                }
            }
        }

        // 收尾窗口超时（工具不响应 abort 且永不结束）时 drain 返回 undefined：
        // 以空结果结算（真实副作用已无法取回，调用方按既有取消路径处理）
        return executionResult ?? {
            responseParts: [],
            toolResults: [],
            checkpoints: []
        };
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
        nestingDepth?: number,
        activeWorkspaceUri?: string,
        modelOverride?: string,
        checkpointMode?: 'auto' | 'skip'
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
                mailboxDrain,
                activeWorkspaceUri,
                modelOverride,
                checkpointMode
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
        mailboxDrain?: { key: string; epoch: number },
        activeWorkspaceUri?: string,
        modelOverride?: string,
        checkpointMode?: 'auto' | 'skip'
    ): AsyncGenerator<ToolExecutionProgressEvent, ToolExecutionFullResult, void> {
        const approvedToolCallIds = executionOptions instanceof Set ? executionOptions : undefined;
        const resolvedProgressEmitter = typeof executionOptions === 'function'
            ? executionOptions
            : progressEmitter;

        // MED-1/E-2：drain epoch 由公共入口领取并经参数传入，核心不再自行 claim（释放统一在入口 finally）

        // 记忆隔离等多工作区支持：优先用调用方传入的工作区；未传入且会话绑定了工作区时
        // 按会话元数据解析（getMetadata 防御性探测：测试替身可能未实现，缺失时视为未绑定工作区）
        let resolvedWorkspaceUri: string | undefined = activeWorkspaceUri;
        if (!resolvedWorkspaceUri && conversationId && this.conversationManager && typeof this.conversationManager.getMetadata === 'function') {
            resolvedWorkspaceUri = await this.conversationManager.getMetadata(conversationId)
                .then(meta => meta?.workspaceUri || undefined)
                .catch(() => undefined);
        }
        // H4 兜底可观测性：会话未绑定工作区时记忆工具会回退全局作用域（跨工作区污染风险）。
        // webview 正常路径会在创建/读取时绑定工作区；此处覆盖纯后端/API 等漏网路径，
        // 把「静默降级」变为可观测——每会话仅告警一次。
        if (conversationId && !resolvedWorkspaceUri && !this.unboundWorkspaceWarned.has(conversationId)) {
            // C-10：有界记录——超过上限时淘汰最旧的一条，Set 永不清除的问题一并解决
            if (this.unboundWorkspaceWarned.size >= ExecutionCore.UNBOUND_WARNED_MAX) {
                let oldestKey: string | undefined;
                let oldestAt = Infinity;
                for (const [key, at] of this.unboundWorkspaceWarned) {
                    if (at < oldestAt) {
                        oldestAt = at;
                        oldestKey = key;
                    }
                }
                if (oldestKey !== undefined) {
                    this.unboundWorkspaceWarned.delete(oldestKey);
                }
            }
            this.unboundWorkspaceWarned.set(conversationId, Date.now());
            this.log.warn('conversation_unbound_workspace', {
                conversationId,
                hint: '会话未绑定工作区，记忆工具将使用全局作用域；如预期应为工作区记忆，请检查会话创建/读取路径是否传入 workspaceUri',
            });
        }

        const responseParts: ContentPart[] = [];
        const toolResults: ToolExecutionResult[] = [];
        const checkpoints: CheckpointRecord[] = [];
        const multimodalAttachments: ContentPart[] = [];

        // 获取工具调用模式
        const toolMode = config?.toolMode || 'function_call';
        const isPromptMode = toolMode === 'xml' || toolMode === 'json';

        // CPF-07：checkpointMode='skip' 时本批次不创建检查点——流式早启动路径对每个工具单独
        // 调用本方法，若各自建检查点会产生 N 组 before/after 物理存档；由 ToolIterationLoopService
        // 按「一次模型回复 = 一个工具批次」统一创建一组（tool_batch）。短路在判定之前，
        // 避免不必要的配置读取与节点反查。
        const skipCheckpointCreation = checkpointMode === 'skip';
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
        const toolNameForCheckpoint: string | null = skipCheckpointCreation ? null : (() => {
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
        // CPF-07：批量路径（tool_batch）透传批内工具名，供 CheckpointManager 按 beforeTools/afterTools
        // 交集精确判定是否创建；单工具路径不需要（CheckpointManager 按工具名精确判定）。
        const checkpointBatchToolNames = toolNameForCheckpoint === 'tool_batch'
            ? calls.map(call => call.name)
            : undefined;
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
                    resolvedMessageNodeId,
                    checkpointBatchToolNames
                        ? { batchToolNames: checkpointBatchToolNames }
                        : undefined
                ).catch((error) => {
                    // deferred 模式下 checkpoint 失败不升级为整批失败：工具已并行执行完成、
                    // 真实副作用结果已收集在 responses/toolResults，泵循环 catch 会把全部调用
                    // 替换为 errorResponse 导致真实结果丢失。降级为警告：diffManager 写盘前
                    // await checkpointReady 得到 null，放弃"写入前存档已完成"保证，结果照常结算。
                    this.log.warn('checkpoint.before_deferred_failed', {
                        conversationId,
                        error: (error as Error)?.message ?? String(error)
                    });
                    return null;
                });
            } else {
                const beforeCheckpoint = await this.checkpointService.createToolExecutionCheckpoint(
                    conversationId,
                    messageIndex,
                    toolNameForCheckpoint,
                    'before',
                    resolvedMessageNodeId,
                    checkpointBatchToolNames
                        ? { batchToolNames: checkpointBatchToolNames }
                        : undefined
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

                // abort 竞速 + 收尾窗口（复用 ToolIterationLoopService 主循环的
                // abort-race 模式）：组内工具若不响应 abortSignal 且永不结束，
                // 裸 Promise.all 会让整个请求（含停止按钮）永久挂起。abort 先到时
                // 给已启动调用一个收尾窗口，窗口内落定的用真实结果结算（真实副作用
                // 结果不能丢），窗口结束仍未落定的按取消结算；窗口有界，停止按钮不被拖死。
                let onAbort: (() => void) | undefined;
                // C-12：创建 abortPromise 前先检查信号已 aborted（已中止时立即 resolve 走取消路径）
                const abortPromise: Promise<undefined> | undefined = abortSignal?.aborted
                    ? Promise.resolve(undefined)
                    : abortSignal
                        ? new Promise<undefined>((resolve) => {
                            onAbort = () => resolve(undefined);
                            abortSignal.addEventListener('abort', onAbort, { once: true });
                        })
                        : undefined;

                const callPromises = group.map(item =>
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
                        deferWriteLock,
                        resolvedWorkspaceUri,
                        modelOverride
                    )
                );

                let responses: Array<Record<string, unknown> | undefined>;
                try {
                    const winner = abortPromise
                        ? await Promise.race([Promise.all(callPromises), abortPromise])
                        : await Promise.all(callPromises);
                    if (winner === undefined) {
                        // abort 先到：收尾窗口内等已启动调用返回真实结果
                        // （响应 abort 的工具会快速返回），窗口结束仍未返回
                        // （不响应 abort 且永不结束）按取消处理。
                        const drainDeadline = Date.now() + PARALLEL_GROUP_ABORT_DRAIN_GRACE_MS;
                        responses = await Promise.all(callPromises.map(p =>
                            raceWithTimeout(p, drainDeadline - Date.now())
                        ));
                    } else {
                        responses = winner;
                    }
                } finally {
                    if (onAbort && abortSignal) {
                        abortSignal.removeEventListener('abort', onAbort);
                    }
                }

                for (let k = 0; k < group.length; k++) {
                    // 收尾窗口超时仍未落定（工具不响应 abort 且永不结束）：
                    // 按取消结算，取消占位写入历史/前端，避免下一轮
                    // rejectAllPendingToolCalls 误标"用户拒绝"（占位结构与
                    // ToolIterationLoopService.settleCancelledToolCalls 一致）。
                    const response = responses[k] ?? {
                        success: false,
                        error: t('modules.api.chat.errors.toolCallCancelled'),
                        cancelled: true
                    };
                    const toolResult = this.finalizeToolResponse(
                        group[k].executionCall,
                        response,
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
                deferWriteLock,
                resolvedWorkspaceUri,
                modelOverride
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
        if (beforeCheckpointPromise && conversationId !== undefined) {
            const beforeCheckpoint = await beforeCheckpointPromise;
            if (beforeCheckpoint) {
                checkpoints.push(beforeCheckpoint);
                // BCP-02：fire-and-forget 绑定（不阻塞工具循环；失败仅 warn）
                void this.bindWorkspaceCheckpointBestEffort(conversationId, resolvedMessageNodeId, beforeCheckpoint.id);
            }
        }

        // 在所有工具执行后创建一个检查点
        if (toolNameForCheckpoint && this.checkpointService && conversationId !== undefined && messageIndex !== undefined) {
            // BCP-01: 复用 before 已反查的节点 ID（与 before 同消息，index 不变；
            // 工具执行只在其后追加 functionResponse，不影响该索引位置的节点），
            // 避免同一批次内第二次全量重读 transcript 文件。
            try {
                const afterCheckpoint = await this.checkpointService.createToolExecutionCheckpoint(
                    conversationId,
                    messageIndex,
                    toolNameForCheckpoint,
                    'after',
                    resolvedMessageNodeId,
                    checkpointBatchToolNames
                        ? { batchToolNames: checkpointBatchToolNames }
                        : undefined
                );
                if (afterCheckpoint) {
                    checkpoints.push(afterCheckpoint);
                    // BCP-02：fire-and-forget 绑定（不阻塞工具循环；失败仅 warn）
                    void this.bindWorkspaceCheckpointBestEffort(conversationId, resolvedMessageNodeId, afterCheckpoint.id);
                }
            } catch (error) {
                if (isDiffReviewOnlyBatch) {
                    // deferred 模式与 before-checkpoint 同构：after 存档失败仅 warn 降级——
                    // 工具已并行执行完成、真实结果已收集在 responses/toolResults，若让异常
                    // 冒泡到泵循环 catch 会把全部调用替换为 errorResponse，已发生副作用的
                    // 真实结果全部丢失。同步模式保持抛错语义（与 before 同步路径一致）。
                    this.log.warn('checkpoint.after_deferred_failed', {
                        conversationId,
                        error: (error as Error)?.message ?? String(error)
                    });
                } else {
                    throw error;
                }
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
}

