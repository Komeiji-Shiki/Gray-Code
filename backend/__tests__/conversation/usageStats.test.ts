/**
 * usageStats 聚合逻辑测试
 *
 * 覆盖：
 * - 各维度（总览 / 按对话 / 按模型 / 按天）的聚合正确性
 * - 旧字段（消息顶层 candidatesTokenCount / thoughtsTokenCount）向后兼容
 * - 读取失败对话的跳过计数
 * - 时间范围筛选（含缺失时间戳消息的排除语义）
 */

import {
    aggregateUsageStats,
    buildConversationUsageIndex,
    type UsageIndex,
    type UsageIndexStore,
    type UsageStatsSource
} from '../../modules/conversation/usageStats';
import type { Content, ConversationMetadata } from '../../modules/conversation/types';

/** 构造一条带用量的 model 消息 */
function modelMessage(overrides: {
    prompt?: number;
    candidates?: number;
    thoughts?: number;
    cacheCreation?: number;
    cacheRead?: number;
    modelVersion?: string;
    timestamp?: number;
}): Content {
    const message: Content = {
        role: 'model',
        parts: [{ text: 'reply' }],
        usageMetadata: {
            promptTokenCount: overrides.prompt ?? 0,
            candidatesTokenCount: overrides.candidates ?? 0,
            thoughtsTokenCount: overrides.thoughts ?? 0,
            ...(overrides.cacheCreation !== undefined ? { cacheCreationTokenCount: overrides.cacheCreation } : {}),
            ...(overrides.cacheRead !== undefined ? { cacheReadTokenCount: overrides.cacheRead } : {})
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
                    modelMessage({ prompt: 100, candidates: 50, thoughts: 10, cacheCreation: 30, cacheRead: 60, modelVersion: 'model-x', timestamp: day1 }),
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
        expect(stats.totals.cacheCreationTokens).toBe(30);
        expect(stats.totals.cacheReadTokens).toBe(60);
        // 缓存是 prompt 的细分，不重复计入 total
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
        expect(modelX?.cacheCreationTokens).toBe(30);
        expect(modelX?.cacheReadTokens).toBe(60);
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
        // 旧消息无缓存字段，缓存桶保持 0
        expect(stats.totals.cacheCreationTokens).toBe(0);
        expect(stats.totals.cacheReadTokens).toBe(0);

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

    test('旧格式（仅 cachedContentTokenCount）缓存合并值回退为命中', async () => {
        const legacy: Content = {
            role: 'model',
            parts: [{ text: 'old' }],
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 20,
                cachedContentTokenCount: 90
            } as Content['usageMetadata']
        };

        const source = createSource({
            'conv-legacy': {
                metadata: { title: 'Legacy' } as Partial<ConversationMetadata>,
                messages: [legacy]
            }
        });

        const stats = await aggregateUsageStats(source);
        expect(stats.totals.cacheCreationTokens).toBe(0);
        expect(stats.totals.cacheReadTokens).toBe(90);
        // 合并值已含在 prompt 中，不重复计入 total
        expect(stats.totals.totalTokens).toBe(120);
    });

    test('优先使用 getMessagesRaw 轻量读取，缺失时回退 getMessages', async () => {
        const rawMessage = modelMessage({ prompt: 5, candidates: 1, cacheRead: 4, modelVersion: 'model-x' });
        const rawSource = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'A' } as ConversationMetadata; },
            async getMessages() { throw new Error('getMessages should not be called'); },
            async getMessagesRaw() { return [rawMessage]; }
        } as UsageStatsSource;
        const rawStats = await aggregateUsageStats(rawSource);
        expect(rawStats.totals.promptTokens).toBe(5);
        expect(rawStats.totals.cacheReadTokens).toBe(4);

        // 不提供 getMessagesRaw 时回退 getMessages
        const fallbackMessage = modelMessage({ prompt: 7, candidates: 2, modelVersion: 'model-x' });
        const fallbackSource = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'A' } as ConversationMetadata; },
            async getMessages() { return [fallbackMessage]; }
        } as UsageStatsSource;
        const fallbackStats = await aggregateUsageStats(fallbackSource);
        expect(fallbackStats.totals.promptTokens).toBe(7);
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

