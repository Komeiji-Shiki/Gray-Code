/**
 * LimCode - 对话用量统计聚合
 *
 * 从已落盘的对话历史中回溯聚合 token 用量，
 * 数据来源为 model 消息上的 usageMetadata（含向后兼容的旧字段）：
 * - promptTokenCount: 每次请求的输入 token（计费口径，逐次累加）
 * - candidatesTokenCount: 输出 token
 * - thoughtsTokenCount: 思考 token
 *
 * 维度：
 * - 总览（totals）
 * - 按对话（byConversation）
 * - 按模型（byModel，以 modelVersion 近似渠道维度）
 * - 按天（byDay，基于消息 timestamp 的本地日期；缺失时间戳的消息只计入其他维度）
 *
 * 性能：全量扫描历史 JSON 的开销随对话数增长明显，统计页可提供 UsageIndexStore
 * （消息级 token 索引，见 UsageIndexStore.ts）。聚合器对每个对话先查索引新鲜度：
 * - fresh：直接聚合索引消息，完全不读历史文件；
 * - missing/stale：回退读取历史并重建写回索引（一次性成本，之后走索引）。
 */

import type { Content, ConversationMetadata } from './types';

/** 单个维度桶的 token 计数 */
export interface UsageBucket {
    /** 输入 token（各次请求 promptTokenCount 之和，已含缓存部分） */
    promptTokens: number;
    /** 输出 token */
    candidatesTokens: number;
    /** 思考 token */
    thoughtsTokens: number;
    /** 缓存写入 token（cacheCreationTokenCount 之和；是 promptTokens 的细分，不重复计入 totalTokens） */
    cacheCreationTokens: number;
    /** 缓存命中 token（cacheReadTokenCount 之和；是 promptTokens 的细分，不重复计入 totalTokens） */
    cacheReadTokens: number;
    /** 合计（prompt + candidates + thoughts） */
    totalTokens: number;
    /** 参与统计的 model 消息数 */
    modelMessages: number;
}

export interface ConversationUsage extends UsageBucket {
    conversationId: string;
    title: string;
    /** 最后更新时间（毫秒） */
    updatedAt: number;
    /**
     * 子代理归集消耗（prompt + candidates + thoughts，仅当该对话存在 subagent 条目时出现）。
     * 已包含在 totalTokens 中，仅作细分展示。
     */
    subagentTokens?: number;
}

export interface ModelUsage extends UsageBucket {
    /** 模型标识（modelVersion），未记录时为 'unknown' */
    modelVersion: string;
}

export interface DailyUsage extends UsageBucket {
    /** 本地日期，格式 YYYY-MM-DD */
    date: string;
}

export interface UsageStatsResult {
    totals: UsageBucket & {
        /** 参与统计的对话数 */
        conversations: number;
        /** 读取失败被跳过的对话数 */
        skippedConversations: number;
    };
    byConversation: ConversationUsage[];
    byModel: ModelUsage[];
    byDay: DailyUsage[];
    /** 统计生成时间（毫秒） */
    generatedAt: number;
}

/** 聚合器对数据源的最小依赖（ConversationManager 结构上满足） */
export interface UsageStatsSource {
    listConversations(): Promise<string[]>;
    getMetadata(conversationId: string): Promise<ConversationMetadata | null | undefined>;
    getMessages(conversationId: string): Promise<Content[]>;
    /** 可选：轻量读取原始消息（不经显示规范化/深拷贝），聚合器优先使用以降低全量扫描开销 */
    getMessagesRaw?(conversationId: string): Promise<Content[]>;
}

/** 用量索引中的单条消息级 token 记录（extractMessageTokens 提取后的扁平结构） */
export interface UsageIndexMessage {
    /** 消息时间戳（毫秒）；缺失/无效时省略，时间筛选激活时不参与统计 */
    timestamp?: number;
    /** 模型标识（trim 后原始值；聚合端缺失时兜底 'unknown'） */
    modelVersion?: string;
    prompt: number;
    candidates: number;
    thoughts: number;
    cacheCreation: number;
    cacheRead: number;
    /**
     * 条目来源（可选）：
     * - main（缺省）：从主会话历史提取的 model 消息；
     * - subagent：子代理消耗 token 的归集条目（不入主历史，由 executor 单独追加）。
     *
     * 修改原因：子代理 token 需要归集到发起它的主会话统计页，同时全量重建索引时
     *          必须保留这些不在历史里的条目，避免统计波动。
     */
    source?: UsageIndexMessageSource;
}

