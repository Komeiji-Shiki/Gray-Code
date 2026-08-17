/**
 * SubAgent 请求级上下文总结与硬上限 fallback。
 *
 * Monitor transcript 始终保留完整原文；本模块只改写真正发送给 provider 的工作 history。
 * 自动总结的触发判定、保留预算和安全切点与主会话共用同一组纯函数。
 */

import type { Content } from '../../../modules/conversation/types';
import { isRealUserMessage } from '../../../modules/conversation/helpers';
import type { BaseChannelConfig } from '../../../modules/config/configs/base';
import type { SummarizeConfig } from '../../../modules/settings/types/summarizeTypes';
import {
    DEFAULT_KEEP_RECENT_TOKENS,
    DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN,
    clampMaxAutoSummarizeAttempts
} from '../../../modules/settings/types/summarizeTypes';
import {
    resolveMaxContextTokensForConfig,
    resolveModelContextWindowForConfig
} from '../../../modules/api/chat/services/contextTrim/contextWindowResolution';
import { calculateContextThreshold, findLastSummaryIndex } from '../../../modules/api/chat/services/contextTrim/roundDetection';
import { evaluateAutoSummaryNeed } from '../../../modules/api/chat/services/contextTrim/autoSummaryDecision';
import {
    planAutoSummarizeMessages,
    resolveKeepRecentTokenBudget
} from '../../../modules/api/chat/services/summarizeRangePlanner';
import type { SubAgentContextCompactionRecord } from '../../../../shared/subAgentContextCompaction';
import type { SubAgentSummaryGenerator } from '../types';
import {
    getSubAgentSummaryCoverage,
    getSubAgentTranscriptIndex,
    withSubAgentSummaryCoverage,
    type SubAgentSummaryCoverage
} from './historyMetadata';

/** 单个可裁剪字符串的初始保留上限，后续还会按总预算继续收缩。 */
const SUBAGENT_MAX_SINGLE_STRING_CHARS = 200_000;
const SUBAGENT_COMPACTION_MAX_ROUNDS = 8;
const SUBAGENT_MIN_RETAINED_CHARS = 128;

export interface SubAgentContextTrimOptions {
    modelOverride?: string;
    systemPrompt?: string;
    toolDeclarations?: unknown[];
    summarizeHistory?: SubAgentSummaryGenerator;
    summaryConfig?: Pick<
        SummarizeConfig,
        'keepRecentRounds' | 'keepRecentTokens' | 'maxAutoSummarizeAttemptsPerTurn'
    >;
    createCompactionIdentity?: () => { id: string; sequence: number };
    onCompactionRecord?: (record: SubAgentContextCompactionRecord) => void;
}

export interface SubAgentContextCompactionResult {
    history: Content[];
    changed: boolean;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    thresholdTokens: number;
    hardInputTokenLimit?: number;
    /** 下一次普通模型响应可用 provider 实报 prompt token 回填的记录。 */
    completedCompactionIds: string[];
}

interface HistorySelection {
    retained: Content[];
    dropped: Content[];
    estimatedTokens: number;
    budget: number;
}

interface FitHistoryResult {
    history: Content[];
    estimatedTokens: number;
    fits: boolean;
}

interface CoverageAggregate {
    sourceStartIndex?: number;
    sourceEndIndex?: number;
    summarizedMessageCount: number;
}

function hasFunctionResponseParts(message: Content): boolean {
    return (message.parts || []).some(part => !!part.functionResponse);
}

function normalizePlanningMessage(message: Content): Content {
    if (message.role === 'user' && hasFunctionResponseParts(message) && !message.isFunctionResponse) {
        return { ...message, isFunctionResponse: true };
    }
    return message;
}

/**
 * 与主总结范围估算一致：优先使用消息已有 token 元数据，缺失时再做保守本地估算。
 */
