/**
 * 请求级细粒度上下文裁剪（fallback，从 ContextTrimService 抽离）。
 *
 * 自动总结不可用或失败时的兜底：按消息 token 预算选择安全切点，允许在长工具回合
 * 内部从 model 边界开始，并用临时 user 标记保证 provider 的角色顺序合法。
 * 该路径不写 trimState，不永久遮蔽 transcript。
 */

import type { Content } from '../../../../conversation/types';
import type { ConversationManager, GetHistoryOptions } from '../../../../conversation/ConversationManager';
import type { BaseChannelConfig } from '../../../../config/configs/base';
import type { DynamicContextStrategy } from '../../../../settings/types';
import type { Logger } from '../../../../../core/logger';
import type { ContextTrimInfo } from '../../utils';
import type { TokenEstimationService } from '../TokenEstimationService';
import { isRealUserMessage } from '../../../../conversation/helpers';
import { validateHistoryIntegrity } from '../../../../channel/HistoryIntegrityValidator';
import { planSummarizeMessages } from '../summarizeRangePlanner';
import {
    resolveMaxContextTokensForConfig,
    resolveModelContextWindowForConfig
} from './contextWindowResolution';
import { resolveContextManagementPolicy } from './policy';
import { findLastSummaryIndex, calculateContextThreshold } from './roundDetection';
import {
    prependPreservedUserInputs,
    buildPreservedUserInputEntry,
    applyPreservedInputTextBudget,
    PRESERVED_USER_INPUTS_HEADER
} from './preservedUserInputs';
import { prependFirstUserMessage, normalizeFallbackHistoryStart } from './historyAssembly';
import { computeValidSuffixMap } from './historyNormalization';

const FALLBACK_PROVIDER_RESERVE_RATIO = 0.1;

/**
 * fallback 已无法构造不超过主模型输入预算的合法历史。
 *
 * 注意：message 仅作开发/日志兜底（英文），对外展示的消息由上层（ChatHandler.formatError）
 * 按 code = CONTEXT_OVERFLOW 走 i18n，并携带 estimatedInputTokens / inputTokenLimit 两个参数。
 */
export class ContextBudgetExceededError extends Error {
    readonly code = 'CONTEXT_OVERFLOW';

    constructor(
        readonly estimatedInputTokens: number,
        readonly inputTokenLimit: number
    ) {
        super(
            `Unable to build a legal request within the context window: the smallest candidate uses about ${estimatedInputTokens} input tokens, above the ${inputTokenLimit}-token window`
        );
        this.name = 'ContextBudgetExceededError';
    }
}

export interface GranularFallbackDeps {
    conversationManager: ConversationManager;
    tokenEstimationService: TokenEstimationService;
    log: Logger;
}

/**
 * 自动总结不可用或失败时的请求级细粒度裁剪。
 *
 * 该路径不写 trimState，不永久遮蔽 transcript；它按消息 token 预算选择安全切点，允许在长工具回合
 * 内部从 model 边界开始，并用临时 user 标记保证 provider 的角色顺序合法。
 *
 * @param stableStartIndex 同一真实用户回合内已确定的切点（绝对索引）。工具结果增长时复用该起点，
 * 保持每轮请求 retainedHistory 前缀一致，让 provider 前缀缓存可以命中；仅当完整性校验失败或
 * 估算总输入超过安全上限时才重新规划切点。新回合/总结成功后传 undefined。
 * @param fixedPromptTokens 系统提示词和本轮 prompt context 的 token 数；这些内容不在 history 中，
 * 但会随请求一起发送，因此必须从总输入预算中扣除。
 */
