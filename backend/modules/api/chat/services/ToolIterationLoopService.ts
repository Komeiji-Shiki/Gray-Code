/**
 * GrayCode - 工具迭代循环服务
 *
 * 封装工具调用循环的核心逻辑，统一处理：
 * - handleChatStream
 * - handleToolConfirmation
 * - handleRetryStream
 * - handleEditAndRetryStream
 * 中的工具调用循环部分
 */

import type { ChannelManager } from '../../../channel/ChannelManager';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { CheckpointRecord } from '../../../checkpoint';
import type { Content, ContentPart } from '../../../conversation/types';
import type { BaseChannelConfig } from '../../../config/configs/base';
import type { GenerateResponse, RequestPromptContext } from '../../../channel/types';
import { ChannelError, ErrorType } from '../../../channel/types';
import { PromptManager } from '../../../prompt';
import { t } from '../../../../i18n';
import { Logger } from '../../../../core/logger';
import type { CheckpointService } from './CheckpointService';
import type { DynamicContextStrategy, ResolvedPromptModeSnapshot } from '../../../settings/types';
import type {
    ChatStreamChunkData,
    ChatStreamCompleteData,
    ChatStreamErrorData,
    ChatStreamToolIterationData,
    ChatStreamCheckpointsData,
    ChatStreamAutoSummaryData,
    ChatStreamAutoSummaryStatusData,
    ChatStreamToolConfirmationData,
    ChatStreamToolsExecutingData,
    ChatStreamToolStatusData,
    PendingToolCall
} from '../types';

import { StreamResponseProcessor, isAsyncGenerator, type ProcessedChunkData } from '../handlers/StreamResponseProcessor';
import type { FunctionCallInfo, ToolExecutionResult } from '../utils';
import type { ToolCallParserService } from './ToolCallParserService';
import type { MessageBuilderService } from './MessageBuilderService';
import type { TokenEstimationService } from './TokenEstimationService';
import type { ContextTrimService } from './ContextTrimService';
import type { ToolExecutionService, ToolExecutionFullResult, ToolExecutionProgressEvent } from './index';
import { MAIN_LOOP_ABORT_DRAIN_GRACE_MS, drainToolExecutionGeneratorAfterAbort } from './abortDrain';
import type { SummarizeService } from './SummarizeService';
import { resolveAndPersistPostToolStopState } from './postToolStopState';
import { createChatToolStatusUpdate, EarlyStreamingToolProgressQueue } from './streamingToolProgress';
import { RepeatedCallGuard } from './repeatedCallGuard';
import { isDiffReviewToolCall } from './diffReviewTools';
import { deserializePromptContextCache, serializePromptContextCache } from '../../../prompt/promptContextCache';
import type { DynamicContextDiffBase, DynamicRuntimeContext } from '../../../prompt/PromptManager';
import { MAIN_SESSION_RUN_ID } from '../../../../core/services/agentMailbox';
import { DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN } from '../../../settings/types/summarizeTypes';

const CONVERSATION_PINNED_FILES_KEY = 'inputPinnedFiles';
const CONVERSATION_SKILLS_KEY = 'inputSkills';

/**
 * 流式取消时给在途早启动工具的收尾窗口（毫秒）。
 *
 * 流式边执行工具已产生真实副作用（写文件、跑命令），取消时若只结算"取消时刻已 settle"
 * 的工具，刚完成/仍在执行的工具结果会永久丢失（历史只剩 cancelled 占位，下一轮
 * rejectAllPendingToolCalls 会误标"用户拒绝"）。窗口内落定的工具用真实结果结算，
 * 超时未落定的标记为取消；窗口有界，保证停止按钮不被不响应 abort 的工具拖死。
 */
export const STREAM_CANCEL_TOOL_SETTLE_GRACE_MS = 3000;

function shouldStartToolDuringModelStream(
    call: FunctionCallInfo,
    toolExecutionService: ToolExecutionService,
    promptModeSnapshot?: ResolvedPromptModeSnapshot
): boolean {
    return !toolExecutionService.toolNeedsConfirmation(call.name, call.args, promptModeSnapshot)
        && !isDiffReviewToolCall(call.name, call.args);
}

/**
 * 工具迭代循环配置
 */
export interface ToolIterationLoopConfig {
    /** 对话 ID */
    conversationId: string;
    /** 配置 ID */
    configId: string;
    /** 渠道配置 */
    config: BaseChannelConfig;
    /** 模型覆盖（可选，仅对本轮循环生效） */
    modelOverride?: string;
    /** 取消信号 */
    abortSignal?: AbortSignal;
    /**
     * 总结请求专用取消信号（仅取消总结 API，不中断主对话请求）
     */
    summarizeAbortSignal?: AbortSignal;
    /** 是否是首条消息（影响系统提示词刷新策略） */
    isFirstMessage?: boolean;
    /** 最大迭代次数（-1 表示无限制） */
    maxIterations: number;
    /** 起始迭代次数（默认 0） */
    startIteration?: number;
    /** 是否创建模型消息前的检查点 */
    createBeforeModelCheckpoint?: boolean;
    /**
     * 是否是新回合的开始（默认 true）。
     * 新回合开始时会生成新的动态上下文并缓存到元数据；
     * 回合继续时（如工具确认后）从元数据读取缓存的动态上下文，保证回合内一致性。
     */
    isNewTurn?: boolean;

    promptModeSnapshot?: ResolvedPromptModeSnapshot;

    /**
     * 本轮动态上下文策略。
     */
    dynamicContextStrategy?: DynamicContextStrategy;
}

/**
 * 工具迭代循环输出类型（流式）
 */
export type ToolIterationLoopOutput =
    | ChatStreamChunkData
    | ChatStreamCompleteData
    | ChatStreamErrorData
    | ChatStreamToolIterationData
    | ChatStreamCheckpointsData
    | ChatStreamAutoSummaryData
    | ChatStreamAutoSummaryStatusData
    | ChatStreamToolConfirmationData
    | ChatStreamToolsExecutingData
    | ChatStreamToolStatusData
    // C-19：取消输出（与 ChatFlowService.ChatStreamCancelledData 同构；
    // 带 content 时回传 addContent 返回的稳定节点 ID，而不是累加器的无 ID 副本）
    | { conversationId: string; cancelled: true; content?: Content };

/**
 * 非流式工具循环结果
 */
export interface NonStreamToolLoopResult {
    /** 最终的 AI 回复内容（如果未超过最大迭代次数） */
    content?: Content;
    /** 是否超过最大工具迭代次数 */
    exceededMaxIterations: boolean;
    /** 是否因主请求取消（abortSignal.aborted）提前终止（与流式路径的 cancelled 输出对齐） */
    cancelled?: boolean;
}

/**
 * 工具迭代循环服务
 *
 * 封装工具调用循环的核心逻辑，减少 ChatHandler 中的重复代码
 */
export class ToolIterationLoopService {
    private promptManager: PromptManager;
    private summarizeService?: SummarizeService;
    private readonly log = Logger.get('ToolLoop');

    /**
     * 各会话「当前真实用户回合」已确定的 fallback 细粒度裁剪起点（绝对索引）。
     *
     * 自动总结失败后 fallback 不写 trimState，但同一回合内的多次工具迭代（含工具确认后的续跑
     * runToolLoop）必须复用同一起点：工具结果增长时若每轮重新规划切点，retainedHistory 开头会
     * 持续后移，provider 前缀缓存无法命中；新回合（isNewTurn）与总结成功后重新评估时清除。
     */
    private readonly granularFallbackStartByConversation = new Map<string, number>();

    /**
     * 回合内动态运行时上下文缓存（todoList / pinnedFiles / skills / workspaceUri）。
     *
     * 现状：同一回合内 runToolLoop 可能被多次调用（新回合生成 → 工具确认 / 隐藏
     * functionResponse 续跑），每次调用都重新 getCustomMetadata 读取元数据并 structuredClone
     * 整份 meta。这里按「会话 + 回合起始消息 id」缓存一次加载结果：同一回合续跑直接复用；
     * 新回合（起始消息 id 变化）自动重新加载；自动总结删除锚点消息导致 id 变化时同样重新加载。
     * 与 granularFallbackStartByConversation 同模式保持有界（M5）。
     */
    private readonly runtimeContextByTurn = new Map<string, { context: DynamicRuntimeContext; turnStartId: string | null }>();

    /**
     * 会话级 Map 最大条目数（M5）。
     *
     * 会话删除路径（webview 层 deleteConversation → ConversationManager.deleteConversation）
     * 不经过本服务，无法在该路径挂清理 hook；这里在 set 处保持有界，超出后淘汰最旧条目
     * （仅影响被淘汰会话的“回合内起点复用 / 尝试计数”，下一回合自然重新规划/清零，无副作用）。
     */
    private static readonly MAX_CONVERSATION_SCOPED_MAP_ENTRIES = 512;

    /** M5：会话级 Map 写入时保持有界（淘汰最旧条目，防止删除会话后条目残留导致无界增长） */
    private evictOldestIfOversized<K>(map: Map<K, unknown>): void {
        while (map.size > ToolIterationLoopService.MAX_CONVERSATION_SCOPED_MAP_ENTRIES) {
            const oldestKey = map.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            map.delete(oldestKey);
        }
    }

    constructor(
        private channelManager: ChannelManager,
        private conversationManager: ConversationManager,
        private toolCallParserService: ToolCallParserService,
        private messageBuilderService: MessageBuilderService,
        private tokenEstimationService: TokenEstimationService,
        private contextTrimService: ContextTrimService,
        private toolExecutionService: ToolExecutionService,
        private checkpointService: CheckpointService
    ) {
        this.promptManager = new PromptManager();
    }

    /**
     * 设置提示词管理器（允许外部注入已初始化的实例）
     */
    setPromptManager(promptManager: PromptManager): void {
        this.promptManager = promptManager;
    }

    /**
     * 设置总结服务（允许外部注入，避免循环依赖）
     */
    setSummarizeService(summarizeService: SummarizeService): void {
        this.summarizeService = summarizeService;
    }