export function estimateSubAgentMessageTokens(message: Content, channelType?: string): number {
    if (!message.usageMetadataPartial) {
        if (message.role === 'user') {
            const byChannel = channelType ? message.tokenCountByChannel?.[channelType] : undefined;
            if (typeof byChannel === 'number' && Number.isFinite(byChannel)) return Math.max(0, byChannel);
            if (typeof message.estimatedTokenCount === 'number' && Number.isFinite(message.estimatedTokenCount)) {
                return Math.max(0, message.estimatedTokenCount);
            }
        } else if (message.role === 'model') {
            const usage = message.usageMetadata;
            if (typeof usage?.candidatesTokenCount === 'number' && Number.isFinite(usage.candidatesTokenCount)) {
                return Math.max(0, usage.candidatesTokenCount);
            }
            if (typeof usage?.totalTokenCount === 'number' && typeof usage.promptTokenCount === 'number') {
                const outputTokens = Math.max(0, usage.totalTokenCount - usage.promptTokenCount);
                const thoughtsTokens = Math.min(Math.max(0, usage.thoughtsTokenCount ?? 0), outputTokens);
                return Math.max(0, outputTokens - thoughtsTokens);
            }
        }
    }

    let tokens = 4;
    for (const part of message.parts || []) {
        if (part.text) {
            tokens += Math.ceil(part.text.length / 4) + 1;
            if (part.thoughtSignature) tokens += Math.ceil(part.thoughtSignature.length / 4);
            if (part.thoughtSignatures) tokens += safeStringifyTokens(part.thoughtSignatures);
        } else if (part.functionResponse) {
            tokens += safeStringifyTokens(part.functionResponse);
        } else if (part.functionCall) {
            tokens += safeStringifyTokens(part.functionCall);
        } else if (part.inlineData?.data) {
            tokens += 500 + Math.ceil(part.inlineData.data.length / 4);
        } else if (part.fileData?.fileUri) {
            tokens += 300;
        } else {
            tokens += safeStringifyTokens(part);
        }
    }
    return Math.ceil(tokens * 1.5);
}

export function estimateSubAgentHistoryTokens(history: Content[], channelType?: string): number {
    return history.reduce((sum, message) => sum + estimateSubAgentMessageTokens(message, channelType), 0);
}

function safeStringifyTokens(value: unknown): number {
    try {
        return Math.ceil(JSON.stringify(value).length / 4) + 1;
    } catch {
        return 64;
    }
}

function estimateTextTokens(text: string): number {
    return Math.ceil((Math.ceil(text.length / 4) + 1) * 1.5);
}

function estimateFixedRequestTokens(options?: SubAgentContextTrimOptions): number {
    if (!options) return 0;
    const systemTokens = typeof options.systemPrompt === 'string'
        ? estimateTextTokens(options.systemPrompt)
        : 0;
    const toolTokens = Array.isArray(options.toolDeclarations)
        ? Math.ceil(safeStringifyTokens(options.toolDeclarations) * 1.5)
        : 0;
    return systemTokens + toolTokens;
}

function estimateRequestTokens(
    history: Content[],
    channelType: string,
    fixedRequestTokens: number
): number {
    return fixedRequestTokens + estimateSubAgentHistoryTokens(history, channelType);
}

function latestProviderPromptTokens(history: Content[]): number | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
        const value = history[i].usageMetadata?.promptTokenCount;
        if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
    }
    return undefined;
}

function cloneHistory(history: Content[]): Content[] {
    try {
        return JSON.parse(JSON.stringify(history)) as Content[];
    } catch {
        try {
            return structuredClone(history) as Content[];
        } catch {
            return history.map(message => ({
                ...message,
                parts: (message.parts || []).map(part => ({ ...part }))
            }));
        }
    }
}

function truncateOversizedStrings(value: unknown, depth: number, maxChars: number): unknown {
    if (typeof value === 'string') {
        if (value.length > maxChars) {
            return value.slice(0, maxChars) + `…[sub-agent context trim: truncated ${value.length} chars]`;
        }
        return value;
    }
    if (depth <= 0) return value;
    if (Array.isArray(value)) {
        return value.map(item => truncateOversizedStrings(item, depth - 1, maxChars));
    }
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = truncateOversizedStrings(item, depth - 1, maxChars);
        }
        return result;
    }
    return value;
}