/** 单个对话的用量索引（消息级 token 明细，落盘打点维护，统计时直接聚合） */
export interface UsageIndex {
    version: 1;
    conversationId: string;
    /** 索引生成时间（毫秒） */
    updatedAt: number;
    messages: UsageIndexMessage[];
}

/** 用量索引条目来源：main=主会话消息（默认），subagent=子代理归集条目（不入主历史） */
export type UsageIndexMessageSource = 'main' | 'subagent';

/** 索引新鲜度：fresh=历史未再改动；stale=历史比索引新；missing=索引不存在 */
export type UsageIndexFreshness = 'fresh' | 'stale' | 'missing';

/**
 * 用量索引存取接口
 *
 * 文件实现见 UsageIndexStore.ts；测试使用内存实现。
 * getFreshness 用于在读取前判断索引是否仍与历史一致：
 * 历史文件（legacy {id}.json 或 segmented {id}/history.index.json）mtime 新于索引即 stale。
 */
export interface UsageIndexStore {
    read(conversationId: string): Promise<UsageIndex | null>;
    write(conversationId: string, index: UsageIndex): Promise<void>;
    remove(conversationId: string): Promise<void>;
    getFreshness(conversationId: string): Promise<UsageIndexFreshness>;
    /**
     * 可选：增量维护用量索引（HIS-08）。
     * 普通追加助手消息时只更新对应用量条目；返回 false 表示增量不可用
     * （索引缺失/损坏），调用方回退全量重建。
     */
    appendUsage?(conversationId: string, appended: Content[]): Promise<boolean>;

    /**
     * 可选：追加已提取好的用量索引条目（子代理归集用，不入对话历史）。
     * 与 appendUsage 的区别：输入已是 UsageIndexMessage（通常带 source='subagent'），
     * 不再做 Content 提取；索引缺失/损坏时返回 false，调用方决定回退策略。
     */
    appendUsageMessages?(conversationId: string, messages: UsageIndexMessage[]): Promise<boolean>;
}

/**
 * 聚合选项：时间范围过滤（毫秒时间戳，含端点）
 *
 * 任一边界生效时，仅统计带有有效 timestamp 且落在范围内的消息；
 * 缺失时间戳的消息在筛选激活时不参与任何维度的统计。
 */
export interface UsageStatsOptions {
    startTime?: number;
    endTime?: number;
    /** 可选：消息级用量索引，命中时跳过历史文件读取（见 loadOne） */
    indexStore?: UsageIndexStore;
}

/** 单个对话的读取结果 */
interface LoadedConversation {
    metadata?: ConversationMetadata | null;
    messages: Content[];
    /** 索引路径：命中新鲜索引时消息明细已提取到 index（messages 为空数组） */
    index?: UsageIndex | null;
}

/**
 * 对中断/取消流的半截 usageMetadata 做保守估算。
 *
 * usageMetadataPartial 为 true 表示 usageMetadata 只覆盖已收到的 chunk
 * （流被取消/网络中断时截断的半截数据），token 数可能严重偏低；
 * 统计端应回退到估算而非信任 usageMetadata。
 * 估算基于消息文本长度：中文等 CJK 约 1 字符/token，英文约 4 字符/token，
 * 取折中 2.5 字符/token 做粗估。
 */