describe('buildConversationUsageIndex', () => {
    test('提取有 token 的 model 消息，跳过 user 与无用量消息', () => {
        const day = atLocalNoon(2026, 3, 1);
        const history: Content[] = [
            userMessage(),
            modelMessage({ prompt: 100, candidates: 50, thoughts: 10, cacheCreation: 20, cacheRead: 30, modelVersion: '  model-x  ', timestamp: day }),
            // 无任何用量：不进入索引
            { role: 'model', parts: [{ text: 'empty' }] } as Content,
            // 缺时间戳：索引中省略 timestamp
            modelMessage({ prompt: 7, candidates: 3, modelVersion: 'model-y' })
        ];

        const index = buildConversationUsageIndex('conv-a', history);
        expect(index.version).toBe(1);
        expect(index.conversationId).toBe('conv-a');
        expect(index.messages).toHaveLength(2);
        expect(index.messages[0]).toEqual({
            timestamp: day,
            modelVersion: 'model-x',
            prompt: 100,
            candidates: 50,
            thoughts: 10,
            cacheCreation: 20,
            cacheRead: 30
        });
        expect(index.messages[1].timestamp).toBeUndefined();
        expect(index.messages[1].modelVersion).toBe('model-y');
    });

    test('中断/取消流的估算逻辑同样进入索引', () => {
        const partial: Content = {
            role: 'model',
            parts: [{ text: 'hello world' }],
            usageMetadataPartial: true,
            usageMetadata: { promptTokenCount: 10 } as Content['usageMetadata']
        } as Content;
        const index = buildConversationUsageIndex('conv-p', [partial]);
        expect(index.messages).toHaveLength(1);
        // candidates 回退到文本长度估算（5 字符 / 2.5 = 2）
        expect(index.messages[0].prompt).toBe(10);
        expect(index.messages[0].candidates).toBeGreaterThanOrEqual(2);
    });
});

/** 内存用量索引：以 historyMtime 与索引 updatedAt 的先后模拟文件 mtime 比较 */
function createMemoryIndexStore(seed: Record<string, { historyMtime: number; index?: UsageIndex }> = {}) {
    const entries = new Map<string, { historyMtime: number; index?: UsageIndex }>(Object.entries(seed));
    return {
        store: {
            async read(id: string): Promise<UsageIndex | null> {
                return entries.get(id)?.index ?? null;
            },
            async write(id: string, index: UsageIndex): Promise<void> {
                const e = entries.get(id) ?? { historyMtime: 0 };
                entries.set(id, { ...e, index });
            },
            async remove(id: string): Promise<void> {
                entries.delete(id);
            },
            async getFreshness(id: string): Promise<'fresh' | 'stale' | 'missing'> {
                const e = entries.get(id);
                if (!e?.index) return 'missing';
                return e.historyMtime > e.index.updatedAt ? 'stale' : 'fresh';
            }
        },
        entries
    };
}

