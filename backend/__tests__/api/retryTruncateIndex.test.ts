/**
 * resolveRetryTruncateIndex 单元测试
 *
 * 背景：retry 语义是「重新生成最后一条 AI 回复」，必须先删除主历史末尾的 model 消息。
 * 否则请求 messages 最后一条是 assistant——带 tool_calls 时 DeepSeek 等 API 会把它
 * 当作 prefill 前缀直接 400（"Function call should not be used with prefix"），
 * 纯文本时也会被 prefill 续写（重试变接龙）。
 */
import { resolveRetryTruncateIndex } from '../../modules/api/chat/services/ChatFlowService';
import type { Content } from '../../modules/conversation/types';

function message(id: string, role: 'user' | 'model', text: string): Content {
    return { id, role, parts: [{ text }] } as Content;
}

describe('resolveRetryTruncateIndex', () => {
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

    test('普通回答：截断点 = 最后一条 model 消息', () => {
        const history = [message('user-1', 'user', 'question'), message('model-1', 'model', 'answer')];

        expect(resolveRetryTruncateIndex(history)).toBe(1);
    });

    test('工具续接回答：截断续接 model，保留前序工具调用与 functionResponse', () => {
        expect(resolveRetryTruncateIndex(toolLoopHistory)).toBe(3);
    });

    test('工具调用后 functionResponse 是最后一条：不截断（请求以 tool 结尾，继续生成）', () => {
        const history = toolLoopHistory.slice(0, 3); // [user, model(tool_call), fr]

        // fr 消息 role=user，历史末尾不是 model → 无 AI 回复尾巴可删；
        // formatter 会把 fr 转成 tool 消息，请求不触发 prefill。
        expect(resolveRetryTruncateIndex(history)).toBe(-1);
    });

    test('工具调用后无续接（fr 仍未返回）时从工具调用消息截断', () => {
        const history = [message('user-1', 'user', 'question'), toolLoopHistory[1]];

        expect(resolveRetryTruncateIndex(history)).toBe(1);
    });

    test('失败流未写出内容（末尾是 user）时不截断，不误删更早的正常回答', () => {
        const history = [
            message('user-1', 'user', 'question'),
            message('model-1', 'model', 'normal answer'),
            message('user-2', 'user', 'question 2'),
        ];

        // 重试的是 user-2 的失败流（从未生成内容）→ 继续生成即可，
        // 绝不能把 model-1 也删掉。
        expect(resolveRetryTruncateIndex(history)).toBe(-1);
    });

    test('末尾连续多条 model（异常状态）时整段删除，保证请求不以 assistant 结尾', () => {
        const history = [
            message('user-1', 'user', 'question'),
            message('model-1', 'model', 'answer 1'),
            message('model-2', 'model', 'answer 2'),
        ];

        expect(resolveRetryTruncateIndex(history)).toBe(1);
    });

    test('role=model 但携带 functionResponse 的混合消息仍按 model 截断', () => {
        const history: Content[] = [
            message('user-1', 'user', 'question'),
            {
                id: 'mixed-model',
                role: 'model',
                parts: [
                    { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
                    { functionResponse: { id: 'call-1', name: 'read_file', response: { success: true } } },
                ],
            } as Content,
        ];

        // 混合消息（中断残留/修复数据形态）role 是 model，isFunctionResponseMessage 不识别；
        // 按 model 截断是正确行为——formatter 会把其 functionResponse part 转成 tool 消息，
        // 删除后不残留孤儿 tool。
        expect(resolveRetryTruncateIndex(history)).toBe(1);
    });

    test('历史中没有 model 消息时返回 -1（失败流未写出内容）', () => {
        expect(resolveRetryTruncateIndex([])).toBe(-1);
        expect(resolveRetryTruncateIndex([message('user-1', 'user', 'question')])).toBe(-1);
    });
});