export async function getHistoryWithGranularFallback(
    deps: GranularFallbackDeps,
    conversationId: string,
    config: BaseChannelConfig,
    historyOptions: GetHistoryOptions,
    modelOverride?: string,
    dynamicContextStrategy: DynamicContextStrategy = 'single',
    stableStartIndex?: number,
    fixedPromptTokens = 0
): Promise<ContextTrimInfo> {
    const rawHistory = await deps.conversationManager.getHistoryRef(conversationId);
    if (rawHistory.length === 0) return { history: [], trimStartIndex: 0 };

    // 逻辑截断：被总结消息（isSummarized）不参与发送与统计（与 getHistoryWithContextTrimInfo 一致）
    const fullHistory = rawHistory.filter(message => !message.isSummarized);
    // 防御：全部消息均为 isSummarized（异常历史）时按空历史处理，避免后续候选评估越界
    if (fullHistory.length === 0) return { history: [], trimStartIndex: 0 };

    const lastSummaryIndex = findLastSummaryIndex(fullHistory);
    const historyStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex : 0;
    const messages = fullHistory.slice(historyStartIndex);
    const channelType = config.type || 'custom';
    const contextResolution = resolveMaxContextTokensForConfig(config, modelOverride);
    // fallback 的输入预算同样必须扣除组合窗口中的最大输出预留。
    const maxContextTokens = contextResolution.maxInputTokens;
    const actualModelWindow = resolveModelContextWindowForConfig(config, modelOverride)?.maxInputTokens;
    const threshold = calculateContextThreshold(config.contextThreshold ?? '80%', maxContextTokens);
    // contextThreshold 只是触发自动总结和“优先压缩到此处”的软阈值，绝不能当成主 Agent 的硬上限。
    // 95% 只作为优先裁剪目标，给 provider 包装/输出留出余量；真正拒绝请求的边界仍是完整模型窗口。
    const preferredInputTokenLimit = Math.max(
        1,
        Math.floor((actualModelWindow ?? maxContextTokens) * 0.95)
    );
    // 只有模型条目明确声明 contextWindow 时才把其输入预算作为硬拒绝边界。渠道
    // maxContextTokens 是上下文管理基准；模型元数据缺失时最多做 best-effort 裁剪，
    // 绝不据此阻止主请求。组合窗口的输出预留已在上方 resolution 中扣除。
    const hardInputTokenLimit = actualModelWindow;
    const fallbackEnvelopeInputTokenLimit = actualModelWindow ?? maxContextTokens;
    const softInputTokenLimit = Math.max(1, Math.min(threshold, preferredInputTokenLimit));
    const providerReserveTokens = Math.max(1, Math.floor(softInputTokenLimit * FALLBACK_PROVIDER_RESERVE_RATIO));
    const normalizedFixedPromptTokens = Number.isFinite(fixedPromptTokens)
        ? Math.max(0, Math.floor(fixedPromptTokens))
        : 0;
    const softHistoryBudgetTokens = Math.max(
        0,
        softInputTokenLimit - normalizedFixedPromptTokens - providerReserveTokens
    );
    const fallbackEnvelopeHistoryBudgetTokens = Math.max(
        0,
        fallbackEnvelopeInputTokenLimit - normalizedFixedPromptTokens
    );

    const estimateFinalHistoryTokens = (history: Content[]): number => history.reduce(
        (total, message) => total + deps.tokenEstimationService.estimateMessageTokens(message),
        0
    );

    const throwContextOverflow = (minimumLegalHistoryTokens = 0): never => {
        if (hardInputTokenLimit === undefined) {
            throw new Error('Context overflow rejection requires a known model context window');
        }
        const estimatedMinimumInputTokens = normalizedFixedPromptTokens + minimumLegalHistoryTokens;
        deps.log.error('trim.fallback_context_overflow', {
            conversationId,
            maxContextTokens,
            threshold,
            softInputTokenLimit,
            preferredInputTokenLimit,
            hardInputTokenLimit,
            fallbackEnvelopeInputTokenLimit,
            fixedPromptTokens: normalizedFixedPromptTokens,
            providerReserveTokens,
            softHistoryBudgetTokens,
            fallbackEnvelopeHistoryBudgetTokens,
            minimumLegalHistoryTokens,
            estimatedMinimumInputTokens,
            originalHistoryLength: fullHistory.length
        });
        throw new ContextBudgetExceededError(estimatedMinimumInputTokens, hardInputTokenLimit);
    };

    // 回合内稳定起点优先：工具结果增长不再把切点往后推（否则每轮 retainedHistory 开头漂移，
    // provider 前缀缓存只能命中 history 之前的固定系统/工具段）。稳定起点允许超过总结软阈值，
    // 只要完整请求仍装得进模型硬窗口；总结阈值不能让正在运行的 Agent 提前中止。
    if (typeof stableStartIndex === 'number' && stableStartIndex >= historyStartIndex && stableStartIndex < fullHistory.length) {
        const suffix = deps.conversationManager.getHistoryForAPIFrom(fullHistory, {
            ...historyOptions,
            startIndex: stableStartIndex,
            includeTurnDynamicContext: dynamicContextStrategy === 'preserve'
        });
        if (validateHistoryIntegrity(suffix, { detectOrphanFunctionCall: true }).valid) {
            const historyWithUserInputs = prependPreservedUserInputs(
                suffix,
                fullHistory,
                stableStartIndex
            );
            // 首条用户消息永远发送（任务锚点）
            const history = normalizeFallbackHistoryStart(
                prependFirstUserMessage(fullHistory, historyWithUserInputs, stableStartIndex)
            );
            const estimatedStableTokens = estimateFinalHistoryTokens(history);
            if (estimatedStableTokens <= fallbackEnvelopeHistoryBudgetTokens) {
                deps.log.warn('trim.fallback_stable_start_reused', {
                    conversationId,
                    stableStartIndex,
                    estimatedStableTokens,
                    fixedPromptTokens: normalizedFixedPromptTokens,
                    providerReserveTokens,
                    softInputTokenLimit,
                    preferredInputTokenLimit,
                    hardInputTokenLimit,
                    fallbackEnvelopeInputTokenLimit,
                    softHistoryBudgetTokens,
                    fallbackEnvelopeHistoryBudgetTokens,
                    originalHistoryLength: fullHistory.length,
                    fallbackHistoryLength: history.length
                });
                return {
                    history,
                    trimStartIndex: stableStartIndex,
                    contextManagementDecision: {
                        enabled: true,
                        mode: 'summarize',
                        source: resolveContextManagementPolicy(config).source,
                        action: 'fallback_stable_start_reused'
                    }
                };
            }
        }
    }

    // —— O(n) 预计算：候选切点评估降为 O(1)/个，替代原「每候选全量格式化 + 校验 + 估算」的 O(n²) ——

    type GranularFallbackCandidate = {
        relativeStartIndex: number;
        absoluteStartIndex: number;
        history: Content[];
        estimatedTokens: number;
    };

    // 1) 逐条消息 token（口径与 planSummarizeMessages 一致：优先渠道精确值，缺失才本地估算）
    const tokenForMessage = (message: Content): number => {
        const byChannel = message.tokenCountByChannel?.[channelType];
        if (typeof byChannel === 'number') return byChannel;
        if (typeof message.estimatedTokenCount === 'number') return message.estimatedTokenCount;
        return deps.tokenEstimationService.estimateMessageTokens(message);
    };
    const fullHistoryTokens = fullHistory.map(tokenForMessage);
    // 2) 候选最终历史的增量估算必须与 buildExactCandidate 的 estimateFinalHistoryTokens 同口径
    //    （一律走注入的 tokenEstimationService.estimateMessageTokens）：后缀、首条锚点、档案消息
    //    都不能用硬编码公式或渠道 token 直接替代，否则预筛与精确复核口径漂移，会把本应通过预算
    //    的候选误判为超限（过度裁剪、甚至误报 CONTEXT_OVERFLOW）。渠道精确值仍仅用于上方 planner。
    const estimatedMessageTokens = fullHistory.map(message =>
        deps.tokenEstimationService.estimateMessageTokens(message)
    );
    // 后缀 token 累计和：estimatedSuffixTokensFrom[i] = Σ estimatedMessageTokens[i..]，候选 O(1) 取值
    const estimatedSuffixTokensFrom = new Array<number>(fullHistory.length + 1);
    estimatedSuffixTokensFrom[fullHistory.length] = 0;
    for (let i = fullHistory.length - 1; i >= 0; i--) {
        estimatedSuffixTokensFrom[i] = estimatedSuffixTokensFrom[i + 1] + estimatedMessageTokens[i];
    }
    const messageTokens = fullHistoryTokens.slice(historyStartIndex);

    const plan = planSummarizeMessages({
        messages,
        messageTokens,
        keepBudgetTokens: Math.max(1, softHistoryBudgetTokens),
        minKeepRounds: 1,
        mode: 'auto'
    });

    // planner 返回 null 既可能代表完整历史已经在预算内，也可能代表单个巨大回合无法按轮规划。
    // 两种情况都从最早合法起点开始逐个验证，绝不能因此直接返回未经预算检查的完整历史。
    const firstCandidateIndex = plan?.cutIndex ?? 0;
    const candidateIndices: number[] = [firstCandidateIndex];
    for (let i = firstCandidateIndex + 1; i < messages.length; i++) {
        if (messages[i]?.role === 'model' || isRealUserMessage(messages[i])) candidateIndices.push(i);
    }

    // 3) 切点有效性：与 normalizeTrimStartIndex 同款 O(n) 后缀有效性预计算（重复 call/response
    //    id、孤儿 response）。注意：原实现对「格式化后」切片做校验（formatter 会剔除孤儿
    //    call/response），本预计算基于原始切片更严格——异常历史下候选会被跳过而选择更深切点，
    //    但最终选中的候选仍经 buildExactCandidate 精确复核，绝不会返回未通过完整性校验的历史。
    const validSuffix = computeValidSuffixMap(fullHistory);

    // 4) 首条真实用户消息锚点（prependFirstUserMessage：任务锚点永远前置）；
    //    token 用注入估算器口径（与 estimateFinalHistoryTokens 一致，见上方 2) 注释）
    const firstUserIndex = fullHistory.findIndex(message => isRealUserMessage(message));

    // 5) 保留用户输入档案（prependPreservedUserInputs）：条目文本按真实用户消息顺序一次性
    //    生成（与 createPreservedUserInputsMessage 同构），累计文本长度按非空条目计数索引，
    //    候选按前缀计数 O(1) 取长度，避免每候选重扫 fullHistory[0..beforeIndex)。
    const preservedFullTextLen: number[] = [0];  // 前 k 条非空条目的档案文本总长（含 header 与分隔符）
    const preservedEntryCountBefore = new Array<number>(fullHistory.length + 1);  // 下标 i 之前的非空条目数
    preservedEntryCountBefore[0] = 0;
    let preservedUserCount = 0;   // 全部真实用户消息计数（条目编号用，空条目也占号）
    let preservedEntryCount = 0;  // 非空条目计数
    let preservedTextLen = 0;
    const preservedEntries: string[] = [];  // 按顺序收集非空条目（预计算档案消息 token 用）
    for (let i = 0; i < fullHistory.length; i++) {
        preservedEntryCountBefore[i + 1] = preservedEntryCount;
        if (!isRealUserMessage(fullHistory[i])) continue;
        const entry = buildPreservedUserInputEntry(fullHistory[i], preservedUserCount);
        preservedUserCount++;
        if (!entry) continue;
        preservedEntries.push(entry);
        preservedTextLen += preservedEntryCount === 0
            ? PRESERVED_USER_INPUTS_HEADER.length + 2 + entry.length
            : 2 + entry.length;
        preservedEntryCount++;
        preservedFullTextLen.push(preservedTextLen);
    }
    // 档案消息 token：对每个条目数 k 构造与 createPreservedUserInputsMessage 完全相同的文本
    // （全量档案文本的前缀 + 同一截断规则），用注入估算器取值（与精确路径同口径）。
    const preservedArchiveText = [PRESERVED_USER_INPUTS_HEADER, ...preservedEntries].join('\n\n');
    const preservedMessageTokensByCount: number[] = [0];
    for (let k = 1; k <= preservedEntryCount; k++) {
        const preservedText = applyPreservedInputTextBudget(
            preservedArchiveText.slice(0, preservedFullTextLen[k])
        );
        preservedMessageTokensByCount.push(
            deps.tokenEstimationService.estimateMessageTokens({
                role: 'user',
                parts: [{ text: preservedText }],
                isSummary: true
            })
        );
    }
    // normalizeFallbackHistoryStart 临时占位消息的 token（固定文本，一次计算）
    const fallbackStartPlaceholderTokens = deps.tokenEstimationService.estimateMessageTokens({
        role: 'user' as const,
        parts: [{ text: '[Earlier context was temporarily omitted after summarization failed.]' }],
        isSummary: true
    });

    // 增量估算候选切点的最终历史 token 数（O(1)）：后缀累计 + 首条用户锚点 + 保留用户输入
    // 档案 + model 开头时的临时占位。与旧实现「格式化后精确估算」的差异主要为被 formatter
    // 过滤的思考内容（本地估算偏大、更保守），最终选中候选仍走 buildExactCandidate 精确复核。
    const estimateCandidateTokens = (absoluteStartIndex: number): number => {
        let tokens = estimatedSuffixTokensFrom[absoluteStartIndex];
        const preservedCount = preservedEntryCountBefore[absoluteStartIndex];
        const hasUserPrefix = preservedCount > 0
            || (firstUserIndex >= 0 && firstUserIndex < absoluteStartIndex);
        if (firstUserIndex >= 0 && firstUserIndex < absoluteStartIndex) {
            tokens += estimatedMessageTokens[firstUserIndex];
        }
        if (preservedCount > 0) {
            tokens += preservedMessageTokensByCount[preservedCount];
        }
        // normalizeFallbackHistoryStart：无任何 user 前置且切片以 model 开头时补临时占位
        if (!hasUserPrefix && fullHistory[absoluteStartIndex]?.role === 'model') {
            tokens += fallbackStartPlaceholderTokens;
        }
        return tokens;
    };

    // 精确评估单个候选（仅对通过增量预筛的候选执行一次：格式化 + 完整性校验 + 精确 token）
    const buildExactCandidate = (relativeStartIndex: number): GranularFallbackCandidate | undefined => {
        const absoluteStartIndex = historyStartIndex + relativeStartIndex;
        const suffix = deps.conversationManager.getHistoryForAPIFrom(fullHistory, {
            ...historyOptions,
            startIndex: absoluteStartIndex,
            includeTurnDynamicContext: dynamicContextStrategy === 'preserve'
        });
        if (!validateHistoryIntegrity(suffix, { detectOrphanFunctionCall: true }).valid) return undefined;

        const historyWithUserInputs = prependPreservedUserInputs(
            suffix,
            fullHistory,
            absoluteStartIndex
        );
        // 首条用户消息永远发送（任务锚点）
        const history = normalizeFallbackHistoryStart(
            prependFirstUserMessage(fullHistory, historyWithUserInputs, absoluteStartIndex)
        );
        const estimatedFallbackTokens = estimateFinalHistoryTokens(history);
        return { relativeStartIndex, absoluteStartIndex, history, estimatedTokens: estimatedFallbackTokens };
    };

    // 按候选顺序 O(1) 预筛（validSuffix + 增量 token），首个通过预筛的候选做一次精确评估；
    // 精确评估失败/超预算则继续下一个。常见情况下仅 1 个候选被精确格式化（O(n) 总代价）。
    const findFirstCandidate = (
        indices: number[],
        budget: number
    ): GranularFallbackCandidate | undefined => {
        for (const relativeStartIndex of indices) {
            const absoluteStartIndex = historyStartIndex + relativeStartIndex;
            if (!validSuffix[absoluteStartIndex]) continue;
            if (estimateCandidateTokens(absoluteStartIndex) > budget) continue;
            const exact = buildExactCandidate(relativeStartIndex);
            if (exact && exact.estimatedTokens <= budget) return exact;
        }
        return undefined;
    };

    const softCandidate = findFirstCandidate(candidateIndices, softHistoryBudgetTokens);
    if (softCandidate) {
        deps.log.warn('trim.fallback_granular_applied', {
            conversationId,
            absoluteStartIndex: softCandidate.absoluteStartIndex,
            relativeStartIndex: softCandidate.relativeStartIndex,
            boundary: plan?.boundary ?? 'unplanned',
            historyBudgetTokens: softHistoryBudgetTokens,
            fixedPromptTokens: normalizedFixedPromptTokens,
            providerReserveTokens,
            softInputTokenLimit,
            preferredInputTokenLimit,
            hardInputTokenLimit,
            fallbackEnvelopeInputTokenLimit,
            originalHistoryLength: fullHistory.length,
            fallbackHistoryLength: softCandidate.history.length
        });
        return {
            history: softCandidate.history,
            trimStartIndex: softCandidate.absoluteStartIndex,
            contextManagementDecision: {
                enabled: true,
                mode: 'summarize',
                source: resolveContextManagementPolicy(config).source,
                action: 'fallback_trim_applied'
            }
        };
    }

    // 无法达到自动总结软阈值时，从完整历史开始寻找仍低于模型硬窗口的最早合法起点。
    // 这条路径宁可多带上下文，也不能把“总结触发阈值”升级成主 Agent 的请求禁令。
    const hardCandidateIndices: number[] = [0];
    for (let i = 1; i < messages.length; i++) {
        if (messages[i]?.role === 'model' || isRealUserMessage(messages[i])) hardCandidateIndices.push(i);
    }
    const hardCandidate = actualModelWindow === undefined
        ? undefined
        : findFirstCandidate(hardCandidateIndices, fallbackEnvelopeHistoryBudgetTokens);
    if (hardCandidate) {
        deps.log.warn('trim.fallback_hard_limit_applied', {
            conversationId,
            absoluteStartIndex: hardCandidate.absoluteStartIndex,
            relativeStartIndex: hardCandidate.relativeStartIndex,
            estimatedHistoryTokens: hardCandidate.estimatedTokens,
            softHistoryBudgetTokens,
            fallbackEnvelopeHistoryBudgetTokens,
            fixedPromptTokens: normalizedFixedPromptTokens,
            hardInputTokenLimit,
            originalHistoryLength: fullHistory.length,
            fallbackHistoryLength: hardCandidate.history.length
        });
        return {
            history: hardCandidate.history,
            trimStartIndex: hardCandidate.absoluteStartIndex,
            contextManagementDecision: {
                enabled: true,
                mode: 'summarize',
                source: resolveContextManagementPolicy(config).source,
                action: 'fallback_hard_limit_applied'
            }
        };
    }

    if (actualModelWindow === undefined) {
        // 不知道 provider 的真实窗口时，选择 token 最少的合法候选尽力降低失败概率，
        // 但绝不把渠道显示/总结基准升级成 CONTEXT_OVERFLOW 拒绝。
        const bestEffortIndices = hardCandidateIndices
            .filter(relativeStartIndex => validSuffix[historyStartIndex + relativeStartIndex])
            .sort((a, b) => (
                estimateCandidateTokens(historyStartIndex + a) - estimateCandidateTokens(historyStartIndex + b)
            ));
        let bestEffortCandidate: GranularFallbackCandidate | undefined;
        for (const relativeStartIndex of bestEffortIndices) {
            bestEffortCandidate = buildExactCandidate(relativeStartIndex);
            if (bestEffortCandidate) break;
        }
        if (bestEffortCandidate) {
            deps.log.warn('trim.fallback_best_effort_applied', {
                conversationId,
                absoluteStartIndex: bestEffortCandidate.absoluteStartIndex,
                relativeStartIndex: bestEffortCandidate.relativeStartIndex,
                estimatedHistoryTokens: bestEffortCandidate.estimatedTokens,
                softHistoryBudgetTokens,
                fallbackEnvelopeHistoryBudgetTokens,
                fixedPromptTokens: normalizedFixedPromptTokens,
                originalHistoryLength: fullHistory.length,
                fallbackHistoryLength: bestEffortCandidate.history.length
            });
            return {
                history: bestEffortCandidate.history,
                trimStartIndex: bestEffortCandidate.absoluteStartIndex,
                contextManagementDecision: {
                    enabled: true,
                    mode: 'summarize',
                    source: resolveContextManagementPolicy(config).source,
                    action: 'fallback_best_effort_applied'
                }
            };
        }
    }

    // 仅供错误日志/估算展示：无法构造合法请求时报告最小候选的近似 token（增量口径）
    const minimumLegalHistoryTokens = hardCandidateIndices
        .filter(relativeStartIndex => validSuffix[historyStartIndex + relativeStartIndex])
        .reduce(
            (minimum, relativeStartIndex) => Math.min(
                minimum,
                estimateCandidateTokens(historyStartIndex + relativeStartIndex)
            ),
            Number.POSITIVE_INFINITY
        );
    return throwContextOverflow(Number.isFinite(minimumLegalHistoryTokens) ? minimumLegalHistoryTokens : 0);
}
