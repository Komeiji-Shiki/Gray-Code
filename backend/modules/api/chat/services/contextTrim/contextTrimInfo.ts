/**
 * 上下文裁剪主流程（getHistoryWithContextTrimInfo，从 ContextTrimService 抽离）。
 *
 * 获取用于 API 调用的历史，应用总结过滤和上下文阈值裁剪 / 自动总结触发判定。
 * 该函数是裁剪策略的编排入口：加载历史与运行时元数据、计数缺失 token、
 * 累加 token、按策略（off / summarize / trim）选择发送历史并产出裁剪决策。
 */

import type { Content } from '../../../../conversation/types';
import type { ConversationManager, GetHistoryOptions } from '../../../../conversation/ConversationManager';
import type { BaseChannelConfig } from '../../../../config/configs/base';
import type { PromptManager } from '../../../../prompt';
import type { DynamicContextStrategy, ResolvedPromptModeSnapshot } from '../../../../settings/types';
import type { Logger } from '../../../../../core/logger';
import type { ContextTrimInfo } from '../../utils';
import type { TokenEstimationService } from '../TokenEstimationService';
import type { MessageBuilderService } from '../MessageBuilderService';
import { isRealUserMessage } from '../../../../conversation/helpers';
import { getPromptContextCacheDynamicSnapshotText } from '../../../../prompt/promptContextCache';
import { resolveMaxContextTokensForConfig, resolveModelContextWindowForConfig } from './contextWindowResolution';
import { resolveContextManagementPolicy } from './policy';
import { findLastSummaryIndex, calculateContextThreshold } from './roundDetection';
import { createPreservedUserInputsMessage } from './preservedUserInputs';
import { normalizeTrimStartIndex } from './historyNormalization';
import { getNormalizedHistoryForStartIndex, countAndUpdateMessageTokens } from './historySelection';
import { accumulateContextTokens } from './tokenAccumulator';
import { performContextTrim } from './contextTrimPlanner';
import { getTrimState, saveTrimState, clearTrimState, CURRENT_TRIM_STATE_SCHEMA_VERSION } from './trimState';

const CONVERSATION_PINNED_FILES_KEY = 'inputPinnedFiles';
const CONVERSATION_SKILLS_KEY = 'inputSkills';

const AUTO_SUMMARY_USEFUL_HISTORY_RATIO = 0.01;
const MIN_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS = 256;
const MAX_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS = 8_192;

export interface ContextTrimEvaluationOptions {
    /**
     * 是否允许本次评估推进持久化裁剪点或触发新的自动总结。
     * 同一真实用户回合的后续工具迭代必须设为 false，只复用回合开始时已有的上下文起点。
     */
    allowStateAdvance?: boolean;
}

export interface ContextTrimInfoDeps {
    conversationManager: ConversationManager;
    promptManager: PromptManager;
    tokenEstimationService: TokenEstimationService;
    messageBuilderService: MessageBuilderService;
    log: Logger;
}

/**
 * 获取用于 API 调用的历史，应用总结过滤和上下文阈值裁剪
 *
 * 策略：
 * 1. 如果有总结消息，从最后一个总结消息开始获取历史
 * 2. 在此基础上，如果 token 数仍超过阈值，继续从总结后的回合中裁剪
 * 3. 使用每条消息的 tokenCountByChannel 来累加计算，避免上下文振荡
 * 4. 裁剪状态保存在内存中，避免重复触发裁剪
 * 5. 每次计算时检查是否可以恢复更多历史（思考 token 减少时）
 *
 * @param precomputedDynamicContextText 预生成的动态上下文文本（可选）。如果传入则直接使用，避免重复生成；如果不传则内部自动生成。
 */
