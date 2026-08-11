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
    extractBranchUsageMessages,
    type UsageIndex,
    type UsageIndexMessage,
    type UsageIndexStore,
    type UsageStatsSource
} from '../../modules/conversation/usageStats';
import { UsageStatsCache, type UsageConversationEntry } from '../../modules/conversation/usageCache';
import { createEmptyBranchGraph, importLinearHistory, insertNode, rerollCandidate } from '../../modules/conversation/branch/BranchGraph';
import type { ConversationBranchGraph, ConversationBranchNode } from '../../modules/conversation/branch/types';
import type { Content, ConversationMetadata } from '../../modules/conversation';

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
function createSource(conversations: Record<string, { metadata?: Partial<ConversationMetadata> | null; messages: Content[]; failing?: boolean; messagesFailing?: boolean }>): UsageStatsSource {
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
            if (entry?.failing || entry?.messagesFailing) throw new Error('read error');
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
        // 明细含被跳过的对话；meta 也读取失败时标题回退为 conversationId
        expect(stats.totals.skippedConversationDetails).toEqual([
            { conversationId: 'conv-bad', title: 'conv-bad' }
        ]);
    });

    test('读取失败时尽力提供对话标题（meta 可读时）', async () => {
        const source = createSource({
            'conv-broken': {
                metadata: { title: 'Broken Conversation' } as Partial<ConversationMetadata>,
                messages: [],
                messagesFailing: true
            }
        });

        const stats = await aggregateUsageStats(source);
        expect(stats.totals.skippedConversations).toBe(1);
        expect(stats.totals.skippedConversationDetails).toEqual([
            { conversationId: 'conv-broken', title: 'Broken Conversation' }
        ]);
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


describe('aggregateUsageStats 内存缓存模式', () => {
    const day = atLocalNoon(2026, 5, 1);

    /** 构造含 conv-a 一条缓存条目的内存缓存 */
    function seedCache(messages: UsageIndexMessage[], overrides: Partial<UsageConversationEntry> = {}): UsageStatsCache {
        const cache = new UsageStatsCache();
        cache.set('conv-a', { title: 'Cached', updatedAt: 1000, messages, ...overrides });
        return cache;
    }

    test('缓存命中：跳过全部文件读取', async () => {
        const cache = seedCache([
            { timestamp: day, modelVersion: 'model-x', prompt: 500, candidates: 250, thoughts: 0, cacheCreation: 0, cacheRead: 0 }
        ]);
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { throw new Error('getMetadata should not be called'); },
            async getMessages() { throw new Error('getMessages should not be called'); },
            async getMessagesRaw() { throw new Error('getMessagesRaw should not be called'); }
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, { cache });
        expect(stats.totals.promptTokens).toBe(500);
        expect(stats.totals.candidatesTokens).toBe(250);
        expect(stats.totals.conversations).toBe(1);
        expect(stats.byConversation[0].title).toBe('Cached');
        expect(stats.byConversation[0].updatedAt).toBe(1000);
        expect(stats.byModel[0].modelVersion).toBe('model-x');
        expect(stats.byDay).toHaveLength(1);
    });

    test('dirty 对话重新读取并回填缓存，dirty 集合被消费', async () => {
        const cache = seedCache([{ prompt: 1, candidates: 0, thoughts: 0, cacheCreation: 0, cacheRead: 0 }]);
        cache.markDirty('conv-a');
        let readCount = 0;
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { readCount++; return { title: 'New', updatedAt: 2000 } as ConversationMetadata; },
            async getMessages() { readCount++; return [modelMessage({ prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day })]; }
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, { cache });
        expect(readCount).toBe(2);
        expect(stats.totals.promptTokens).toBe(100);
        expect(stats.byConversation[0].title).toBe('New');
        // 缓存已回填为最新明细，且 dirty 已消费
        const entry = cache.get('conv-a')!;
        expect(entry.title).toBe('New');
        expect(entry.updatedAt).toBe(2000);
        expect(entry.messages[0].prompt).toBe(100);
        expect(cache.takeDirty()).toHaveLength(0);
    });

    test('已删除对话从缓存清理', async () => {
        const cache = seedCache([]);
        cache.set('conv-b', { title: 'B', updatedAt: 0, messages: [] });
        const source = {
            async listConversations() { return ['conv-b']; },
            async getMetadata() { return null; },
            async getMessages() { return []; }
        } as UsageStatsSource;

        await aggregateUsageStats(source, { cache });
        expect(cache.has('conv-a')).toBe(false);
        expect(cache.has('conv-b')).toBe(true);
    });

    test('缓存 + 时间筛选：按缓存消息 timestamp 过滤', async () => {
        const early = atLocalNoon(2026, 4, 1);
        const inRange = atLocalNoon(2026, 5, 1);
        const cache = seedCache([
            { timestamp: early, modelVersion: 'model-x', prompt: 1, candidates: 1, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
            { timestamp: inRange, modelVersion: 'model-x', prompt: 10, candidates: 10, thoughts: 0, cacheCreation: 0, cacheRead: 0 }
        ]);
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { throw new Error('getMetadata should not be called'); },
            async getMessages() { throw new Error('getMessages should not be called'); }
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, {
            cache,
            startTime: atLocalNoon(2026, 4, 15),
            endTime: atLocalNoon(2026, 5, 15)
        });
        expect(stats.totals.promptTokens).toBe(10);
        expect(stats.totals.modelMessages).toBe(1);
    });
});

