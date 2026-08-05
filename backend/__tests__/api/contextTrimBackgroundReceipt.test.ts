/**
 * ContextTrimService 后台任务回执回合边界回归测试。
 *
 * 背景：后台子 Agent 完成结果曾作为普通 user 消息回流，被识别为新回合。
 * 当上一回合约 350k token 时，裁剪器会整体丢弃上一回合，只留下约 20k 的后台回执回合。
 */

import { ContextTrimService } from '../../modules/api/chat/services/ContextTrimService';
import type { Content } from '../../modules/conversation/types';

function createService(): ContextTrimService {
    return new ContextTrimService({} as any, {} as any, {} as any, {} as any);
}

describe('ContextTrimService.identifyRounds - background task receipt', () => {
    it('后台任务回执是原任务的异步延续，不创建新的裁剪回合', () => {
        const history: Content[] = [
            {
                role: 'user',
                parts: [{ text: '执行一个很长的任务' }],
                isUserInput: true
            },
            {
                role: 'model',
                parts: [{ text: '正在处理' }],
                usageMetadata: { totalTokenCount: 350000 }
            },
            {
                role: 'user',
                parts: [{ text: '[Background task completed]\nResult: ...' }],
                isUserInput: false,
                source: 'background_task'
            },
            {
                role: 'model',
                parts: [{ text: '已收到后台结果' }],
                usageMetadata: { totalTokenCount: 20000 }
            }
        ];

        const rounds = createService().identifyRounds(history);

        expect(rounds).toEqual([
            { startIndex: 0, endIndex: 4, tokenCount: 20000 }
        ]);
    });

    it('后续真实用户消息仍正常开始新回合，旧历史无 isUserInput 标记也兼容', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: '旧历史用户消息' }] },
            { role: 'model', parts: [{ text: '旧回答' }] },
            { role: 'user', parts: [{ text: '后台结果' }], source: 'background_task' },
            { role: 'model', parts: [{ text: '后台结果总结' }] },
            { role: 'user', parts: [{ text: '新的真实问题' }], isUserInput: true },
            { role: 'model', parts: [{ text: '新回答' }] }
        ];

        const rounds = createService().identifyRounds(history);

        expect(rounds.map(round => [round.startIndex, round.endIndex])).toEqual([
            [0, 4],
            [4, 6]
        ]);
    });
});