export function estimatePartialMessageTokens(message: Content): { prompt: number; candidates: number; thoughts: number; cacheCreation: number; cacheRead: number } | null {
    const usage = message.usageMetadata;

    let charCount = 0;
    for (const part of message.parts ?? []) {
        if (typeof part.text === 'string') {
            charCount += part.text.length;
        }
        if (part.redactedThinking) {
            charCount += part.redactedThinking.length;
        }
        // functionCall 的 JSON 参数也是模型输出 token（工具调用密集的取消流不应低估）
        if (part.functionCall) {
            try {
                const argsStr = typeof part.functionCall.args === 'string'
                    ? part.functionCall.args
                    : JSON.stringify(part.functionCall.args ?? '');
                charCount += argsStr.length;
            } catch {
                // 忽略序列化失败
            }
        }
    }
    const estimatedCandidates = Math.max(1, Math.ceil(charCount / 2.5));

    // 取消流可能从未收到任何 usage 事件（OpenAI chat / Gemini 的 usage 只在最后
    // 一个 chunk 送达，取消时通常没有）：此时 usageMetadata 为 undefined，也不能
    // 返回 null——否则整条 model 消息被跳过（连 prompt 都不计），M6 声称修复的
    // "中断/取消流 token 严重少计" 只在 Anthropic 类每 chunk 带 usage 的渠道生效。
    // prompt 侧无法从消息文本估算（输入是全量历史+系统提示词），保守记 0。
    // 旧格式（无拆分字段）的缓存合并值近似全部记为命中：OpenAI/Gemini 语义下
    // cachedContentTokenCount 本就是命中；Anthropic 以命中为主，偏差最小。
    const hasSplitCache = usage?.cacheCreationTokenCount !== undefined || usage?.cacheReadTokenCount !== undefined;
    return {
        prompt: usage?.promptTokenCount ?? 0,
        candidates: Math.max(usage?.candidatesTokenCount ?? 0, estimatedCandidates),
        thoughts: usage?.thoughtsTokenCount ?? 0,
        cacheCreation: usage?.cacheCreationTokenCount ?? 0,
        cacheRead: usage?.cacheReadTokenCount ?? (hasSplitCache ? 0 : usage?.cachedContentTokenCount ?? 0)
    };
}

/**
 * 读取单个对话（失败返回 null，由调用方计入 skipped）
 *
 * 提供 indexStore 时优先走索引：
 * - 索引 fresh（历史未被改动）→ 直接返回索引消息，完全不读历史文件；
 * - 索引缺失/过期/损坏 → 回退读取历史，由调用方负责重建写回索引。
 */
async function loadOne(source: UsageStatsSource, conversationId: string, indexStore?: UsageIndexStore): Promise<LoadedConversation | null> {
    if (indexStore) {
        try {
            const freshness = await indexStore.getFreshness(conversationId);
            if (freshness === 'fresh') {
                const index = await indexStore.read(conversationId);
                if (index && Array.isArray(index.messages)) {
                    const metadata = await source.getMetadata(conversationId);
                    return { metadata, messages: [], index };
                }
            }
        } catch {
            // 索引读失败（含 metadata 失败）：回退历史路径
        }
    }
    try {
        const metadata = await source.getMetadata(conversationId);
        const messages = typeof source.getMessagesRaw === 'function'
            ? await source.getMessagesRaw(conversationId)
            : await source.getMessages(conversationId);
        return { metadata, messages };
    } catch {
        return null;
    }
}

/**
 * 限流并发执行：同时最多 concurrency 个任务在途。
 * 用量统计需要逐个读取全部对话，串行 IO 在对话多时耗时明显；
 * 并发受限于文件句柄与内存，取一个适中的并发上限。
 */
async function runBounded<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (next < items.length) {
            const index = next++;
            await task(items[index]);
        }
    }));
}

/** 从消息中提取 token 计数（优先 usageMetadata，向后兼容旧字段） */
export function extractMessageTokens(message: Content): { prompt: number; candidates: number; thoughts: number; cacheCreation: number; cacheRead: number } | null {
    // 中断/取消流的 usageMetadata 只覆盖已收到的 chunk，token 严重偏低：
    // 回退到文本长度估算，避免统计结果与真实消耗偏差过大。
    if (message.usageMetadataPartial) {
        return estimatePartialMessageTokens(message);
    }

    const usage = message.usageMetadata;
    const prompt = usage?.promptTokenCount ?? 0;
    const candidates = usage?.candidatesTokenCount ?? message.candidatesTokenCount ?? 0;
    const thoughts = usage?.thoughtsTokenCount ?? message.thoughtsTokenCount ?? 0;
    // 旧格式（仅合并值 cachedContentTokenCount）无法拆分写入/命中，近似全部记为命中
    const hasSplitCache = usage?.cacheCreationTokenCount !== undefined || usage?.cacheReadTokenCount !== undefined;
    const cacheCreation = usage?.cacheCreationTokenCount ?? 0;
    const cacheRead = usage?.cacheReadTokenCount ?? (hasSplitCache ? 0 : usage?.cachedContentTokenCount ?? 0);

    if (prompt === 0 && candidates === 0 && thoughts === 0) {
        return null;
    }
    return { prompt, candidates, thoughts, cacheCreation, cacheRead };
}