describe('aggregateUsageStats 子代理归集（source=subagent）', () => {
    const day = atLocalNoon(2026, 6, 1);

    test('索引 fresh：subagent 条目计入总览与按对话，且 ConversationUsage 提供 subagentTokens 细分', async () => {
        const seed = {
            'conv-a': {
                historyMtime: 9000,
                index: {
                    version: 1,
                    conversationId: 'conv-a',
                    updatedAt: 10_000,
                    messages: [
                        // 主会话消息（无 source）
                        { timestamp: day, modelVersion: 'model-x', prompt: 500, candidates: 250, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                        // 子代理归集条目
                        { timestamp: day, modelVersion: 'model-y', prompt: 100, candidates: 50, thoughts: 10, cacheCreation: 20, cacheRead: 30, source: 'subagent' }
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

        const stats = await aggregateUsageStats(source, { indexStore: store });

        // 总览包含 subagent 消耗（prompt 600 = 500 + 100）
        expect(stats.totals.promptTokens).toBe(600);
        expect(stats.totals.candidatesTokens).toBe(300);
        expect(stats.totals.thoughtsTokens).toBe(10);
        expect(stats.totals.cacheCreationTokens).toBe(20);
        expect(stats.totals.cacheReadTokens).toBe(30);
        expect(stats.totals.modelMessages).toBe(2);
        expect(stats.totals.totalTokens).toBe(910);

        // 按对话包含 subagent 消耗，并提供细分
        expect(stats.byConversation).toHaveLength(1);
        expect(stats.byConversation[0].totalTokens).toBe(910);
        expect(stats.byConversation[0].subagentTokens).toBe(160); // 100 + 50 + 10

        // 按模型：subagent 的 model-y 也进入维度
        expect(stats.byModel.find(m => m.modelVersion === 'model-y')?.promptTokens).toBe(100);
    });

    test('索引 stale 重建时保留已有 subagent 条目，统计不丢子代理消耗', async () => {
        const stale = {
            historyMtime: 20_000,
            index: {
                version: 1,
                conversationId: 'conv-a',
                updatedAt: 10_000,
                messages: [
                    { timestamp: day, modelVersion: 'model-y', prompt: 100, candidates: 50, thoughts: 10, cacheCreation: 0, cacheRead: 0, source: 'subagent' }
                ]
            } as UsageIndex
        };
        const { store, entries } = createMemoryIndexStore({ 'conv-a': stale });
        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                // 历史里只有主会话消息，没有 subagent 条目
                messages: [modelMessage({ prompt: 300, candidates: 100, modelVersion: 'model-x', timestamp: day })]
            }
        });

        const stats = await aggregateUsageStats(source, { indexStore: store });

        // 统计 = 历史主会话 + 旧索引保留的 subagent
        expect(stats.totals.promptTokens).toBe(400);
        expect(stats.totals.modelMessages).toBe(2);
        expect(stats.byConversation[0].subagentTokens).toBe(160);

        // 重建后的索引同时包含主会话消息与保留的 subagent 条目
        const rebuilt = entries.get('conv-a')!.index!;
        expect(rebuilt.messages).toHaveLength(2);
        expect(rebuilt.messages.some(m => m.source === 'subagent')).toBe(true);
        expect(rebuilt.messages.some(m => m.modelVersion === 'model-x')).toBe(true);
    });

    test('索引缺失重建时无旧 subagent 条目，不影响既有重建行为', async () => {
        const { store, entries } = createMemoryIndexStore();
        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                messages: [modelMessage({ prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day })]
            }
        });

        const stats = await aggregateUsageStats(source, { indexStore: store });
        expect(stats.totals.promptTokens).toBe(100);
        const rebuilt = entries.get('conv-a')!.index!;
        expect(rebuilt.messages).toHaveLength(1);
        expect(rebuilt.messages[0].source).toBeUndefined();
    });
});