    private async loadDynamicRuntimeContext(conversationId: string): Promise<{
        todoList?: unknown;
        pinnedFiles?: unknown;
        skills?: unknown;
        workspaceUri?: string;
    }> {
        const [todoList, pinnedFiles, skills, meta] = await Promise.all([
            this.conversationManager.getCustomMetadata(conversationId, 'todoList').catch(() => undefined),
            this.conversationManager.getCustomMetadata(conversationId, CONVERSATION_PINNED_FILES_KEY).catch(() => undefined),
            this.conversationManager.getCustomMetadata(conversationId, CONVERSATION_SKILLS_KEY).catch(() => undefined),
            // 会话绑定的工作区 URI（记忆隔离：工具执行按工作区路由记忆存储）。
            // 测试替身可能未实现 getMetadata：防御性探测，缺失时视为未绑定工作区
            (typeof this.conversationManager.getMetadata === 'function'
                ? this.conversationManager.getMetadata(conversationId).catch(() => null)
                : Promise.resolve(null))
        ]);

        return {
            todoList,
            pinnedFiles,
            skills,
            workspaceUri: meta?.workspaceUri
        };
    }

    /**
     * 回合内动态运行时上下文复用：同一回合（同一起始用户消息 id）内只加载一次。
     * turnStartId 为 null（无起始用户消息可锚定）时不缓存，保持原有每次加载语义。
     */
    private async getOrLoadRuntimeContext(
        conversationId: string,
        turnStartId: string | null
    ): Promise<DynamicRuntimeContext> {
        if (turnStartId !== null) {
            const cached = this.runtimeContextByTurn.get(conversationId);
            if (cached && cached.turnStartId === turnStartId) {
                return cached.context;
            }
        }
        const context = await this.loadDynamicRuntimeContext(conversationId);
        if (turnStartId !== null) {
            this.runtimeContextByTurn.set(conversationId, { context, turnStartId });
            this.evictOldestIfOversized(this.runtimeContextByTurn);
        }
        return context;
    }

    /**
     * 在真实用户消息落盘前生成本回合的动态上下文快照。
     *
     * 快照必须随新消息一次性写入；消息进入历史后只允许读取，禁止再用 updateMessage 改写，
     * 否则后台回执或新请求会把已经参与 provider 前缀缓存的旧回合内容覆盖掉。
     */
    async createTurnDynamicContext(
        conversationId: string,
        turnStartId: string,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        dynamicContextStrategy?: DynamicContextStrategy
    ): Promise<string> {
        const runtimeContext = await this.getOrLoadRuntimeContext(conversationId, turnStartId);
        // 仅 preserve 策略启用跨回合差分：历史快照回插保证省略的 section 对模型仍可见。
        const diffBase = dynamicContextStrategy === 'preserve'
            ? await this.loadPreviousTurnDiffBase(conversationId, turnStartId)
            : undefined;
        const promptContextBundle = this.promptManager.getPromptContextBundle(
            promptModeSnapshot,
            runtimeContext,
            diffBase ? { diffBase } : undefined
        );
        return serializePromptContextCache(promptContextBundle);
    }

    /**
     * 从历史中定位最近一个带 turnDynamicContext 的用户回合，作为差分基准。
     *
     * 新用户消息尚未落盘，历史里最近的缓存即上一轮；找不到（首轮 / 总结裁剪后）
     * 或上一轮是旧格式缓存（无 section 级数据）时返回 undefined，
     * 调用方退化为全量发送，保证信息不丢失。
     *
     * 总结感知：被总结覆盖的消息（isSummarized）原文虽留在历史但不再发送给模型，
     * 差分基准必须基于模型实际可见的回合——可见历史从最近一条总结消息之后开始，
     * 该起点之前（含被覆盖回合）一律不作为基准，否则与其相同的 section 会被差分省略，
     * 而模型从未见过这些内容，造成上下文静默丢失。
     */
    private async loadPreviousTurnDiffBase(
        conversationId: string,
        currentTurnStartId: string
    ): Promise<DynamicContextDiffBase | undefined> {
        const historyRef = await this.conversationManager.getHistoryRef(conversationId);
        // 可见历史起点：从最后一个总结消息之后开始（总结消息本身也可能携带动态上下文，一并排除）
        let visibleStart = 0;
        for (let i = historyRef.length - 1; i >= 0; i--) {
            const message = historyRef[i];
            if (message.isSummary) {
                visibleStart = i + 1;
                break;
            }
        }
        for (let i = historyRef.length - 1; i >= visibleStart; i--) {
            const message = historyRef[i];
            if (message.role !== 'user' || message.isSummarized || !message.turnDynamicContext) {
                continue;
            }
            if (typeof message.id === 'string' && message.id === currentTurnStartId) {
                continue;
            }
            const cached = deserializePromptContextCache(message.turnDynamicContext);
            if (!cached.sectionValues) {
                // 旧缓存无 section 级数据，无法差分：直接退化全量发送。
                return undefined;
            }
            return {
                sectionValues: cached.sectionValues,
                templateFingerprint: cached.dynamicTemplateFingerprint
            };
        }
        return undefined;
    }

    private orderToolResultsByCallSequence(
        calls: FunctionCallInfo[],
        groups: Array<ToolExecutionResult[] | undefined>
    ): ToolExecutionResult[] {
        const byId = new Map<string, ToolExecutionResult>();
        const extras: ToolExecutionResult[] = [];

        for (const group of groups) {
            if (!group) continue;
            for (const result of group) {
                if (!result?.id) {
                    extras.push(result);
                    continue;
                }
                if (!byId.has(result.id)) {
                    byId.set(result.id, result);
                }
            }
        }

        const ordered: ToolExecutionResult[] = [];
        for (const call of calls) {
            const match = byId.get(call.id);
            if (match) {
                ordered.push(match);
                byId.delete(call.id);
            }
        }

        ordered.push(...byId.values(), ...extras);
        return ordered;
    }

    private orderFunctionResponsePartsByCallSequence(
        calls: FunctionCallInfo[],
        groups: Array<ContentPart[] | undefined>
    ): ContentPart[] {
        const byId = new Map<string, ContentPart>();
        const extras: ContentPart[] = [];

        for (const group of groups) {
            if (!group) continue;
            for (const part of group) {
                const id = part.functionResponse?.id;
                if (!id) {
                    extras.push(part);
                    continue;
                }
                if (!byId.has(id)) {
                    byId.set(id, part);
                }
            }
        }

        const ordered: ContentPart[] = [];
        for (const call of calls) {
            const match = byId.get(call.id);
            if (match) {
                ordered.push(match);
                byId.delete(call.id);
            }
        }

        ordered.push(...byId.values(), ...extras);
        return ordered;
    }
    