/**
 * 从对话历史构建用量索引（纯函数）。
 *
 * 供两处复用：消息落盘打点（ConversationManager 保存后）与统计侧索引缺失/过期时的重建。
 * 只保留有 token 计数的 model 消息，与统计语义一致；
 * 时间戳无效的消息省略 timestamp（筛选激活时不计入，与统计端一致）。
 */
export function buildConversationUsageIndex(conversationId: string, history: Content[]): UsageIndex {
    const messages: UsageIndexMessage[] = [];
    for (const message of history) {
        if (message.role !== 'model') continue;
        const tokens = extractMessageTokens(message);
        if (!tokens) continue;
        const ts = message.timestamp;
        messages.push({
            timestamp: (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) ? ts : undefined,
            modelVersion: (message.modelVersion || '').trim(),
            ...tokens
        });
    }
    return { version: 1, conversationId, updatedAt: Date.now(), messages };
}

function createBucket(): UsageBucket {
    return { promptTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, modelMessages: 0 };
}

function addToBucket(bucket: UsageBucket, tokens: { prompt: number; candidates: number; thoughts: number; cacheCreation: number; cacheRead: number }): void {
    bucket.promptTokens += tokens.prompt;
    bucket.candidatesTokens += tokens.candidates;
    bucket.thoughtsTokens += tokens.thoughts;
    bucket.cacheCreationTokens += tokens.cacheCreation;
    bucket.cacheReadTokens += tokens.cacheRead;
    bucket.totalTokens += tokens.prompt + tokens.candidates + tokens.thoughts;
    bucket.modelMessages += 1;
}

/** 将毫秒时间戳格式化为本地日期 YYYY-MM-DD */
function toLocalDateKey(timestamp: number): string {
    const d = new Date(timestamp);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** 判断消息/索引记录是否通过时间范围筛选（timestamp 缺失或无效时不通过） */
function passesTimeFilter(record: { timestamp?: unknown }, options?: UsageStatsOptions): boolean {
    const hasFilter = typeof options?.startTime === 'number' || typeof options?.endTime === 'number';
    if (!hasFilter) return true;

    const ts = record.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return false;
    if (typeof options?.startTime === 'number' && ts < options.startTime) return false;
    if (typeof options?.endTime === 'number' && ts > options.endTime) return false;
    return true;
}

/**
 * 累加一条消息级 token 记录到各维度桶（索引消息与历史消息共用）。
 * 时间范围筛选在此统一执行：缺时间戳的记录在筛选激活时不参与统计。
 */
function accumulateRecord(
    conversationBucket: UsageBucket,
    totals: UsageBucket,
    modelBuckets: Map<string, UsageBucket>,
    dayBuckets: Map<string, UsageBucket>,
    record: UsageIndexMessage,
    options?: UsageStatsOptions
): void {
    if (!passesTimeFilter(record, options)) return;

    const tokens = {
        prompt: record.prompt,
        candidates: record.candidates,
        thoughts: record.thoughts,
        cacheCreation: record.cacheCreation,
        cacheRead: record.cacheRead
    };
    addToBucket(conversationBucket, tokens);
    addToBucket(totals, tokens);

    // 按模型
    const modelKey = (record.modelVersion || '').trim() || 'unknown';
    let modelBucket = modelBuckets.get(modelKey);
    if (!modelBucket) {
        modelBucket = createBucket();
        modelBuckets.set(modelKey, modelBucket);
    }
    addToBucket(modelBucket, tokens);

    // 按天（缺失时间戳的消息不计入该维度）
    if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) && record.timestamp > 0) {
        const dayKey = toLocalDateKey(record.timestamp);
        let dayBucket = dayBuckets.get(dayKey);
        if (!dayBucket) {
            dayBucket = createBucket();
            dayBuckets.set(dayKey, dayBucket);
        }
        addToBucket(dayBucket, tokens);
    }
}

/**
 * 聚合所有对话的 token 用量
 *
 * 单个对话读取失败时跳过并计入 skippedConversations，不影响整体统计。
 * 提供 options.indexStore 时：索引 fresh 的对话直接聚合索引（不读历史文件），
 * 索引缺失/过期/损坏的对话回退读取历史并在统计完成后重建写回索引。
 */