function truncateOversizedParts(history: Content[], maxChars: number, protectedIndices: ReadonlySet<number>): void {
    for (let index = 0; index < history.length; index++) {
        if (protectedIndices.has(index)) continue;
        const message = history[index];
        for (const part of message.parts || []) {
            if (part.text) {
                part.text = truncateOversizedStrings(part.text, 0, maxChars) as string;
            }
            if (part.functionCall) {
                part.functionCall = {
                    ...part.functionCall,
                    args: truncateOversizedStrings(part.functionCall.args, 3, maxChars) as Record<string, unknown>
                };
            }
            if (part.functionResponse) {
                part.functionResponse = {
                    ...part.functionResponse,
                    response: truncateOversizedStrings(part.functionResponse.response, 3, maxChars) as Record<string, unknown>
                };
            }
        }
    }
}

function minimizeOversizedParts(history: Content[], protectedIndices: ReadonlySet<number>): void {
    for (let index = 0; index < history.length; index++) {
        if (protectedIndices.has(index)) continue;
        const message = history[index];
        for (const part of message.parts || []) {
            if (part.text && part.text.length > SUBAGENT_MIN_RETAINED_CHARS) {
                part.text = part.text.slice(0, SUBAGENT_MIN_RETAINED_CHARS)
                    + '…[sub-agent context trim: detail omitted]';
            }
            if (part.functionCall) {
                part.functionCall = { ...part.functionCall, args: {} };
            }
            if (part.functionResponse) {
                part.functionResponse = {
                    ...part.functionResponse,
                    response: { result: '[sub-agent context trim: tool result omitted]' }
                };
            }
        }
    }
}

function cloneAndFitHistory(
    history: Content[],
    budget: number,
    protectedPrefixCount: number,
    channelType: string
): FitHistoryResult {
    const fitted = cloneHistory(history);
    const protectedIndices = new Set<number>();
    for (let i = 0; i < Math.min(protectedPrefixCount, fitted.length); i++) protectedIndices.add(i);

    const mutableMessageCount = Math.max(1, fitted.length - protectedIndices.size);
    let cap = Math.min(
        SUBAGENT_MAX_SINGLE_STRING_CHARS,
        Math.max(
            SUBAGENT_MIN_RETAINED_CHARS,
            Math.floor((Math.max(1, budget) * 4) / Math.max(1, mutableMessageCount * 3))
        )
    );
    for (let attempt = 0; attempt < SUBAGENT_COMPACTION_MAX_ROUNDS; attempt++) {
        truncateOversizedParts(fitted, cap, protectedIndices);
        const estimatedTokens = estimateSubAgentHistoryTokens(fitted, channelType);
        if (estimatedTokens <= budget) return { history: fitted, estimatedTokens, fits: true };
        const ratio = budget / Math.max(estimatedTokens, 1);
        cap = Math.max(SUBAGENT_MIN_RETAINED_CHARS, Math.floor(cap * ratio * 0.9));
    }

    minimizeOversizedParts(fitted, protectedIndices);
    const estimatedTokens = estimateSubAgentHistoryTokens(fitted, channelType);
    return { history: fitted, estimatedTokens, fits: estimatedTokens <= budget };
}

/**
 * 从最旧处移除完整工具回合；不可变前缀（首条任务 + 当前 summary）与最新工具对保留。
 */
function selectHistoryForBudget(
    history: Content[],
    budget: number,
    protectedPrefixCount: number,
    channelType: string
): HistorySelection {
    const perMessageTokens = history.map(message => estimateSubAgentMessageTokens(message, channelType));
    const total = perMessageTokens.reduce((sum, tokens) => sum + tokens, 0);
    if (total <= budget || history.length <= protectedPrefixCount) {
        return { retained: history, dropped: [], estimatedTokens: total, budget };
    }

    let keepFrom = protectedPrefixCount;
    let remaining = total;
    let protectedTailStart = Math.max(protectedPrefixCount, history.length - 2);
    for (let i = history.length - 2; i >= protectedPrefixCount; i--) {
        const next = history[i + 1];
        if (history[i].role === 'model' && next?.role === 'user' && hasFunctionResponseParts(next)) {
            protectedTailStart = i;
            break;
        }
    }

    for (let i = protectedPrefixCount; i < protectedTailStart && remaining > budget;) {
        const message = history[i];
        if (message.role === 'user' && hasFunctionResponseParts(message)) break;
        const next = history[i + 1];
        const dropPair = !!next && next.role === 'user' && hasFunctionResponseParts(next);
        remaining -= perMessageTokens[i] + (dropPair ? perMessageTokens[i + 1] : 0);
        i += dropPair ? 2 : 1;
        keepFrom = i;
    }

    const retained = keepFrom > protectedPrefixCount
        ? [...history.slice(0, protectedPrefixCount), ...history.slice(keepFrom)]
        : history;
    const dropped = keepFrom > protectedPrefixCount
        ? history.slice(protectedPrefixCount, keepFrom)
        : [];
    return {
        retained,
        dropped,
        estimatedTokens: estimateSubAgentHistoryTokens(retained, channelType),
        budget
    };
}

