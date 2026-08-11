/**
 * 预设临时消息伪造思考（fakeThought）的发送侧过滤策略测试。
 *
 * 语义与真实历史思考完全一致：仅当渠道显式开启「发送历史思考内容」（sendHistoryThoughts=true）
 * 时回传伪造思考；未配置（undefined）或显式关闭都剥离 thought part（正文照发），
 * 与 formatHistoryForAPI 的 `sendHistoryThoughts ?? false` 默认保持一致，
 * 避免同一条消息因默认值分歧在不同路径下产出不同字节、破坏提示词前缀缓存。
 * 过滤必须在发送侧执行，不能写进 turnDynamicContext 缓存（缓存可能被不同渠道复用）。
 */
import { applyPromptContextThoughtPolicy } from '../../modules/api/chat/services/ToolIterationLoopService';
import type { RequestPromptContext } from '../../modules/channel/types';
import type { Content } from '../../modules/conversation/types';

const userMessage: Content = {
    role: 'user',
    parts: [{ text: 'Static user context' }]
};

const assistantMessageWithFakeThought: Content = {
    role: 'model',
    parts: [
        { text: 'Fake reasoning trace', thought: true },
        { text: 'Assistant prelude' }
    ]
};

const afterHistoryMessage: Content = {
    role: 'user',
    parts: [{ text: 'After history context' }]
};

function createPromptContext(): RequestPromptContext {
    return {
        beforeHistoryMessages: [userMessage, assistantMessageWithFakeThought],
        afterHistoryMessages: [afterHistoryMessage],
        historyPlacement: 'entry'
    };
}

describe('applyPromptContextThoughtPolicy', () => {
    test('keeps fake thought parts only when sendHistoryThoughts is explicitly enabled', () => {
        const result = applyPromptContextThoughtPolicy(createPromptContext(), { sendHistoryThoughts: true });
        expect(result.beforeHistoryMessages[1].parts).toHaveLength(2);
        expect(result.beforeHistoryMessages[1].parts[0]).toEqual({ text: 'Fake reasoning trace', thought: true });
    });

    test('strips fake thought parts when sendHistoryThoughts is unset or explicitly disabled', () => {
        for (const sendHistoryThoughts of [undefined, false]) {
            const result = applyPromptContextThoughtPolicy(createPromptContext(), { sendHistoryThoughts });

            // 伪造思考被剥离，正文保留
            expect(result.beforeHistoryMessages[1].parts).toEqual([{ text: 'Assistant prelude' }]);
            // 普通正文消息不受影响
            expect(result.beforeHistoryMessages[0].parts).toEqual([{ text: 'Static user context' }]);
            // afterHistoryMessages 同样处理
            expect(result.afterHistoryMessages[0].parts).toEqual([{ text: 'After history context' }]);
        }
    });

    test('does not mutate the input prompt context', () => {
        const context = createPromptContext();
        applyPromptContextThoughtPolicy(context, { sendHistoryThoughts: false });

        expect(context.beforeHistoryMessages[1].parts).toHaveLength(2);
    });
});
