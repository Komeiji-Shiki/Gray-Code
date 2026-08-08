/**
 * SummarizeService.handleSummarizeContext 单轮场景回归测试
 *
 * 背景：手动总结单轮（历史中只有一条真实用户消息）时，规划器走 intra_round 轮内截断，
 * 切点必然位于轮首 user 消息之后 → insertIndex 恒大于 lastRealUserMessageIndex。
 * 旧实现把这种情况一律判为 STALE_RANGE 放弃落盘，导致「只有一个 user 输入」的手动总结
 * 永远失败，前端报「总结失败: 对话历史在总结期间发生变化」。
 *
 * 修复：markAndInsertSummarizedAtomically 新增 allowCoverLastRealUserRound 开关，
 * 手动总结在「整个历史仅一条真实用户消息」时放行（用户主动总结，无后续回合需要保护），
 * 把这一轮的前半部分拿去总结；自动总结保持严格 STALE（回合内吞掉当前用户消息会毁掉
 * 回复上下文，见 summarizeOverflowTrim.test.ts 的 H2 用例）。
 *
 * 放行不破坏的既有保护：
 * - 首条用户消息仍不标记（锚点原样保留并永远发送）
 * - insertIndex 越界（并发删除把历史缩短到区间之外）仍 STALE
 * - 多轮历史（realUserCount > 1）仍 STALE
 */

import { SummarizeService } from '../../modules/api/chat/services/SummarizeService';
import type { Content } from '../../modules/conversation/types';

// ==================== 消息构造工具 ====================

/** 真实用户消息（带 tokenCountByChannel，走精确估算口径） */
const userMsg = (text: string, tokens: number, extra: Partial<Content> = {}): Content => ({
    role: 'user',
    parts: [{ text }],
    tokenCountByChannel: { openai: tokens },
    ...extra
});

/** functionCall 消息（model 角色，走 usageMetadata 口径） */
const fcMsg = (id: string, tokens: number): Content => ({
    role: 'model',
    parts: [{ functionCall: { name: 'tool', args: {}, id } }],
    usageMetadata: { totalTokenCount: tokens, promptTokenCount: 0 }
});

/** functionResponse 消息（user 角色，与 functionCall 共享 id） */
const frMsg = (id: string, tokens: number): Content => ({
    role: 'user',
    isFunctionResponse: true,
    parts: [{ functionResponse: { name: 'tool', response: { ok: true }, id } }],
    tokenCountByChannel: { openai: tokens }
});

/** model 文本消息（走 usageMetadata 口径） */
const modelMsg = (text: string, tokens: number): Content => ({
    role: 'model',
    parts: [{ text }],
    usageMetadata: { totalTokenCount: tokens, promptTokenCount: 0 }
});

/** 提取消息的可读标识（functionCall id / functionResponse id / 文本），用于断言历史形态 */
const msgLabel = (m: Content): string =>
    m.parts[0]?.functionCall?.id
    ?? m.parts[0]?.functionResponse?.id
    ?? m.parts[0]?.text
    ?? '';

/** 总结文本必须 >= MIN_SUMMARY_LENGTH（50 字符），否则会被 LOW_QUALITY_SUMMARY 拒绝 */
const SUCCESS_SUMMARY: Content = {
    role: 'model',
    parts: [{ text: '已完成总结。这是足够长的总结正文：目标已记录、已完成步骤与当前进度、下一步计划与关键约束均已覆盖，供后续对话继续使用。' }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100 }
};

// ==================== 测试脚手架 ====================

interface HarnessOptions {
    fullHistory: Content[];
    /** 可选：getHistoryRef 返回的「规划快照」（默认 deep copy of fullHistory） */
    historyRef?: Content[];
    /** 可选：mutateContents 读写的「落盘」历史（默认与 historyRef 同一引用） */
    liveHistory?: Content[];
    maxContextTokens?: number;
    keepRecentTokens?: number | string;
    keepRecentRounds?: number;
}

interface Harness {
    service: SummarizeService;
    generate: jest.Mock;
    liveHistory: Content[];
}

