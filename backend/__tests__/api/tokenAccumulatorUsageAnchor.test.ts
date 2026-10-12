/** 当前请求预算只累加选中的正文；旧 usage 不可充当缺少请求身份的总量锚点。 */

import { accumulateContextTokens } from '../../modules/api/chat/services/contextTrim/tokenAccumulator';
import type { AccumulateTokensDeps } from '../../modules/api/chat/services/contextTrim/tokenAccumulator';
import type { Content } from '../../modules/conversation/types';

function makeUserMessage(text: string): Content {
    return { role: 'user', parts: [{ text }] };
}

function makeModelMessage(usage: Content['usageMetadata']): Content {
    return {
        role: 'model',
        parts: [{ text: 'reply' }],
        usageMetadata: usage
    };
}

function makeDeps(estimateMessageTokens = jest.fn().mockReturnValue(500)): AccumulateTokensDeps {
    return {
        tokenEstimationService: {
            estimateMessageTokens
        },
        messageBuilderService: {
            hasThoughtContent: jest.fn().mockReturnValue(false)
        }
    } as unknown as AccumulateTokensDeps;
}

function makeParams(fullHistory: Content[], extra: Record<string, unknown> = {}) {
    return {
        fullHistory,
        effectiveStartIndex: 0,
        lastNonFunctionResponseUserIndex: -1,
        historyThoughtMinIndex: 0,
        historyThoughtMaxIndex: -1,
        sendHistoryThoughts: false,
        sendHistoryThoughtSignatures: false,
        sendCurrentThoughts: true,
        sendCurrentThoughtSignatures: false,
        channelType: 'anthropic',
        promptTokens: 1000,
        preservedDynamicContextTokenByIndex: new Map(),
        ...extra
    } as Parameters<typeof accumulateContextTokens>[1];
}

describe('accumulateContextTokens usage 锚点模式', () => {
    test('旧 usage 不覆盖当前正文预算，模型输出仅计一次', () => {
        const estimateMessageTokens = jest.fn().mockReturnValue(500);
        const deps = makeDeps(estimateMessageTokens);
        const history = [
            makeUserMessage('hello'),
            makeModelMessage({ promptTokenCount: 300_000, candidatesTokenCount: 50_000, totalTokenCount: 350_000 })
        ];

        const result = accumulateContextTokens(deps, makeParams(history, { useUsageAnchor: true }));

        expect(result.estimatedTotalTokens).toBe(2000);
        expect(estimateMessageTokens).toHaveBeenCalledTimes(2);
    });

    test('只有 prompt usage 也不复用旧输入预算', () => {
        const deps = makeDeps();
        const history = [
            makeUserMessage('hello'),
            makeModelMessage({ promptTokenCount: 200_000, candidatesTokenCount: 30_000 })
        ];

        const result = accumulateContextTokens(deps, makeParams(history, { useUsageAnchor: true }));

        expect(result.estimatedTotalTokens).toBe(2000);
    });

    test('usage 之后的新输入与工具结果继续计入当前预算', () => {
        const estimateMessageTokens = jest.fn().mockReturnValue(500);
        const deps = makeDeps(estimateMessageTokens);
        const history = [
            makeUserMessage('first user input'),
            makeModelMessage({ promptTokenCount: 240_000, candidatesTokenCount: 20_199, totalTokenCount: 260_199 }),
            makeUserMessage('new user input after the anchored reply'),
            { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { name: 'read_file', response: { content: 'new result' } } }] } as Content
        ];

        const result = accumulateContextTokens(deps, makeParams(history, { useUsageAnchor: true }));

        expect(result.estimatedTotalTokens).toBe(3000);
        expect(estimateMessageTokens).toHaveBeenCalledTimes(4);
    });

    test('无 usage 记录时直接计数选中的正文', () => {
        const estimateMessageTokens = jest.fn().mockReturnValue(500);
        const deps = makeDeps(estimateMessageTokens);
        const history = [makeUserMessage('hello')];

        const result = accumulateContextTokens(deps, makeParams(history, { useUsageAnchor: true }));

        expect(result.estimatedTotalTokens).toBe(1500); // promptTokens(1000) + 用户消息估算(500)
        expect(estimateMessageTokens).toHaveBeenCalledTimes(1);
    });

    test('默认路径也不把模型 usage 输出重复加到正文上', () => {
        const estimateMessageTokens = jest.fn().mockReturnValue(500);
        const deps = makeDeps(estimateMessageTokens);
        const history = [
            makeUserMessage('hello'),
            makeModelMessage({ promptTokenCount: 200, candidatesTokenCount: 50, totalTokenCount: 250 })
        ];

        const result = accumulateContextTokens(deps, makeParams(history));

        // 固定前缀 1000 + 用户正文 500 + 模型正文 500。
        expect(result.estimatedTotalTokens).toBe(2000);
    });
});