function aggregateCoverage(messages: Content[]): CoverageAggregate {
    let sourceStartIndex: number | undefined;
    let sourceEndIndex: number | undefined;
    let summarizedMessageCount = 0;

    for (const message of messages) {
        const summaryCoverage = getSubAgentSummaryCoverage(message);
        if (summaryCoverage) {
            sourceStartIndex = sourceStartIndex === undefined
                ? summaryCoverage.sourceStartIndex
                : Math.min(sourceStartIndex, summaryCoverage.sourceStartIndex);
            sourceEndIndex = sourceEndIndex === undefined
                ? summaryCoverage.sourceEndIndex
                : Math.max(sourceEndIndex, summaryCoverage.sourceEndIndex);
            summarizedMessageCount += summaryCoverage.summarizedMessageCount;
            continue;
        }
        const transcriptIndex = getSubAgentTranscriptIndex(message);
        if (transcriptIndex === undefined) continue;
        sourceStartIndex = sourceStartIndex === undefined
            ? transcriptIndex
            : Math.min(sourceStartIndex, transcriptIndex);
        sourceEndIndex = sourceEndIndex === undefined
            ? transcriptIndex + 1
            : Math.max(sourceEndIndex, transcriptIndex + 1);
        summarizedMessageCount += 1;
    }

    return { sourceStartIndex, sourceEndIndex, summarizedMessageCount };
}

function toSummaryCoverage(aggregate: CoverageAggregate): SubAgentSummaryCoverage | undefined {
    if (aggregate.sourceStartIndex === undefined || aggregate.sourceEndIndex === undefined) return undefined;
    if (aggregate.sourceEndIndex <= aggregate.sourceStartIndex) return undefined;
    return {
        sourceStartIndex: aggregate.sourceStartIndex,
        sourceEndIndex: aggregate.sourceEndIndex,
        summarizedMessageCount: aggregate.summarizedMessageCount
    };
}

function resolveBoundaryContentIndex(tail: Content[], coverage: CoverageAggregate): number | undefined {
    for (const message of tail) {
        const index = getSubAgentTranscriptIndex(message);
        if (index !== undefined) return index;
    }
    return coverage.sourceEndIndex;
}

function resolveProtectedPrefixCount(history: Content[]): number {
    const lastSummaryIndex = findLastSummaryIndex(history);
    return lastSummaryIndex >= 0 ? lastSummaryIndex + 1 : Math.min(1, history.length);
}

function resolveSummaryPlan(history: Content[], channelType: string, summaryConfig?: SubAgentContextTrimOptions['summaryConfig']): {
    candidateStart: number;
    candidateEnd: number;
    previousSummaryIndex: number;
} | undefined {
    if (history.length < 3) return undefined;
    const previousSummaryIndex = findLastSummaryIndex(history);
    const candidateStart = previousSummaryIndex >= 0 ? previousSummaryIndex : 0;
    const originalPlanningMessages = history.slice(candidateStart);
    if (originalPlanningMessages.length < 2) return undefined;

    // 旧 summary 在增量总结规划中充当这一段压缩历史的虚拟 user 轮首；仅修改规划副本，
    // 真正发给总结模型的 Content 仍保留 isSummary 标记。
    const planningMessages = originalPlanningMessages.map((message, index) => {
        const normalized = normalizePlanningMessage(message);
        if (index === 0 && normalized.isSummary) {
            return { ...normalized, isSummary: false, isAutoSummary: false };
        }
        return normalized;
    });
    const messageTokens = originalPlanningMessages.map(message => estimateSubAgentMessageTokens(message, channelType));
    const totalActiveTokens = messageTokens.reduce((sum, tokens) => sum + tokens, 0);
    const keepBudgetTokens = resolveKeepRecentTokenBudget(
        summaryConfig?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
        totalActiveTokens
    );
    const plan = planAutoSummarizeMessages({
        messages: planningMessages,
        messageTokens,
        keepBudgetTokens,
        minKeepRounds: summaryConfig?.keepRecentRounds ?? 2
    });
    if (!plan || plan.cutIndex <= 0) return undefined;

    const candidateEnd = candidateStart + plan.cutIndex;
    if (candidateEnd - candidateStart < 2) return undefined;
    return { candidateStart, candidateEnd, previousSummaryIndex };
}