function createHarness(options: HarnessOptions): Harness {
    const {
        fullHistory,
        maxContextTokens = 1000,
        keepRecentTokens = '10%',
        keepRecentRounds = 1
    } = options;
    // 规划快照与落盘历史分离：模拟「规划后、写入前历史被并发写入」
    const planningHistory = options.historyRef ?? JSON.parse(JSON.stringify(fullHistory));
    const mutableHistory = options.liveHistory ?? planningHistory;

    const configs: Record<string, any> = {
        cfg1: { id: 'cfg1', type: 'openai', enabled: true, maxContextTokens }
    };

    const generate = jest.fn().mockResolvedValue({ content: SUCCESS_SUMMARY });

    const conversationManager = {
        getHistory: jest.fn().mockResolvedValue(planningHistory),
        getHistoryRef: jest.fn().mockResolvedValue(planningHistory),
        getTranscriptRepository: jest.fn(() => ({
            mutateContents: jest.fn(async (mutator: (history: Content[]) => Content[]) => {
                const copy = JSON.parse(JSON.stringify(mutableHistory)) as Content[];
                const next = mutator(copy);
                if (next !== copy) {
                    const persisted = JSON.parse(JSON.stringify(next)) as Content[];
                    mutableHistory.splice(0, mutableHistory.length, ...persisted);
                    return persisted;
                }
                return copy;
            })
        }))
    };

    const contextTrimService = {
        findLastSummaryIndex: jest.fn().mockReturnValue(-1),
        identifyRounds: jest.fn().mockReturnValue([])
    };

    const settingsManager = {
        getSummarizeConfig: jest.fn().mockReturnValue({
            keepRecentRounds,
            keepRecentTokens,
            useSeparateModel: false,
            summarizeChannelId: '',
            summarizeModelId: '',
            summarizePrompt: '',
            summarizeMaxInputRatio: 0.5
        })
    };

    const service = new SummarizeService(
        { getConfig: jest.fn(async (id: string) => configs[id]) } as any,
        { generate } as any,
        conversationManager as any,
        contextTrimService as any,
        settingsManager as any
    );

    return { service, generate, liveHistory: mutableHistory };
}

// ==================== 测试用例 ====================

describe('SummarizeService.handleSummarizeContext - 单轮（唯一真实用户消息）放行', () => {
    it('单超大轮轮内截断：不再 STALE，成功总结这一轮的前半部分', async () => {
        // 单轮 240 token > 预算 100（10% of 1000）→ intra_round 轮内截断，
        // 切点落在最后一个满足预算的 model 消息（done，index 5）→ insertIndex=5。
        const singleOversizedRound: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            fcMsg('fc2', 40), frMsg('fc2', 40), modelMsg('done', 40)
        ];

        const { service, liveHistory } = createHarness({ fullHistory: singleOversizedRound });

        const result = await service.handleSummarizeContext({ conversationId: 'conv1', configId: 'cfg1' });

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.insertIndex).toBe(5);
            // 首条用户消息保护：r1 不标记，[1, 5) 共 4 条被标记
            expect(result.removedCount).toBe(4);
            expect(result.summarizedMessageCount).toBe(4);
        }

        // 历史 = [r1, fc1✓, fr1✓, fc2✓, fr2✓, summary, done]（原文完整保留 + 插入总结）
        expect(liveHistory).toHaveLength(7);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[0].isSummarized).toBeUndefined();
        expect(liveHistory[1]).toMatchObject({ isSummarized: true });
        expect(liveHistory[2]).toMatchObject({ isSummarized: true });
        expect(liveHistory[3]).toMatchObject({ isSummarized: true });
        expect(liveHistory[4]).toMatchObject({ isSummarized: true });
        expect(liveHistory[5]).toMatchObject({ isSummary: true, index: 5 });
        expect(liveHistory[5].parts[0].text).toContain('[对话总结]');
        expect(msgLabel(liveHistory[6])).toBe('done');
    });

    it('总结期间历史并发变长（追加非真实用户消息）：仍成功，不因 insertIndex > 最后用户消息而放弃', async () => {
        const planningSnapshot: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            fcMsg('fc2', 40), frMsg('fc2', 40), modelMsg('done', 40)
        ];
        // 规划时 insertIndex=5；总结期间后台回执/回复尾部追加（不引入新的真实用户回合）
        const concurrentGrownHistory: Content[] = [
            ...planningSnapshot,
            modelMsg('more', 10)
        ];

        const { service, liveHistory } = createHarness({
            fullHistory: planningSnapshot,
            historyRef: planningSnapshot,
            liveHistory: concurrentGrownHistory
        });

        const result = await service.handleSummarizeContext({ conversationId: 'conv1', configId: 'cfg1' });

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.insertIndex).toBe(5);
            expect(result.removedCount).toBe(4);
        }
        // 总结消息插入规划位置，追加的消息原样保留在尾巴
        expect(liveHistory).toHaveLength(8);
        expect(liveHistory[5]).toMatchObject({ isSummary: true });
        expect(msgLabel(liveHistory[6])).toBe('done');
        expect(msgLabel(liveHistory[7])).toBe('more');
    });

    it('总结期间历史被并发缩短导致 insertIndex 越界：仍 STALE_RANGE，不落盘', async () => {
        const planningSnapshot: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            fcMsg('fc2', 40), frMsg('fc2', 40), modelMsg('done', 40)
        ];
        // 规划时 insertIndex=5；总结期间并发删除把历史缩到 3 条 → insertIndex 越界
        const concurrentShrunkenHistory: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40)
        ];

        const { service, liveHistory } = createHarness({
            fullHistory: planningSnapshot,
            historyRef: planningSnapshot,
            liveHistory: concurrentShrunkenHistory
        });

        const result = await service.handleSummarizeContext({ conversationId: 'conv1', configId: 'cfg1' });

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('STALE_RANGE');
        }
        // 不落盘：历史保持并发写入后的形态
        expect(liveHistory.map(msgLabel)).toEqual(['r1', 'fc1', 'fc1']);
    });
});