describe('aggregateUsageStats 索引模式', () => {
    const day = atLocalNoon(2026, 4, 1);

    function buildSeedIndex(conversationId: string, updatedAt: number): { historyMtime: number; index: UsageIndex } {
        const index: UsageIndex = {
            version: 1,
            conversationId,
            updatedAt,
            messages: [
                { timestamp: day, modelVersion: 'model-x', prompt: 500, candidates: 250, thoughts: 0, cacheCreation: 0, cacheRead: 0 }
            ]
        };
        return {
            historyMtime: updatedAt - 1000, // 历史早于索引 ⇒ fresh
            index
        };
    }

    test('索引 fresh：直接聚合索引，完全不读历史消息', async () => {
        const seed = { 'conv-a': buildSeedIndex('conv-a', 10_000) };
        const { store } = createMemoryIndexStore(seed);
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha', updatedAt: 1000 } as ConversationMetadata; },
            // 索引命中时不应被调用：抛错验证
            async getMessages() { throw new Error('getMessages should not be called'); }
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, { indexStore: store });
        expect(stats.totals.promptTokens).toBe(500);
        expect(stats.totals.candidatesTokens).toBe(250);
        expect(stats.totals.modelMessages).toBe(1);
        expect(stats.byConversation[0].title).toBe('Alpha');
        expect(stats.byModel[0].modelVersion).toBe('model-x');
        expect(stats.byDay).toHaveLength(1);
    });

    test('索引 fresh 且时间筛选激活：按索引消息 timestamp 过滤', async () => {
        const early = atLocalNoon(2026, 3, 1);
        const inRange = atLocalNoon(2026, 4, 1);
        const seed = {
            'conv-a': {
                historyMtime: 9000,
                index: {
                    version: 1,
                    conversationId: 'conv-a',
                    updatedAt: 10_000,
                    messages: [
                        { timestamp: early, modelVersion: 'model-x', prompt: 1, candidates: 1, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                        { timestamp: inRange, modelVersion: 'model-x', prompt: 10, candidates: 10, thoughts: 0, cacheCreation: 0, cacheRead: 0 }
                    ]
                } as UsageIndex
            }
        };
        const { store } = createMemoryIndexStore(seed);
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { throw new Error('getMessages should not be called'); }
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, {
            indexStore: store,
            startTime: atLocalNoon(2026, 3, 15),
            endTime: atLocalNoon(2026, 4, 15)
        });
        expect(stats.totals.promptTokens).toBe(10);
        expect(stats.totals.modelMessages).toBe(1);
    });

    test('索引缺失：回退读历史并重建写回', async () => {
        const { store, entries } = createMemoryIndexStore();
        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                messages: [modelMessage({ prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day })]
            }
        });

        const stats = await aggregateUsageStats(source, { indexStore: store });
        expect(stats.totals.promptTokens).toBe(100);
        // 索引已写回
        const rebuilt = entries.get('conv-a')?.index;
        expect(rebuilt).toBeDefined();
        expect(rebuilt!.messages).toHaveLength(1);
        expect(rebuilt!.messages[0].prompt).toBe(100);

        // 第二次聚合：命中 fresh 索引，历史不再被读取
        const spyingSource = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { throw new Error('should hit index'); }
        } as UsageStatsSource;
        const stats2 = await aggregateUsageStats(spyingSource, { indexStore: store });
        expect(stats2.totals.promptTokens).toBe(100);
    });

    test('索引 stale（历史更新）：回退读历史并重建', async () => {
        const stale = buildSeedIndex('conv-a', 10_000);
        stale.historyMtime = 20_000; // 历史比索引新
        const { store, entries } = createMemoryIndexStore({ 'conv-a': stale });
        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                messages: [
                    modelMessage({ prompt: 300, candidates: 100, modelVersion: 'model-x', timestamp: day }),
                    modelMessage({ prompt: 50, candidates: 25, modelVersion: 'model-y', timestamp: day })
                ]
            }
        });

        const stats = await aggregateUsageStats(source, { indexStore: store });
        expect(stats.totals.promptTokens).toBe(350);
        expect(stats.byModel).toHaveLength(2);
        // 重建后的索引包含两条消息
        expect(entries.get('conv-a')!.index!.messages).toHaveLength(2);
    });

    test('索引损坏（fresh 但 read 返回 null）：回退历史并重建', async () => {
        let writeCount = 0;
        const brokenStore: UsageIndexStore = {
            async read() { return null; },
            async write() { writeCount++; },
            async remove() {},
            async getFreshness() { return 'fresh'; }
        };
        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                messages: [modelMessage({ prompt: 77, candidates: 33, modelVersion: 'model-x', timestamp: day })]
            }
        });

        const stats = await aggregateUsageStats(source, { indexStore: brokenStore });
        expect(stats.totals.promptTokens).toBe(77);
        expect(writeCount).toBe(1);
    });

    test('索引写回失败不影响统计结果', async () => {
        const failingStore: UsageIndexStore = {
            async read() { return null; },
            async write() { throw new Error('disk full'); },
            async remove() {},
            async getFreshness() { return 'missing'; }
        };
        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                messages: [modelMessage({ prompt: 5, candidates: 2, modelVersion: 'model-x', timestamp: day })]
            }
        });

        const stats = await aggregateUsageStats(source, { indexStore: failingStore });
        expect(stats.totals.promptTokens).toBe(5);
    });
});