describe('aggregateUsageStats 队列内重建（R2 1.1 / 2.1）', () => {
    const day = atLocalNoon(2026, 7, 1);

    /** 带 rebuild 的内存索引：rebuild 立即执行 build（回调内可模拟队列内重读最新历史） */
    function createRebuildingMemoryIndexStore(seed: Record<string, { historyMtime: number; index?: UsageIndex }> = {}) {
        const entries = new Map<string, { historyMtime: number; index?: UsageIndex }>(Object.entries(seed));
        const store = {
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
            },
            async rebuild(id: string, build: (previous: UsageIndex | null) => Promise<UsageIndex> | UsageIndex): Promise<UsageIndex> {
                const e = entries.get(id);
                const next = await build(e?.index ?? null);
                entries.set(id, { historyMtime: 0, index: next });
                return next;
            }
        };
        return { store, entries };
    }

    test('重建回调在队列内重读最新历史：并发落盘的 main 条目不被重建覆盖（R2 1.1）', async () => {
        const { store, entries } = createRebuildingMemoryIndexStore();
        let historyReads = 0;
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { return []; },
            async getMessagesRaw() {
                historyReads++;
                if (historyReads === 1) {
                    // loadOne 读到的 H0：只有 1 条 main 消息
                    return [modelMessage({ prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day })];
                }
                // 重建回调在队列内重读：已包含并发追加的第 2 条 main 消息
                return [
                    modelMessage({ prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day }),
                    modelMessage({ prompt: 200, candidates: 100, modelVersion: 'model-x', timestamp: day })
                ];
            }
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, { indexStore: store });
        // 重建回调在队列内重读到最新历史：本次统计即包含并发落盘的 main 条目（300）
        expect(stats.totals.promptTokens).toBe(300);
        expect(stats.totals.modelMessages).toBe(2);
        // 落盘索引包含并发落盘的 main 条目（R2 1.1 修复目标：不静默覆盖丢失）
        const rebuilt = entries.get('conv-a')!.index!;
        expect(rebuilt.messages).toHaveLength(2);
        expect(rebuilt.messages.map(m => m.prompt).sort((a, b) => a - b)).toEqual([100, 200]);

        // 下次统计（索引 fresh）：全部计入，不再读历史
        const stats2 = await aggregateUsageStats({
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { throw new Error('should hit index'); },
            async getMessagesRaw() { throw new Error('should hit index'); }
        } as UsageStatsSource, { indexStore: store });
        expect(stats2.totals.promptTokens).toBe(300);
    });

    test('重建路径缓存回填包含 subagent 合并条目（R2 2.1）', async () => {
        const stale = {
            historyMtime: 20_000,
            index: {
                version: 1,
                conversationId: 'conv-a',
                updatedAt: 10_000,
                messages: [
                    { timestamp: day, modelVersion: 'model-y', prompt: 100, candidates: 50, thoughts: 10, cacheCreation: 0, cacheRead: 0, source: 'subagent' }
                ]
            } as UsageIndex
        };
        const { store } = createMemoryIndexStore({ 'conv-a': stale });
        const cache = new UsageStatsCache();
        const source = createSource({
            'conv-a': {
                metadata: { title: 'Alpha' } as Partial<ConversationMetadata>,
                messages: [modelMessage({ prompt: 300, candidates: 100, modelVersion: 'model-x', timestamp: day })]
            }
        });

        await aggregateUsageStats(source, { indexStore: store, cache });

        // 缓存回填使用重建后的完整明细：main + 合并的 subagent 条目
        const cached = cache.get('conv-a')!;
        expect(cached.messages.some(m => m.source === 'subagent' && m.prompt === 100)).toBe(true);
        expect(cached.messages.some(m => m.modelVersion === 'model-x' && m.prompt === 300)).toBe(true);

        // 第二次统计：缓存命中（零文件 IO），subagent 仍计入（不因重建出现波动）
        const spyingSource = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { throw new Error('should hit cache'); },
            async getMessages() { throw new Error('should hit cache'); },
            async getMessagesRaw() { throw new Error('should hit cache'); }
        } as UsageStatsSource;
        const stats2 = await aggregateUsageStats(spyingSource, { indexStore: store, cache });
        expect(stats2.totals.promptTokens).toBe(400);
        expect(stats2.byConversation[0].subagentTokens).toBe(160);
    });
});

