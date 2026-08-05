import { resolveRerollTruncateIndex } from '../../modules/api/chat/services/ChatFlowService';
import type { Content } from '../../modules/conversation/types';

function message(id: string, role: 'user' | 'model', text: string): Content {
    return { id, role, parts: [{ text }] } as Content;
}

describe('resolveRerollTruncateIndex', () => {
    const toolLoopHistory: Content[] = [
        message('user-1', 'user', 'question'),
        {
            id: 'model-tool',
            role: 'model',
            parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: {} } }],
        } as Content,
        {
            id: 'function-response',
            role: 'user',
            isFunctionResponse: true,
            parts: [{ functionResponse: { id: 'call-1', name: 'read_file', response: { success: true } } }],
        } as Content,
        message('model-answer', 'model', 'answer after tool'),
    ];

    test('普通回答从目标 model 自身开始截断', () => {
        const history = [message('user-1', 'user', 'question'), message('model-1', 'model', 'answer')];

        expect(resolveRerollTruncateIndex(history, 'model-1')).toBe(1);
    });

    test('工具续接回答只截断续接 model，保留前序工具调用与 functionResponse', () => {
        expect(resolveRerollTruncateIndex(toolLoopHistory, 'model-answer')).toBe(3);
    });

    test('省略目标时选择最后一条 model，同样保留已有工具结果', () => {
        expect(resolveRerollTruncateIndex(toolLoopHistory)).toBe(3);
    });

    test('选择工具调用 model 时从该消息开始截断，后续 functionResponse 一并清理', () => {
        expect(resolveRerollTruncateIndex(toolLoopHistory, 'model-tool')).toBe(1);
    });

    test('目标不存在或位于首条消息时返回 -1', () => {
        expect(resolveRerollTruncateIndex(toolLoopHistory, 'missing')).toBe(-1);
        expect(resolveRerollTruncateIndex([message('model-root', 'model', 'orphan')], 'model-root')).toBe(-1);
    });
});
