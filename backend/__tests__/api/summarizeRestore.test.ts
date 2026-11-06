/**
 * 总结覆盖区间恢复的纯函数测试。
 *
 * 覆盖 restoreSummarizedRange 纯函数：取消覆盖区间 isSummarized 标记、区间边界（上一个总结）、幂等。
 */

import { restoreSummarizedRange } from '../../modules/conversation/TranscriptMutation';
import type { Content } from '../../modules/conversation/types';

// ==================== 消息构造工具 ====================

const userMsg = (text: string, extra: Partial<Content> = {}): Content => ({
    role: 'user',
    parts: [{ text }],
    ...extra,
});

const modelMsg = (text: string, extra: Partial<Content> = {}): Content => ({
    role: 'model',
    parts: [{ text }],
    ...extra,
});

const summaryMsg = (id: string, text: string): Content => ({
    id,
    role: 'user',
    parts: [{ text }],
    isSummary: true,
});

/** 总结后的历史形态：[首条(不标记), m1/a1(标记), 总结, m3/a3(活跃)] */
function summarizedHistory(): Content[] {
    return [
        userMsg('r0'),
        userMsg('m1', { isSummarized: true }),
        modelMsg('a1', { isSummarized: true }),
        summaryMsg('sum-1', '摘要'),
        userMsg('m3'),
        modelMsg('a3'),
    ];
}

describe('restoreSummarizedRange 纯函数', () => {
    test('取消覆盖区间的 isSummarized 标记，不动总结消息与 parentId 链', () => {
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
        expect(result.contents.map((m) => m.parts[0]?.text ?? m.role)).toHaveLength(6);
        // 原数组不被污染（纯函数）
        expect(history[1].isSummarized).toBe(true);
    });

    test('覆盖区间以上一个总结消息为界，恢复后不影响更早总结的覆盖区', () => {
        const history = [
            userMsg('r0'),
            userMsg('early', { isSummarized: true }),
            summaryMsg('sum-0', '旧摘要'),
            userMsg('late', { isSummarized: true }),
            summaryMsg('sum-1', '新摘要'),
            userMsg('active'),
        ];
        const result = restoreSummarizedRange(history, 4);

        expect(result.restoredCount).toBe(1);
        expect(result.contents[1].isSummarized).toBe(true); // 更早总结的覆盖区不受影响
        expect(result.contents[3].isSummarized).toBeUndefined(); // 本总结覆盖区已恢复
    });

    test('非总结消息 / 越界 / 区间无标记消息时幂等返回 0', () => {
        const history = summarizedHistory();
        expect(restoreSummarizedRange(history, 0).restoredCount).toBe(0);
        expect(restoreSummarizedRange(history, 99).restoredCount).toBe(0);

        const noMarked = [userMsg('r0'), summaryMsg('sum-1', '摘要'), userMsg('m3')];
        const result = restoreSummarizedRange(noMarked, 1);
        expect(result.restoredCount).toBe(0);
        expect(result.contents[1].isSummary).toBe(true);
    });
});