function recordEvent(
    options: SubAgentContextTrimOptions | undefined,
    record: SubAgentContextCompactionRecord
): void {
    options?.onCompactionRecord?.({ ...record });
}

let fallbackCompactionSequence = 0;
function createCompactionIdentity(options?: SubAgentContextTrimOptions): { id: string; sequence: number } {
    if (options?.createCompactionIdentity) return options.createCompactionIdentity();
    const sequence = ++fallbackCompactionSequence;
    return { id: `subagent-context-${Date.now()}-${sequence}`, sequence };
}

function applySuccessfulSummary(
    history: Content[],
    plan: { candidateStart: number; candidateEnd: number; previousSummaryIndex: number },
    generated: Extract<Awaited<ReturnType<SubAgentSummaryGenerator>>, { success: true }>
): {
    history: Content[];
    coverage: CoverageAggregate;
    boundaryContentIndex?: number;
    summarizedMessageCount: number;
} | undefined {
    const candidateLength = plan.candidateEnd - plan.candidateStart;
    const consumed = Math.min(candidateLength, Math.max(0, generated.consumedMessageCount));
    if (consumed < 2) return undefined;
    const actualEnd = plan.candidateStart + consumed;

    const prefixEnd = plan.previousSummaryIndex >= 0 ? plan.previousSummaryIndex : 1;
    if (actualEnd <= prefixEnd) return undefined;
    const removedMessages = history.slice(prefixEnd, actualEnd);
    const coverage = aggregateCoverage(removedMessages);
    const summaryCoverage = toSummaryCoverage(coverage);
    const summary = withSubAgentSummaryCoverage({
        ...generated.summary,
        summarizedMessageCount: coverage.summarizedMessageCount
    }, summaryCoverage);
    const tail = history.slice(actualEnd);
    return {
        history: [...history.slice(0, prefixEnd), summary, ...tail],
        coverage,
        boundaryContentIndex: resolveBoundaryContentIndex(tail, coverage),
        summarizedMessageCount: coverage.summarizedMessageCount
    };
}

function applyHardFallback(
    history: Content[],
    channelType: string,
    fixedRequestTokens: number,
    hardInputTokenLimit: number
): {
    history: Content[];
    coverage: CoverageAggregate;
    boundaryContentIndex?: number;
    estimatedTokensAfter: number;
    fits: boolean;
} {
    const historyBudget = Math.max(1, hardInputTokenLimit - fixedRequestTokens);
    const protectedPrefixCount = resolveProtectedPrefixCount(history);
    const selection = selectHistoryForBudget(history, historyBudget, protectedPrefixCount, channelType);
    const fitted = cloneAndFitHistory(selection.retained, historyBudget, protectedPrefixCount, channelType);
    const coverage = aggregateCoverage(selection.dropped);
    const tail = fitted.history.slice(protectedPrefixCount);
    return {
        history: fitted.history,
        coverage,
        boundaryContentIndex: resolveBoundaryContentIndex(tail, coverage),
        estimatedTokensAfter: fixedRequestTokens + fitted.estimatedTokens,
        fits: fitted.fits && fixedRequestTokens + fitted.estimatedTokens <= hardInputTokenLimit
    };
}

/**
 * 仅做请求级安全裁剪的兼容入口。首条任务与已有 summary 保持逐字不变。
 */
