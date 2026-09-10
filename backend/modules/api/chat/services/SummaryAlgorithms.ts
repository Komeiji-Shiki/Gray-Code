import type { Content, ContentPart, SummaryTokenStats } from '../../../conversation/types';
import type { BaseChannelConfig } from '../../../config/configs/base';
import { validateHistoryIntegrity } from '../../../channel/HistoryIntegrityValidator';
import { resolveMaxContextTokensForConfig, resolveModelContextWindowForConfig } from './contextTrim/contextWindowResolution';
import type { RequestPromptContext } from '../../../channel/types';
import type { DynamicContextStrategy, ResolvedPromptModeSnapshot } from '../../../settings/types';
import type { MessageTokenEstimator } from './MessageTokenEstimator';
export const BUILTIN_SUMMARIZE_SYSTEM_PROMPT = `You are an expert conversation summarization assistant.
Always respond in English.
Produce a structured summary with clear, step-by-step sections.
Follow this exact structure:
1. User Goal
2. Completed Steps
3. Current Progress
4. Next Steps
5. Important Constraints
6. Open Questions / Risks
Use concise bullet points under each section.
Preserve exact technical details (file paths, function names, config keys, IDs, and numbers).`;

/** 仅追加到总结 user 消息末尾的详细操作要求；不改变其他请求参数。 */
const DETAILED_SUMMARIZE_USER_PROMPT = `Temporarily pause the current task and do not continue implementation or call tools. Read and analyze every preceding message carefully, then produce a detailed standalone handoff summary so the task can resume in a fresh context without rereading the full history, redoing completed work, or being re-supplied with constraints already established. Be complete on the items below even at the cost of length; keep everything else concise. Preserve, stated exactly: (1) what the user asked for, decided, agreed, ruled out, or set as a preference, constraint, or boundary; (2) any difficulties or problems that came up and how they were handled or resolved; (3) any possibilities, options, or approaches that were raised, tried, or set aside, and why; (4) exactly where things stand now — what has been covered, settled, or completed so far; (5) anything still open, unresolved, promised, or expected to happen next; (6) specific details that would be hard to reconstruct — file paths, symbols, configuration keys, API names, IDs, numbers, dates, error messages, test results, links, and exact wording. Clearly distinguish the original goal, completed work, current state, pending work, and the exact next actions, and include important edge cases and explain why key implementation choices were made. Weight the two voices differently: keep what the user said, asked for, shared, or established close to their own words, while your own explanations and reasoning may be condensed to just their conclusions or outputs, as long as nothing in the six items above is dropped. Do not answer the original task, modify files, or omit unfinished details; output only the comprehensive summary.`;

/** 总结截止锚点提示模板：提示模型忽略锚点消息及其之后的内容（保留区逐字保留）。 */
const SUMMARY_ANCHOR_HINT = `\n\nIMPORTANT BOUNDARY: The summary must cover ONLY the conversation up to (but not including) the message quoted below. Everything starting from that message must be preserved verbatim and MUST NOT appear in the summary. Stop at the boundary and ignore all messages after it. Boundary message: "{anchor}"`;

/** 锚点文本最大长度（字符）。 */
const SUMMARY_ANCHOR_MAX_CHARS = 120;

/**
 * 从保留区（fullHistory 中从 insertIndex 起）提取第一条有文本的消息作为总结截止锚点。
 *
 * 保留区是「最近保留、不参与总结」的内容；用其首条文本做锚点，总结模型即可把
 * 总结范围与落盘标记范围对齐（提示词只影响文本，不改变发送前缀，缓存继续命中）。
 * 保留区没有可引用的文本（全为工具消息等）时返回 undefined。
 */
export function extractSummaryAnchorText(fullHistory: Content[], insertIndex: number): string | undefined {
    for (let i = insertIndex; i < fullHistory.length; i++) {
        const text = extractFirstMessageText(fullHistory[i]);
        if (text) return text;
    }
    return undefined;
}

/** 提取消息中第一条有意义的文本（拼接所有 text part，压缩空白，截断到锚点长度）。 */
function extractFirstMessageText(message: Content): string | undefined {
    const parts = message.parts;
    if (!Array.isArray(parts)) return undefined;
    const text = parts
        .filter(p => typeof p.text === 'string' && p.text.trim() && !p.thought)
        .map(p => p.text)
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return undefined;
    return text.length > SUMMARY_ANCHOR_MAX_CHARS
        ? text.slice(0, SUMMARY_ANCHOR_MAX_CHARS)
        : text;
}