    /**
     * 找到当前回合的起始用户消息索引（最后一个 isUserInput=true 的 user 消息）
     */
    private findTurnStartMessageIndex(history: Content[]): number {
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'user' && history[i].isUserInput) {
                return i;
            }
        }
        return -1;
    }

    /**
     * 会话级自动总结已用次数：conversationId → { turnStartMessageId, attempts }。
     *
     * M3：autoSummarizeAttempts 原为每次 runToolLoop / runNonStreamLoop 的局部变量，
     * 工具确认后 isNewTurn=false 的续跑会重新从 0 计数，maxAutoSummarizeAttemptsPerTurn
     * 形同虚设。这里以「回合起始用户消息 id」作为真实用户回合标识：新回合清零，续跑读取并
     * 累加。同一会话在 H1 写序竞态修复后不会并发两个流式循环（webview 层等待旧流退出），
     * 单写者假设成立；新回合 set 覆盖旧条目即完成清理，Map 不随回合数增长。
     */
    private readonly turnAutoSummarizeAttempts = new Map<string, { turnStartMessageId: string; attempts: number }>();

    /**
     * M3：解析本回合已用的自动总结尝试次数。
     *
     * - 新真实用户回合（isNewTurn=true）或回合锚点变化（总结等结构变化导致起始消息漂移）：
     *   清零并记录新锚点；
     * - 回合续跑（retry / 工具确认后的继续，isNewTurn=false 且锚点未变）：复用已用次数。
     */
    private resolveTurnAutoSummarizeAttempts(
        conversationId: string,
        turnStartMessageId: string | undefined,
        isNewTurn: boolean,
    ): number {
        const anchor = typeof turnStartMessageId === 'string' && turnStartMessageId.trim()
            ? turnStartMessageId.trim()
            : '';
        const current = this.turnAutoSummarizeAttempts.get(conversationId);
        if (isNewTurn || anchor !== current?.turnStartMessageId) {
            this.turnAutoSummarizeAttempts.set(conversationId, { turnStartMessageId: anchor, attempts: 0 });
            // M5：保持会话级 Map 有界（会话删除后条目不残留无界增长）
            this.evictOldestIfOversized(this.turnAutoSummarizeAttempts);
            return 0;
        }
        return current.attempts;
    }

    /**
     * M3：累加并持久化一次自动总结尝试（供总结分支在 autoSummarizeAttempts++ 处调用）。
     */
    private consumeTurnAutoSummarizeAttempt(conversationId: string, currentAttempts: number): number {
        const nextAttempts = currentAttempts + 1;
        const entry = this.turnAutoSummarizeAttempts.get(conversationId);
        if (entry) {
            entry.attempts = nextAttempts;
        }
        return nextAttempts;
    }

    /**
     * 清除指定会话的裁剪状态
     * 
     * 在以下情况下应调用：
     * - 删除消息
     * - 回退到检查点
     * - 编辑消息
     * 
     * @param conversationId 会话 ID
     */
    async clearTrimState(conversationId: string): Promise<void> {
        await this.contextTrimService.clearTrimState(conversationId);
        // 编辑/删除/回档等历史结构变更后，旧 fallback 切点可能错位，一并清除。
        this.granularFallbackStartByConversation.delete(conversationId);
    }

    /**
     * 合并两个取消信号：任一信号触发都将中止返回信号
     *
     * 用于自动总结场景：
     * - 主请求取消（abortSignal）
     * - 仅取消总结（summarizeAbortSignal）
     *
     * 返回 dispose 而不是裸信号：两个信号都没触发时监听器不会自行摘除，
     * 而 abortSignal 的生命周期是整个回合，一轮里多次自动总结会持续累积。
     */
    private mergeAbortSignals(
        primary?: AbortSignal,
        secondary?: AbortSignal
    ): { signal?: AbortSignal; dispose: () => void } {
        const noop = () => { };
        if (!primary) return { signal: secondary, dispose: noop };
        if (!secondary) return { signal: primary, dispose: noop };

        if (primary.aborted || secondary.aborted) {
            const controller = new AbortController();
            controller.abort();
            return { signal: controller.signal, dispose: noop };
        }

        const controller = new AbortController();
        const dispose = () => {
            primary.removeEventListener('abort', onAbort);
            secondary.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            dispose();
            if (!controller.signal.aborted) {
                controller.abort();
            }
        };

        primary.addEventListener('abort', onAbort, { once: true });
        secondary.addEventListener('abort', onAbort, { once: true });
        return { signal: controller.signal, dispose };
    }

    /**
     * 取消时结算模型消息里已经落地的工具调用。
     *
     * 流式取消会把累加器中的部分内容直接写进历史，其中可能已经包含**完整**的 functionCall。
     * 不补对应的 functionResponse，历史里就留下悬空的 tool_use：Anthropic / OpenAI 在下一次
     * 请求时会直接以 400 拒绝，而用户看到的是一句和「我刚才按了停止」毫无关系的报错。
     *
     * 流式提前执行已经跑完的工具用真实结果结算——它们的副作用（写文件、跑命令）已经发生，
     * 丢掉结果等于对模型隐瞒；其余标记为已取消。
     */
    private async settleCancelledToolCalls(
        conversationId: string,
        cancelledContent: Content,
        settledResults: Map<string, ToolExecutionFullResult>
    ): Promise<void> {
        const cancelledCalls = cancelledContent.parts
            .map(part => part.functionCall)
            .filter((call): call is NonNullable<ContentPart['functionCall']> & { id: string } => !!call?.id);

        if (cancelledCalls.length === 0) {
            return;
        }

        const responseParts: ContentPart[] = cancelledCalls.map(call => {
            const settledPart = settledResults.get(call.id)
                ?.responseParts
                .find(part => part.functionResponse?.id === call.id);

            return settledPart ?? {
                functionResponse: {
                    id: call.id,
                    name: call.name || 'unknown',
                    response: {
                        success: false,
                        error: t('modules.api.chat.errors.toolCallCancelled'),
                        cancelled: true
                    }
                }
            };
        });

        // 提前执行工具产生的多模态附件（xml/json prompt 模式）不能丢：
        // 与响应 part 一并写入，否则 generate_image / MCP 图片结果静默丢失。
        const multimodalAttachments = Array.from(settledResults.values())
            .flatMap(result => result.multimodalAttachments ?? []);
        const allParts = multimodalAttachments.length > 0
            ? [...multimodalAttachments, ...responseParts]
            : responseParts;

        // 用 settleFunctionResponses 代替 addContent：cancelStream 的
        // rejectAllPendingToolCalls 可能已写入"用户拒绝"占位，addContent 的去重
        // 会把真实结果丢弃（真实副作用结果永久丢失）；settleFunctionResponses
        // 保证真实结果永远覆盖占位。
        await this.conversationManager.settleFunctionResponses(conversationId, allParts);
    }

    /**
     * 运行工具迭代循环（流式）
     *
     * 这是核心方法，封装了工具调用循环的完整逻辑
     *
     * @param loopConfig 循环配置
     * @yields 流式响应数据
     */
    async *runToolLoop(
        loopConfig: ToolIterationLoopConfig
    ): AsyncGenerator<ToolIterationLoopOutput> {
        const {
            conversationId,
            configId,
            config,
            modelOverride,
            abortSignal,
            summarizeAbortSignal,
            isFirstMessage = false,
            promptModeSnapshot,
            maxIterations,
            startIteration = 0,
            createBeforeModelCheckpoint = true
        } = loopConfig;

        const isNewTurn = loopConfig.isNewTurn !== false;
        let dynamicContextStrategy: DynamicContextStrategy = loopConfig.dynamicContextStrategy ?? 'single';

        let iteration = startIteration;
        // 上下文裁剪/自动总结只允许在真实用户回合边界推进一次。工具确认后的继续属于同一回合，
        // 只能复用已有起点；否则前台 SubAgent 的大 functionResponse 会在回合中途挤掉整段旧历史。
        let contextManagementEvaluatedForTurn = !isNewTurn;
        // 新回合（含总结成功后重新评估）不继承上一回合的 fallback 切点，重新规划。
        if (isNewTurn) {
            this.granularFallbackStartByConversation.delete(conversationId);
        }
        // 单个真实用户回合内自动总结的最大尝试次数（配置化，默认 2；尝试耗尽后走细粒度安全裁剪）
        const maxAutoSummarizeAttempts = this.summarizeService?.getMaxAutoSummarizeAttemptsPerTurn()
            ?? DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN;

        // 同参数重复失败调用护栏（turn 级别，跨工具迭代存活）
        const repeatedCallGuard = new RepeatedCallGuard();

        // 动态上下文在回合开始时生成一次，回合内所有迭代（包括工具确认后的继续）复用
        // 动态部分包含：当前时间、文件树、标签页、活动编辑器、诊断、固定文件、TODO、Skills
        // 这些内容不存储到后端历史，仅在发送时按 promptContext 临时插入
        // 缓存存储在回合起始用户消息的 turnDynamicContext 字段上，确保每个回合独立
        let promptContext: RequestPromptContext;
        let dynamicContextText: string;
        let dynamicContextCache: string;
        let runtimeContext: DynamicRuntimeContext | undefined = undefined;

        // 获取历史以定位回合起始用户消息
        const historyRef = await this.conversationManager.getHistoryRef(conversationId);
        const turnStartIndex = this.findTurnStartMessageIndex(historyRef);
        // 回合锚点：起始用户消息 id（缓存命中分支与新回合分支共用，用于回合内运行时上下文复用）
        const turnStartId = turnStartIndex >= 0 ? (historyRef[turnStartIndex]?.id ?? null) : null;
        // M3：自动总结已用次数提升到「真实用户回合」级——新回合清零，续跑（isNewTurn=false）
        // 从会话级记录读取已用次数，避免续跑重新从 0 计数导致 maxAutoSummarizeAttemptsPerTurn 失效。
        let autoSummarizeAttempts = this.resolveTurnAutoSummarizeAttempts(
            conversationId,
            historyRef[turnStartIndex]?.id,
            isNewTurn,
        );

        if (turnStartIndex < 0 || !historyRef[turnStartIndex]?.turnDynamicContext) {
            // 新用户消息已经在 ChatFlowService 中携带快照；这里只对旧历史缺失缓存的兼容路径
            // 临时生成并使用，绝不把结果写回已经存在的消息。
            runtimeContext = await this.getOrLoadRuntimeContext(conversationId, turnStartId);
            const promptContextBundle = this.promptManager.getPromptContextBundle(promptModeSnapshot, runtimeContext);
            promptContext = {
                beforeHistoryMessages: promptContextBundle.beforeHistoryMessages,
                afterHistoryMessages: promptContextBundle.afterHistoryMessages,
                historyPlacement: promptContextBundle.historyPlacement
            };
            dynamicContextText = promptContextBundle.text;
            dynamicContextCache = serializePromptContextCache(promptContextBundle);

            // 快照只在真实用户消息创建时落盘；这里禁止 updateMessage 覆盖已发送消息。
        } else {
            // 回合继续（如工具确认后、重试等）：从结构化缓存恢复，旧纯文本缓存也兼容
            dynamicContextCache = historyRef[turnStartIndex].turnDynamicContext!;
            const cached = deserializePromptContextCache(dynamicContextCache);
            dynamicContextText = cached.contextText;
            dynamicContextStrategy = historyRef[turnStartIndex].turnDynamicContextStrategy ?? dynamicContextStrategy;
            promptContext = {
                beforeHistoryMessages: cached.beforeHistoryMessages,
                afterHistoryMessages: cached.afterHistoryMessages,
                historyPlacement: cached.historyPlacement
            };
            // 加载 runtime 以便解析系统提示词（回合内复用同一份，避免重复读元数据）
            runtimeContext = await this.getOrLoadRuntimeContext(conversationId, turnStartId);
        }

        // 预设临时消息中的伪造思考（fakeThought）受渠道「发送历史思考内容」开关控制：
        // 未配置或显式关闭都不回传（与真实历史思考的默认语义一致）。必须在发送侧过滤，不能写入 turnDynamicContext 缓存。
        promptContext = applyPromptContextThoughtPolicy(promptContext, config);

        // -1 表示无限制
        while (maxIterations === -1 || iteration < maxIterations) {
            iteration++;

            // 1. 检查是否已取消
            if (abortSignal?.aborted) {
                yield {
                    conversationId,
                    cancelled: true as const
                };
                return;
            }

            // 2. 创建模型消息前的检查点（如果配置了）
            if (createBeforeModelCheckpoint) {
                const checkpointData = await this.createBeforeModelCheckpoint(
                    conversationId,
                    iteration
                );
                if (checkpointData) {
                    yield checkpointData;
                }
            }

            // 3. 获取对话历史（应用上下文裁剪）
            const historyOptions = this.messageBuilderService.buildHistoryOptions(config);
            let trimResult = await this.contextTrimService.getHistoryWithContextTrimInfo(
                conversationId,
                config,
                historyOptions,
                dynamicContextText,
                promptModeSnapshot,
                modelOverride,
                dynamicContextStrategy,
                { allowStateAdvance: !contextManagementEvaluatedForTurn }
            );

            this.log.debug('stream.trim_result', {
                conversationId, iteration,
                modelOverride: modelOverride || null,
                configModel: (config as any).model || null,
                trimStartIndex: trimResult.trimStartIndex,
                historyLength: trimResult.history.length,
                needsAutoSummarize: !!trimResult.needsAutoSummarize
            });

            // 3.5 自动总结检测：如果需要总结，先执行总结再重新获取历史
            if (
                trimResult.needsAutoSummarize &&
                this.summarizeService &&
                autoSummarizeAttempts < maxAutoSummarizeAttempts
            ) {
                // M3：累加并持久化到会话级回合记录（续跑时读回）
                autoSummarizeAttempts = this.consumeTurnAutoSummarizeAttempt(conversationId, autoSummarizeAttempts);
                this.log.info('stream.auto_summarize_triggered', { conversationId, iteration, autoSummarizeAttempts });

                // 先通知前端显示“自动总结中”提示
                yield {
                    conversationId,
                    autoSummaryStatus: true as const,
                    status: 'started' as const
                } satisfies ChatStreamAutoSummaryStatusData;

                const merged = this.mergeAbortSignals(abortSignal, summarizeAbortSignal);

                let summarizeResult: Awaited<ReturnType<SummarizeService['handleAutoSummarize']>>;
                try {
                    summarizeResult = await this.summarizeService.handleAutoSummarize(
                        conversationId,
                        configId,
                        merged.signal,
                        modelOverride
                    );
                } finally {
                    merged.dispose();
                }

                if (summarizeResult.success) {
                    this.log.info('stream.auto_summarize_completed', { conversationId, iteration });

                    // 先通知前端插入总结消息，避免必须重载才能看到
                    if (typeof summarizeResult.insertIndex === 'number') {
                        yield {
                            conversationId,
                            autoSummary: true as const,
                            summaryContent: summarizeResult.summaryContent,
                            insertIndex: summarizeResult.insertIndex,
                            // 逻辑截断：本次总结标记（被覆盖）的消息数；前端据此标记本地消息并插入总结
                            removedCount: summarizeResult.removedCount ?? 0
                        } satisfies ChatStreamAutoSummaryData;
                    }

                    // 总结完成，隐藏“自动总结中”提示
                    yield {
                        conversationId,
                        autoSummaryStatus: true as const,
                        status: 'completed' as const
                    } satisfies ChatStreamAutoSummaryStatusData;

                    // 动态快照位于不可变的真实用户消息上；总结后的当前循环继续使用内存快照，
                    // 不再为了迁移缓存而修改历史消息。
                    // 总结调用不占用主模型工具迭代额度；重新获取历史后再发起本轮 API 请求。
                    iteration--;
                    continue;
                }

                if ('error' in summarizeResult) {
                    const summarizeError = summarizeResult.error;

                    // 主请求取消：直接结束整个对话请求
                    if (abortSignal?.aborted) {
                        yield {
                            conversationId,
                            cancelled: true as const
                        };
                        return;
                    }

                    // 仅取消总结：不终止主请求，继续正常调用 AI
                    const isSummaryOnlyAborted = summarizeError.code === 'ABORTED';

                    // 总结失败，隐藏“自动总结中”提示
                    yield {
                        conversationId,
                        autoSummaryStatus: true as const,
                        status: 'failed' as const,
                        message: isSummaryOnlyAborted
                            ? t('modules.api.chat.errors.summarizeAborted')
                            : summarizeError.message
                    } satisfies ChatStreamAutoSummaryStatusData;

                    // 总结失败：记录日志，但不要阻塞当前轮对话，继续正常请求
                    this.log.warn('stream.auto_summarize_failed', { conversationId, iteration, code: summarizeError.code, message: summarizeError.message });
                    if (!isSummaryOnlyAborted && autoSummarizeAttempts < maxAutoSummarizeAttempts) {
                        iteration--;
                        continue;
                    }
                }
            }

            if (trimResult.needsAutoSummarize || trimResult.needsContextFallback) {
                // 总结失败、总结服务不可用或本回合尝试次数耗尽：使用不持久化的细粒度安全裁剪，
                // 不再把超阈值全量历史直接交给 provider，也不永久修改 trimState。
                // 回合内首次评估（含总结成功后重新评估）重新规划切点；后续工具迭代复用已确定起点，
                // 保持 retainedHistory 前缀稳定（provider 前缀缓存命中）。
                if (!contextManagementEvaluatedForTurn) {
                    this.granularFallbackStartByConversation.delete(conversationId);
                }
                trimResult = await this.contextTrimService.getHistoryWithGranularFallback(
                    conversationId,
                    config,
                    historyOptions,
                    modelOverride,
                    dynamicContextStrategy,
                    this.granularFallbackStartByConversation.get(conversationId),
                    trimResult.fixedPromptTokens
                );
                this.granularFallbackStartByConversation.set(conversationId, trimResult.trimStartIndex);
                // M5：保持会话级 Map 有界（会话删除后条目不残留无界增长）
                this.evictOldestIfOversized(this.granularFallbackStartByConversation);
            }

            // 一旦本回合即将真正请求主模型，后续工具迭代固定复用当前裁剪起点。
            // 自动总结成功会在上方 continue，仍允许重新评估总结后的历史。
            contextManagementEvaluatedForTurn = true;
            const { history } = trimResult;

            // 4. 获取静态系统提示词（可被 API provider 缓存）
            // 静态部分包含：操作系统、时区、用户语言、工作区路径、工具定义
            const dynamicSystemPrompt = (isFirstMessage && iteration === 1)
                ? this.promptManager.refreshAndGetPrompt(promptModeSnapshot, runtimeContext)
                : this.promptManager.getSystemPrompt(promptModeSnapshot, false, runtimeContext);

            // 5. 记录请求开始时间
            const requestStartTime = Date.now();

            // 6. 调用 AI
            const response = await this.channelManager.generate({
                configId,
                history,
                abortSignal,
                dynamicSystemPrompt,
                promptContext,
                dynamicContextStrategy,
                modelOverride,
                promptModeSnapshot,
                conversationId
            });

            // 7. 处理响应
            let finalContent: Content;

            // 流式边执行工具：跟踪流式期间已启动异步执行的工具 ID 和 Promise（仅流式模式使用）
            // 存储 ToolExecutionFullResult，既包含 responseParts（写入历史），
            // 也包含 toolResults（通知前端，result 字段是工具本身的业务返回值）。
            const streamingToolPromises = new Map<string, Promise<ToolExecutionFullResult>>();
            const streamingToolResults = new Map<string, ToolExecutionFullResult>();
            const earlyToolProgressQueue = new EarlyStreamingToolProgressQueue();
            const drainSettledEarlyToolStatuses = (): ChatStreamToolStatusData[] => earlyToolProgressQueue
                .drainSettled()
                .flatMap(settlement => settlement.fullResult.toolResults.map(toolResult => ({
                    conversationId,
                    toolStatus: true as const,
                    tool: createChatToolStatusUpdate(toolResult)
                })));

            if (isAsyncGenerator(response)) {
                // 流式响应处理
                const processor = new StreamResponseProcessor({
                    requestStartTime,
                    providerType: config.type as 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
                    toolMode: config.toolMode || 'function_call',
                    abortSignal,
                    conversationId
                });
                // 处理流并 yield 每个 chunk，同时检测新完成的 functionCall 提前启动执行
                for await (const chunkData of processor.processStream(response)) {
                    yield chunkData;

                    // 流式边执行工具：检测 StreamAccumulator 中新完成的 functionCall。
                    // 对不需要确认且不需要模式策略拒绝的工具，立即启动异步执行。
                    // 需要确认的工具跳过（仍走现有的暂停等待路径）。
                    if (!abortSignal?.aborted) {
                        const newCalls = processor.getAccumulator().getNewCompletedFunctionCalls();
                        for (const fc of newCalls) {
                            // 只对不需要确认、且不会创建 pending diff 审阅会话的工具提前执行。
                            if (shouldStartToolDuringModelStream(fc, this.toolExecutionService, promptModeSnapshot)) {
                                this.log.info('stream.early_tool_start', { conversationId, iteration, toolName: fc.name, toolId: fc.id });
                                yield {
                                    conversationId,
                                    toolStatus: true as const,
                                    tool: {
                                        id: fc.id,
                                        name: fc.name,
                                        status: 'executing' as const,
                                        args: fc.args
                                    }
                                } satisfies ChatStreamToolStatusData;

                                // 检查点挂到“即将写入的模型消息”索引上（与 createModelMessageCheckpoint
                                // 的 before 语义一致）。以前这里传 undefined，导致流式早启动的工具
                                // （含 execute_command 等会改变文件系统的工具）完全没有检查点保护。
                                const earlyCheckpointIndex = (await this.conversationManager.getHistoryRef(conversationId)).length;
                                const rawPromise = this.toolExecutionService.executeFunctionCallsWithResults(
                                    [repeatedCallGuard.guardCall({ id: fc.id, name: fc.name, args: fc.args })],
                                    conversationId,
                                    earlyCheckpointIndex,
                                    config,
                                    abortSignal,
                                    promptModeSnapshot,
                                    undefined,
                                    undefined,
                                    undefined,
                                    // E-1：早启动生成器一律不参与主会话信箱 drain（不传 mailbox 身份）。
                                    // 原因：早启动在其持有 epoch 期间完成 drain 后，若流中途 cancel 且
                                    // 携带 agentInbox 的结果被整体丢弃（partialContent.parts.length===0 不落盘，
                                    // 或调用 id 不在 partialContent 中不结算），消息已从 inbox 移除、未持久化 =
                                    // 丢失。改为统一由主循环 drain；无主循环时在 autoPrefix 为空分支显式 drain 一次。
                                    undefined,
                                    undefined,
                                    // 主会话路径无嵌套深度（subagent 工具自行注入子代理深度）
                                    undefined,
                                    // 当前对话绑定的工作区 URI（用于工具执行的工作区限定/记忆路由）
                                    runtimeContext?.workspaceUri,
                                    // General Worker 模型继承：把主会话当前模型透传给工具上下文
                                    modelOverride
                                ).catch(err => {
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

                    for (const statusChunk of drainSettledEarlyToolStatuses()) {
                        yield statusChunk;
                    }
                }

                // 检查是否被取消
                if (processor.isCancelled()) {
                    let partialContent = processor.getContent();

                    // 流式取消收尾窗口（对齐 843-871 行 early-abort 路径的 abort-race 模式）：
                    // 早启动工具已产生真实副作用，取消时先等它们落定，用真实结果结算，而不是
                    // 只结算"取消时刻已 settle"的工具——否则刚完成/仍在执行的工具结果只会写入
                    // 将被丢弃的 streamingToolResults，历史留下 cancelled 占位，下一轮
                    // rejectAllPendingToolCalls 会误标"用户拒绝"，模型可能重复执行。
                    // abort 此刻已触发，不能再与 abort race（会立即 resolve 造成忙等），
                    // 改用 deadline 兜底：窗口内落定的工具结算真实结果，超时未落定的标记取消。
                    const settleDeadline = Date.now() + STREAM_CANCEL_TOOL_SETTLE_GRACE_MS;
                    while (earlyToolProgressQueue.hasPending() && Date.now() < settleDeadline) {
                        const readyStatuses = drainSettledEarlyToolStatuses();
                        if (readyStatuses.length > 0) {
                            for (const statusChunk of readyStatuses) {
                                yield statusChunk;
                            }
                            continue;
                        }
                        const remainingMs = settleDeadline - Date.now();
                        if (remainingMs <= 0) {
                            break;
                        }
                        let settleTimer: ReturnType<typeof setTimeout> | undefined;
                        const timeoutPromise = new Promise<void>((resolve) => {
                            settleTimer = setTimeout(resolve, remainingMs);
                        });
                        try {
                            await Promise.race([earlyToolProgressQueue.waitForNextSettlement(), timeoutPromise]);
                        } finally {
                            // 工具先落定时清理 timer，避免残留 open handle
                            if (settleTimer) {
                                clearTimeout(settleTimer);
                            }
                        }
                    }
                    for (const statusChunk of drainSettledEarlyToolStatuses()) {
                        yield statusChunk;
                    }

                    if (partialContent.parts.length > 0) {
                        // 标记半截 usage：流被取消时 usageMetadata 只覆盖已收到的 chunk，
                        // 统计端（usageStats/getStats）据此回退到文本长度估算。
                        partialContent.usageMetadataPartial = true;
                        const persistedPartialContent = await this.conversationManager.addContent(conversationId, partialContent);
                        if (persistedPartialContent) {
                            partialContent = persistedPartialContent;
                        }
                        await this.settleCancelledToolCalls(conversationId, partialContent, streamingToolResults);

                        // 与 stream_early_abort 路径（878-902 行）对齐：结算 stop state，
                        // 避免 pendingApprovalGate 等状态残留，否则后续 hidden continuation
                        // 会被 APPROVAL_GATE_MISMATCH 拦截或漏掉审批门。
                        const cancelledCalls = partialContent.parts
                            .map(part => part.functionCall)
                            .filter((call): call is NonNullable<ContentPart['functionCall']> & { id: string } => !!call?.id);
                        const settledEarlyResults = Array.from(streamingToolResults.values());
                        const settledToolResults = this.orderToolResultsByCallSequence(
                            cancelledCalls,
                            [settledEarlyResults.flatMap(result => result.toolResults)]
                        );
                        await resolveAndPersistPostToolStopState(
                            this.conversationManager,
                            conversationId,
                            cancelledCalls,
                            settledToolResults,
                            {
                                logger: this.log,
                                logContext: { iteration, executionPath: 'stream_cancel' }
                            }
                        );
                    }
                    // 取消输出已并入 ToolIterationLoopOutput 联合（cancelled 成员）；
                    // 若半截内容已落盘，必须回传 addContent 返回的稳定节点 ID，而不是累加器的无 ID 副本。
                    yield {
                        conversationId,
                        cancelled: true as const,
                        ...(partialContent.parts.length > 0 ? { content: partialContent } : {})
                    };
                    return;
                }

                finalContent = processor.getContent();
            } else {
                // 非流式响应处理
                const processor = new StreamResponseProcessor({
                    requestStartTime,
                    providerType: config.type as 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
                    toolMode: config.toolMode || 'function_call',
                    abortSignal,
                    conversationId
                });

                const { content, chunkData } = processor.processNonStream(response as GenerateResponse);
                finalContent = content;
                yield chunkData;
            }

            // 9. 转换工具调用格式
            this.toolCallParserService.convertPromptModeToolCallsToFunctionCalls(finalContent, config.toolMode || 'function_call');
            this.toolCallParserService.ensureFunctionCallIds(finalContent);

            // 9.5 确保 modelVersion 来自配置而非依赖 API 返回（第三方代理可能不返回 model 字段）
            const configuredModel = modelOverride || (config as any).model;
            if (!finalContent.modelVersion && configuredModel) {
                finalContent.modelVersion = configuredModel;
            }

            // 10. 保存 AI 响应到历史
            if (finalContent.parts.length > 0) {
                const persistedContent = await this.conversationManager.addContent(conversationId, finalContent);
                if (persistedContent) {
                    finalContent = persistedContent;
                }
            }

            // 11. 检查是否有工具调用
            const functionCalls = this.toolCallParserService.extractFunctionCalls(finalContent, config.toolMode || 'function_call');

            if (functionCalls.length === 0) {
                // 没有工具调用，创建模型消息后的检查点并返回完成数据
                const modelMessageCheckpoints: CheckpointRecord[] = [];
                const checkpoint = await this.checkpointService.createModelMessageCheckpoint(
                    conversationId,
                    'after'
                );
                if (checkpoint) {
                    modelMessageCheckpoints.push(checkpoint);
                }

                // 返回完成数据
                yield {
                    conversationId,
                    content: finalContent,
                    checkpoints: modelMessageCheckpoints
                };
                return;
            }

            // 12. 有工具调用：按 AI 输出顺序依次处理。
            // 规则：执行到第一个“需要用户批准”的工具时暂停；后续工具必须等待前置工具完成。

            // 找到第一个需要确认的工具（按顺序），并只自动执行它之前的前缀工具。
            const autoPrefix: FunctionCallInfo[] = [];
            let firstConfirmTool: FunctionCallInfo | null = null;

            for (const call of functionCalls) {
                if (this.toolExecutionService.toolNeedsConfirmation(call.name, call.args, promptModeSnapshot)) {
                    firstConfirmTool = call;
                    break;
                }
                autoPrefix.push(call);
            }

            let executionResult: ToolExecutionFullResult | undefined;

            // 流式边执行工具：等待流式期间已启动的异步工具完成，
            // 将其从 autoPrefix 中移除（避免重复执行）。
            if (streamingToolPromises.size > 0) {
                // 等待循环内必须有 abort 检查：若某工具不响应 abortSignal 且永不结束，
                // 无检查的 waitForNextSettlement 会让整个请求永久挂起，停止按钮失效。
                while (earlyToolProgressQueue.hasPending() && !abortSignal?.aborted) {
                    const readyStatuses = drainSettledEarlyToolStatuses();
                    if (readyStatuses.length > 0) {
                        for (const statusChunk of readyStatuses) {
                            yield statusChunk;
                        }
                        continue;
                    }
                    if (abortSignal?.aborted) {
                        break;
                    }
                    if (abortSignal) {
                        // waitForNextSettlement 本身无 abort 监听：若某工具不响应
                        // abortSignal 且永不结束，单独等待会永久挂起、停止按钮失效。
                        // 与 abort 事件做 race，取消时立即退出等待循环。
                        let onAbort: (() => void) | undefined;
                        const abortPromise = abortSignal.aborted
                            ? Promise.resolve()
                            : new Promise<void>((resolve) => {
                                onAbort = () => resolve();
                                abortSignal.addEventListener('abort', onAbort, { once: true });
                            });
                        try {
                            await Promise.race([earlyToolProgressQueue.waitForNextSettlement(), abortPromise]);
                        } finally {
                            if (onAbort) {
                                abortSignal.removeEventListener('abort', onAbort);
                            }
                        }
                    } else {
                        // 无 abort 信号时直接等下一次落定——若用已 resolve 的 Promise 做 race，
                        // 循环会退化为纯忙等（100% CPU）直到工具落定。
                        await earlyToolProgressQueue.waitForNextSettlement();
                    }
                }
                for (const statusChunk of drainSettledEarlyToolStatuses()) {
                    yield statusChunk;
                }

                // 等待期间被取消：已执行完的提前执行工具用真实结果结算（副作用已发生，
                // 结果不能丢），未完成的调用标记为取消，避免悬空 tool_use 触发 API 400。
                if (abortSignal?.aborted) {
                    await this.settleCancelledToolCalls(conversationId, finalContent, streamingToolResults);
                    // 与串行 abort 路径（executionPath: 'stream_abort'）语义对齐：
                    // 结算 stop state，避免 pendingApprovalGate 等状态残留。
                    const settledEarlyResults = Array.from(streamingToolResults.values());
                    const settledToolResults = this.orderToolResultsByCallSequence(
                        functionCalls,
                        [settledEarlyResults.flatMap(result => result.toolResults)]
                    );
                    await resolveAndPersistPostToolStopState(
                        this.conversationManager,
                        conversationId,
                        functionCalls,
                        settledToolResults,
                        {
                            logger: this.log,
                            logContext: { iteration, executionPath: 'stream_early_abort' }
                        }
                    );
                    yield {
                        conversationId,
                        cancelled: true as const
                    };
                    return;
                }

                const remainingAutoPrefix: FunctionCallInfo[] = [];

                for (const call of autoPrefix) {
                    if (streamingToolResults.has(call.id)) {
                        this.log.info('stream.early_tool_done', { conversationId, toolName: call.name, toolId: call.id });
                    } else {
                        remainingAutoPrefix.push(call);
                    }
                }

                autoPrefix.length = 0;
                autoPrefix.push(...remainingAutoPrefix);
            }

            // C-21：预构建 id -> 下标映射，避免每个 start 事件都线性扫描 autoPrefix
            const autoPrefixIndexById = new Map<string, number>(autoPrefix.map((c, i) => [c.id, i]));

            const earlyFullResults = Array.from(streamingToolResults.values());
            const earlyToolResults = this.orderToolResultsByCallSequence(
                functionCalls,
                [earlyFullResults.flatMap(result => result.toolResults)]
            );
            repeatedCallGuard.recordResults(earlyToolResults);
            const earlyResponseParts = this.orderFunctionResponsePartsByCallSequence(
                functionCalls,
                [earlyFullResults.flatMap(result => result.responseParts)]
            );
            // 流式提前执行的工具产生的多模态附件（xml/json prompt 模式）。
            // 以前这些附件被完全忽略，提前执行的 generate_image / MCP 图片结果会静默丢失。
            const earlyMultimodalAttachments = earlyFullResults.flatMap(result => result.multimodalAttachments ?? []);
            // 流式提前执行的工具创建的检查点（挂在 earlyCheckpointIndex 上，与
            // createModelMessageCheckpoint 的 before 语义一致）。主循环路径透传
            // executionResult.checkpoints，此分支无主循环执行，透传提前执行结果
            // 汇总的真实检查点（此前恒下发 checkpoints:[]，前端无检查点可回档）。
            const earlyCheckpoints = earlyFullResults.flatMap(result => result.checkpoints ?? []);

            // 如果所有工具都已在流式期间执行完，autoPrefix 为空，
            // 但 earlyResponseParts 中有结果需要写入历史。
            // 必须写入，否则下一轮 LLM 调用时 assistant 的 tool_use 没有对应的 tool_result，
            // Anthropic API 会返回 400 错误。
            if (autoPrefix.length === 0 && earlyResponseParts.length > 0) {
                // E-1：早启动生成器不 drain（见上），此处是最终落盘路径，
                // 显式 drain 一次主会话信箱并注入结果（无主循环时的唯一投递点）。
                // drainInboxIntoResults 内部会先校验该 mailbox 无并发执行循环持有
                // drain 权（MED-1），避免与并发新主循环竞争时消息挂到将被丢弃的结果上。
                this.toolExecutionService.drainInboxIntoResults(
                    conversationId,
                    MAIN_SESSION_RUN_ID,
                    earlyResponseParts,
                    earlyToolResults
                );
                // BR-08：改用 settleFunctionResponses 落盘（替代 addContent 末尾追加）：
                // 正常路径（assistant 为历史末条）插入位置等价；与用户插话竞态时插回
                // assistant 的 FR 块之后，不会形成 [assistant(tool_calls), user, tool]
                // 的非法交替顺序，已执行工具的真实结果对后续请求保持可见。
                // 对已存在的 rejected 占位同样有就地替换语义。
                await this.conversationManager.settleFunctionResponses(
                    conversationId,
                    earlyMultimodalAttachments.length > 0
                        ? [...earlyMultimodalAttachments, ...earlyResponseParts]
                        : earlyResponseParts
                );

                const earlyStopState = await resolveAndPersistPostToolStopState(
                    this.conversationManager,
                    conversationId,
                    functionCalls,
                    earlyToolResults,
                    {
                        logger: this.log,
                        logContext: { iteration, executionPath: 'stream_early' }
                    }
                );

                if (firstConfirmTool && !earlyStopState.shouldStop) {
                    yield {
                        conversationId,
                        pendingToolCalls: [{
                            id: firstConfirmTool.id,
                            name: firstConfirmTool.name,
                            args: firstConfirmTool.args
                        }],
                        content: finalContent,
                        awaitingConfirmation: true as const,
                        toolResults: earlyToolResults,
                        checkpoints: earlyCheckpoints
                    } satisfies ChatStreamToolConfirmationData;

                    return;
                }

                yield {
                    conversationId,
                    content: finalContent,
                    toolIteration: true as const,
                    toolResults: earlyToolResults,
                    checkpoints: earlyCheckpoints,
                };

                if (earlyStopState.shouldStop) {
                    return;
                }

                continue;
            }

            if (autoPrefix.length > 0) {
                // 在执行循环开始前，立即发送包含所有待执行工具的初始 toolsExecuting
                // 让前端尽早看到完整的工具队列（第一个为 executing，其余为 queued）
                // 先过一次同参数重复失败护栏：快照与真实执行共用同一份 guarded 列表，
                // 避免前端看到未护栏的原始 args（与护栏替换后的实际执行不一致）。
                const guardedAutoPrefix = repeatedCallGuard.guardCalls(autoPrefix);
                yield {
                    conversationId,
                    content: finalContent,
                    toolsExecuting: true as const,
                    pendingToolCalls: guardedAutoPrefix.map(c => ({
                        id: c.id,
                        name: c.name,
                        args: c.args
                    }))
                } satisfies ChatStreamToolsExecutingData;

                const currentHistory = await this.conversationManager.getHistoryRef(conversationId);
                const messageIndex = currentHistory.length - 1;

                // 执行工具调用（按顺序），并实时发送每个工具的开始/结束状态；
                // 达到连续失败阈值的重复调用会被护栏替换为短路错误调用
                const gen = this.toolExecutionService.executeFunctionCallsWithProgress(
                    guardedAutoPrefix,
                    conversationId,
                    messageIndex,
                    config,
                    abortSignal,
                    promptModeSnapshot,
                    undefined,
                    undefined,
                    undefined,
                    // A-COMM：主会话信箱按 conversationId + 主会话保留 runId 挂载
                    conversationId,
                    MAIN_SESSION_RUN_ID,
                    // 主会话路径无嵌套深度（subagent 工具自行注入子代理深度）
                    undefined,
                    // 当前对话绑定的工作区 URI（用于工具执行的工作区限定/记忆路由）
                    runtimeContext?.workspaceUri,
                    // General Worker 模型继承：把主会话当前模型透传给工具上下文
                    modelOverride
                );

                while (true) {
                    // 主循环 gen.next() 与 abort race（复用 857-870 行 abort-race 模式）：
                    // 若当前工具不响应 abortSignal 且永不结束，单独的 await gen.next() 会让
                    // 整个请求（含停止按钮）永久挂起。abort 先到时先给生成器一个短暂收尾窗口：
                    // 响应 abort 的工具会快速返回已完成部分的真实结果（不能丢，否则历史只剩
                    // "用户拒绝"占位），窗口结束仍未返回则放弃，立即走下方取消路径。
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
                        const nextPromise = gen.next();
                        const winner = abortPromise
                            ? await Promise.race([nextPromise, abortPromise])
                            : await nextPromise;
                        if (winner === undefined) {
                            // abort 先到：收尾窗口内等生成器返回已完成部分的真实结果
                            executionResult = await drainToolExecutionGeneratorAfterAbort(
                                gen,
                                nextPromise,
                                MAIN_LOOP_ABORT_DRAIN_GRACE_MS
                            );
                            break;
                        }
                        const { value, done } = winner;
                        if (done) {
                            executionResult = value as ToolExecutionFullResult;
                            break;
                        }

                        const event = value as ToolExecutionProgressEvent;

                        if (event.type === 'start') {
                            // 计算当前工具及所有剩余待执行工具（O(1) 查表，替代逐次 findIndex）
                            const currentIndex = autoPrefixIndexById.get(event.call.id) ?? -1;
                            const remaining = currentIndex !== -1 ? guardedAutoPrefix.slice(currentIndex) : [event.call];

                            // 工具执行前发送剩余队列信息（让前端实时显示执行进度）
                            yield {
                                conversationId,
                                content: finalContent,
                                toolsExecuting: true as const,
                                pendingToolCalls: remaining.map(c => ({
                                    id: c.id,
                                    name: c.name,
                                    args: c.args
                                }))
                            } satisfies ChatStreamToolsExecutingData;
                            continue;
                        }

                        if (event.type === 'end') {
                            yield {
                                conversationId,
                                toolStatus: true as const,
                                tool: createChatToolStatusUpdate(event.toolResult)
                            } satisfies ChatStreamToolStatusData;
                        }
                    } catch (error) {
                        // 主循环泵 gen.next() reject（工具执行异常/内部错误，如 checkpoint 落盘失败）：
                        // 与 execution.ts 非流式主循环的 catch 同构——已无法取回真实结果，为每个调用
                        // 构造带 error 的 responsePart/toolResult，保证 assistant 的每个 tool_use 都有
                        // 配对 tool_result，不让异常穿透为 error chunk，也不留下孤儿 tool_calls（否则
                        // 下一轮 generate 触发 Anthropic/OpenAI 400）。按普通工具失败语义落盘，模型
                        // 继续处理；与 abort 收尾窗口超时的空结果（取消语义）区分：此处是失败语义。
                        this.log.warn('tool_gen_next_rejected', {
                            conversationId,
                            messageIndex,
                            iteration,
                            error: (error as Error)?.message ?? String(error),
                        });
                        const errorResponse: Record<string, unknown> = {
                            success: false,
                            error: (error as Error)?.message ?? String(error),
                        };
                        executionResult = {
                            responseParts: guardedAutoPrefix.map(call => ({
                                functionResponse: {
                                    id: call.id,
                                    name: call.name,
                                    response: errorResponse
                                }
                            })),
                            toolResults: guardedAutoPrefix.map(call => ({
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

                // 检查是否已取消
                if (abortSignal?.aborted) {
                    // 工具已全部执行完并产生真实副作用（改文件、跑命令），
                    // 结果必须写入历史：否则模型对磁盘状态的认知与事实不符，
                    // 且下次请求前 rejectAllPendingToolCalls 会把悬空调用标记为"用户拒绝"，
                    // 真实执行结果永久丢失，模型可能重复执行同一工具调用。
                    if (executionResult) {
                        const combinedToolResults = this.orderToolResultsByCallSequence(
                            functionCalls,
                            [earlyToolResults, executionResult.toolResults]
                        );
                        const orderedFunctionResponseParts = this.orderFunctionResponsePartsByCallSequence(
                            functionCalls,
                            [earlyResponseParts, executionResult.responseParts]
                        );
                        const combinedMultimodalAttachments = [
                            ...earlyMultimodalAttachments,
                            ...(executionResult.multimodalAttachments ?? [])
                        ];
                        const functionResponseParts = combinedMultimodalAttachments.length > 0
                            ? [...combinedMultimodalAttachments, ...orderedFunctionResponseParts]
                            : orderedFunctionResponseParts;

                        await this.conversationManager.settleFunctionResponses(conversationId, functionResponseParts);

                        await resolveAndPersistPostToolStopState(
                            this.conversationManager,
                            conversationId,
                            functionCalls,
                            combinedToolResults,
                            {
                                logger: this.log,
                                logContext: { iteration, executionPath: 'stream_abort' }
                            }
                        );
                    } else {
                        // BR-08：drain 收尾窗口超时拿不到真实结果（工具不响应 abort 且永不结束）。
                        // 此前整段跳过结算，历史残留"无响应的孤儿 tool_calls"——下一个请求构建时
                        // formatter 会原样发送这些 call（无配对 tool 消息）→ OpenAI/Anthropic 400，
                        // 或新回合 rejectAllPendingToolCalls 把它们误标为"用户拒绝"。
                        // 这里把早启动工具的真实结果与其余调用的 cancelled 占位一并结算，
                        // 保证 assistant 的每个 tool_calls 都有配对响应。
                        const earlySettledResults = new Map<string, ToolExecutionFullResult>();
                        let attachmentsAssigned = false;
                        for (const part of earlyResponseParts) {
                            const id = part.functionResponse?.id;
                            if (id) {
                                // 多模态附件只随第一个 wrapper 携带：settleCancelledToolCalls
                                // 会对所有 settledResults 的附件做 flatMap，重复携带会写 N 份
                                earlySettledResults.set(id, {
                                    toolResults: [],
                                    responseParts: [part],
                                    checkpoints: [],
                                    multimodalAttachments: attachmentsAssigned
                                        ? []
                                        : earlyMultimodalAttachments
                                });
                                attachmentsAssigned = true;
                            }
                        }
                        await this.settleCancelledToolCalls(conversationId, finalContent, earlySettledResults);
                    }

                    yield {
                        conversationId,
                        cancelled: true as const
                    };
                    return;
                }

                // 将函数响应添加到历史（合并流式期间提前执行的 + 后续执行的结果）

                // 该块仅在主循环以 done 正常结束时可达（此时 executionResult 必然已赋值，
                // abort 路径在上面已提前 return）；TS 控制流无法跨循环收窄，这里断言后使用，
                // 不改变运行时行为。
                const finalExecutionResult = executionResult!;

                repeatedCallGuard.recordResults(finalExecutionResult.toolResults);

                const combinedToolResults = this.orderToolResultsByCallSequence(
                    functionCalls,
                    [earlyToolResults, finalExecutionResult.toolResults]
                );
                const orderedFunctionResponseParts = this.orderFunctionResponsePartsByCallSequence(
                    functionCalls,
                    [earlyResponseParts, finalExecutionResult.responseParts]
                );
                // 合并流式提前执行与后续串行执行两条路径的多模态附件，缺一不可
                const combinedMultimodalAttachments = [
                    ...earlyMultimodalAttachments,
                    ...(finalExecutionResult.multimodalAttachments ?? [])
                ];
                const functionResponseParts = combinedMultimodalAttachments.length > 0
                    ? [...combinedMultimodalAttachments, ...orderedFunctionResponseParts]
                    : orderedFunctionResponseParts;

                executionResult = {
                    ...finalExecutionResult,
                    responseParts: orderedFunctionResponseParts,
                    toolResults: combinedToolResults,
                    multimodalAttachments: combinedMultimodalAttachments.length > 0 ? combinedMultimodalAttachments : undefined
                };

                // BR-08：与 1285 分支一致，用 settleFunctionResponses 落盘（替代 addContent）：
                // 正常路径位置等价；与用户插话竞态时插回 assistant 的 FR 块之后，不会形成
                // [assistant(tool_calls), user, tool] 非法交替；且对 cancel 竞态下已写入的
                // rejected 占位有就地替换语义（addContent 的去重会丢弃真实结果）。
                await this.conversationManager.settleFunctionResponses(conversationId, functionResponseParts);
            }

            if (executionResult) {
                const postToolStopState = await resolveAndPersistPostToolStopState(
                    this.conversationManager,
                    conversationId,
                    functionCalls,
                    executionResult.toolResults,
                    {
                        logger: this.log,
                        logContext: { iteration, executionPath: 'stream' }
                    }
                );

                if (postToolStopState.shouldStop) {
                    yield {
                        conversationId,
                        content: finalContent,
                        toolIteration: true as const,
                        toolResults: executionResult.toolResults,
                        checkpoints: executionResult.checkpoints
                    };

                    return;
                }
            }

            // 13. 如果遇到需要确认的工具，则暂停并等待（仅等待当前这个“队首”工具）
            if (firstConfirmTool) {
                yield {
                    conversationId,
                    pendingToolCalls: [{
                        id: firstConfirmTool.id,
                        name: firstConfirmTool.name,
                        args: firstConfirmTool.args
                    }],
                    content: finalContent,
                    awaitingConfirmation: true as const,
                    toolResults: executionResult?.toolResults,
                    checkpoints: executionResult?.checkpoints
                };

                return;
            }

            // 14. 没有需要确认的工具，说明所有工具均已自动执行完成
            if (executionResult) {
                yield {
                    conversationId,
                    content: finalContent,
                    toolIteration: true as const,
                    toolResults: executionResult.toolResults,
                    checkpoints: executionResult.checkpoints
                };
            }

            // 继续循环，让 AI 处理函数结果
        }

        // 达到最大迭代次数
        yield {
            conversationId,
            error: {
                code: 'MAX_TOOL_ITERATIONS',
                message: t('modules.api.chat.errors.maxToolIterations', { maxIterations })
            }
        };
    }

    /**
     * 运行非流式工具循环
     *
     * 用于 handleChat / handleRetry / handleEditAndRetry 等非流式场景，
     * 不产生流式 chunk，仅返回最终内容或标记超出最大迭代次数。
     */
    async runNonStreamLoop(
        conversationId: string,
        configId: string,
        config: BaseChannelConfig,
        maxIterations: number,
        modelOverride?: string,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        dynamicContextStrategy: DynamicContextStrategy = 'single',
        isNewTurn: boolean = true,
        abortSignal?: AbortSignal,
        summarizeAbortSignal?: AbortSignal
    ): Promise<NonStreamToolLoopResult> {
        let iteration = 0;
        // 与流式路径一致：非新回合从第一轮起就禁止推进裁剪；新回合只在首次实际模型请求前评估。
        let contextManagementEvaluatedForTurn = !isNewTurn;
        // 新回合不继承上一回合的 fallback 切点，重新规划。
        if (isNewTurn) {
            this.granularFallbackStartByConversation.delete(conversationId);
        }
        // 单个真实用户回合内自动总结的最大尝试次数（配置化，默认 2；尝试耗尽后走细粒度安全裁剪）
        const maxAutoSummarizeAttempts = this.summarizeService?.getMaxAutoSummarizeAttemptsPerTurn()
            ?? DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN;
        const repeatedCallGuard = new RepeatedCallGuard();
        const historyOptions = this.messageBuilderService.buildHistoryOptions(config);

        // 在回合开始时一次性生成动态上下文，回合内所有迭代复用，并存到回合起始用户消息上。
        // 非新回合（retry / hidden functionResponse / 工具确认后的继续）必须读取这个缓存，
        // 不能重新生成并让动态上下文跟随历史尾部漂移。
        const historyRef = await this.conversationManager.getHistoryRef(conversationId);
        const turnStartIndex = this.findTurnStartMessageIndex(historyRef);
        // 回合锚点：起始用户消息 id（缓存命中分支与新回合分支共用，用于回合内运行时上下文复用）
        const turnStartId = turnStartIndex >= 0 ? (historyRef[turnStartIndex]?.id ?? null) : null;
        // M3：与流式路径一致——自动总结已用次数按「真实用户回合」记录，续跑读取并累加。
        let autoSummarizeAttempts = this.resolveTurnAutoSummarizeAttempts(
            conversationId,
            historyRef[turnStartIndex]?.id,
            isNewTurn,
        );

        let promptContext: RequestPromptContext;
        let dynamicContextText: string;
        let dynamicContextCache: string;
        let runtimeContext: DynamicRuntimeContext | undefined = undefined;

        if (turnStartIndex < 0 || !historyRef[turnStartIndex]?.turnDynamicContext) {
            // 新用户消息已经在 ChatFlowService 中携带快照；这里只对旧历史缺失缓存的兼容路径
            // 临时生成并使用，绝不把结果写回已经存在的消息。
            runtimeContext = await this.getOrLoadRuntimeContext(conversationId, turnStartId);
            const promptContextBundle = this.promptManager.getPromptContextBundle(promptModeSnapshot, runtimeContext);
            promptContext = {
                beforeHistoryMessages: promptContextBundle.beforeHistoryMessages,
                afterHistoryMessages: promptContextBundle.afterHistoryMessages,
                historyPlacement: promptContextBundle.historyPlacement
            };
            dynamicContextText = promptContextBundle.text;
            dynamicContextCache = serializePromptContextCache(promptContextBundle);

            // 快照只在真实用户消息创建时落盘；这里禁止 updateMessage 覆盖已发送消息。
        } else {
            dynamicContextCache = historyRef[turnStartIndex].turnDynamicContext!;
            const cached = deserializePromptContextCache(dynamicContextCache);
            dynamicContextText = cached.contextText;
            dynamicContextStrategy = historyRef[turnStartIndex].turnDynamicContextStrategy ?? dynamicContextStrategy;
            promptContext = {
                beforeHistoryMessages: cached.beforeHistoryMessages,
                afterHistoryMessages: cached.afterHistoryMessages,
                historyPlacement: cached.historyPlacement
            };

            runtimeContext = await this.getOrLoadRuntimeContext(conversationId, turnStartId);
        }

        // 预设临时消息中的伪造思考（fakeThought）受渠道「发送历史思考内容」开关控制：
        // 未配置或显式关闭都不回传（与真实历史思考的默认语义一致）。必须在发送侧过滤，不能写入 turnDynamicContext 缓存。
        promptContext = applyPromptContextThoughtPolicy(promptContext, config);

        // -1 表示无限制
        while (maxIterations === -1 || iteration < maxIterations) {
            iteration++;

            // D2：与流式路径（runToolLoop 循环顶部）对齐——主请求取消时立即返回，
            // 不再发起新一轮 API 请求（此前会继续调 generate，取消语义依赖 provider 侧）。
            if (abortSignal?.aborted) {
                return { exceededMaxIterations: false, cancelled: true };
            }

            // 获取对话历史（应用总结过滤和上下文阈值裁剪）
            let trimResult = await this.contextTrimService.getHistoryWithContextTrimInfo(
                conversationId,
                config,
                historyOptions,
                dynamicContextText,
                promptModeSnapshot,
                modelOverride,
                dynamicContextStrategy,
                { allowStateAdvance: !contextManagementEvaluatedForTurn }
            );

            this.log.debug('nonstream.trim_result', {
                conversationId, iteration,
                modelOverride: modelOverride || null,
                configModel: (config as any).model || null,
                trimStartIndex: trimResult.trimStartIndex,
                historyLength: trimResult.history.length,
                needsAutoSummarize: !!trimResult.needsAutoSummarize
            });

            // 自动总结检测
            if (
                trimResult.needsAutoSummarize &&
                this.summarizeService &&
                autoSummarizeAttempts < maxAutoSummarizeAttempts
            ) {
                // M3：累加并持久化到会话级回合记录（续跑时读回）
                autoSummarizeAttempts = this.consumeTurnAutoSummarizeAttempt(conversationId, autoSummarizeAttempts);
                this.log.info('nonstream.auto_summarize_triggered', { conversationId, iteration, autoSummarizeAttempts });

                // H5：非流式路径透传 abort 信号——主请求取消（abortSignal）或仅取消总结
                // （summarizeAbortSignal）任一触发都中止总结调用，与流式路径对齐。
                const merged = this.mergeAbortSignals(abortSignal, summarizeAbortSignal);
                let summarizeResult: Awaited<ReturnType<SummarizeService['handleAutoSummarize']>>;
                try {
                    summarizeResult = await this.summarizeService.handleAutoSummarize(
                        conversationId,
                        configId,
                        merged.signal,
                        modelOverride
                    );
                } finally {
                    merged.dispose();
                }

                if (summarizeResult.success) {
                    // 动态快照位于不可变的真实用户消息上；总结后的当前循环继续使用内存快照，
                    // 不再为了迁移缓存而修改历史消息。
                    // 总结调用不占用主模型工具迭代额度。
                    iteration--;
                    continue;
                }

                if ('error' in summarizeResult) {
                    const summarizeError = summarizeResult.error;

                    // 总结失败：不阻塞当前请求，继续使用现有历史
                    this.log.warn('nonstream.auto_summarize_failed', { conversationId, iteration, code: summarizeError.code, message: summarizeError.message });
                    if (summarizeError.code !== 'ABORTED' && autoSummarizeAttempts < maxAutoSummarizeAttempts) {
                        iteration--;
                        continue;
                    }
                }
            }

            if (trimResult.needsAutoSummarize || trimResult.needsContextFallback) {
                // 与流式路径一致：回合内首次评估重新规划切点，后续迭代复用已确定起点（前缀缓存稳定）。
                if (!contextManagementEvaluatedForTurn) {
                    this.granularFallbackStartByConversation.delete(conversationId);
                }
                trimResult = await this.contextTrimService.getHistoryWithGranularFallback(
                    conversationId,
                    config,
                    historyOptions,
                    modelOverride,
                    dynamicContextStrategy,
                    this.granularFallbackStartByConversation.get(conversationId),
                    trimResult.fixedPromptTokens
                );
                this.granularFallbackStartByConversation.set(conversationId, trimResult.trimStartIndex);
                // M5：保持会话级 Map 有界（会话删除后条目不残留无界增长）
                this.evictOldestIfOversized(this.granularFallbackStartByConversation);
            }

            contextManagementEvaluatedForTurn = true;
            const history = trimResult.history;

            // 获取静态系统提示词（可被 API provider 缓存）
            // 与流式路径（runToolLoop 顶部）的差异说明：流式在 isFirstMessage && iteration===1 时
            // 用 refreshAndGetPrompt 强制刷新一次（环境上下文新鲜度优先），后续迭代与非流式一致
            // 复用 getSystemPrompt 的缓存；非流式路径首轮不强制刷新，行为差异是有意设计。
            const dynamicSystemPrompt = this.promptManager.getSystemPrompt(promptModeSnapshot, false, runtimeContext);

            // 调用 AI（非流式）；透传 abortSignal：非流式模型生成阶段同样需要支持取消
            const response = await this.channelManager.generate({
                configId,
                history,
                abortSignal,
                dynamicSystemPrompt,
                promptContext,
                dynamicContextStrategy,
                modelOverride,
                promptModeSnapshot,
                conversationId
            });

            // 类型守卫：确保是 GenerateResponse
            if (!('content' in response)) {
                throw new Error('Unexpected stream response from generate()');
            }

            const generateResponse = response as GenerateResponse;
            let finalContent = generateResponse.content;

            // 转换 XML 工具调用为 functionCall 格式（如果有）
            this.toolCallParserService.convertPromptModeToolCallsToFunctionCalls(finalContent, config.toolMode || 'function_call');
            // 为没有 id 的 functionCall 添加唯一 id（Gemini 格式不返回 id）
            this.toolCallParserService.ensureFunctionCallIds(finalContent);

            // 确保 modelVersion 来自配置而非依赖 API 返回（第三方代理可能不返回 model 字段）
            const configuredModel = modelOverride || (config as any).model;
            if (!finalContent.modelVersion && configuredModel) {
                finalContent.modelVersion = configuredModel;
            }

            // 保存 AI 响应到历史
            if (finalContent.parts.length > 0) {
                const persistedContent = await this.conversationManager.addContent(conversationId, finalContent);
                if (persistedContent) {
                    finalContent = persistedContent;
                }
            }

            // 检查是否有工具调用
            const functionCalls = this.toolCallParserService.extractFunctionCalls(finalContent, config.toolMode || 'function_call');

            if (functionCalls.length === 0) {
                // 没有工具调用，结束循环并返回
                return {
                    content: finalContent,
                    exceededMaxIterations: false
                };
            }

            // 有工具调用，执行工具并添加结果
            // 获取当前消息索引（AI 响应刚刚添加到历史）
            const currentHistory = await this.conversationManager.getHistoryRef(conversationId);
            const messageIndex = currentHistory.length - 1;

            const executionResult = await this.toolExecutionService.executeFunctionCallsWithResults(
                repeatedCallGuard.guardCalls(functionCalls),
                conversationId,
                messageIndex,
                config,
                abortSignal,
                promptModeSnapshot,
                undefined,
                undefined,
                undefined,
                // A-COMM：主会话信箱按 conversationId + 主会话保留 runId 挂载
                conversationId,
                MAIN_SESSION_RUN_ID,
                // 主会话路径无嵌套深度（subagent 工具自行注入子代理深度）
                undefined,
                // 当前对话绑定的工作区 URI（用于工具执行的工作区限定/记忆路由）
                runtimeContext?.workspaceUri,
                // General Worker 模型继承：把主会话当前模型透传给工具上下文
                modelOverride
            );
            repeatedCallGuard.recordResults(executionResult.toolResults);

            const functionResponseParts = executionResult.multimodalAttachments
                ? [...executionResult.multimodalAttachments, ...executionResult.responseParts]
                : executionResult.responseParts;

            // 将函数响应添加到历史（作为 user 消息，标记为函数响应）。
            // abort 收尾窗口超时（工具不响应 abort 且永不结束）时 executeFunctionCallsWithResults
            // 返回空结果：无真实函数响应可写，跳过落盘，避免历史出现 parts:[] 的空 user 消息。
            if (functionResponseParts.length > 0) {
                await this.conversationManager.addContent(conversationId, {
                    role: 'user',
                    parts: functionResponseParts,
                    isFunctionResponse: true
                });
            }

            const postToolStopState = await resolveAndPersistPostToolStopState(
                this.conversationManager,
                conversationId,
                functionCalls,
                executionResult.toolResults,
                {
                    logger: this.log,
                    logContext: { iteration, executionPath: 'non_stream' }
                }
            );

            if (postToolStopState.shouldStop) {
                return {
                    content: finalContent,
                    exceededMaxIterations: false
                };
            }
            
            // 注：工具响应消息的 token 计数将在下一次循环的 getHistoryWithContextTrimInfo 中
            // 与系统提示词、动态上下文一起并行计算

            // 继续循环，让 AI 处理函数结果
        }

        // 达到最大迭代次数
        return {
            exceededMaxIterations: true
        };
    }

    /**
     * 创建模型消息前的检查点
     *
     * @param conversationId 对话 ID
     * @param iteration 当前迭代次数
     * @returns 检查点数据（用于 yield）或 null
     */
    private async createBeforeModelCheckpoint(
        conversationId: string,
        iteration: number
    ): Promise<ChatStreamCheckpointsData | null> {
        const checkpoint = await this.checkpointService.createModelMessageCheckpoint(
            conversationId,
            'before',
            iteration
        );
        if (!checkpoint) {
            return null;
        }

        return {
            conversationId,
            checkpoints: [checkpoint],
            checkpointOnly: true as const
        };
    }
}


/**
 * 按渠道的「发送历史思考内容」（sendHistoryThoughts）开关处理预设临时消息中的伪造思考。
 *
 * 预设 assistant 条目配置 fakeThought 后，PromptManager 会以 thought part 附加在消息正文前。
 * 伪造思考与真实历史思考语义完全一致：仅当渠道显式开启 sendHistoryThoughts 时回传；
 * 未配置（undefined）或显式关闭都剥离 thought part（正文照发），
 * 与 formatHistoryForAPI 对真实历史思考的 `sendHistoryThoughts ?? false` 默认保持一致——
 * 同一条消息不会因默认值分歧在不同路径下产出不同字节，破坏提示词前缀缓存。
 *
 * 该过滤必须在发送侧执行，不能写进 turnDynamicContext 缓存：
 * 同一回合缓存可能被不同渠道复用，开关是渠道级的。
 */
export function applyPromptContextThoughtPolicy(
    promptContext: RequestPromptContext,
    config: Pick<BaseChannelConfig, 'sendHistoryThoughts'>
): RequestPromptContext {
    if (config.sendHistoryThoughts === true) {
        return promptContext;
    }

    const stripThoughtParts = (messages: Content[]): Content[] =>
        messages.map(message => ({
            ...message,
            parts: message.parts.filter(part => part.thought !== true)
        }));

    return {
        ...promptContext,
        beforeHistoryMessages: stripThoughtParts(promptContext.beforeHistoryMessages),
        afterHistoryMessages: stripThoughtParts(promptContext.afterHistoryMessages)
    };
}