/**
 * 逻辑截断恢复（restoreSummarizedMessages / 删除总结自动恢复）回归测试。
 *
 * 覆盖：
 * - restoreSummarizedRange 纯函数：取消覆盖区间 isSummarized 标记、区间边界（上一个总结）、幂等
 * - ConversationManager.deleteMessage 删除总结消息 → 自动恢复其覆盖的原文（取消标记）
 * - ConversationManager.deleteMessagesInRange 删除区间含多个总结 → 从晚到早逐个恢复
 * - SummarizeService.restoreSummarizedMessages：取消标记 + 删除总结消息本身（恢复按钮 API）
 * - 恢复后原文重新成为活跃消息（无 isSummarized 标记）
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import { restoreSummarizedRange } from '../../modules/conversation/TranscriptMutation';
import { SummarizeService } from '../../modules/api/chat/services/SummarizeService';
import type { Content } from '../../modules/conversation/types';
import { setGlobalBranchService } from '../../modules/conversation/branch/BranchService';

afterEach(() => {
    setGlobalBranchService(undefined);
});

// ==================== 消息构造工具 ====================

const userMsg = (text: string, extra: Partial<Content> = {}): Content => ({
    role: 'user',
    parts: [{ text }],
    ...extra
});

const modelMsg = (text: string, extra: Partial<Content> = {}): Content => ({
    role: 'model',
    parts: [{ text }],
    ...extra
});

const summaryMsg = (id: string, text: string): Content => ({
    id,
    role: 'user',
    parts: [{ text }],
    isSummary: true
});

/** 总结后的历史形态：[首条(不标记), m1/a1(标记), 总结, m3/a3(活跃)] */
function summarizedHistory(): Content[] {
    return [
        userMsg('r0'),
        userMsg('m1', { isSummarized: true }),
        modelMsg('a1', { isSummarized: true }),
        summaryMsg('sum-1', '摘要'),
        userMsg('m3'),
        modelMsg('a3')
    ];
}

describe('restoreSummarizedRange 纯函数', () => {
    it('取消覆盖区间的 isSummarized 标记，不动总结消息与 parentId 链', () => {
        const history = summarizedHistory();
        const result = restoreSummarizedRange(history, 3);

        expect(result.restoredCount).toBe(2);
        // 被恢复的消息不再带 isSummarized 标记
        expect(result.contents[1].isSummarized).toBeUndefined();
        expect(result.contents[2].isSummarized).toBeUndefined();
        // 总结消息与区间外消息不变
        expect(result.contents[3].isSummary).toBe(true);
        expect(result.contents[4].parts[0].text).toBe('m3');
        // 不改变长度与顺序
        expect(result.contents.map(m => m.parts[0]?.text ?? m.role)).toHaveLength(6);
        // 原数组不被污染（纯函数）
        expect(history[1].isSummarized).toBe(true);
    });

    it('覆盖区间以上一个总结消息为界，恢复后不影响更早总结的覆盖区', () => {
        const history = [
            userMsg('r0'),
            userMsg('early', { isSummarized: true }),
            summaryMsg('sum-0', '旧摘要'),
            userMsg('late', { isSummarized: true }),
            summaryMsg('sum-1', '新摘要'),
            userMsg('active')
        ];
        const result = restoreSummarizedRange(history, 4);

        expect(result.restoredCount).toBe(1);
        expect(result.contents[1].isSummarized).toBe(true); // 更早总结的覆盖区不受影响
        expect(result.contents[3].isSummarized).toBeUndefined(); // 本总结覆盖区已恢复
    });

    it('非总结消息 / 越界 / 区间无标记消息时幂等返回 0', () => {
        const history = summarizedHistory();
        expect(restoreSummarizedRange(history, 0).restoredCount).toBe(0);
        expect(restoreSummarizedRange(history, 99).restoredCount).toBe(0);

        const noMarked = [
            userMsg('r0'),
            summaryMsg('sum-1', '摘要'),
            userMsg('m3')
        ];
        const result = restoreSummarizedRange(noMarked, 1);
        expect(result.restoredCount).toBe(0);
        expect(result.contents[1].isSummary).toBe(true);
    });
});

