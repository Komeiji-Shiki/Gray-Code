/**
 * 子代理请求级上下文预算、裁剪与独立压缩。
 *
 * 子代理不复用主会话的 ContextTrimService：主会话总结会写入主会话历史，不能直接
 * 套到 SubAgent transcript。这里保留一个只影响 provider 请求的独立 history，
 * 在完整工具回合边界把旧回合压成摘要；Monitor transcript 仍保留完整原始内容。
 */

import type { Content } from '../../../modules/conversation/types';
import type { BaseChannelConfig } from '../../../modules/config/configs/base';
import { resolveMaxContextTokensForConfig } from '../../../modules/api/chat/services/contextTrim/contextWindowResolution';

/** 无模型窗口元数据时，子代理沿用原有的防御性默认预算。 */
const SUBAGENT_CONTEXT_BUDGET_DEFAULT_TOKENS = 128000;
const SUBAGENT_CONTEXT_BUDGET_RATIO = 0.8;
/** 单个字符串的初始保留上限，后续还会按总预算继续收缩。 */
const SUBAGENT_MAX_SINGLE_STRING_CHARS = 200000;
const SUBAGENT_COMPACTION_SUMMARY_MAX_CHARS = 8000;
const SUBAGENT_COMPACTION_PREVIEW_CHARS = 640;
const SUBAGENT_COMPACTION_MAX_ROUNDS = 8;
const SUBAGENT_MIN_RETAINED_CHARS = 128;

export interface SubAgentContextTrimOptions {
    /** 实际发送模型覆盖，用于读取模型列表中的上下文/输出上限。 */
    modelOverride?: string;
    /** 本次请求的动态系统提示词，计入输入预算。 */
    systemPrompt?: string;
    /** 本次请求实际暴露给模型的工具声明，计入输入预算。 */
    toolDeclarations?: unknown[];
}

interface HistorySelection {
    retained: Content[];
    dropped: Content[];
    estimatedTokens: number;
    budget: number;
}

function hasFunctionResponseParts(message: Content): boolean {
    return (message.parts || []).some(part => !!part.functionResponse);
}

/**
 * 本地 token 估算：4 字符约 1 token，并加 1.5 倍安全系数。
 * 导出给回归测试和诊断使用，运行时不依赖 API token 计数服务。
 */
export function estimateSubAgentMessageTokens(message: Content): number {
    let tokens = 4; // 消息级开销（role 等）
    for (const part of message.parts || []) {
        if (part.text) {
            tokens += Math.ceil(part.text.length / 4) + 1;
        } else if (part.functionResponse) {
            tokens += safeStringifyTokens(part.functionResponse);
        } else if (part.functionCall) {
            tokens += safeStringifyTokens(part.functionCall);
        } else if (part.inlineData?.data) {
            tokens += 500 + Math.ceil(part.inlineData.data.length / 4);
        } else if (part.fileData?.fileUri) {
            tokens += 300;
        } else {
            tokens += 8;
        }
    }
    return Math.ceil(tokens * 1.5);
}

export function estimateSubAgentHistoryTokens(history: Content[]): number {
    return history.reduce((sum, message) => sum + estimateSubAgentMessageTokens(message), 0);
}

/** 序列化 part 估算 token；不可序列化时按固定开销兜底，不打断整个 run。 */
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

function resolveSubAgentInputBudget(
    channelConfig: BaseChannelConfig,
    options?: SubAgentContextTrimOptions
): number {
    const resolution = resolveMaxContextTokensForConfig(channelConfig, options?.modelOverride);
    // 保留历史兼容：没有任何模型/渠道窗口元数据时，子代理仍使用 128k 防御预算，
    // 但若显式开启了输出上限，组合窗口的输出预留仍然要扣除。
    if (resolution.source === 'default') {
        const outputReserve = resolution.contextWindowIncludesOutput
            ? (resolution.maxOutputTokens ?? 0)
            : 0;
        return Math.max(1, SUBAGENT_CONTEXT_BUDGET_DEFAULT_TOKENS - outputReserve);
    }
    return resolution.maxInputTokens;
}