export function trimSubAgentHistoryForContext(
    history: Content[],
    channelConfig: BaseChannelConfig,
    options?: SubAgentContextTrimOptions
): Content[] {
    const channelType = channelConfig.type || 'custom';
    const fixedRequestTokens = estimateFixedRequestTokens(options);
    const resolution = resolveMaxContextTokensForConfig(channelConfig, options?.modelOverride);
    const threshold = calculateContextThreshold(channelConfig.contextThreshold ?? '80%', resolution.maxInputTokens);
    const historyBudget = Math.max(1, threshold - fixedRequestTokens);
    if (estimateRequestTokens(history, channelType, fixedRequestTokens) <= threshold) return history;
    const protectedPrefixCount = resolveProtectedPrefixCount(history);
    const selection = selectHistoryForBudget(history, historyBudget, protectedPrefixCount, channelType);
    return cloneAndFitHistory(selection.retained, historyBudget, protectedPrefixCount, channelType).history;
}

/**
 * 主会话策略对齐的 SubAgent 自动总结入口。
 *
 * - 软阈值：尝试模型总结；失败但未越过硬上限时保持原 history；
 * - 硬上限：才执行可见的请求级 fallback；
 * - 首条任务和已有 summary 永不截断；
 * - 总结生成器只允许替换它实际消费的安全前缀。
 */