describe('ConversationManager 删除总结消息自动恢复原文', () => {
    async function seedManager(history: Content[]): Promise<{ manager: ConversationManager; id: string }> {
        const manager = new ConversationManager(new MemoryStorageAdapter());
        const id = 'conv-restore';
        for (const message of history) {
            await manager.addContent(id, message);
        }
        return { manager, id };
    }

    it('deleteMessage 删除总结消息 → 覆盖区间自动取消标记（原文恢复活跃）', async () => {
        const { manager, id } = await seedManager(summarizedHistory());
        const structuralSync = jest.fn(async () => ({ synced: true, deferred: false }));
        const ordinaryDeleteSync = jest.fn();
        setGlobalBranchService({
            syncMainHistoryAfterStructuralMutation: structuralSync,
            syncGraphAfterHistoryDelete: ordinaryDeleteSync,
        } as any);
        // 定位总结消息下标（addContent 按序追加，下标 3）
        const summaryIndex = 3;

        await manager.deleteMessage(id, summaryIndex);

        const history = await manager.getMessagesRaw(id);
        // 总结消息已删除，历史 = 5 条
        expect(history).toHaveLength(5);
        // 被恢复的消息不再标记
        expect(history[1].isSummarized).toBeUndefined();
        expect(history[2].isSummarized).toBeUndefined();
        // 首条用户消息与活跃消息不受影响
        expect(history[0].isSummarized).toBeUndefined();
        expect(history[3].parts[0].text).toBe('m3');
        expect(structuralSync).toHaveBeenCalledWith(id, 'summary_deleted');
        expect(ordinaryDeleteSync).not.toHaveBeenCalled();
    });

    it('deleteMessagesInRange 删除区间含多个总结 → 从晚到早逐个恢复各自覆盖区', async () => {
        const history = [
            userMsg('r0'),
            userMsg('early', { isSummarized: true }),
            summaryMsg('sum-0', '旧摘要'),
            userMsg('late', { isSummarized: true }),
            summaryMsg('sum-1', '新摘要'),
            userMsg('active')
        ];
        const { manager, id } = await seedManager(history);

        // 删除 [4, 6)（新摘要 + 活跃消息）：被删区间含总结 sum-1 → 恢复其覆盖区（late 取消标记，幸存）
        await manager.deleteMessagesInRange(id, 4, 5);

        const result = await manager.getMessagesRaw(id);
        expect(result).toHaveLength(4);
        // sum-0 的覆盖区（early）保持标记（它未被删除、仍在发送范围外）
        expect(result[1].isSummarized).toBe(true);
        // sum-1 的覆盖区（late）已恢复
        expect(result[3].parts[0].text).toBe('late');
        expect(result[3].isSummarized).toBeUndefined();
    });
});

describe('SummarizeService.restoreSummarizedMessages（恢复按钮 API）', () => {
    function createHarness(history: Content[]) {
        let liveHistory = JSON.parse(JSON.stringify(history)) as Content[];
        const mutateContents = jest.fn(async (mutator: (h: Content[]) => Content[]) => {
            const copy = JSON.parse(JSON.stringify(liveHistory)) as Content[];
            const next = mutator(copy);
            if (next !== copy) {
                const persisted = JSON.parse(JSON.stringify(next)) as Content[];
                liveHistory.splice(0, liveHistory.length, ...persisted);
                return persisted;
            }
            return copy;
        });
        const conversationManager = {
            getTranscriptRepository: jest.fn(() => ({ mutateContents })),
            getHistoryRef: jest.fn(async () => JSON.parse(JSON.stringify(liveHistory)))
        };
        const service = new SummarizeService(
            { getConfig: jest.fn() } as any,
            { generate: jest.fn() } as any,
            conversationManager as any,
            { findLastSummaryIndex: jest.fn(() => -1), identifyRounds: jest.fn(() => []) } as any
        );
        return { service, liveHistory: () => liveHistory, mutateContents };
    }

    it('恢复：取消覆盖区间标记 + 删除总结消息，返回恢复数', async () => {
        const { service, liveHistory } = createHarness(summarizedHistory());
        const structuralSync = jest.fn(async () => ({ synced: true, deferred: false }));
        setGlobalBranchService({ syncMainHistoryAfterStructuralMutation: structuralSync } as any);

        const result = await service.restoreSummarizedMessages('conv1', 'sum-1');

        expect(result.success).toBe(true);
        expect(result.restoredCount).toBe(2);
        expect(result.removedSummaryId).toBe('sum-1');

        const history = liveHistory();
        expect(history).toHaveLength(5);
        expect(history[1].isSummarized).toBeUndefined();
        expect(history[2].isSummarized).toBeUndefined();
        // 总结消息已删除
        expect(history.some(m => m.id === 'sum-1')).toBe(false);
        expect(structuralSync).toHaveBeenCalledWith('conv1', 'summary_restored');
    });

    it('总结消息不存在时成功返回 0，不落盘', async () => {
        const { service, mutateContents, liveHistory } = createHarness(summarizedHistory());

        const result = await service.restoreSummarizedMessages('conv1', 'no-such-summary');

        expect(result.success).toBe(true);
        expect(result.restoredCount).toBe(0);
        // mutateContents 回调返回原引用 → 不写回
        expect(liveHistory()).toHaveLength(6);
        expect(mutateContents).toHaveBeenCalledTimes(1);
    });
});
