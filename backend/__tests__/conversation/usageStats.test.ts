/**
 * usageStats 聚合逻辑测试
 *
 * 覆盖：
 * - 各维度（总览 / 按对话 / 按模型 / 按天）的聚合正确性
 * - 旧字段（消息顶层 candidatesTokenCount / thoughtsTokenCount）向后兼容
 * - 读取失败对话的跳过计数
 * - 时间范围筛选（含缺失时间戳消息的排除语义）
 */

import { aggregateUsageStats, type UsageStatsSource } from '../../modules/conversation/usageStats';
import type { Content, ConversationMetadata } from '../../modules/conversation/types';

/** 构造一条带用量的 model 消息 */
function modelMessage(overrides: {
    prompt?: number;
    candidates?: number;
    thoughts?: number;
    modelVersion?: string;
    timestamp?: number;
}): Content {
    const message: Content = {
        role: 'model',
        parts: [{ text: 'reply' }],
        usageMetadata: {
            promptTokenCount: overrides.prompt ?? 0,
            candidatesTokenCount: overrides.candidates ?? 0,
            thoughtsTokenCount: overrides.thoughts ?? 0
        } as Content['usageMetadata']
    };
    if (overrides.modelVersion !== undefined) message.modelVersion = overrides.modelVersion;
    if (overrides.timestamp !== undefined) (message as any).timestamp = overrides.timestamp;
    return message;
}

function userMessage(): Content {
    return { role: 'user', parts: [{ text: 'hi' }] };
}

/** 构造内存数据源 */
function createSource(conversations: Record<string, { metadata?: Partial<ConversationMetadata> | null; messages: Content[]; failing?: boolean }>): UsageStatsSource {
    return {
        async listConversations() {
            return Object.keys(conversations);
        },
        async getMetadata(id: string) {
            const entry = conversations[id];
            if (entry?.failing) throw new Error('read error');
            return (entry?.metadata ?? null) as ConversationMetadata | null;
        },
        async getMessages(id: string) {
            const entry = conversations[id];
            if (entry?.failing) throw new Error('read error');
            return entry?.messages ?? [];
        }
    };
}