describe('aggregateUsageStats listConversations 失败', () => {
    test('listConversations 失败时跳过 prune，不清空整个内存缓存', async () => {
        const cache = new UsageStatsCache();
        cache.set('conv-a', {
            title: 'Alpha',
            updatedAt: 1,
            messages: [{
                timestamp: 1000,
                modelVersion: 'model-x',
                prompt: 10,
                candidates: 5,
                thoughts: 0,
                cacheCreation: 0,
                cacheRead: 0
            }]
        });
        const source: UsageStatsSource = {
            async listConversations() { throw new Error('io error'); },
            async getMetadata() { return null; },
            async getMessages() { return []; }
        };

        const stats = await aggregateUsageStats(source, { cache });
        // 列表失败：本次按空列表统计，但缓存条目保留（否则下次统计全量重读）
        expect(stats.totals.conversations).toBe(0);
        expect(cache.has('conv-a')).toBe(true);
    });

    test('listConversations 成功时仍正常 prune 已删除对话', async () => {
        const cache = new UsageStatsCache();
        cache.set('conv-gone', { title: 'Gone', updatedAt: 1, messages: [] });
        const source: UsageStatsSource = {
            async listConversations() { return []; },
            async getMetadata() { return null; },
            async getMessages() { return []; }
        };

        await aggregateUsageStats(source, { cache });

        expect(cache.has('conv-gone')).toBe(false);
    });
});

// ==================== TREE-08：分支图合并（全部分支计入） ====================

/** 构造带 id/用量的历史消息 */
function historyMessage(overrides: {
    id: string;
    role?: 'user' | 'model';
    prompt?: number;
    candidates?: number;
    timestamp?: number;
    modelVersion?: string;
}): Content {
    const message = overrides.role === 'user'
        ? ({ role: 'user', parts: [{ text: 'hi' }] } as Content)
        : modelMessage({
            prompt: overrides.prompt,
            candidates: overrides.candidates,
            modelVersion: overrides.modelVersion,
            timestamp: overrides.timestamp
        });
    message.id = overrides.id;
    return message;
}

/** 构造分支节点（model 节点可带 usage） */
function branchNode(
    id: string,
    parentId: string | null,
    role: 'user' | 'model',
    usage?: { prompt: number; candidates: number; thoughts?: number; cacheCreation?: number; cacheRead?: number },
    options: { timestamp?: number; modelVersion?: string; deleted?: boolean } = {}
): ConversationBranchNode {
    const node: ConversationBranchNode = {
        id,
        parentId,
        role,
        parts: role === 'model' ? [{ text: 'reply' }] : [{ text: 'hi' }],
        kind: 'normal',
        createdAt: options.timestamp ?? 1000,
        timestamp: options.timestamp,
        modelVersion: options.modelVersion,
        deleted: options.deleted,
    };
    if (usage) {
        node.usageMetadata = {
            promptTokenCount: usage.prompt,
            candidatesTokenCount: usage.candidates,
            thoughtsTokenCount: usage.thoughts ?? 0,
            ...(usage.cacheCreation !== undefined ? { cacheCreationTokenCount: usage.cacheCreation } : {}),
            ...(usage.cacheRead !== undefined ? { cacheReadTokenCount: usage.cacheRead } : {}),
        } as Content['usageMetadata'];
    }
    return node;
}

/**
 * 构造 reroll 后的典型终态：
 * 主历史 = 活跃路径（u1 → m1 → r1，r1 为新候选），旧回答 m2 退为非活跃候选（sidecar 独有）。
 */
function buildRerollEndState(day: number): { history: Content[]; graph: ConversationBranchGraph } {
    const history = [
        historyMessage({ id: 'u1', role: 'user' }),
        historyMessage({ id: 'm1', prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day }),
        historyMessage({ id: 'r1', prompt: 300, candidates: 150, modelVersion: 'model-x', timestamp: day }),
    ];
    let graph = importLinearHistory(history);
    const old = branchNode('m2', 'm1', 'model', { prompt: 200, candidates: 100 }, { timestamp: day, modelVersion: 'model-x' });
    graph = insertNode(graph, old, { setActive: false, updateTail: false });
    return { history, graph };
}