export interface AutoSummaryRequestContext {
    /** 当前主请求已经计算出的、可复用的动态 system prompt。 */
    dynamicSystemPrompt?: string;
    /** 当前主请求的动态上下文插入位置与消息快照。 */
    promptContext?: RequestPromptContext;
    /** 当前主请求使用的动态上下文策略。 */
    dynamicContextStrategy?: DynamicContextStrategy;
    /** 当前主请求使用的提示词/工具策略快照。 */
    promptModeSnapshot?: ResolvedPromptModeSnapshot;
    /** 触发总结时主请求实际准备发送的完整历史（含最新工具调用/结果）。 */
    history?: Content[];
    /** 是否要求总结请求保持主请求前缀，而不是走清洗隔离路径。 */
    preservePrefix?: boolean;
}
const SUMMARY_PROVIDER_RESERVE_RATIO = 0.02;
const MIN_SUMMARY_PROVIDER_RESERVE_TOKENS = 32;
// summarizeMaxInputRatio 是“自动总结缩小范围”的软预算设置；手动总结不应被默认 50% 提前拒绝。
// 手动请求只在接近总结模型真实窗口时预检失败，并给 provider 包装留出少量余量。
export const MANUAL_SUMMARY_MAX_INPUT_RATIO = 0.95;

/**
 * 自动总结文本最低长度（字符数）。
 *
 * H1：物理替换语义下，低于该长度的总结会被直接拒绝（LOW_QUALITY_SUMMARY）而不替换历史——
 * 防止模型返回“已总结”“OK”等无信息量占位文本时，把真实对话历史物理删除。
 */
export const MIN_SUMMARY_LENGTH = 50;


/**
 * 上下文总结服务
 *
 * 职责：
 * 1. 处理上下文总结请求
 * 2. 识别需要总结的回合范围
 * 3. 清理历史消息中的内部字段
 * 4. 调用 AI 生成总结
 * 5. 管理总结消息的插入和删除
 */

export class SummaryAlgorithms {
    constructor(protected tokenEstimationService?: Pick<MessageTokenEstimator, "estimateMessageTokens">) {}


    getLatestMainContextTokenCount(history: Content[]): number | undefined {
        for (let i = history.length - 1; i >= 0; i--) {
            const message = history[i];
            if (message.role !== 'model' || !message.usageMetadata) continue;
            const prompt = message.usageMetadata.promptTokenCount;
            if (typeof prompt === 'number' && Number.isFinite(prompt)) return Math.max(0, prompt);
            const total = message.usageMetadata.totalTokenCount;
            if (typeof total === 'number' && Number.isFinite(total)) return Math.max(0, total);
        }
        return undefined;
    }


    buildSummaryTokenStats(options: {
        fullHistory: Content[];
        messagesToSummarize: Content[];
        summaryText: string;
        channelType: string;
        providerSummaryTokens?: number;
    }): SummaryTokenStats {
        const sourceTokenCount = this.estimateMessagesTokens(options.messagesToSummarize, options.channelType);
        const summaryTokenCount = typeof options.providerSummaryTokens === 'number'
            ? Math.max(0, options.providerSummaryTokens)
            : this.estimateSingleMessageTokensLocally({ role: 'user', parts: [{ text: options.summaryText }] });
        const estimatedTokensSaved = Math.max(0, sourceTokenCount - summaryTokenCount);
        const contextTokenCountBefore = this.getLatestMainContextTokenCount(options.fullHistory);
        return {
            sourceTokenCount,
            summaryTokenCount,
            estimatedTokensSaved,
            ...(contextTokenCountBefore !== undefined
                ? {
                    contextTokenCountBefore,
                    estimatedContextTokenCountAfter: Math.max(
                        0,
                        contextTokenCountBefore - sourceTokenCount + summaryTokenCount
                    )
                }
                : {})
        };
    }


