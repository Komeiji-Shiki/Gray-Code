/**
 * SummarizeService.handleSummarizeContext 手动总结范围放行回归测试
 *
 * 背景：手动总结时规划器可能走 intra_round 轮内截断（单轮历史、或最后一轮超预算
 * 的多轮历史），切点必然位于轮首 user 消息之后 → insertIndex 恒大于
 * lastRealUserMessageIndex。旧实现把这种情况一律判为 STALE_RANGE 放弃落盘，
 * 导致手动总结失败，前端报「总结失败: 对话历史在总结期间发生变化」。
 *
 * 修复：markAndInsertSummarizedAtomically 的 allowCoverLastRealUserRound 开关
 * 对手动总结整体放行（用户主动总结，无进行中的回合需要保护），把「最后一轮的
 * 前半段」拿去总结；自动总结保持严格 STALE（回合内吞掉当前用户消息会毁掉
 * 回复上下文，见 summarizeOverflowTrim.test.ts 的 H2 用例与规划器 auto 分支）。
 *
 * 放行不破坏的既有保护：
 * - 首条用户消息仍不标记（锚点原样保留并永远发送）
 * - insertIndex 越界（并发删除把历史缩短到区间之外）仍 STALE
 * - 无任何真实用户消息仍 STALE
 */

import type { Content } from '../../modules/conversation/types';
import { createSummarizeHarness } from '../__fixtures__/harnessFixtures';

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



// ==================== 测试用例 ====================