export async function aggregateUsageStats(source: UsageStatsSource, options?: UsageStatsOptions): Promise<UsageStatsResult> {
    const totals = createBucket();
    let skippedConversations = 0;
    let conversationsWithUsage = 0;

    const byConversation: ConversationUsage[] = [];
    const modelBuckets = new Map<string, UsageBucket>();
    const dayBuckets = new Map<string, UsageBucket>();

    let conversationIds: string[] = [];
    try {
        conversationIds = await source.listConversations();
    } catch {
        conversationIds = [];
    }

    // 并发读取各对话（限流避免一次性打开过多文件），结果按原顺序消费。
    // 提供 indexStore 时优先读轻量用量索引，缺失/过期再回退历史（见 loadOne）。
    const indexStore = options?.indexStore;
    const loadedMap = new Map<string, LoadedConversation | null>();
    await runBounded(conversationIds, 12, async (conversationId) => {
        loadedMap.set(conversationId, await loadOne(source, conversationId, indexStore));
    });

    for (const conversationId of conversationIds) {
        const loaded = loadedMap.get(conversationId) ?? null;
        if (loaded === null) {
            skippedConversations++;
            continue;
        }

        const conversationBucket = createBucket();
        // 子代理归集消耗（source='subagent' 的条目；与时间筛选保持同一口径）
        let conversationSubagentTokens = 0;

        if (loaded.index) {
            // 索引路径：token 记录已提取，直接累加
            for (const record of loaded.index.messages) {
                accumulateRecord(conversationBucket, totals, modelBuckets, dayBuckets, record, options);
                if (record.source === 'subagent' && passesTimeFilter(record, options)) {
                    conversationSubagentTokens += record.prompt + record.candidates + record.thoughts;
                }
            }
        } else {
            // 历史路径：逐条提取并累加
            for (const message of loaded.messages) {
                if (message.role !== 'model') continue;
                const tokens = extractMessageTokens(message);
                if (!tokens) continue;
                accumulateRecord(conversationBucket, totals, modelBuckets, dayBuckets, {
                    timestamp: message.timestamp,
                    modelVersion: message.modelVersion,
                    ...tokens
                }, options);
            }
            // 索引缺失/过期：重建写回（失败不影响本次统计，下次仍会走重建）。
            // 子代理归集条目不在主历史里：重建时从旧索引合并保留，并把它们计入本次统计
            // （统计语义 = 主会话历史 + 已归集的子代理消耗，避免重建当次出现波动）。
            if (indexStore) {
                try {
                    const rebuilt = buildConversationUsageIndex(conversationId, loaded.messages);
                    const previous = await indexStore.read(conversationId);
                    if (previous && Array.isArray(previous.messages)) {
                        const subagentEntries = previous.messages.filter(m => m.source === 'subagent');
                        for (const record of subagentEntries) {
                            accumulateRecord(conversationBucket, totals, modelBuckets, dayBuckets, record, options);
                            if (passesTimeFilter(record, options)) {
                                conversationSubagentTokens += record.prompt + record.candidates + record.thoughts;
                            }
                        }
                        if (subagentEntries.length > 0) {
                            rebuilt.messages.push(...subagentEntries);
                        }
                    }
                    await indexStore.write(conversationId, rebuilt);
                } catch {
                    // 忽略索引写失败
                }
            }
        }

        if (conversationBucket.modelMessages > 0) {
            conversationsWithUsage++;
            const usage: ConversationUsage = {
                conversationId,
                title: (loaded.metadata?.title || '').trim() || conversationId,
                updatedAt: loaded.metadata?.updatedAt ?? 0,
                ...conversationBucket
            };
            if (conversationSubagentTokens > 0) {
                usage.subagentTokens = conversationSubagentTokens;
            }
            byConversation.push(usage);
        }
    }

    // 排序：对话/模型按用量降序，日期按时间降序
    byConversation.sort((a, b) => b.totalTokens - a.totalTokens);

    const byModel: ModelUsage[] = [...modelBuckets.entries()]
        .map(([modelVersion, bucket]) => ({ modelVersion, ...bucket }))
        .sort((a, b) => b.totalTokens - a.totalTokens);

    const byDay: DailyUsage[] = [...dayBuckets.entries()]
        .map(([date, bucket]) => ({ date, ...bucket }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));

    return {
        totals: {
            ...totals,
            conversations: conversationsWithUsage,
            skippedConversations
        },
        byConversation,
        byModel,
        byDay,
        generatedAt: Date.now()
    };
}