describe('extractBranchUsageMessages（TREE-08）', () => {
    const day = atLocalNoon(2026, 8, 1);

    test('只提取非活跃 model 节点；主历史 id 去重', () => {
        const { history, graph } = buildRerollEndState(day);
        const ids = new Set(history.filter(m => m.id).map(m => m.id as string));
        const entries = extractBranchUsageMessages(graph, ids);
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('m2');
        expect(entries[0].prompt).toBe(200);
        expect(entries[0].candidates).toBe(100);
        expect(entries[0].source).toBe('branch');
        expect(entries[0].modelVersion).toBe('model-x');
    });

    test('无 historyIds 时按图活跃路径兜底过滤活跃节点', () => {
        const { graph } = buildRerollEndState(day);
        const entries = extractBranchUsageMessages(graph);
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('m2');
    });

    test('切换过渡态（图活跃路径 ≠ 主历史）：主历史 id 去重优先，不双计不遗漏', () => {
        // 主历史只到 m1；图活跃路径已切到 r1（TREE-06 重写主历史前的过渡态）
        const history = [
            historyMessage({ id: 'u1', role: 'user' }),
            historyMessage({ id: 'm1', prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day }),
        ];
        const candidate = branchNode('r1', 'm1', 'model', { prompt: 300, candidates: 150 }, { timestamp: day, modelVersion: 'model-x' });
        const graph = rerollCandidate(importLinearHistory(history), 'm1', candidate, { updateTail: true });
        const ids = new Set(history.map(m => m.id as string));
        const entries = extractBranchUsageMessages(graph, ids);
        // r1 虽在图活跃路径上，但不在主历史：必须计入（不遗漏）；m1 在主历史：不计（不双计）
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('r1');
    });

    test('软删除节点不计入', () => {
        const { history, graph } = buildRerollEndState(day);
        const deleted = branchNode('gone', 'm1', 'model', { prompt: 500, candidates: 250 }, { timestamp: day, modelVersion: 'model-x', deleted: true });
        const withDeleted = insertNode(graph, deleted, { setActive: false, updateTail: false });
        const ids = new Set(history.map(m => m.id as string));
        const entries = extractBranchUsageMessages(withDeleted, ids);
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('m2');
    });

    test('空图 / 损坏图（无根）/ 无用量节点 / user 节点：返回空', () => {
        expect(extractBranchUsageMessages(createEmptyBranchGraph())).toEqual([]);
        const corrupt = {
            version: 1,
            rootNodeId: null,
            activeTailNodeId: null,
            nodes: { x: branchNode('x', null, 'model', { prompt: 1, candidates: 1 }) },
        } as unknown as ConversationBranchGraph;
        expect(extractBranchUsageMessages(corrupt)).toEqual([]);
        const noUsage = {
            version: 1,
            rootNodeId: 'r',
            activeTailNodeId: 'r',
            nodes: { r: branchNode('r', null, 'model') },
        };
        expect(extractBranchUsageMessages(noUsage)).toEqual([]);
        const userOnly = {
            version: 1,
            rootNodeId: 'r',
            activeTailNodeId: 'r',
            nodes: { r: branchNode('r', null, 'user') },
        };
        expect(extractBranchUsageMessages(userOnly)).toEqual([]);
    });

    test('R8b-L1 id 权威时跳过 activePath 解析：损坏图（activeChildId 环）不放弃合并', () => {
        // 图存在 activeChildId 环（root → x → root），但根/节点完好、可枚举非活跃候选
        const cyclic = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'x',
            nodes: {
                root: { ...branchNode('root', null, 'user'), activeChildId: 'x' },
                x: { ...branchNode('x', 'root', 'model', { prompt: 50, candidates: 25 }), activeChildId: 'root' },
            },
        } as unknown as ConversationBranchGraph;
        // 主历史 id 权威（非空）：去重不依赖图活跃路径，环不应阻断分支合并
        const entries = extractBranchUsageMessages(cyclic, new Set(['root']));
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('x');
        expect(entries[0].prompt).toBe(50);
        // 无 id（需要活跃路径兜底）时解析失败 → 放弃合并（行为不变）
        expect(extractBranchUsageMessages(cyclic)).toEqual([]);
    });

    test('R8b-M2 中断 reroll 候选（usageMetadataPartial）按估算口径计入，不按截断原值', () => {
        const day = atLocalNoon(2026, 8, 1);
        const { history, graph } = buildRerollEndState(day);
        // 非活跃候选 m2 标记为中断流：usageMetadataPartial + 截断的 usageMetadata（candidates 只有 2）
        const truncated = { ...graph.nodes['m2']! } as any;
        truncated.usageMetadataPartial = true;
        truncated.usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 0 };
        truncated.parts = [{ text: 'x'.repeat(100) }]; // 100 字符 → 估算 candidates = ceil(100/2.5) = 40
        const withTruncated = { ...graph, nodes: { ...graph.nodes, m2: truncated } };
        const ids = new Set(history.filter(m => m.id).map(m => m.id as string));
        const entries = extractBranchUsageMessages(withTruncated, ids);
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('m2');
        // 中断候选：candidates 走文本估算（40 > 截断值 2），prompt 保留截断值 10（输入侧无法估算）
        expect(entries[0].candidates).toBe(40);
        expect(entries[0].prompt).toBe(10);
    });
});