describe('SummarizeService.handleSummarizeContext - 单轮（唯一真实用户消息）放行', () => {
    test('单超大轮轮内截断：不再 STALE，成功总结这一轮的前半部分', async () => {
        // 单轮 240 token > 预算 100（10% of 1000）→ intra_round 轮内截断，
        // 切点落在最后一个满足预算的 model 消息（done，index 5）→ insertIndex=5。
        const singleOversizedRound: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            fcMsg('fc2', 40), frMsg('fc2', 40), modelMsg('done', 40)
        ];

        const { service, liveHistory } = createSummarizeHarness({ fullHistory: singleOversizedRound });

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

    test('总结期间历史并发变长（追加非真实用户消息）：仍成功，不因 insertIndex > 最后用户消息而放弃', async () => {
        const planningSnapshot: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            fcMsg('fc2', 40), frMsg('fc2', 40), modelMsg('done', 40)
        ];
        // 规划时 insertIndex=5；总结期间后台回执/回复尾部追加（不引入新的真实用户回合）
        const concurrentGrownHistory: Content[] = [
            ...planningSnapshot,
            modelMsg('more', 10)
        ];

        const { service, liveHistory } = createSummarizeHarness({
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

    test('总结期间历史被并发缩短导致 insertIndex 越界：仍 STALE_RANGE，不落盘', async () => {
        const planningSnapshot: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            fcMsg('fc2', 40), frMsg('fc2', 40), modelMsg('done', 40)
        ];
        // 规划时 insertIndex=5；总结期间并发删除把历史缩到 3 条 → insertIndex 越界
        const concurrentShrunkenHistory: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40)
        ];

        const { service, liveHistory } = createSummarizeHarness({
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

describe('SummarizeService.handleSummarizeContext - 多轮 + 末轮超预算（工具长回合）放行', () => {
    const msgLabel = (m: Content): string =>
        m.parts[0]?.functionCall?.id
        ?? m.parts[0]?.functionResponse?.id
        ?? m.parts[0]?.text
        ?? '';

    test('三轮、末轮 800/1200 超过 50% 预算：轮内截断深入末轮，手动总结成功', async () => {
        const threeRounds: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            userMsg('r2', 40), fcMsg('fc2', 40), frMsg('fc2', 40),
            userMsg('r3', 200), fcMsg('fc3', 200), frMsg('fc3', 200),
            modelMsg('done', 200)
        ];

        const { service, liveHistory } = createSummarizeHarness({ fullHistory: threeRounds });

        const result = await service.handleSummarizeContext({ conversationId: 'conv1', configId: 'cfg1' });

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.insertIndex).toBe(9);
            // 首条用户消息保护：r1 不标记，[1, 9) 共 8 条被标记
            expect(result.removedCount).toBe(8);
            expect(result.summarizedMessageCount).toBe(8);
        }
        // 历史 = [r1, fc1✓..fr3✓(8 条), summary, done]，原文完整保留 + 插入总结
        expect(liveHistory).toHaveLength(11);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[0].isSummarized).toBeUndefined();
        expect(liveHistory.slice(1, 9)).toEqual(
            expect.arrayContaining([expect.objectContaining({ isSummarized: true })])
        );
        expect(liveHistory[9]).toMatchObject({ isSummary: true, index: 9 });
        expect(msgLabel(liveHistory[10])).toBe('done');
    });

    test('四轮、末轮超预算且总 token 更多：同样放行成功', async () => {
        const fourRounds: Content[] = [
            userMsg('r1', 50), fcMsg('fc1', 50), frMsg('fc1', 50),
            userMsg('r2', 50), fcMsg('fc2', 50), frMsg('fc2', 50),
            userMsg('r3', 50), fcMsg('fc3', 50), frMsg('fc3', 50),
            userMsg('r4', 300), fcMsg('fc4', 250), frMsg('fc4', 250),
            modelMsg('done', 300)
        ];

        const { service, liveHistory } = createSummarizeHarness({ fullHistory: fourRounds });

        const result = await service.handleSummarizeContext({ conversationId: 'conv1', configId: 'cfg1' });

        expect(result.success).toBe(true);
        if (result.success) {
            // 首条用户消息保护：r1 不标记，[1, 12) 共 11 条被标记
            expect(result.insertIndex).toBe(12);
            expect(result.removedCount).toBe(11);
        }
        expect(liveHistory).toHaveLength(13 + 1);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[0].isSummarized).toBeUndefined();
        expect(liveHistory[12]).toMatchObject({ isSummary: true, index: 12 });
        expect(msgLabel(liveHistory[13])).toBe('done');
    });
});

describe('SummarizeService.handleSummarizeContext - 放行边界（手动总结无进行中回合）', () => {
    test('多轮历史范围覆盖最后一轮用户消息（预算不足轮内截断）：手动总结放行成功', async () => {
        // 两轮：规划预算 100 装不下任何保留后缀，切点被迫深入轮内（done，index 6）
        // → insertIndex=6 > lastRealUserMessageIndex=3（user1 之后的 user2）。
        // 手动总结是用户主动行为，没有进行中的回合需要保护：覆盖最后一轮的前半段
        // 正是预期行为（把这一轮之前的内容拿去总结）；自动总结才保持严格 STALE。
        const twoRounds: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            userMsg('r2', 40), fcMsg('fc2', 40), frMsg('fc2', 40),
            modelMsg('done', 40)
        ];

        const { service, liveHistory } = createSummarizeHarness({ fullHistory: twoRounds });

        const result = await service.handleSummarizeContext({ conversationId: 'conv1', configId: 'cfg1' });

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.insertIndex).toBe(6);
            // 首条用户消息保护：r1 不标记，[1, 6) 共 5 条被标记
            expect(result.removedCount).toBe(5);
            expect(result.summarizedMessageCount).toBe(5);
        }
        // 历史 = [r1, fc1✓, fr1✓, r2✓, fc2✓, fr2✓, summary, done]
        expect(liveHistory).toHaveLength(8);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[0].isSummarized).toBeUndefined();
        expect(liveHistory.slice(1, 6)).toEqual(
            expect.arrayContaining([expect.objectContaining({ isSummarized: true })])
        );
        expect(liveHistory[6]).toMatchObject({ isSummary: true, index: 6 });
        expect(msgLabel(liveHistory[7])).toBe('done');
    });

    test('多轮 + 预算充足（正常路径）：照常成功，放行逻辑不介入', async () => {
        // 预算 300（绝对数）：最早满足保留预算的候选切点是 fc1（index 1，suffix 240 <= 300）
        // → cutIndex=1。insertIndex=1 <= lastRealUserMessageIndex=3，不触发 STALE 分支，走正常路径。
        const twoRounds: Content[] = [
            userMsg('r1', 40), fcMsg('fc1', 40), frMsg('fc1', 40),
            userMsg('r2', 40), fcMsg('fc2', 40), frMsg('fc2', 40),
            modelMsg('done', 40)
        ];

        const { service, liveHistory } = createSummarizeHarness({
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