    /**
     * 总结候选超出总结模型预算时，只缩短候选的尾部，返回能装入的最大完整前缀。
     * 调用方仅替换 consumedMessageCount 覆盖的消息；未进入总结请求的尾部继续留在
     * provider history，绝不再出现“删除整段、只总结后半段”的信息空洞。
     */
    fitSummaryHistoryPrefixToBudget(
        messages: Content[],
        maxHistoryTokens: number,
        channelType: string
    ): { messages: Content[]; consumedMessageCount: number; estimatedTokens: number } | undefined {
        const perMessageTokens = messages.map(message => this.estimateMessageTokensForBudget(message, channelType));
        const prefixTokens = new Array<number>(messages.length + 1).fill(0);
        for (let i = 0; i < messages.length; i++) {
            prefixTokens[i + 1] = prefixTokens[i] + perMessageTokens[i];
        }

        // 至少消费两条消息：只总结首条任务或旧 summary 没有新增信息，也不能形成有效压缩。
        for (let end = messages.length; end >= 2; end--) {
            const estimatedTokens = prefixTokens[end];
            if (estimatedTokens > maxHistoryTokens) continue;
            const candidate = messages.slice(0, end);
            if (!validateHistoryIntegrity(candidate).valid) continue;
            return {
                messages: candidate,
                consumedMessageCount: end,
                estimatedTokens
            };
        }
        return undefined;
    }


    buildDetailedSummaryPrompt(prompt: string, anchorText?: string): string {
        const anchorHint = anchorText
            ? SUMMARY_ANCHOR_HINT.replace('{anchor}', anchorText)
            : '';
        return `${prompt}\n\n${DETAILED_SUMMARIZE_USER_PROMPT}${anchorHint}`;
    }


    resolveSummaryInputBudget(
        config: BaseChannelConfig,
        modelOverride: string | undefined,
        inputRatio: number,
        prompt: string,
        dynamicSystemPrompt?: string
    ): {
        modelMaxContextTokens: number;
        modelMaxInputTokens: number;
        maxInputTokens: number;
        fixedRequestTokens: number;
        maxHistoryTokens: number;
    } {
        // 总结请求真正发给当前/独立总结模型，优先使用该模型自己的 contextWindow；
        // 渠道 maxContextTokens 只是上下文管理与显示基准，仅在模型元数据缺失时作为回退。
        const modelResolution = (
            resolveModelContextWindowForConfig(config, modelOverride)
            ?? resolveMaxContextTokensForConfig(config, modelOverride)
        );
        const modelMaxContextTokens = modelResolution.maxContextTokens;
        const modelMaxInputTokens = modelResolution.maxInputTokens;
        // inputRatio 是总结请求的历史输入比例；先从组合窗口扣除总结输出预留，
        // 再按比例规划待总结历史，避免“输入预算 + 总结输出”再次超过窗口。
        const maxInputTokens = Math.max(1, Math.floor(modelMaxInputTokens * inputRatio));
        const systemPromptTokens = this.estimateSingleMessageTokensLocally({
            role: 'user',
            parts: [{ text: dynamicSystemPrompt || BUILTIN_SUMMARIZE_SYSTEM_PROMPT }]
        });
        const userPromptTokens = this.estimateSingleMessageTokensLocally({
            role: 'user',
            parts: [{ text: prompt }]
        });
        const providerReserveTokens = Math.max(
            MIN_SUMMARY_PROVIDER_RESERVE_TOKENS,
            Math.floor(maxInputTokens * SUMMARY_PROVIDER_RESERVE_RATIO)
        );
        const fixedRequestTokens = systemPromptTokens + userPromptTokens + providerReserveTokens;
        return {
            modelMaxContextTokens,
            modelMaxInputTokens,
            maxInputTokens,
            fixedRequestTokens,
            maxHistoryTokens: Math.max(0, maxInputTokens - fixedRequestTokens)
        };
    }