function resolveHistoryBudget(
    channelConfig: BaseChannelConfig,
    options?: SubAgentContextTrimOptions
): number {
    const inputBudget = resolveSubAgentInputBudget(channelConfig, options);
    const fixedRequestTokens = estimateFixedRequestTokens(options);
    return Math.max(
        1,
        Math.floor(inputBudget * SUBAGENT_CONTEXT_BUDGET_RATIO) - fixedRequestTokens
    );
}

/** 深度截断对象中的字符串，保留 JSON 结构。 */
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

function truncateOversizedParts(history: Content[], maxChars: number): void {
    for (const message of history) {
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

/** 最后一道收敛：保留协议壳，舍弃无法继续压缩的超大具体值。 */
function minimizeOversizedParts(history: Content[]): void {
    for (const message of history) {
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

function cloneAndFitHistory(history: Content[], budget: number): Content[] {
    let fitted: Content[];
    try {
        fitted = JSON.parse(JSON.stringify(history)) as Content[];
    } catch {
        // 工具结果含 BigInt/循环引用时改用 Node 20 的 structuredClone；只有该能力也失败时
        // 才退到逐层副本，确保后续截断不会修改调用方持有的原 history。
        try {
            fitted = structuredClone(history) as Content[];
        } catch {
            fitted = history.map(message => ({
                ...message,
                parts: (message.parts || []).map(part => ({
                    ...part,
                    ...(part.functionCall
                        ? { functionCall: { ...part.functionCall, args: { ...(part.functionCall.args as Record<string, unknown>) } } }
                        : {}),
                    ...(part.functionResponse
                        ? { functionResponse: { ...part.functionResponse, response: { ...(part.functionResponse.response as Record<string, unknown>) } } }
                        : {})
                }))
            }));
        }
    }

    let cap = Math.min(
        SUBAGENT_MAX_SINGLE_STRING_CHARS,
        Math.max(
            SUBAGENT_MIN_RETAINED_CHARS,
            Math.floor((budget * 4) / Math.max(1, fitted.length * 3))
        )
    );
    for (let attempt = 0; attempt < SUBAGENT_COMPACTION_MAX_ROUNDS; attempt++) {
        truncateOversizedParts(fitted, cap);
        const estimatedTokens = estimateSubAgentHistoryTokens(fitted);
        if (estimatedTokens <= budget) return fitted;
        const ratio = budget / Math.max(estimatedTokens, 1);
        cap = Math.max(SUBAGENT_MIN_RETAINED_CHARS, Math.floor(cap * ratio * 0.9));
    }

    minimizeOversizedParts(fitted);
    return fitted;
}

/**
 * 从最旧处移除完整工具回合。
 * 首条任务消息和最新完整工具对（以及其后的最终回答）保留；只有真正超预算时才删除中间内容。
 */
function selectHistoryForBudget(history: Content[], budget: number): HistorySelection {
    const perMessageTokens = history.map(estimateSubAgentMessageTokens);
    const total = perMessageTokens.reduce((sum, tokens) => sum + tokens, 0);
    if (total <= budget || history.length <= 1) {
        return { retained: history, dropped: [], estimatedTokens: total, budget };
    }

    let keepFrom = 0;
    let remaining = total;
    // 首条是任务锚点。末尾保护区从“最新完整 functionCall/functionResponse 对”开始，
    // 并连同其后的最终回答一起保留；这样不会为了满足预算拆出孤立 response。
    let protectedTailStart = Math.max(1, history.length - 2);
    for (let i = history.length - 2; i >= 1; i--) {
        const next = history[i + 1];
        if (history[i].role === 'model' && next?.role === 'user' && hasFunctionResponseParts(next)) {
            protectedTailStart = i;
            break;
        }
    }
    for (let i = 1; i < protectedTailStart && remaining > budget; ) {
        const message = history[i];
        if (message.role === 'user' && hasFunctionResponseParts(message)) {
            // 不拆孤立 functionResponse；合法 executor history 不会从这里开始，
            // 异常历史交给后面的字符串收敛处理。
            break;
        }
        const next = history[i + 1];
        const dropPair = !!next && next.role === 'user' && hasFunctionResponseParts(next);
        const cost = perMessageTokens[i] + (dropPair ? perMessageTokens[i + 1] : 0);
        // 这里必须继续删除，即使本轮删除后刚好低于预算；旧实现反而 break，
        // 导致“删一轮就够”的历史完全没有被裁剪。
        remaining -= cost;
        i += dropPair ? 2 : 1;
        keepFrom = i;
    }

    const retained = keepFrom > 0 ? [history[0], ...history.slice(keepFrom)] : history;
    const dropped = keepFrom > 1 ? history.slice(1, keepFrom) : [];
    return {
        retained,
        dropped,
        estimatedTokens: estimateSubAgentHistoryTokens(retained),
        budget
    };
}

function previewValue(value: unknown, maxChars = SUBAGENT_COMPACTION_PREVIEW_CHARS): string {
    let text: string;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        text = '[unserializable value]';
    }
    text = text || '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function buildCompactionSummary(dropped: Content[]): Content | undefined {
    if (dropped.length === 0) return undefined;
    const lines: string[] = [
        '[Earlier sub-agent context was compacted. Preserve these completed-work facts:]'
    ];
    for (const message of dropped) {
        for (const part of message.parts || []) {
            if (part.functionCall) {
                lines.push(`- tool call ${part.functionCall.name} (${part.functionCall.id || 'no-id'}): ${previewValue(part.functionCall.args)}`);
            } else if (part.functionResponse) {
                lines.push(`- tool result ${part.functionResponse.name} (${part.functionResponse.id || 'no-id'}): ${previewValue(part.functionResponse.response)}`);
            } else if (part.text?.trim()) {
                lines.push(`- ${previewValue(part.text)}`);
            }
            if (lines.join('\n').length >= SUBAGENT_COMPACTION_SUMMARY_MAX_CHARS) break;
        }
        if (lines.join('\n').length >= SUBAGENT_COMPACTION_SUMMARY_MAX_CHARS) break;
    }
    let text = lines.join('\n');
    if (text.length > SUBAGENT_COMPACTION_SUMMARY_MAX_CHARS) {
        text = text.slice(0, SUBAGENT_COMPACTION_SUMMARY_MAX_CHARS) + '\n[…earlier details omitted]';
    }
    return {
        role: 'user',
        parts: [{ text }],
        isSummary: true,
        isAutoSummary: true,
        timestamp: Date.now()
    } as Content;
}

/**
 * 仅做请求级裁剪的兼容入口。不会插入摘要，供旧调用方和纯裁剪测试继续使用。
 */
export function trimSubAgentHistoryForContext(
    history: Content[],
    channelConfig: BaseChannelConfig,
    options?: SubAgentContextTrimOptions
): Content[] {
    const budget = resolveHistoryBudget(channelConfig, options);
    if (estimateSubAgentHistoryTokens(history) <= budget) return history;
    const selection = selectHistoryForBudget(history, budget);
    return cloneAndFitHistory(selection.retained, budget);
}

/**
 * 子代理独立上下文压缩：
 * - 只在发送给 provider 的 history 中替换旧回合；Monitor transcript 不变；
 * - 只删除完整工具回合，不拆当前 functionCall/functionResponse；
 * - 摘要是普通 user summary，不携带伪造的 thought signature；保留区中的 Gemini /
 *   OpenAI Responses reasoning 元数据原样保留。
 */
export function compactSubAgentHistoryForContext(
    history: Content[],
    channelConfig: BaseChannelConfig,
    options?: SubAgentContextTrimOptions
): Content[] {
    const budget = resolveHistoryBudget(channelConfig, options);
    if (estimateSubAgentHistoryTokens(history) <= budget) return history;
    const selection = selectHistoryForBudget(history, budget);

    const summary = buildCompactionSummary(selection.dropped);
    const withSummary = summary && selection.retained.length > 0
        ? [selection.retained[0], summary, ...selection.retained.slice(1)]
        : selection.retained;
    return cloneAndFitHistory(withSummary, budget);
}
