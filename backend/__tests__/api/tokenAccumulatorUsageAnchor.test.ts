/**
 * accumulateContextTokens 的 usage 锚点模式测试。
 *
 * 背景：自动总结判定此前用「系统提示词 + 逐条本地估算（×1.5 安全系数）」累加，
 * 与前端 usedTokens 显示口径（最后一条 usage 的 totalTokenCount）脱节——
 * 用户看到 26 万却触发 40 万阈值的总结。useUsageAnchor=true 时直接以最后一条
 * 真实 usage 为锚点，与显示值完全同源；无 usage 时回退原有估算逻辑。
 */

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

function makeDeps(estimateMessageTokens = jest.fn()): AccumulateTokensDeps {
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
    test('命中最后一条 usage：直接返回 totalTokenCount，且不调用本地估算', () => {
        const estimateMessageTokens = jest.fn().mockReturnValue(999_999);
        const deps = makeDeps(estimateMessageTokens);
        const history = [
            makeUserMessage('hello'),
            makeModelMessage({ promptTokenCount: 300_000, candidatesTokenCount: 50_000, totalTokenCount: 350_000 })
        ];

        const result = accumulateContextTokens(deps, makeParams(history, { useUsageAnchor: true }));

        expect(result.estimatedTotalTokens).toBe(350_000);
        // 锚点命中后不再逐条本地估算
        expect(estimateMessageTokens).not.toHaveBeenCalled();
    });

    test('totalTokenCount 缺失时回退 promptTokenCount', () => {
        const deps = makeDeps();
        const history = [
            makeUserMessage('hello'),
            makeModelMessage({ promptTokenCount: 200_000, candidatesTokenCount: 30_000 })
        ];

        const result = accumulateContextTokens(deps, makeParams(history, { useUsageAnchor: true }));

        expect(result.estimatedTotalTokens).toBe(200_000);
    });

    test('usage 之后的新消息不累加：显示多少就用多少', () => {
        // 模拟主人的场景：上一轮主回复 usage 显示 260199，之后又有新输入和
        // 无 usage 的模型回复，判定值仍与显示值一致（不因本地估算提前触发）
        const estimateMessageTokens = jest.fn().mockReturnValue(999_999);
        const deps = makeDeps(estimateMessageTokens);
        const history = [
            makeUserMessage('first user input'),
            makeModelMessage({ promptTokenCount: 240_000, candidatesTokenCount: 20_199, totalTokenCount: 260_199 }),
            makeUserMessage('new user input after the anchored reply'),
            makeModelMessage(undefined as unknown as Content['usageMetadata'])
        ];

        const result = accumulateContextTokens(deps, makeParams(history, { useUsageAnchor: true }));

        expect(result.estimatedTotalTokens).toBe(260_199);
        expect(estimateMessageTokens).not.toHaveBeenCalled();
    });

    test('无任何 usage 记录：回退原有估算逻辑', () => {
        const estimateMessageTokens = jest.fn().mockReturnValue(500);
        const deps = makeDeps(estimateMessageTokens);
        const history = [makeUserMessage('hello')];

        const result = accumulateContextTokens(deps, makeParams(history, { useUsageAnchor: true }));

        expect(result.estimatedTotalTokens).toBe(1500); // promptTokens(1000) + 用户消息估算(500)
        expect(estimateMessageTokens).toHaveBeenCalledTimes(1);
    });

    test('默认关闭锚点模式：保持原有累加行为', () => {
        const estimateMessageTokens = jest.fn().mockReturnValue(500);
        const deps = makeDeps(estimateMessageTokens);
        const history = [
            makeUserMessage('hello'),
            makeModelMessage({ promptTokenCount: 200, candidatesTokenCount: 50, totalTokenCount: 250 })
        ];

        const result = accumulateContextTokens(deps, makeParams(history));

        // promptTokens(1000) + 用户消息估算(500) + 模型 usage candidates(50)
        expect(result.estimatedTotalTokens).toBe(1550);
    });
});
