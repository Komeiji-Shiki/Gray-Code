/**
 * 预设临时消息伪造思考（fakeThought）的发送侧过滤策略测试。
 *
 * 语义与真实历史思考一致：渠道显式关闭「发送历史思考内容」（sendHistoryThoughts=false）
 * 时不回传伪造思考（剥离 thought part，正文照发）；开启或未配置时原样保留。
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
    it('keeps fake thought parts when sendHistoryThoughts is enabled or unset', () => {
        for (const sendHistoryThoughts of [undefined, true]) {
            const result = applyPromptContextThoughtPolicy(createPromptContext(), { sendHistoryThoughts });
            expect(result.beforeHistoryMessages[1].parts).toHaveLength(2);
            expect(result.beforeHistoryMessages[1].parts[0]).toEqual({ text: 'Fake reasoning trace', thought: true });
        }
    });

    it('strips fake thought parts when sendHistoryThoughts is explicitly disabled', () => {
        const result = applyPromptContextThoughtPolicy(createPromptContext(), { sendHistoryThoughts: false });

        // 伪造思考被剥离，正文保留
        expect(result.beforeHistoryMessages[1].parts).toEqual([{ text: 'Assistant prelude' }]);
        // 普通正文消息不受影响
        expect(result.beforeHistoryMessages[0].parts).toEqual([{ text: 'Static user context' }]);
        // afterHistoryMessages 同样处理
        expect(result.afterHistoryMessages[0].parts).toEqual([{ text: 'After history context' }]);
    });

    it('does not mutate the input prompt context', () => {
        const context = createPromptContext();
        applyPromptContextThoughtPolicy(context, { sendHistoryThoughts: false });

        expect(context.beforeHistoryMessages[1].parts).toHaveLength(2);
    });
});