/** 某天本地 12:00 的毫秒时间戳 */
function atLocalNoon(year: number, month: number, day: number): number {
    return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

describe('aggregateUsageStats', () => {
    test('聚合总览、按对话、按模型、按天维度', async () => {
        const day1 = atLocalNoon(2026, 1, 10);
        const day2 = atLocalNoon(2026, 1, 11);

        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha', updatedAt: 1000 } as Partial<ConversationMetadata>,
                messages: [
                    userMessage(),
                    modelMessage({ prompt: 100, candidates: 50, thoughts: 10, modelVersion: 'model-x', timestamp: day1 }),
                    modelMessage({ prompt: 200, candidates: 100, modelVersion: 'model-y', timestamp: day2 })
                ]
            },
            'conv-b': {
                metadata: { title: '', updatedAt: 2000 } as Partial<ConversationMetadata>,
                messages: [
                    modelMessage({ prompt: 1000, candidates: 500, modelVersion: 'model-x', timestamp: day2 })
                ]
            }
        });

        const stats = await aggregateUsageStats(source);

        // 总览
        expect(stats.totals.promptTokens).toBe(1300);
        expect(stats.totals.candidatesTokens).toBe(650);
        expect(stats.totals.thoughtsTokens).toBe(10);
        expect(stats.totals.totalTokens).toBe(1960);
        expect(stats.totals.modelMessages).toBe(3);
        expect(stats.totals.conversations).toBe(2);
        expect(stats.totals.skippedConversations).toBe(0);

        // 按对话：降序排列；空标题回退为对话 ID
        expect(stats.byConversation).toHaveLength(2);
        expect(stats.byConversation[0].conversationId).toBe('conv-b');
        expect(stats.byConversation[0].totalTokens).toBe(1500);
        expect(stats.byConversation[1].title).toBe('Alpha');
        expect(stats.byConversation[0].title).toBe('conv-b');

        // 按模型：model-x 聚合两条消息
        const modelX = stats.byModel.find(m => m.modelVersion === 'model-x');
        expect(modelX?.promptTokens).toBe(1100);
        expect(modelX?.modelMessages).toBe(2);
        expect(stats.byModel[0].modelVersion).toBe('model-x');

        // 按天：两个日期桶
        expect(stats.byDay).toHaveLength(2);
        expect(stats.byDay[0].date > stats.byDay[1].date).toBe(true);
    });

    test('兼容旧字段并忽略无用量消息', async () => {
        const legacy: Content = {
            role: 'model',
            parts: [{ text: 'old' }],
            candidatesTokenCount: 40,
            thoughtsTokenCount: 5
        } as Content;

        const source = createSource({
            'conv-legacy': {
                metadata: { title: 'Legacy' } as Partial<ConversationMetadata>,
                messages: [
                    legacy,
                    // 无任何用量的 model 消息不参与统计
                    { role: 'model', parts: [{ text: 'empty' }] }
                ]
            }
        });

        const stats = await aggregateUsageStats(source);
        expect(stats.totals.candidatesTokens).toBe(40);
        expect(stats.totals.thoughtsTokens).toBe(5);
        expect(stats.totals.modelMessages).toBe(1);

        // 未记录 modelVersion 时归入 unknown
        expect(stats.byModel[0].modelVersion).toBe('unknown');
        // 缺失时间戳的消息不计入按天维度
        expect(stats.byDay).toHaveLength(0);
    });

    test('读取失败的对话计入 skippedConversations', async () => {
        const source = createSource({
            'conv-ok': {
                metadata: { title: 'OK' } as Partial<ConversationMetadata>,
                messages: [modelMessage({ prompt: 10, candidates: 5, modelVersion: 'model-x' })]
            },
            'conv-bad': { messages: [], failing: true }
        });

        const stats = await aggregateUsageStats(source);
        expect(stats.totals.skippedConversations).toBe(1);
        expect(stats.totals.conversations).toBe(1);
        expect(stats.totals.promptTokens).toBe(10);
    });

    test('时间范围筛选：仅统计范围内消息，缺时间戳消息被排除', async () => {
        const early = atLocalNoon(2026, 1, 1);
        const inRange = atLocalNoon(2026, 1, 10);
        const late = atLocalNoon(2026, 1, 20);

        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                messages: [
                    modelMessage({ prompt: 1, candidates: 1, modelVersion: 'model-x', timestamp: early }),
                    modelMessage({ prompt: 10, candidates: 10, modelVersion: 'model-x', timestamp: inRange }),
                    modelMessage({ prompt: 100, candidates: 100, modelVersion: 'model-x', timestamp: late }),
                    // 缺时间戳：筛选激活时被排除
                    modelMessage({ prompt: 1000, candidates: 1000, modelVersion: 'model-x' })
                ]
            }
        });

        const stats = await aggregateUsageStats(source, {
            startTime: atLocalNoon(2026, 1, 5),
            endTime: atLocalNoon(2026, 1, 15)
        });

        expect(stats.totals.promptTokens).toBe(10);
        expect(stats.totals.candidatesTokens).toBe(10);
        expect(stats.totals.modelMessages).toBe(1);
        expect(stats.byDay).toHaveLength(1);

        // 无筛选时全部统计（含缺时间戳消息）
        const allStats = await aggregateUsageStats(source);
        expect(allStats.totals.promptTokens).toBe(1111);
        expect(allStats.totals.modelMessages).toBe(4);
    });

    test('仅设置 startTime 的单边筛选', async () => {
        const before = atLocalNoon(2026, 2, 1);
        const after = atLocalNoon(2026, 2, 10);

        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                messages: [
                    modelMessage({ prompt: 1, candidates: 0, modelVersion: 'model-x', timestamp: before }),
                    modelMessage({ prompt: 2, candidates: 0, modelVersion: 'model-x', timestamp: after })
                ]
            }
        });

        const stats = await aggregateUsageStats(source, { startTime: atLocalNoon(2026, 2, 5) });
        expect(stats.totals.promptTokens).toBe(2);
        expect(stats.totals.modelMessages).toBe(1);
    });
});