export async function getHistoryWithContextTrimInfo(
    deps: ContextTrimInfoDeps,
    conversationId: string,
    config: BaseChannelConfig,
    historyOptions: GetHistoryOptions,
    precomputedDynamicContextText?: string,
    promptModeSnapshot?: ResolvedPromptModeSnapshot,
    modelOverride?: string,
    dynamicContextStrategy: DynamicContextStrategy = 'single',
    evaluationOptions: ContextTrimEvaluationOptions = {}
): Promise<ContextTrimInfo> {
    // 先获取完整的原始历史（含已被总结覆盖的 isSummarized 消息）
    const rawHistory = await deps.conversationManager.getHistoryRef(conversationId);

    // 如果历史为空，直接返回
    if (rawHistory.length === 0) {
        return { history: [], trimStartIndex: 0 };
    }

    // 逻辑截断：被总结覆盖的消息（isSummarized）不参与发送与统计，但原文完整保留在存储中
    // （可显示、可搜索）。过滤后的历史与「物理删除后」的历史语义完全等价，
    // 下游所有索引 / token / 回合计算无需感知标记消息，也不会因残留历史死循环触发总结。
    // 同时记录「过滤下标 → 原始存储下标」映射：计数回写 / 批量预计数按原始下标读写存储，
    // 快照内就地回填按过滤下标（见下方 missingTokenMessages 调用处），避免计数错位。
    const rawIndexByFilteredIndex: number[] = [];
    const fullHistory: Content[] = [];
    for (let i = 0; i < rawHistory.length; i++) {
        if (rawHistory[i].isSummarized) continue;
        rawIndexByFilteredIndex.push(i);
        fullHistory.push(rawHistory[i]);
    }

    const policy = resolveContextManagementPolicy(config);
    if (!policy.enabled) {
        // 总结（手动/自动）是用户显式要求建立的上下文边界，不应依赖自动上下文管理开关。
        // 总结采用逻辑截断语义：被覆盖消息打 isSummarized 标记保留在历史中（上面已过滤），
        // 发送时从最后一个总结消息开始，避免把总结边界之前的内容重新携带进请求
        // （否则等同于完全没有压缩）。
        const lastSummaryIndex = findLastSummaryIndex(fullHistory);
        if (lastSummaryIndex >= 0) {
            const normalizedHistory = await getNormalizedHistoryForStartIndex(
                deps.conversationManager,
                conversationId,
                fullHistory,
                historyOptions,
                lastSummaryIndex,
                lastSummaryIndex,
                dynamicContextStrategy
            );
            deps.log.info('manual_summary_boundary_applied', {
                conversationId,
                summaryStartIndex: lastSummaryIndex,
                fullHistoryLength: fullHistory.length,
                historyLength: normalizedHistory.history.length
            });
            return {
                history: normalizedHistory.history,
                trimStartIndex: normalizedHistory.trimStartIndex,
                contextManagementDecision: {
                    enabled: false,
                    mode: 'off',
                    source: policy.source,
                    action: 'manual_summary_applied'
                }
            };
        }

        // HIS-03/04：fullHistory 已在上面加载，直接复用，避免同一迭代内第二次 loadHistory
        const history = deps.conversationManager.getHistoryForAPIFrom(fullHistory, {
            ...historyOptions,
            startIndex: 0,
            includeTurnDynamicContext: dynamicContextStrategy === 'preserve'
        });
        deps.log.debug('trim.disabled', { conversationId, source: policy.source, fullHistoryLength: fullHistory.length });
        return {
            history,
            trimStartIndex: 0,
            contextManagementDecision: {
                enabled: false,
                mode: 'off',
                source: policy.source,
                action: 'disabled'
            }
        };
    }

    // 获取当前渠道类型（gemini, openai, anthropic, custom）
    const channelType = config.type || 'custom';

    // 查找最后一个总结消息
    const lastSummaryIndex = findLastSummaryIndex(fullHistory);

    // 基础起始索引（只考虑 summary）
    const summaryStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex : 0;

    // 从持久化存储获取裁剪状态
    let savedState = await getTrimState(deps.conversationManager, conversationId, deps.log);

    if (savedState) {
        // 检测回退：如果保存的 trimStartIndex 超出了当前历史长度，清除状态
        if (savedState.trimStartIndex >= fullHistory.length) {
            deps.log.warn('trim_state_cleared_invalid', {
                conversationId,
                savedTrimStartIndex: savedState.trimStartIndex,
                reason: 'out_of_bounds',
                fullHistoryLength: fullHistory.length
            });
            await clearTrimState(deps.conversationManager, conversationId);
            savedState = null;
        } else {
            const normalizedSavedState = normalizeTrimStartIndex(fullHistory, summaryStartIndex, savedState.trimStartIndex);
            if (!normalizedSavedState.valid) {
                deps.log.warn('trim_state_cleared_invalid', {
                    conversationId,
                    savedTrimStartIndex: savedState.trimStartIndex,
                    reason: normalizedSavedState.reason,
                    issueKind: normalizedSavedState.issueKind,
                    callId: normalizedSavedState.issueCallId
                });
                await clearTrimState(deps.conversationManager, conversationId);
                savedState = null;
            } else if (normalizedSavedState.startIndex !== savedState.trimStartIndex) {
                deps.log.info('trim_state_normalized', {
                    conversationId,
                    savedTrimStartIndex: savedState.trimStartIndex,
                    normalizedStartIndex: normalizedSavedState.startIndex,
                    cleared: normalizedSavedState.startIndex <= summaryStartIndex,
                    reason: normalizedSavedState.reason
                });
                if (normalizedSavedState.startIndex > summaryStartIndex) {
                    savedState = {
                        schemaVersion: CURRENT_TRIM_STATE_SCHEMA_VERSION,
                        trimStartIndex: normalizedSavedState.startIndex
                    };
                    await saveTrimState(deps.conversationManager, conversationId, savedState);
                } else {
                    await clearTrimState(deps.conversationManager, conversationId);
                    savedState = null;
                }
            }
        }
    }

    // 旧 trim 模式的回合内调用只能复用既有裁剪点，禁止大 functionResponse 临时推进持久状态。
    // summarize 模式不能在这里短路：长时间工具循环仍需每轮检查 token，并在接近上限时触发模型总结。
    if (evaluationOptions.allowStateAdvance === false && policy.mode === 'trim') {
        const turnStartIndex = savedState?.trimStartIndex ?? summaryStartIndex;
        const normalizedHistory = await getNormalizedHistoryForStartIndex(
            deps.conversationManager,
            conversationId,
            fullHistory,
            historyOptions,
            summaryStartIndex,
            turnStartIndex,
            dynamicContextStrategy
        );
        deps.log.debug('trim.turn_state_reused', {
            conversationId,
            requestedStartIndex: turnStartIndex,
            finalTrimStartIndex: normalizedHistory.trimStartIndex,
            fullHistoryLength: fullHistory.length
        });
        return {
            history: normalizedHistory.history,
            trimStartIndex: normalizedHistory.trimStartIndex,
            contextManagementDecision: {
                enabled: true,
                mode: policy.mode,
                source: policy.source,
                action: 'turn_state_reused'
            }
        };
    }

    // 加载 runtime 元数据以便正确生成系统提示词和动态上下文
    const [todoList, pinnedFiles, skills] = await Promise.all([
        deps.conversationManager.getCustomMetadata(conversationId, 'todoList').catch(() => undefined),
        deps.conversationManager.getCustomMetadata(conversationId, CONVERSATION_PINNED_FILES_KEY).catch(() => undefined),
        deps.conversationManager.getCustomMetadata(conversationId, CONVERSATION_SKILLS_KEY).catch(() => undefined)
    ]);

    const runtime = {
        todoList,
        pinnedFiles,
        skills
    };

    // 收集需要计算 token 的内容：系统提示词、动态上下文、缺失 token 数的用户消息
    // 传入 runtime 以便正确解析模板中的变量
    const systemPrompt = deps.promptManager.getSystemPrompt(promptModeSnapshot, false, runtime);

    // 使用预生成的 prompt context 文本（如果传入），否则内部生成；该文本包含 chat-history 前后两侧临时消息。
    let dynamicContextText: string;
    if (precomputedDynamicContextText !== undefined) {
        dynamicContextText = precomputedDynamicContextText;
    } else {
        dynamicContextText = deps.promptManager.getDynamicContextText(promptModeSnapshot, runtime);
    }

    // 查找缺失 token 数的用户消息
    const missingTokenMessages: Array<{ index: number; message: Content }> = [];
    for (let i = 0; i < fullHistory.length; i++) {
        const message = fullHistory[i];
        if (message.role === 'user' && message.tokenCountByChannel?.[channelType] === undefined) {
            missingTokenMessages.push({ index: i, message });
        }
    }

    // 并行计算所有需要的 token 数
    const textsToCount = [systemPrompt, dynamicContextText];

    // 并行执行文本计数和消息计数。
    // C-16：missingTokenMessages 的 index 是过滤 isSummarized 后的下标，而
    // countAndUpdateMessageTokens / preCountUserMessageTokensBatch 按原始存储下标读写，
    // 必须先经 rawIndexByFilteredIndex 映射为原始下标，否则会更新/读取到错误消息（计数错位）。
    const [textTokenResults, messageTokenResults] = await Promise.all([
        deps.tokenEstimationService.countTextTokensBatch(textsToCount, channelType),
        missingTokenMessages.length > 0
            ? countAndUpdateMessageTokens(
                deps.conversationManager,
                deps.tokenEstimationService,
                conversationId,
                channelType,
                missingTokenMessages.map(m => ({ ...m, index: rawIndexByFilteredIndex[m.index] }))
            )
            : Promise.resolve([] as number[])
    ]);

    const [systemPromptTokens, dynamicContextTokens] = textTokenResults;

    // 把精确计数结果回填到 fullHistory 快照，使 accumulateTokens 读到精确值而非粗估。
    // 计数结果已通过 preCountUserMessageTokensBatch 写回存储（下一轮生效），
    // 但本轮 accumulateTokens 读的是计数前的 fullHistory，需要就地修正。
    // 返回数组与 missingTokenMessages 等长（跳过条目为 undefined 占位），逐条对齐
    // 不会错位；undefined 条目保持粗估，下一轮裁剪时重新计数。
    if (messageTokenResults.length > 0) {
        for (let i = 0; i < missingTokenMessages.length; i++) {
            const { index } = missingTokenMessages[i];
            const count = messageTokenResults[i];
            if (count !== undefined && fullHistory[index]) {
                const existing = fullHistory[index].tokenCountByChannel;
                fullHistory[index].tokenCountByChannel = {
                    ...existing,
                    [channelType]: count
                };
            }
        }
    }

    // 系统提示词、动态上下文，以及最后总结之前按原文保留的真实用户输入。
    // 用户输入档案会实际注入请求，必须纳入阈值预算，不能因“通常较小”而漏算。
    const preservedUserInputsForBudget = createPreservedUserInputsMessage(fullHistory, summaryStartIndex);
    const preservedUserInputTokens = preservedUserInputsForBudget
        ? deps.tokenEstimationService.estimateMessageTokens(preservedUserInputsForBudget)
        : 0;
    const promptTokens = systemPromptTokens + dynamicContextTokens + preservedUserInputTokens;

    // 从 historyOptions 获取用户配置
    const sendHistoryThoughts = historyOptions.sendHistoryThoughts ?? false;
    const sendHistoryThoughtSignatures = historyOptions.sendHistoryThoughtSignatures ?? false;
    const sendCurrentThoughts = historyOptions.sendCurrentThoughts ?? true;
    const sendCurrentThoughtSignatures = historyOptions.sendCurrentThoughtSignatures ?? false;
    const historyThinkingRounds = historyOptions.historyThinkingRounds ?? -1;

    // 找到最后一个非函数响应的 user 消息索引（当前轮次的起点）
    let lastNonFunctionResponseUserIndex = -1;
    for (let i = fullHistory.length - 1; i >= 0; i--) {
        const message = fullHistory[i];
        if (isRealUserMessage(message)) {
            lastNonFunctionResponseUserIndex = i;
            break;
        }
    }

    const preservedDynamicContextTokenByIndex = new Map<number, number>();
    if (dynamicContextStrategy === 'preserve') {
        const preservedDynamicContextEntries = fullHistory
            .map((message, index) => ({
                index,
                text: getPromptContextCacheDynamicSnapshotText(message.turnDynamicContext),
                message
            }))
            .filter(({ index, text, message }) =>
                index !== lastNonFunctionResponseUserIndex &&
                message.role === 'user' &&
                message.isUserInput &&
                !!text?.trim()
            );
        const preservedDynamicContextTexts = preservedDynamicContextEntries.map(entry => entry.text!);
        const preservedDynamicContextTokens = await deps.tokenEstimationService.countTextTokensBatch(preservedDynamicContextTexts, channelType);
        preservedDynamicContextEntries.forEach((entry, index) => {
            preservedDynamicContextTokenByIndex.set(entry.index, preservedDynamicContextTokens[index] ?? 0);
        });
    }

    // 识别所有回合起始位置
    const roundStartIndices: number[] = [];
    for (let i = 0; i < fullHistory.length; i++) {
        const message = fullHistory[i];
        if (isRealUserMessage(message)) {
            roundStartIndices.push(i);
        }
    }

    // 计算历史思考回合的有效范围（与 getHistoryForAPI 保持一致）
    let historyThoughtMinIndex = 0;
    let historyThoughtMaxIndex = lastNonFunctionResponseUserIndex;

    if (historyThinkingRounds === 0) {
        historyThoughtMinIndex = fullHistory.length;
        historyThoughtMaxIndex = -1;
    } else if (historyThinkingRounds > 0) {
        const totalRounds = roundStartIndices.length;
        if (totalRounds > 1) {
            const roundsToSkip = Math.max(0, totalRounds - 1 - historyThinkingRounds);
            if (roundsToSkip > 0 && roundsToSkip < totalRounds) {
                historyThoughtMinIndex = roundStartIndices[roundsToSkip];
            }
        }
    }

    // 获取最大上下文和阈值
    const maxContextResolution = resolveMaxContextTokensForConfig(config, modelOverride);
    const maxContextTokens = maxContextResolution.maxContextTokens;
    const thresholdConfig = config.contextThreshold ?? '80%';
    const threshold = calculateContextThreshold(thresholdConfig, maxContextTokens);

    deps.log.debug('trim.threshold_resolved', {
        conversationId,
        channelType,
        threshold,
        thresholdConfig,
        maxContextTokens,
        maxContextSource: maxContextResolution.source,
        configMaxContextTokens: maxContextResolution.configMaxContextTokens,
        modelId: maxContextResolution.modelId,
        modelContextWindow: maxContextResolution.modelContextWindow,
        contextManagementEnabled: policy.enabled,
        contextManagementMode: policy.mode,
        contextManagementSource: policy.source,
        contextTrimExtraCut: config.contextTrimExtraCut ?? 0,
        summaryStartIndex,
        savedTrimStartIndex: savedState?.trimStartIndex ?? null,
        fullHistoryLength: fullHistory.length
    });

    deps.log.debug('trim.token_breakdown', {
        conversationId,
        systemPromptTokens,
        dynamicContextTokens,
        preservedUserInputTokens,
        promptTokens,
        missingTokenMessages: missingTokenMessages.length,
        historyThinkingRounds,
        sendHistoryThoughts,
        sendHistoryThoughtSignatures,
        sendCurrentThoughts,
        sendCurrentThoughtSignatures,
        historyThoughtMinIndex,
        historyThoughtMaxIndex
    });

    const accumulateDeps = {
        tokenEstimationService: deps.tokenEstimationService,
        messageBuilderService: deps.messageBuilderService
    };

    // ========== 自动总结模式 ==========
    // 自动总结模式下不做裁剪，而是返回「最后一个总结消息及其之后」的历史 + needsAutoSummarize
    // 标记，由 ToolIterationLoopService 在发送请求前触发总结。逻辑截断语义下被总结消息已在上方
    // 过滤（isSummarized 不参与统计），token 估算口径与模型视角一致，不会每轮反复触发。
    if (policy.mode === 'summarize') {
        // 首条用户消息永远发送（任务锚点）：getNormalizedHistoryForStartIndex 返回前统一调用
        // prependFirstUserMessage 原样前置（与 Preserved user inputs 档案并存，轻微冗余换取原话完整），
        // 这里不再手动拼接，避免重复。
        const normalizedHistory = await getNormalizedHistoryForStartIndex(
            deps.conversationManager,
            conversationId,
            fullHistory,
            historyOptions,
            summaryStartIndex,
            summaryStartIndex,
            dynamicContextStrategy
        );
        const summarizeHistory = normalizedHistory.history;

        // 估算当前 token 总量来判断是否需要总结
        const fullTokenResult = accumulateContextTokens(accumulateDeps, {
            fullHistory,
            effectiveStartIndex: summaryStartIndex,
            lastNonFunctionResponseUserIndex,
            historyThoughtMinIndex,
            historyThoughtMaxIndex,
            sendHistoryThoughts,
            sendHistoryThoughtSignatures,
            sendCurrentThoughts,
            sendCurrentThoughtSignatures,
            channelType,
            promptTokens,
            preservedDynamicContextTokenByIndex,
            // 与 UI usedTokens 显示口径对齐：以最后一条真实 usage 为锚点，避免本地估算脱节
            useUsageAnchor: true
        });

        // 直接复用现有 token 估算系统：
        // - 用户消息优先使用 estimatedTokenCount（由 TokenCount API 或本地估算预写入）
        // - 模型消息使用 usageMetadata（candidates/thoughts）或回退估算
        // 不再额外维护 totalTokenCount/安全系数等并行判定逻辑。
        const exceedsSoftThreshold = fullTokenResult.estimatedTotalTokens > threshold;
        const hardInputTokenLimit = resolveModelContextWindowForConfig(config, modelOverride)?.maxContextTokens;
        const compressibleHistoryTokens = Math.max(0, fullTokenResult.estimatedTotalTokens - promptTokens);
        const minimumUsefulHistoryTokens = Math.max(
            MIN_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS,
            Math.min(
                MAX_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS,
                Math.floor(maxContextTokens * AUTO_SUMMARY_USEFUL_HISTORY_RATIO)
            )
        );
        // 固定 prompt 自身已经越过总结软阈值时，总结无法把总量压回阈值以下。若此时只有很少的
        // 新历史可压缩，反复总结只会每轮省几百到一两千 token；跳过这次低收益总结并继续主请求。
        const lowSavingsBecauseFixedPromptExceedsThreshold =
            exceedsSoftThreshold &&
            promptTokens >= threshold &&
            compressibleHistoryTokens < minimumUsefulHistoryTokens;
        const needsAutoSummarize = exceedsSoftThreshold && !lowSavingsBecauseFixedPromptExceedsThreshold;
        // 跳过低收益总结不等于忽略真正的模型窗口。只有已经逼近硬窗口时才直接进入请求级 fallback；
        // 位于软阈值与硬窗口之间时原样继续，避免把总结阈值升级成 Agent 请求禁令。
        const needsContextFallback =
            !needsAutoSummarize &&
            hardInputTokenLimit !== undefined &&
            fullTokenResult.estimatedTotalTokens > hardInputTokenLimit;

        deps.log.debug('trim.auto_summarize_check', {
            conversationId,
            estimatedTotalTokens: fullTokenResult.estimatedTotalTokens,
            threshold,
            hardInputTokenLimit,
            promptTokens,
            compressibleHistoryTokens,
            minimumUsefulHistoryTokens,
            lowSavingsBecauseFixedPromptExceedsThreshold,
            needsAutoSummarize,
            needsContextFallback
        });

        if (needsAutoSummarize) {
            deps.log.info('auto_summarize_needed', { conversationId, estimatedTotalTokens: fullTokenResult.estimatedTotalTokens, threshold });
        }

        return {
            history: summarizeHistory,
            trimStartIndex: normalizedHistory.trimStartIndex,
            needsAutoSummarize,
            needsContextFallback,
            // 口径说明：fixedPromptTokens 只含系统提示词 + 动态上下文（不会随裁剪变化、且不在 history 中），
            // 不含 preservedUserInputTokens——被裁剪区域的逐字用户输入档案由 fallback 的 prependPreservedUserInputs
            // 在裁剪后的 history 内重新计算，若在此扣除会造成重复预算；而 accumulateTokens 的 promptTokens
            // （用于软阈值/硬窗口判定）是另一口径，包含该档案。
            fixedPromptTokens: systemPromptTokens + dynamicContextTokens,
            contextManagementDecision: {
                enabled: true,
                mode: 'summarize',
                source: policy.source,
                action: needsAutoSummarize
                    ? 'auto_summarize_needed'
                    : (needsContextFallback
                        ? 'hard_fallback_needed'
                        : (lowSavingsBecauseFixedPromptExceedsThreshold
                            ? 'auto_summarize_skipped_low_savings'
                            : 'not_needed'))
            }
        };
    }

    // ========== 上下文裁剪模式（原有逻辑） ==========

    // 检查是否可以恢复更多历史
    // 首先计算从 summaryStartIndex 开始的完整 token 数
    const fullTokenResult = accumulateContextTokens(accumulateDeps, {
        fullHistory,
        effectiveStartIndex: summaryStartIndex,
        lastNonFunctionResponseUserIndex,
        historyThoughtMinIndex,
        historyThoughtMaxIndex,
        sendHistoryThoughts,
        sendHistoryThoughtSignatures,
        sendCurrentThoughts,
        sendCurrentThoughtSignatures,
        channelType,
        promptTokens,
        preservedDynamicContextTokenByIndex
    });

    deps.log.debug('trim.full_history_estimate', {
        conversationId,
        estimatedTotalTokens: fullTokenResult.estimatedTotalTokens,
        threshold,
        roundCount: fullTokenResult.roundTokenInfos.length,
        summaryStartIndex,
        usageStats: fullTokenResult.usageStats
    });

    // 如果完整历史不超过阈值，清除裁剪状态，返回完整历史
    if (fullTokenResult.estimatedTotalTokens <= threshold) {
        await clearTrimState(deps.conversationManager, conversationId);
        const normalizedHistory = await getNormalizedHistoryForStartIndex(
            deps.conversationManager,
            conversationId,
            fullHistory,
            historyOptions,
            summaryStartIndex,
            summaryStartIndex,
            dynamicContextStrategy
        );
        deps.log.debug('trim.not_needed', {
            conversationId,
            estimatedTotalTokens: fullTokenResult.estimatedTotalTokens,
            threshold
        });
        return {
            history: normalizedHistory.history,
            trimStartIndex: normalizedHistory.trimStartIndex,
            contextManagementDecision: {
                enabled: true,
                mode: 'trim',
                source: policy.source,
                action: 'not_needed'
            }
        };
    }

    const plannerDeps = {
        conversationManager: deps.conversationManager,
        log: deps.log
    };

    // 完整历史超过阈值，需要裁剪
    // 如果有保存的裁剪状态，检查使用该状态后是否仍超过阈值
    if (savedState && savedState.trimStartIndex > summaryStartIndex) {
        const trimmedTokenResult = accumulateContextTokens(accumulateDeps, {
            fullHistory,
            effectiveStartIndex: savedState.trimStartIndex,
            lastNonFunctionResponseUserIndex,
            historyThoughtMinIndex,
            historyThoughtMaxIndex,
            sendHistoryThoughts,
            sendHistoryThoughtSignatures,
            sendCurrentThoughts,
            sendCurrentThoughtSignatures,
            channelType,
            promptTokens,
            preservedDynamicContextTokenByIndex
        });

        deps.log.debug('trim.saved_state_estimate', {
            conversationId,
            savedTrimStartIndex: savedState.trimStartIndex,
            estimatedTotalTokens: trimmedTokenResult.estimatedTotalTokens,
            threshold,
            roundCount: trimmedTokenResult.roundTokenInfos.length,
            usageStats: trimmedTokenResult.usageStats
        });

        // 如果使用保存的状态后不超过阈值，直接使用
        if (trimmedTokenResult.estimatedTotalTokens <= threshold) {
            const normalizedHistory = await getNormalizedHistoryForStartIndex(
                deps.conversationManager,
                conversationId,
                fullHistory,
                historyOptions,
                summaryStartIndex,
                savedState.trimStartIndex,
                dynamicContextStrategy
            );

            deps.log.debug('trim.saved_state_reused', {
                conversationId,
                finalTrimStartIndex: normalizedHistory.trimStartIndex
            });

            return {
                history: normalizedHistory.history,
                trimStartIndex: normalizedHistory.trimStartIndex,
                contextManagementDecision: {
                    enabled: true,
                    mode: 'trim',
                    source: policy.source,
                    action: 'saved_state_reused'
                }
            };
        }

        // 使用保存的状态后仍然超过阈值，需要进一步裁剪
        // 使用 trimmedTokenResult 的回合信息进行裁剪
        return await performContextTrim(
            plannerDeps,
            conversationId,
            fullHistory,
            config,
            historyOptions,
            savedState.trimStartIndex,
            trimmedTokenResult.estimatedTotalTokens,
            promptTokens,
            trimmedTokenResult.roundTokenInfos,
            threshold,
            maxContextTokens,
            dynamicContextStrategy
        );
    }

    // 没有保存的状态，或者状态无效，从 summaryStartIndex 开始裁剪
    return await performContextTrim(
        plannerDeps,
        conversationId,
        fullHistory,
        config,
        historyOptions,
        summaryStartIndex,
        fullTokenResult.estimatedTotalTokens,
        promptTokens,
        fullTokenResult.roundTokenInfos,
        threshold,
        maxContextTokens,
        dynamicContextStrategy
    );
}
