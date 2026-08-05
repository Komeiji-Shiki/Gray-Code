/**
 * ContextTrimService.getHistoryWithGranularFallback 回合内稳定起点回归测试。
 *
 * 背景：总结失败后 fallback 每轮重新规划切点时，工具结果一增长 absoluteStartIndex 就向后移动，
 * 每轮发出去的 retainedHistory 开头都不一样，provider 前缀缓存只能命中 history 之前的固定系统/工具段。
 *
 * 修复：ToolIterationLoopService 在同一真实用户回合内记录第一次 fallback 的 trimStartIndex，
 * 后续迭代通过 stableStartIndex 传入复用；仅当完整性校验失败或估算超过模型完整窗口
 * 时才重新规划。
 */

import { ContextTrimService } from '../../modules/api/chat/services/ContextTrimService';
import type { Content } from '../../modules/conversation/types';

describe('ContextTrimService.getHistoryWithGranularFallback - stable start index', () => {
    function createHarness(historyRef: () => Content[]) {
        const conversationManager = {
            getHistoryRef: jest.fn(() => Promise.resolve(historyRef())),
            getHistoryForAPIFrom: jest.fn((contents: Content[], options: { startIndex: number }) => (
                contents.slice(options.startIndex)
            )),
            getCustomMetadata: jest.fn().mockResolvedValue(undefined),
            setCustomMetadata: jest.fn(),
            invalidateContextManagementState: jest.fn()
        };
        const promptManager = {
            getSystemPrompt: jest.fn(() => ''),
            getDynamicContextText: jest.fn(() => '')
        };
        const tokenEstimationService = {
            countTextTokensBatch: jest.fn().mockResolvedValue([0, 0]),
            preCountUserMessageTokensBatch: jest.fn().mockResolvedValue(undefined),
            estimateMessageTokens: jest.fn((message: Content) =>
                message.tokenCountByChannel?.custom ?? 100
            )
        };
        const service = new ContextTrimService(
            conversationManager as any,
            promptManager as any,
            tokenEstimationService as any,
            {} as any
        );
        return { service, conversationManager, tokenEstimationService };
    }

    /** 工具循环历史：从 index 3（fc-a）开始的 suffix 恰好 700 tokens（+ preserved 100 ≤ 预算 936） */
    function buildToolLoopHistory(): Content[] {
        return [
            { role: 'user', parts: [{ text: 'old' }], isUserInput: true, tokenCountByChannel: { custom: 100 } },
            { role: 'model', parts: [{ text: 'old answer' }], tokenCountByChannel: { custom: 100 } },
            { role: 'user', parts: [{ text: 'current' }], isUserInput: true, tokenCountByChannel: { custom: 150 } },
            { role: 'model', parts: [{ functionCall: { id: 'a', name: 'tool', args: {} } }], tokenCountByChannel: { custom: 150 } },
            { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'a', name: 'tool', response: { ok: true } } }], tokenCountByChannel: { custom: 150 } },
            { role: 'model', parts: [{ functionCall: { id: 'b', name: 'tool', args: {} } }], tokenCountByChannel: { custom: 150 } },
            { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'b', name: 'tool', response: { ok: true } } }], tokenCountByChannel: { custom: 150 } },
            { role: 'model', parts: [{ text: 'done' }], tokenCountByChannel: { custom: 100 } }
        ];
    }

    const config = {
        type: 'custom',
        model: 'test-model',
        models: [{ id: 'test-model', contextWindow: 1_300 }],
        maxContextTokens: 1_300,
        contextThreshold: '80%'
    } as any;
    // threshold/input limit = 1040；provider reserve = 104；history budget = 936；总历史 1050（超预算触发裁剪）

    it('工具结果增长时复用 stableStartIndex，retainedHistory 前缀保持稳定', async () => {
        let history = buildToolLoopHistory();
        const { service } = createHarness(() => history);

        // 首次调用（回合内第一次评估，无稳定起点）：规划出切点 3
        const first = await service.getHistoryWithGranularFallback('c1', config, {});
        expect(first.trimStartIndex).toBe(3);
        expect(first.contextManagementDecision?.action).toBe('fallback_trim_applied');
        // model（fc-a）开头 → 前置临时 user 占位 + preserved user inputs
        expect(first.history[0]).toMatchObject({ role: 'user', isSummary: true });
        expect(first.history[1].parts[0].functionCall?.id).toBe('a');

        // 工具结果小幅增长 100 tokens（成对追加 fc-c + fr-c），总输入仍在安全预算内。
        history = [
            ...history,
            { role: 'model', parts: [{ functionCall: { id: 'c', name: 'tool', args: {} } }], tokenCountByChannel: { custom: 50 } },
            { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'c', name: 'tool', response: { ok: true } } }], tokenCountByChannel: { custom: 50 } }
        ];

        const second = await service.getHistoryWithGranularFallback('c1', config, {}, undefined, 'single', 3);
        expect(second.trimStartIndex).toBe(3);
        expect(second.contextManagementDecision?.action).toBe('fallback_stable_start_reused');
        // retainedHistory 前缀与首次完全一致（preserved 输入 + suffix 相同），只是尾部追加了新工具结果
        expect(second.history.slice(0, first.history.length)).toEqual(first.history);
        expect(second.history.length).toBe(first.history.length + 2);
        expect(second.history[second.history.length - 1].parts[0].functionResponse?.id).toBe('c');
    });

    it('稳定起点超过优先预算但最小合法请求恰好等于完整窗口时仍继续', async () => {
        let history = buildToolLoopHistory();
        const { service } = createHarness(() => history);

        const first = await service.getHistoryWithGranularFallback('c1', config, {});
        expect(first.trimStartIndex).toBe(3);

        // 工具结果暴涨 1200 tokens：加上 preserved 输入后恰好等于 1300 的完整窗口。
        // 95% 预留不能把它提前升级成硬拒绝，应退到完整窗口边界继续。
        history = [
            ...history,
            { role: 'model', parts: [{ functionCall: { id: 'c', name: 'tool', args: {} } }], tokenCountByChannel: { custom: 600 } },
            { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'c', name: 'tool', response: { ok: true } } }], tokenCountByChannel: { custom: 600 } }
        ];

        const result = await service.getHistoryWithGranularFallback('c1', config, {}, undefined, 'single', 3);
        expect(result.contextManagementDecision?.action).toBe('fallback_hard_limit_applied');
        expect(result.trimStartIndex).toBe(8);
    });

    it('稳定起点越界或早于总结起点时忽略并重新规划', async () => {
        const history = buildToolLoopHistory();
        const { service } = createHarness(() => history);

        // 越界起点：忽略，正常规划出 3
        const outOfBounds = await service.getHistoryWithGranularFallback('c1', config, {}, undefined, 'single', 999);
        expect(outOfBounds.trimStartIndex).toBe(3);

        // 历史包含总结（index 2 是 summary，historyStartIndex = 2）：
        // stableStartIndex=1 早于总结起点 → 忽略，规划起点至少 >= 2
        const summarizedHistory: Content[] = [
            { role: 'user', parts: [{ text: 'goal' }], isUserInput: true, tokenCountByChannel: { custom: 50 } },
            { role: 'model', parts: [{ text: 'a' }], tokenCountByChannel: { custom: 50 } },
            { role: 'user', parts: [{ text: 'summary' }], isSummary: true, tokenCountByChannel: { custom: 100 } },
            { role: 'model', parts: [{ text: 'after summary' }], tokenCountByChannel: { custom: 200 } },
            { role: 'user', parts: [{ text: 'new' }], isUserInput: true, tokenCountByChannel: { custom: 200 } },
            { role: 'model', parts: [{ text: 'new answer' }], tokenCountByChannel: { custom: 200 } }
        ];
        const { service: s2 } = createHarness(() => summarizedHistory);
        const result = await s2.getHistoryWithGranularFallback('c2', config, {}, undefined, 'single', 1);
        expect(result.trimStartIndex).toBe(2);
        // history[0] 是 preserved 用户输入档案（goal），history[1] 才是总结消息
        expect(result.history[1].parts[0].text).toContain('summary');
    });

    it('稳定起点落在 model 消息上时同样补临时 user 占位保证角色顺序', async () => {
        let history = buildToolLoopHistory();
        const { service } = createHarness(() => history);

        // 先规划出起点 3（model/fc-a），历史增长后仍以 3 为稳定起点
        const first = await service.getHistoryWithGranularFallback('c1', config, {});
        expect(first.trimStartIndex).toBe(3);

        history = [
            ...history,
            { role: 'model', parts: [{ functionCall: { id: 'c', name: 'tool', args: {} } }], tokenCountByChannel: { custom: 50 } },
            { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'c', name: 'tool', response: { ok: true } } }], tokenCountByChannel: { custom: 50 } }
        ];

        const second = await service.getHistoryWithGranularFallback('c1', config, {}, undefined, 'single', 3);
        expect(second.history[0]).toMatchObject({ role: 'user', isSummary: true });
        expect(second.history[1].parts[0].functionCall?.id).toBe('a');
        expect(second.trimStartIndex).toBe(3);
    });

    it('固定系统提示词和动态上下文会从 fallback 历史预算中扣除', async () => {
        const history = buildToolLoopHistory();
        const { service } = createHarness(() => history);

        // input limit 1040 - provider reserve 104 - fixed prompt 400 = history budget 536。
        // 起点 3 的最终历史约 800，必须继续推进到起点 5（约 500）。
        const result = await service.getHistoryWithGranularFallback(
            'c1',
            config,
            {},
            undefined,
            'single',
            undefined,
            400
        );

        expect(result.trimStartIndex).toBe(5);
        expect(result.contextManagementDecision?.action).toBe('fallback_trim_applied');
    });

    it('超过总结软阈值但仍低于模型硬窗口时继续请求，不把总结阈值当硬上限', async () => {
        const history = buildToolLoopHistory();
        const { service } = createHarness(() => history);

        // 软预算只剩 36 tokens，任何候选都无法达到；模型硬窗口仍给 history 留有 335 tokens。
        // 应选择硬窗口内最早的合法候选继续请求，而不是报 CONTEXT_OVERFLOW。
        const result = await service.getHistoryWithGranularFallback(
            'c1',
            config,
            {},
            undefined,
            'single',
            undefined,
            900
        );

        expect(result.contextManagementDecision?.action).toBe('fallback_hard_limit_applied');
        expect(result.history.length).toBeGreaterThan(0);
    });

    it('只有连最小合法请求也装不进模型硬窗口时才报 CONTEXT_OVERFLOW', async () => {
        const history = buildToolLoopHistory();
        const { service } = createHarness(() => history);

        await expect(
            service.getHistoryWithGranularFallback(
                'c1',
                config,
                {},
                undefined,
                'single',
                undefined,
                1_101
            )
        ).rejects.toMatchObject({
            code: 'CONTEXT_OVERFLOW',
            estimatedInputTokens: 1_301,
            inputTokenLimit: 1_300
        });
    });

    it('模型未声明 contextWindow 时不把渠道 maxContextTokens 当硬拒绝边界', async () => {
        const history = buildToolLoopHistory();
        const { service } = createHarness(() => history);
        const configWithoutKnownWindow = {
            type: 'custom',
            maxContextTokens: 1_300,
            contextThreshold: '80%'
        } as any;

        const result = await service.getHistoryWithGranularFallback(
            'c1',
            configWithoutKnownWindow,
            {},
            undefined,
            'single',
            undefined,
            1_101
        );

        expect(result.contextManagementDecision?.action).toBe('fallback_best_effort_applied');
        expect(result.history.length).toBeGreaterThan(0);
    });
});