describe('aggregateUsageStats 分支图合并（TREE-08）', () => {
    const day = atLocalNoon(2026, 8, 1);

    test('reroll 后旧候选计入对话总消耗，活跃路径不双计（历史路径 + source.getBranchGraph）', async () => {
        const { history, graph } = buildRerollEndState(day);
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { return history; },
            async getBranchGraph() { return graph; },
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source);

        // 主历史 100+300 + 旧候选 200，无双计
        expect(stats.totals.promptTokens).toBe(600);
        expect(stats.totals.candidatesTokens).toBe(300);
        expect(stats.totals.modelMessages).toBe(3);
        expect(stats.totals.totalTokens).toBe(900);
        expect(stats.totals.inactiveBranchTokens).toBe(300);
        expect(stats.byConversation[0].inactiveBranchTokens).toBe(300);
        expect(stats.byConversation[0].totalTokens).toBe(900);
        // 分支条目进入按模型/按天维度
        expect(stats.byModel[0].promptTokens).toBe(600);
        expect(stats.byModel[0].modelMessages).toBe(3);
        expect(stats.byDay[0].promptTokens).toBe(600);
    });

    test('多候选累加（含深层续接节点）：全部非活跃分支计入', async () => {
        const history = [
            historyMessage({ id: 'u1', role: 'user' }),
            historyMessage({ id: 'm1', prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day }),
            historyMessage({ id: 'c2', prompt: 20, candidates: 10, modelVersion: 'model-y', timestamp: day }),
        ];
        // 主历史 = 活跃路径（u1 → m1 → c2）；c1 与 d1 为非活跃候选（sidecar 独有）
        let graph = importLinearHistory(history);
        const c1 = branchNode('c1', 'm1', 'model', { prompt: 10, candidates: 5 }, { timestamp: day, modelVersion: 'model-y' });
        graph = insertNode(graph, c1, { setActive: false, updateTail: false });
        const deep = branchNode('d1', 'c1', 'model', { prompt: 40, candidates: 20 }, { timestamp: day, modelVersion: 'model-y' });
        graph = insertNode(graph, deep, { setActive: false, updateTail: false });

        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { return history; },
            async getBranchGraph() { return graph; },
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source);
        // 主历史 100+20 + c1(10) + d1(40)；c2 在活跃路径（主历史）不重复计
        expect(stats.totals.promptTokens).toBe(170);
        expect(stats.totals.candidatesTokens).toBe(85);
        expect(stats.totals.modelMessages).toBe(4);
        expect(stats.byConversation[0].inactiveBranchTokens).toBe(75);
        expect(stats.totals.inactiveBranchTokens).toBe(75);
        // byModel：model-y = 主历史 c2(20) + 候选 c1(10) + d1(40)
        expect(stats.byModel.find(m => m.modelVersion === 'model-y')?.promptTokens).toBe(70);
    });

    test('切换过渡态（图活跃路径≠主历史）：按主历史 id 去重，不双计且新路径也计入', async () => {
        const history = [
            historyMessage({ id: 'u1', role: 'user' }),
            historyMessage({ id: 'm1', prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day }),
        ];
        const candidate = branchNode('r1', 'm1', 'model', { prompt: 300, candidates: 150 }, { timestamp: day, modelVersion: 'model-x' });
        const graph = rerollCandidate(importLinearHistory(history), 'm1', candidate, { updateTail: true });

        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { return history; },
            async getBranchGraph() { return graph; },
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source);
        // 旧路径（主历史 m1）100 + 新路径候选 r1 300：全部计入一次，不双计
        expect(stats.totals.promptTokens).toBe(400);
        expect(stats.totals.modelMessages).toBe(2);
        expect(stats.byConversation[0].inactiveBranchTokens).toBe(450);
        expect(stats.totals.inactiveBranchTokens).toBe(450);
    });

    test('索引 fresh 路径：非活跃候选合并，活跃节点不双计（按条目 id 去重）', async () => {
        const { history, graph } = buildRerollEndState(day);
        const seed = {
            'conv-a': {
                historyMtime: 9000,
                index: {
                    version: 1,
                    conversationId: 'conv-a',
                    updatedAt: 10_000,
                    // 主历史索引条目（TREE-08 新格式：带 id）
                    messages: [
                        { id: 'm1', timestamp: day, modelVersion: 'model-x', prompt: 100, candidates: 50, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                        { id: 'r1', timestamp: day, modelVersion: 'model-x', prompt: 300, candidates: 150, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                    ]
                } as UsageIndex
            }
        };
        const { store } = createMemoryIndexStore(seed);
        // 模拟 FileUsageIndexStore：通过 indexStore.readBranchGraph 提供图
        (store as any).readBranchGraph = async () => graph;
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { throw new Error('should hit index'); },
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, { indexStore: store });
        expect(stats.totals.promptTokens).toBe(600);
        expect(stats.totals.candidatesTokens).toBe(300);
        expect(stats.totals.modelMessages).toBe(3);
        expect(stats.byConversation[0].inactiveBranchTokens).toBe(300);
        expect(stats.totals.inactiveBranchTokens).toBe(300);
    });

    test('旧索引（无消息 id）：回退按图活跃路径过滤，不双计', async () => {
        const { graph } = buildRerollEndState(day);
        const seed = {
            'conv-a': {
                historyMtime: 9000,
                index: {
                    version: 1,
                    conversationId: 'conv-a',
                    updatedAt: 10_000,
                    messages: [
                        { timestamp: day, modelVersion: 'model-x', prompt: 100, candidates: 50, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                        { timestamp: day, modelVersion: 'model-x', prompt: 300, candidates: 150, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                    ]
                } as UsageIndex
            }
        };
        const { store } = createMemoryIndexStore(seed);
        (store as any).readBranchGraph = async () => graph;
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { throw new Error('should hit index'); },
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, { indexStore: store });
        expect(stats.totals.promptTokens).toBe(600);
        expect(stats.totals.modelMessages).toBe(3);
        expect(stats.byConversation[0].inactiveBranchTokens).toBe(300);
    });

    test('无分支图 / 图损坏：降级为仅主历史统计（行为不变）', async () => {
        const history = [
            historyMessage({ id: 'u1', role: 'user' }),
            historyMessage({ id: 'm1', prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day }),
        ];
        // 无图：source 不提供 getBranchGraph
        const statsNoGraph = await aggregateUsageStats(createSource({
            'conv-a': { metadata: { title: 'Alpha' } as Partial<ConversationMetadata>, messages: history }
        }));
        expect(statsNoGraph.totals.promptTokens).toBe(100);
        expect(statsNoGraph.totals.inactiveBranchTokens).toBeUndefined();
        expect(statsNoGraph.byConversation[0].inactiveBranchTokens).toBeUndefined();

        // 损坏图（有节点无根）：合并被跳过
        const corrupt = {
            version: 1,
            rootNodeId: null,
            activeTailNodeId: null,
            nodes: { x1: branchNode('x1', null, 'model', { prompt: 999, candidates: 1 }, { timestamp: day }) },
        } as unknown as ConversationBranchGraph;
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { return history; },
            async getBranchGraph() { return corrupt; },
        } as UsageStatsSource;
        const statsCorrupt = await aggregateUsageStats(source);
        expect(statsCorrupt.totals.promptTokens).toBe(100);
        expect(statsCorrupt.totals.inactiveBranchTokens).toBeUndefined();
    });

    test('时间筛选作用于分支条目：范围外不计入总览与细分', async () => {
        const inRange = atLocalNoon(2026, 8, 10);
        const outRange = atLocalNoon(2026, 9, 10);
        const history = [
            historyMessage({ id: 'u1', role: 'user' }),
            historyMessage({ id: 'm1', prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: inRange }),
        ];
        let graph = importLinearHistory(history);
        const inCandidate = branchNode('c-in', 'm1', 'model', { prompt: 10, candidates: 5 }, { timestamp: inRange, modelVersion: 'model-y' });
        const outCandidate = branchNode('c-out', 'm1', 'model', { prompt: 300, candidates: 150 }, { timestamp: outRange, modelVersion: 'model-y' });
        graph = insertNode(graph, inCandidate, { setActive: false, updateTail: false });
        graph = insertNode(graph, outCandidate, { setActive: false, updateTail: false });

        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { return history; },
            async getBranchGraph() { return graph; },
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, {
            startTime: atLocalNoon(2026, 8, 1),
            endTime: atLocalNoon(2026, 8, 31),
        });
        expect(stats.totals.promptTokens).toBe(110); // 100 + 10（范围外的 300 被筛掉）
        expect(stats.byConversation[0].inactiveBranchTokens).toBe(15);
        expect(stats.totals.inactiveBranchTokens).toBe(15);
        expect(stats.byDay).toHaveLength(1);

        // 无筛选：全量
        const all = await aggregateUsageStats(source);
        expect(all.totals.promptTokens).toBe(410);
        expect(all.byConversation[0].inactiveBranchTokens).toBe(465);
    });

    test('R8b-M1 混合态索引（部分主历史条目缺 id）→ 回退活跃路径兜底，无双计', async () => {
        const day = atLocalNoon(2026, 8, 1);
        const history = [
            historyMessage({ id: 'u1', role: 'user' }),
            historyMessage({ id: 'm1', prompt: 100, candidates: 50, modelVersion: 'model-x', timestamp: day }),
            historyMessage({ id: 'm2', prompt: 60, candidates: 30, modelVersion: 'model-x', timestamp: day }),
        ];
        const graph = importLinearHistory(history); // 活跃路径 = 全量（u1 → m1 → m2）
        const seed = {
            'conv-a': {
                historyMtime: 9000,
                index: {
                    version: 1,
                    conversationId: 'conv-a',
                    updatedAt: 10_000,
                    // 混合态：m1 带 id，m2 缺 id（旧索引/迁移失败）
                    messages: [
                        { id: 'm1', timestamp: day, modelVersion: 'model-x', prompt: 100, candidates: 50, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                        { timestamp: day, modelVersion: 'model-x', prompt: 60, candidates: 30, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                    ]
                } as UsageIndex
            }
        };
        const { store } = createMemoryIndexStore(seed);
        (store as any).readBranchGraph = async () => graph;
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { throw new Error('should hit index'); },
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, { indexStore: store });
        // 主历史 100 + 60；m2 虽缺 id 但已在主历史（活跃路径）→ 不双计
        expect(stats.totals.promptTokens).toBe(160);
        expect(stats.totals.candidatesTokens).toBe(80);
        expect(stats.totals.modelMessages).toBe(2);
        expect(stats.totals.inactiveBranchTokens).toBeUndefined();
        expect(stats.byConversation[0].inactiveBranchTokens).toBeUndefined();
    });

    test('缓存回填包含分支条目，二次统计缓存命中仍含分支消耗', async () => {
        const { history, graph } = buildRerollEndState(day);
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { return history; },
            async getBranchGraph() { return graph; },
        } as UsageStatsSource;
        const cache = new UsageStatsCache();

        const stats1 = await aggregateUsageStats(source, { cache });
        expect(stats1.totals.promptTokens).toBe(600);
        const cached = cache.get('conv-a')!;
        expect(cached.messages.some(m => m.source === 'branch' && m.prompt === 200)).toBe(true);

        // 二次统计：缓存命中（零文件 IO），分支消耗不丢
        const spyingSource = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { throw new Error('should hit cache'); },
            async getMessages() { throw new Error('should hit cache'); },
            async getMessagesRaw() { throw new Error('should hit cache'); },
        } as UsageStatsSource;
        const stats2 = await aggregateUsageStats(spyingSource, { cache });
        expect(stats2.totals.promptTokens).toBe(600);
        expect(stats2.byConversation[0].inactiveBranchTokens).toBe(300);
    });

    test('索引 stale 重建后仍合并分支候选消耗，且重建写回不含 branch 条目（方案 A 不落盘）', async () => {
        const { history, graph } = buildRerollEndState(day);
        const stale = {
            historyMtime: 20_000,
            index: {
                version: 1,
                conversationId: 'conv-a',
                updatedAt: 10_000,
                messages: [
                    { timestamp: day, modelVersion: 'model-x', prompt: 1, candidates: 1, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
                ]
            } as UsageIndex
        };
        const { store, entries } = createMemoryIndexStore({ 'conv-a': stale });
        (store as any).readBranchGraph = async () => graph;
        const source = {
            async listConversations() { return ['conv-a']; },
            async getMetadata() { return { title: 'Alpha' } as ConversationMetadata; },
            async getMessages() { return history; },
        } as UsageStatsSource;

        const stats = await aggregateUsageStats(source, { indexStore: store });
        expect(stats.totals.promptTokens).toBe(600);
        expect(stats.byConversation[0].inactiveBranchTokens).toBe(300);
        // 重建写回的索引仍只含主历史（branch 条目只存在于内存/缓存）
        const rebuilt = entries.get('conv-a')!.index!;
        expect(rebuilt.messages.every(m => m.source !== 'branch')).toBe(true);
        expect(rebuilt.messages.some(m => m.id === 'm1')).toBe(true);
    });
});

describe('buildConversationUsageIndex 消息 id（TREE-08）', () => {
    test('带 id 的消息进入索引条目，无 id 消息省略', () => {
        const withId = modelMessage({ prompt: 5, candidates: 1, modelVersion: 'model-x' });
        withId.id = 'mid-1';
        const withoutId = modelMessage({ prompt: 6, candidates: 2, modelVersion: 'model-x' });
        const index = buildConversationUsageIndex('conv-a', [withId, withoutId]);
        expect(index.messages).toHaveLength(2);
        expect(index.messages[0].id).toBe('mid-1');
        expect(index.messages[1].id).toBeUndefined();
    });
});