export async function compactSubAgentHistoryForContext(
    history: Content[],
    channelConfig: BaseChannelConfig,
    options?: SubAgentContextTrimOptions
): Promise<SubAgentContextCompactionResult> {
    const channelType = channelConfig.type || 'custom';
    const fixedRequestTokens = estimateFixedRequestTokens(options);
    const resolution = resolveMaxContextTokensForConfig(channelConfig, options?.modelOverride);
    const thresholdTokens = calculateContextThreshold(
        channelConfig.contextThreshold ?? '80%',
        resolution.maxInputTokens
    );
    const hardInputTokenLimit = resolveModelContextWindowForConfig(
        channelConfig,
        options?.modelOverride
    )?.maxInputTokens;
    const estimatedTokensBefore = estimateRequestTokens(history, channelType, fixedRequestTokens);
    const completedCompactionIds: string[] = [];
    let workingHistory = history;
    let lastFailedRecord: SubAgentContextCompactionRecord | undefined;

    const maxAttempts = clampMaxAutoSummarizeAttempts(
        options?.summaryConfig?.maxAutoSummarizeAttemptsPerTurn
        ?? DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const estimatedCurrentTokens = estimateRequestTokens(workingHistory, channelType, fixedRequestTokens);
        const decision = evaluateAutoSummaryNeed({
            estimatedTotalTokens: estimatedCurrentTokens,
            thresholdTokens,
            fixedPromptTokens: fixedRequestTokens,
            maxInputTokens: resolution.maxInputTokens,
            hardInputTokenLimit
        });
        if (!decision.needsAutoSummarize) break;

        const identity = createCompactionIdentity(options);
        const startedAt = Date.now();
        const runningRecord: SubAgentContextCompactionRecord = {
            ...identity,
            attempt,
            status: 'running',
            strategy: 'summary',
            startedAt,
            estimatedTokensBefore: estimatedCurrentTokens,
            thresholdTokens,
            ...(hardInputTokenLimit !== undefined ? { hardLimitTokens: hardInputTokenLimit } : {}),
            ...(latestProviderPromptTokens(workingHistory) !== undefined
                ? { previousProviderPromptTokens: latestProviderPromptTokens(workingHistory) }
                : {})
        };
        recordEvent(options, runningRecord);

        const plan = resolveSummaryPlan(workingHistory, channelType, options?.summaryConfig);
        if (!plan) {
            lastFailedRecord = {
                ...runningRecord,
                status: 'failed',
                completedAt: Date.now(),
                errorCode: 'NOT_ENOUGH_CONTENT',
                errorMessage: 'No safe automatic-summary boundary is available while preserving the current task.'
            };
            recordEvent(options, lastFailedRecord);
            break;
        }
        if (!options?.summarizeHistory) {
            lastFailedRecord = {
                ...runningRecord,
                status: 'failed',
                completedAt: Date.now(),
                errorCode: 'SUMMARY_SERVICE_UNAVAILABLE',
                errorMessage: 'The shared summary service is unavailable.'
            };
            recordEvent(options, lastFailedRecord);
            break;
        }

        const candidate = workingHistory.slice(plan.candidateStart, plan.candidateEnd);
        const generated = await options.summarizeHistory(candidate, {
            configId: channelConfig.id,
            modelOverride: options.modelOverride
        });
        if (!generated.success) {
            lastFailedRecord = {
                ...runningRecord,
                status: 'failed',
                completedAt: Date.now(),
                errorCode: generated.code,
                errorMessage: generated.message
            };
            recordEvent(options, lastFailedRecord);
            break;
        }

        const applied = applySuccessfulSummary(workingHistory, plan, generated);
        if (!applied) {
            lastFailedRecord = {
                ...runningRecord,
                status: 'failed',
                completedAt: Date.now(),
                errorCode: 'INVALID_SUMMARY_RANGE',
                errorMessage: 'The summary generator did not consume a replaceable history prefix.'
            };
            recordEvent(options, lastFailedRecord);
            break;
        }

        workingHistory = applied.history;
        const estimatedTokensAfter = estimateRequestTokens(workingHistory, channelType, fixedRequestTokens);
        const completedRecord: SubAgentContextCompactionRecord = {
            ...runningRecord,
            status: 'completed',
            completedAt: Date.now(),
            estimatedTokensAfter,
            summaryRequestTokens: generated.summaryRequestPromptTokens,
            summaryOutputTokens: generated.summaryTokenCount,
            summarizedMessageCount: applied.summarizedMessageCount,
            retainedMessageCount: workingHistory.length,
            sourceStartIndex: applied.coverage.sourceStartIndex,
            sourceEndIndex: applied.coverage.sourceEndIndex,
            boundaryContentIndex: applied.boundaryContentIndex
        };
        recordEvent(options, completedRecord);
        completedCompactionIds.push(completedRecord.id);
        lastFailedRecord = undefined;
    }

    let estimatedTokensAfter = estimateRequestTokens(workingHistory, channelType, fixedRequestTokens);
    const exceedsHardLimit = hardInputTokenLimit !== undefined && estimatedTokensAfter > hardInputTokenLimit;
    if (exceedsHardLimit) {
        const fallback = applyHardFallback(
            workingHistory,
            channelType,
            fixedRequestTokens,
            hardInputTokenLimit
        );
        const baseRecord: SubAgentContextCompactionRecord = lastFailedRecord ?? (() => {
            const identity = createCompactionIdentity(options);
            return {
                ...identity,
                attempt: Math.max(1, completedCompactionIds.length + 1),
                status: 'running' as const,
                strategy: 'summary' as const,
                startedAt: Date.now(),
                estimatedTokensBefore: estimatedTokensAfter,
                thresholdTokens,
                hardLimitTokens: hardInputTokenLimit,
                ...(latestProviderPromptTokens(workingHistory) !== undefined
                    ? { previousProviderPromptTokens: latestProviderPromptTokens(workingHistory) }
                    : {})
            };
        })();
        const fallbackRecord: SubAgentContextCompactionRecord = {
            ...baseRecord,
            status: fallback.fits ? 'fallback' : 'failed',
            strategy: 'hard_fallback',
            completedAt: Date.now(),
            estimatedTokensAfter: fallback.estimatedTokensAfter,
            summarizedMessageCount: fallback.coverage.summarizedMessageCount,
            retainedMessageCount: fallback.history.length,
            sourceStartIndex: fallback.coverage.sourceStartIndex,
            sourceEndIndex: fallback.coverage.sourceEndIndex,
            boundaryContentIndex: fallback.boundaryContentIndex,
            errorCode: fallback.fits ? baseRecord.errorCode : 'IMMUTABLE_PREFIX_EXCEEDS_CONTEXT',
            errorMessage: fallback.fits
                ? baseRecord.errorMessage
                : 'The complete initial task and current summary alone exceed the model input limit; they were not truncated.'
        };
        recordEvent(options, fallbackRecord);
        if (fallback.fits) {
            workingHistory = fallback.history;
            estimatedTokensAfter = fallback.estimatedTokensAfter;
            completedCompactionIds.push(fallbackRecord.id);
        }
    }

    return {
        history: workingHistory,
        changed: workingHistory !== history,
        estimatedTokensBefore,
        estimatedTokensAfter,
        thresholdTokens,
        ...(hardInputTokenLimit !== undefined ? { hardInputTokenLimit } : {}),
        completedCompactionIds
    };
}