describe('ContextTrimService - turn-scoped trim state', () => {
    function createTurnScopedHarness(history: Content[], trimState?: Record<string, unknown>) {
        const conversationManager = {
            getHistoryRef: jest.fn().mockResolvedValue(history),
            getCustomMetadata: jest.fn().mockImplementation(async (_conversationId: string, key: string) => (
                key === 'trimState' ? trimState : undefined
            )),
            getHistoryForAPIFrom: jest.fn().mockImplementation((contents: Content[], options: { startIndex: number }) => (
                contents.slice(options.startIndex)
            )),
            invalidateContextManagementState: jest.fn(),
            setCustomMetadata: jest.fn()
        };
        const promptManager = {
            getSystemPrompt: jest.fn(() => ''),
            getDynamicContextText: jest.fn(() => '')
        };
        const tokenEstimationService = {
            countTextTokensBatch: jest.fn().mockResolvedValue([0, 0]),
            preCountUserMessageTokensBatch: jest.fn().mockResolvedValue(undefined),
            estimateMessageTokens: jest.fn(() => 100)
        };
        const service = new ContextTrimService(
            conversationManager as any,
            promptManager as any,
            tokenEstimationService as any,
            {} as any
        );
        return { service, conversationManager, promptManager, tokenEstimationService };
    }

    const largeSubAgentHistory: Content[] = [
        { role: 'user', parts: [{ text: '旧回合' }], isUserInput: true },
        { role: 'model', parts: [{ text: '旧回答' }] },
        { role: 'user', parts: [{ text: '当前回合' }], isUserInput: true },
        {
            role: 'model',
            parts: [{ functionCall: { id: 'subagent-call', name: 'subagents', args: {} } }]
        },
        {
            role: 'user',
            isFunctionResponse: true,
            parts: [{
                functionResponse: {
                    id: 'subagent-call',
                    name: 'subagents',
                    response: { success: true, data: { response: 'x'.repeat(200_000) } }
                }
            }]
        }
    ];

    it('同一回合的 SubAgent 大结果接近上限时触发模型总结而不是推进整轮 trimState', async () => {
        const { service, conversationManager } = createTurnScopedHarness(largeSubAgentHistory);

        const result = await service.getHistoryWithContextTrimInfo(
            'conv-turn',
            {
                contextManagementEnabled: true,
                contextManagementMode: 'trim',
                maxContextTokens: 400,
                contextThreshold: '80%'
            } as any,
            {},
            '',
            undefined,
            undefined,
            'single',
            { allowStateAdvance: false }
        );

        expect(result.needsAutoSummarize).toBe(true);
        expect(result.contextManagementDecision?.action).toBe('auto_summarize_needed');
        expect(conversationManager.setCustomMetadata).not.toHaveBeenCalled();
    });

    it('总结起点之前的真实用户输入会按原文档案注入请求', async () => {
        const summarizedHistory: Content[] = [
            { role: 'user', parts: [{ text: '最初目标必须保留' }], isUserInput: true },
            { role: 'model', parts: [{ text: '旧回答' }] },
            { role: 'user', parts: [{ text: '历史总结' }], isSummary: true },
            { role: 'model', parts: [{ text: '总结后的回答' }] },
            { role: 'user', parts: [{ text: '最新要求' }], isUserInput: true }
        ];
        const { service } = createTurnScopedHarness(summarizedHistory);

        const result = await service.getHistoryWithContextTrimInfo(
            'conv-summarized',
            { contextManagementEnabled: true, maxContextTokens: 100_000 } as any,
            {}
        );

        expect(result.trimStartIndex).toBe(2);
        expect(result.history[0]).toMatchObject({ role: 'user', isSummary: true });
        expect(result.history[0].parts[0].text).toContain('最初目标必须保留');
        expect(result.history.slice(1)).toEqual(summarizedHistory.slice(2));
    });

    it('升级后清除可能在工具回合中途写入的旧裁剪状态', async () => {
        const { service, conversationManager } = createTurnScopedHarness(largeSubAgentHistory, {
            trimStartIndex: 2
        });

        const result = await service.getHistoryWithContextTrimInfo(
            'conv-legacy-trim-state',
            { contextManagementEnabled: true, contextManagementMode: 'trim', maxContextTokens: 100_000 } as any,
            {},
            '',
            undefined,
            undefined,
            'single',
            { allowStateAdvance: false }
        );

        expect(result.history).toEqual(largeSubAgentHistory);
        expect(result.trimStartIndex).toBe(0);
        expect(conversationManager.invalidateContextManagementState).toHaveBeenCalledWith(
            'conv-legacy-trim-state',
            'trim_state_schema_upgrade'
        );
    });

    it('总结失败兜底可在当前长工具轮内部裁剪且不写持久 trimState', async () => {
        const fallbackHistory: Content[] = [
            { role: 'user', parts: [{ text: 'old' }], isUserInput: true, tokenCountByChannel: { custom: 50 } },
            { role: 'model', parts: [{ text: 'old answer' }], tokenCountByChannel: { custom: 50 } },
            { role: 'user', parts: [{ text: 'current' }], isUserInput: true, tokenCountByChannel: { custom: 100 } },
            {
                role: 'model',
                parts: [{ functionCall: { id: 'a', name: 'tool', args: {} } }],
                tokenCountByChannel: { custom: 200 }
            },
            {
                role: 'user', isFunctionResponse: true,
                parts: [{ functionResponse: { id: 'a', name: 'tool', response: { ok: true } } }],
                tokenCountByChannel: { custom: 200 }
            },
            {
                role: 'model',
                parts: [{ functionCall: { id: 'b', name: 'tool', args: {} } }],
                tokenCountByChannel: { custom: 200 }
            },
            {
                role: 'user', isFunctionResponse: true,
                parts: [{ functionResponse: { id: 'b', name: 'tool', response: { ok: true } } }],
                tokenCountByChannel: { custom: 200 }
            },
            { role: 'model', parts: [{ text: 'done' }], tokenCountByChannel: { custom: 100 } }
        ];
        const { service, conversationManager } = createTurnScopedHarness(fallbackHistory);

        const result = await service.getHistoryWithGranularFallback(
            'conv-fallback',
            { type: 'custom', maxContextTokens: 1_250, contextThreshold: '80%' } as any,
            {}
        );

        expect(result.contextManagementDecision?.action).toBe('fallback_trim_applied');
        expect(result.trimStartIndex).toBe(3);
        expect(result.history[0]).toMatchObject({ role: 'user', isSummary: true });
        expect(result.history[0].parts[0].text).toContain('old');
        expect(result.history[0].parts[0].text).toContain('current');
        expect(result.history[1].parts[0].functionCall?.id).toBe('a');
        expect(result.history[2].parts[0].functionResponse?.id).toBe('a');
        expect(conversationManager.setCustomMetadata).not.toHaveBeenCalled();
    });
});
