/**
 * 总结截止锚点提取测试（preserve 路径：提示模型忽略保留区，对齐总结文本与落盘范围）
 *
 * 覆盖：
 * - 保留区首条有文本消息直接作为锚点
 * - 保留区首条无文本（工具消息）时向后找第一条有文本的
 * - 保留区全无文本时返回 undefined
 * - insertIndex 越界（无保留区）时返回 undefined
 * - thought 文本不参与锚点
 * - 文本截断到 SUMMARY_ANCHOR_MAX_CHARS（120 字符）
 */
import {
    extractSummaryAnchorText
} from '../../modules/api/chat/services/SummarizeService';
import type { Content } from '../../modules/conversation/types';

function userMessage(text: string): Content {
    return {
        role: 'user',
        parts: [{ text }]
    };
}

function toolMessage(): Content {
    return {
        role: 'user',
        parts: [{
            functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { ok: true }
            }
        }]
    };
}

function assistantWithThought(text: string, thought: string): Content {
    return {
        role: 'model',
        parts: [
            { text: thought, thought: true },
            { text }
        ]
    };
}

describe('extractSummaryAnchorText', () => {
    test('保留区首条有文本消息直接作为锚点', () => {
        const history: Content[] = [
            userMessage('earlier message'),
            userMessage('retained latest message')
        ];

        expect(extractSummaryAnchorText(history, 1)).toBe('retained latest message');
    });

    test('保留区首条无文本（工具消息）时向后找第一条有文本的', () => {
        const history: Content[] = [
            userMessage('earlier message'),
            toolMessage(),
            userMessage('retained latest message')
        ];

        expect(extractSummaryAnchorText(history, 1)).toBe('retained latest message');
    });

    test('保留区全无文本时返回 undefined', () => {
        const history: Content[] = [
            userMessage('earlier message'),
            toolMessage()
        ];

        expect(extractSummaryAnchorText(history, 1)).toBeUndefined();
    });

    test('insertIndex 越界（无保留区）时返回 undefined', () => {
        const history: Content[] = [userMessage('only message')];

        expect(extractSummaryAnchorText(history, 1)).toBeUndefined();
        expect(extractSummaryAnchorText(history, 5)).toBeUndefined();
    });

    test('thought 文本不参与锚点', () => {
        const history: Content[] = [
            userMessage('earlier message'),
            assistantWithThought('visible reply text', 'internal thought')
        ];

        expect(extractSummaryAnchorText(history, 1)).toBe('visible reply text');
    });

    test('文本压缩空白并截断到 120 字符', () => {
        const longText = 'word '.repeat(100);
        const history: Content[] = [
            userMessage('earlier message'),
            userMessage(longText)
        ];

        const anchor = extractSummaryAnchorText(history, 1);
        expect(anchor).toBeDefined();
        expect(anchor!.length).toBe(120);
        expect(anchor!.startsWith('word')).toBe(true);
        expect(anchor).not.toContain('\n');
    });

    test('多 text part 拼接后压缩空白', () => {
        const history: Content[] = [
            userMessage('earlier message'),
            {
                role: 'user',
                parts: [{ text: 'first line' }, { text: 'second line' }]
            }
        ];

        expect(extractSummaryAnchorText(history, 1)).toBe('first line second line');
    });
});
