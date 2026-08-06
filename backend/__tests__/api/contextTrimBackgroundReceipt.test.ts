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
    function createTurnScopedHarness(
        history: Content[],
        trimState?: Record<string, unknown>,
        fixedPromptTokens = 0
    ) {
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
            countTextTokensBatch: jest.fn().mockResolvedValue([fixedPromptTokens, 0]),
            preCountUserMessageTokensBatch: jest.fn().mockResolvedValue(undefined),
            estimateMessageTokens: jest.fn(() => 100)
        };
        const messageBuilderService = {
            hasThoughtContent: jest.fn(() => false),
            hasThoughtSignatures: jest.fn(() => false)
        };
        const service = new ContextTrimService(
            conversationManager as any,
            promptManager as any,
            tokenEstimationService as any,
            messageBuilderService as any
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
        // 首条用户消息原样保留在请求头部（原始任务锚点，isRealUserMessage 保护）
        expect(result.history[0]).toMatchObject({ role: 'user', parts: [{ text: '最初目标必须保留' }] });
        expect(result.history[0]).not.toHaveProperty('isSummary');
        // Preserved user inputs 档案仍注入（含首条用户消息的原文），紧随其后
        expect(result.history[1]).toMatchObject({ role: 'user', isSummary: true });
        expect(result.history[1].parts[0].text).toContain('最初目标必须保留');
        expect(result.history.slice(2)).toEqual(summarizedHistory.slice(2));
    });

    it('自动上下文管理关闭时仍应用用户显式创建的手动总结边界', async () => {
        const summarizedHistory: Content[] = [
            { role: 'user', parts: [{ text: '最初目标' }], isUserInput: true },
            { role: 'model', parts: [{ text: '很长的旧回答' }] },
            { role: 'user', parts: [{ text: '手动总结' }], isSummary: true },
            { role: 'model', parts: [{ text: '总结后的回答' }] }
        ];
        const { service } = createTurnScopedHarness(summarizedHistory);

        const result = await service.getHistoryWithContextTrimInfo(
            'conv-manual-summary',
            {
                contextManagementEnabled: false,
                contextThresholdEnabled: false,
                autoSummarizeEnabled: false
            } as any,
            {}
        );

        expect(result.trimStartIndex).toBe(2);
        // 首条用户消息永远发送（任务锚点）：位于发送历史最前
        expect(result.history[0]).toMatchObject({ role: 'user', parts: [{ text: '最初目标' }] });
        expect(result.history[0]).not.toHaveProperty('isSummary');
        // Preserved user inputs 档案紧随其后（含首条用户消息原文）
        expect(result.history[1]).toMatchObject({ role: 'user', isSummary: true });
        expect(result.history[1].parts[0].text).toContain('最初目标');
        // 手动总结边界仍然生效：总结消息在档案之后，总结之前的内容不重新携带
        expect(result.history[2]).toMatchObject({ role: 'user', isSummary: true });
        expect(result.history[2].parts[0].text).toContain('手动总结');
        expect(result.history.slice(3)).toEqual(summarizedHistory.slice(3));
        expect(result.contextManagementDecision).toMatchObject({
            enabled: false,
            mode: 'off',
            action: 'manual_summary_applied'
        });
    });

    it.each([
        ['显式总开关', { contextManagementEnabled: false }],
        ['旧版双开关', { contextThresholdEnabled: false, autoSummarizeEnabled: false }]
    ])('自动上下文管理关闭（%s）时不因总结阈值或配置窗口阻止主请求', async (_label, disabledConfig) => {
        const oversizedHistory: Content[] = [
            { role: 'user', parts: [{ text: 'x'.repeat(10_000) }], isUserInput: true },
            { role: 'model', parts: [{ text: 'y'.repeat(10_000) }] }
        ];
        const { service } = createTurnScopedHarness(oversizedHistory);

        const result = await service.getHistoryWithContextTrimInfo(
            'conv-context-management-off',
            {
                ...disabledConfig,
                maxContextTokens: 100,
                contextThreshold: '1%'
            } as any,
            {}
        );

        expect(result.history).toEqual(oversizedHistory);
        expect(result.needsAutoSummarize).not.toBe(true);
        expect(result.contextManagementDecision).toMatchObject({
            enabled: false,
            mode: 'off',
            action: 'disabled'
        });
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
        // 首条用户消息永远发送（任务锚点）：history[0] = old，history[1] = preserved 档案（含 old/current）
        expect(result.history[0]).toMatchObject({ role: 'user', parts: [{ text: 'old' }] });
        expect(result.history[0]).not.toHaveProperty('isSummary');
        expect(result.history[1]).toMatchObject({ role: 'user', isSummary: true });
        expect(result.history[1].parts[0].text).toContain('old');
        expect(result.history[1].parts[0].text).toContain('current');
        expect(result.history[2].parts[0].functionCall?.id).toBe('a');
        expect(result.history[3].parts[0].functionResponse?.id).toBe('a');
        expect(conversationManager.setCustomMetadata).not.toHaveBeenCalled();
    });

    it('固定 prompt 已超软阈值且新增历史很少时跳过低收益自动总结并继续主请求', async () => {
        const smallDelta: Content[] = [
            { role: 'user', parts: [{ text: 'small delta' }], isUserInput: true, tokenCountByChannel: { custom: 20 } },
            {
                role: 'model',
                parts: [{ text: 'small answer' }],
                usageMetadata: { candidatesTokenCount: 20 }
            }
        ];
        const { service } = createTurnScopedHarness(smallDelta, undefined, 330);

        const result = await service.getHistoryWithContextTrimInfo(
            'conv-low-value-auto-summary',
            {
                type: 'custom',
                model: 'tiny-model',
                models: [{ id: 'tiny-model', contextWindow: 400 }],
                contextManagementEnabled: true,
                contextManagementMode: 'summarize',
                maxContextTokens: 400,
                contextThreshold: '80%'
            } as any,
            {}
        );

        expect(result.needsAutoSummarize).toBe(false);
        expect(result.needsContextFallback).toBe(false);
        expect(result.history).toEqual(smallDelta);
        expect(result.contextManagementDecision?.action).toBe('auto_summarize_skipped_low_savings');
    });

    it('低收益总结被跳过但总输入已越过硬窗口时仍进入请求级 fallback', async () => {
        const smallDelta: Content[] = [
            { role: 'user', parts: [{ text: 'small delta' }], isUserInput: true, tokenCountByChannel: { custom: 60 } },
            {
                role: 'model',
                parts: [{ text: 'small answer' }],
                usageMetadata: { candidatesTokenCount: 60 }
            }
        ];
        const { service } = createTurnScopedHarness(smallDelta, undefined, 330);

        const result = await service.getHistoryWithContextTrimInfo(
            'conv-hard-fallback',
            {
                type: 'custom',
                model: 'tiny-model',
                models: [{ id: 'tiny-model', contextWindow: 400 }],
                contextManagementEnabled: true,
                contextManagementMode: 'summarize',
                maxContextTokens: 400,
                contextThreshold: '80%'
            } as any,
            {}
        );

        expect(result.needsAutoSummarize).toBe(false);
        expect(result.needsContextFallback).toBe(true);
        expect(result.contextManagementDecision?.action).toBe('hard_fallback_needed');
    });
});