    /**
     * 清理消息中不应发送给 API 的内部字段
     */
    cleanMessagesForSummarize(messages: Content[], config: BaseChannelConfig): Content[] {
        // 已收到响应的 call id：rejected 且无配对的调用（中断/取消残留真孤儿）整体丢弃，
        // 否则剥字段后变成孤儿 tool_calls 发给总结模型 → 400。有配对的 rejected 调用
        // 保留（剥字段），其响应在下方改写为拒绝态，成对发送。
        const respondedCallIds = new Set<string>();
        for (const msg of messages) {
            for (const part of msg.parts) {
                if (part.functionResponse?.id) {
                    respondedCallIds.add(part.functionResponse.id);
                }
            }
        }

        return messages.map(msg => {
            const cleanedParts = msg.parts
                // 过滤掉思考内容
                .filter(part => !part.thought && !(part.thoughtSignatures && Object.keys(part).length === 1))
                .map(part => {
                    // 丢弃无配对响应的 rejected functionCall（中断残留孤儿）
                    if (part.functionCall?.rejected && part.functionCall.id
                        && !respondedCallIds.has(part.functionCall.id)) {
                        return null as unknown as ContentPart;
                    }

                    let cleanedPart = { ...part };

                    // 移除思考签名
                    if (cleanedPart.thoughtSignatures) {
                        const { thoughtSignatures, ...rest } = cleanedPart;
                        cleanedPart = rest;
                    }

                    // 清理 functionCall 中的 rejected 字段
                    if (cleanedPart.functionCall) {
                        const { rejected, ...cleanedFunctionCall } = cleanedPart.functionCall;
                        cleanedPart = {
                            ...cleanedPart,
                            functionCall: cleanedFunctionCall
                        };
                    }

                    // 图片等内联媒体替换为文本占位符：总结模型无需加载图片字节，
                    // 既省输入 token，也避免不支持多模态的总结渠道直接报错。
                    if (cleanedPart.inlineData) {
                        cleanedPart = {
                            text: `[Image: ${cleanedPart.inlineData.displayName || cleanedPart.inlineData.mimeType || 'attachment'}]`
                        };
                    } else if (cleanedPart.fileData) {
                        // 文件引用同样转占位符（用户贴入的图片文件等不被总结请求携带）。
                        cleanedPart = {
                            text: `[File: ${cleanedPart.fileData.displayName || cleanedPart.fileData.fileUri || 'attachment'}]`
                        };
                    }

                    // 清理 functionResponse.response 中仅供运行时/UI 使用的内部字段。
                    // agentInbox 是已发生的模型可见历史，保留以便总结不遗漏代理补充内容；
                    // 一次性消费由 mailbox drain/claim 保证，不通过删除历史字段实现。
                    if (cleanedPart.functionResponse) {
                        const rawResponse = cleanedPart.functionResponse.response as Record<string, unknown> | undefined;

                        if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
                            const { diffContentId, diffId, diffs, pendingDiffId, ...rest } = rawResponse;

                            if (rest.data && typeof rest.data === 'object' && !Array.isArray(rest.data)) {
                                const {
                                    diffContentId: dataDiffContentId,
                                    diffId: dataDiffId,
                                    diffs: dataDiffs,
                                    pendingDiffId: dataPendingDiffId,
                                    toolId: dataToolId,
                                    terminalId: dataTerminalId,
                                    multiRoot: dataMultiRoot,
                                    command: dataCommand,
                                    cwd: dataCwd,
                                    shell: dataShell,
                                    channelName: dataChannelName,
                                    modelId: dataModelId,
                                    // steps / toolsUsed / agentInbox 保留给总结模型。
                                    ...dataRest
                                } = rest.data as Record<string, unknown>;

                                // data.results 数组中的每个元素同样剥离 diffContentId / pendingDiffId
                                if (Array.isArray(dataRest.results)) {
                                    dataRest.results = (dataRest.results as Array<Record<string, unknown>>).map(item => {
                                        if (item && typeof item === 'object' && !Array.isArray(item)) {
                                            const { diffContentId: itemDiffContentId, pendingDiffId: itemPendingDiffId, ...itemRest } = item;
                                            return itemRest;
                                        }
                                        return item;
                                    });
                                }

                                rest.data = dataRest;
                            }

                            cleanedPart = {
                                ...cleanedPart,
                                functionResponse: {
                                    ...cleanedPart.functionResponse,
                                    response: rest
                                }
                            };
                        }
                    }

                    return cleanedPart;
                })
                // 过滤掉清理后变成空的 parts
                .filter(part => {
                    if (part === null) return false;
                    const keys = Object.keys(part);
                    if (keys.length === 0) return false;
                    // 仅剩 thought: true/false 的空壳 part
                    if (keys.length === 1 && keys[0] === 'thought') return false;
                    return true;
                });

            // 跳过清理后 parts 为空的消息
            if (cleanedParts.length === 0) {
                return null;
            }

            // 保留消息的核心字段，移除不应发送给 API 的内部元数据
            const result: Content = {
                role: msg.role,
                parts: cleanedParts
            };

            // 保留总结消息标记（用于增量总结时 AI 理解上下文）
            if (msg.isSummary) {
                result.isSummary = msg.isSummary;
            }

            return result;
        }).filter((msg): msg is Content => msg !== null);
    }


    /**
     * 估算单条消息的 token 数（用于保留预算计算）
     *
     * 口径与 ContextTrimService.accumulateTokens 对齐：
     * - user 消息优先当前渠道的 tokenCountByChannel，其次 estimatedTokenCount，最后本地估算
     * - model 消息优先 usageMetadata（输出 token 扣除思考部分），否则本地估算
     */
    estimateMessageTokensForBudget(message: Content, channelType: string): number {
        // 中断/取消流的 usageMetadata 只覆盖已收到的 chunk，token 数可能严重偏低：
        // 若据此规划保留预算会低估实际占用、总结范围规划过大。
        // 与 conversation/usageStats.ts extractMessageTokens 及 manager/stats.ts
        // 的 usageMetadataPartial 回退口径一致——回退到本地估算而非信任半截 usage。
        if (message.usageMetadataPartial) {
            return this.estimateSingleMessageTokensLocally(message);
        }

        if (message.role === 'user') {
            const byChannel = message.tokenCountByChannel?.[channelType];
            if (typeof byChannel === 'number') {
                return byChannel;
            }
            if (typeof message.estimatedTokenCount === 'number') {
                return message.estimatedTokenCount;
            }
            return this.estimateSingleMessageTokensLocally(message);
        }

        const usage = message.usageMetadata;
        if (usage) {
            if (typeof usage.totalTokenCount === 'number' && typeof usage.promptTokenCount === 'number') {
                const outputTokens = Math.max(0, usage.totalTokenCount - usage.promptTokenCount);
                const thoughtsTokens = Math.min(Math.max(0, usage.thoughtsTokenCount ?? 0), outputTokens);
                return Math.max(0, outputTokens - thoughtsTokens);
            }
            if (typeof usage.candidatesTokenCount === 'number') {
                return Math.max(0, usage.candidatesTokenCount);
            }
        }
        return this.estimateSingleMessageTokensLocally(message);
    }


    /**
     * 本地估算单条消息的 token 数
     */
    estimateSingleMessageTokensLocally(message: Content): number {
        if (this.tokenEstimationService) {
            return this.tokenEstimationService.estimateMessageTokens(message);
        }
        // 兜底：无 tokenEstimationService 时按统一安全系数 1.5 偏大估算
        const text = message.parts.map(p => p.text || '').join('');
        return Math.ceil(Math.ceil(text.length / 4) * 1.5) || 1;
    }


    /**
     * 估算一组消息的 token 数
     *
     * 用于判断待总结内容是否超出总结模型上下文。
     * 口径与 resolveSummarizeRange 的预算估算（estimateMessageTokensForBudget）一致：
     * 优先 usageMetadata / tokenCountByChannel，缺失才本地估算，保证溢出判断与范围规划一致。
     *
     * @param channelType 当前渠道类型（tokenCountByChannel 的取值口径）
     */
    estimateMessagesTokens(messages: Content[], channelType: string): number {
        let total = 0;
        for (const msg of messages) {
            total += this.estimateMessageTokensForBudget(msg, channelType);
        }
        return total;
    }


    /**
     * 解析此前总结累计覆盖的原始消息数
     *
     * 从最后一个总结消息读取其 summarizedMessageCount（该值是截至该次总结的累计覆盖数）；
     * 若该字段缺失（历史数据不完整），则往前找更早的总结消息，取最近一个有该字段的累计值；
     * 仍找不到则回退 0。不再回退到数组下标——多条总结时下标与累计覆盖数不一致，会错算计数。
     */
    resolvePreviousSummarizedCount(fullHistory: Content[], lastSummaryIndex: number): number {
        if (lastSummaryIndex < 0) {
            return 0;
        }
        for (let i = lastSummaryIndex; i >= 0; i--) {
            const msg = fullHistory[i];
            if (!msg?.isSummary) {
                continue;
            }
            if (typeof msg.summarizedMessageCount === 'number') {
                return msg.summarizedMessageCount;
            }
        }
        return 0;
    }
}