describe('SummarizeService.handleSummarizeContext - 放行边界（仅单轮生效）', () => {
    it('多轮历史（realUserCount > 1）范围覆盖第二轮用户消息：仍 STALE_RANGE', async () => {
        // 两轮：规划预算 100 装不下任何保留后缀，切点被迫深入轮内（done，index 6）
        // → insertIndex=6 > lastRealUserMessageIndex=3（user1），但真实用户消息有 2 条，
        // 不属于「唯一真实用户回合」放行范围，保持 STALE。
        const twoRounds: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            userMsg('r2', 40), fcMsg('fc2', 40), frMsg('fc2', 40),
            modelMsg('done', 40)
        ];

        const { service, liveHistory } = createHarness({ fullHistory: twoRounds });

        const result = await service.handleSummarizeContext({ conversationId: 'conv1', configId: 'cfg1' });

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('STALE_RANGE');
        }
        // 不落盘：两轮对话原样保留
        expect(liveHistory).toHaveLength(7);
        expect(liveHistory.some(m => m.isSummary)).toBe(false);
    });

    it('多轮 + 预算充足（正常路径）：照常成功，放行逻辑不介入', async () => {
        // 预算 300（绝对数）：最早满足保留预算的候选切点是 fc1（index 1，suffix 240 <= 300）
        // → cutIndex=1。insertIndex=1 <= lastRealUserMessageIndex=3，不触发 STALE 分支，走正常路径。
        const twoRounds: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            userMsg('r2', 40), fcMsg('fc2', 40), frMsg('fc2', 40),
            modelMsg('done', 40)
        ];

        const { service, liveHistory } = createHarness({
            fullHistory: twoRounds,
            keepRecentTokens: 300 // 绝对预算：保留 suffix <= 300 的最早切点（fc1）
        });

        const result = await service.handleSummarizeContext({ conversationId: 'conv1', configId: 'cfg1' });

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.insertIndex).toBe(1);
            // r1 受首条用户消息保护不标记 → 本次实际标记 0 条
            expect(result.removedCount).toBe(0);
        }
        // r1 原样保留；summary 插入 index 1；其余消息原样保留
        expect(liveHistory).toHaveLength(8);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[0].isSummarized).toBeUndefined();
        expect(liveHistory[1]).toMatchObject({ isSummary: true, index: 1 });
        expect(liveHistory.slice(2).map(msgLabel)).toEqual(['fc1', 'fc1', 'r2', 'fc2', 'fc2', 'done']);
    });
});
