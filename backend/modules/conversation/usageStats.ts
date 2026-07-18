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
 */

import type { Content, ConversationMetadata } from './types';

/** 单个维度桶的 token 计数 */
export interface UsageBucket {
    /** 输入 token（各次请求 promptTokenCount 之和） */
    promptTokens: number;
    /** 输出 token */
    candidatesTokens: number;
    /** 思考 token */
    thoughtsTokens: number;
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
}

/** 单个对话的读取结果 */
interface LoadedConversation {
    metadata?: ConversationMetadata | null;
    messages: Content[];
}

/** 读取单个对话（失败返回 null，由调用方计入 skipped） */
async function loadOne(source: UsageStatsSource, conversationId: string): Promise<LoadedConversation | null> {
    try {
        const metadata = await source.getMetadata(conversationId);
        const messages = await source.getMessages(conversationId);
        return { metadata, messages };
    } catch {
        return null;
    }
}

/** 从消息中提取 token 计数（优先 usageMetadata，向后兼容旧字段） */
function extractMessageTokens(message: Content): { prompt: number; candidates: number; thoughts: number } | null {
    const usage = message.usageMetadata;
    const prompt = usage?.promptTokenCount ?? 0;
    const candidates = usage?.candidatesTokenCount ?? message.candidatesTokenCount ?? 0;
    const thoughts = usage?.thoughtsTokenCount ?? message.thoughtsTokenCount ?? 0;

    if (prompt === 0 && candidates === 0 && thoughts === 0) {
        return null;
    }
    return { prompt, candidates, thoughts };
}

function createBucket(): UsageBucket {
    return { promptTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, totalTokens: 0, modelMessages: 0 };
}

function addToBucket(bucket: UsageBucket, tokens: { prompt: number; candidates: number; thoughts: number }): void {
    bucket.promptTokens += tokens.prompt;
    bucket.candidatesTokens += tokens.candidates;
    bucket.thoughtsTokens += tokens.thoughts;
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

/** 判断消息是否通过时间范围筛选 */
function passesTimeFilter(message: Content, options?: UsageStatsOptions): boolean {
    const hasFilter = typeof options?.startTime === 'number' || typeof options?.endTime === 'number';
    if (!hasFilter) return true;

    const ts = message.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return false;
    if (typeof options?.startTime === 'number' && ts < options.startTime) return false;
    if (typeof options?.endTime === 'number' && ts > options.endTime) return false;
    return true;
}

/**
 * 聚合所有对话的 token 用量
 *
 * 单个对话读取失败时跳过并计入 skippedConversations，不影响整体统计。
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

    for (const conversationId of conversationIds) {
        const loaded = await loadOne(source, conversationId);
        if (loaded === null) {
            skippedConversations++;
            continue;
        }

        const conversationBucket = createBucket();

        for (const message of loaded.messages) {
            if (message.role !== 'model') continue;
            if (!passesTimeFilter(message, options)) continue;
            const tokens = extractMessageTokens(message);
            if (!tokens) continue;

            addToBucket(conversationBucket, tokens);
            addToBucket(totals, tokens);

            // 按模型
            const modelKey = (message.modelVersion || '').trim() || 'unknown';
            let modelBucket = modelBuckets.get(modelKey);
            if (!modelBucket) {
                modelBucket = createBucket();
                modelBuckets.set(modelKey, modelBucket);
            }
            addToBucket(modelBucket, tokens);

            // 按天（缺失时间戳的消息不计入该维度）
            if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && message.timestamp > 0) {
                const dayKey = toLocalDateKey(message.timestamp);
                let dayBucket = dayBuckets.get(dayKey);
                if (!dayBucket) {
                    dayBucket = createBucket();
                    dayBuckets.set(dayKey, dayBucket);
                }
                addToBucket(dayBucket, tokens);
            }
        }

        if (conversationBucket.modelMessages > 0) {
            conversationsWithUsage++;
            byConversation.push({
                conversationId,
                title: (loaded.metadata?.title || '').trim() || conversationId,
                updatedAt: loaded.metadata?.updatedAt ?? 0,
                ...conversationBucket
            });
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
