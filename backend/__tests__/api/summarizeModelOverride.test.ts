import { SummarizeService } from '../../modules/api/chat/services/SummarizeService';
import type { Content } from '../../modules/conversation/types';

const history: Content[] = [
    { role: 'user', parts: [{ text: 'round 1' }], isUserInput: true },
    { role: 'model', parts: [{ text: 'answer 1' }] },
    { role: 'user', parts: [{ text: 'round 2' }], isUserInput: true },
    { role: 'model', parts: [{ text: 'answer 2' }] },
    { role: 'user', parts: [{ text: 'round 3' }], isUserInput: true },
    { role: 'model', parts: [{ text: 'answer 3' }] }
];

/**
 * 保持本地的 createHarness（createHarness 收敛批次）：useSeparateModel/summarizeModelId 位置参数 +
 * main/dedicated 双配置 map，形状与共享的 createSummarizeHarness 差异过大，不收敛，
 * 见 ../__fixtures__/harnessFixtures.ts 头注释。
 */
function createHarness(
    useSeparateModel = false,
    summarizeModelId = 'summary-model',
    options: {
        mainConfig?: Record<string, unknown>;
        dedicatedConfig?: Record<string, unknown>;
        summarizePrompt?: string;
    } = {}
) {
    const configs: Record<string, any> = {
        main: {
            id: 'main',
            type: 'openai',
            enabled: true,
            model: '',
            maxContextTokens: 100_000,
            ...options.mainConfig
        },
        dedicated: {
            id: 'dedicated',
            type: 'openai',
            enabled: true,
            model: '',
            maxContextTokens: 100_000,
            ...options.dedicatedConfig
        }
    };
    const generate = jest.fn().mockResolvedValue({
        content: {
            role: 'model',
            // 总结文本必须 >= MIN_SUMMARY_LENGTH（50 字符），否则会被 LOW_QUALITY_SUMMARY 拒绝
            // （与共享 fixture 的 SUCCESS_SUMMARY 同语义，见 harnessFixtures.ts）
            parts: [{ text: '已完成总结。这是足够长的总结正文：目标已记录、已完成步骤与当前进度、下一步计划与关键约束均已覆盖，供后续对话继续使用。' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 }
        }
    });
    const conversationManager = {
        getHistory: jest.fn().mockResolvedValue(history),
        getHistoryRef: jest.fn().mockResolvedValue(history),
        insertContent: jest.fn().mockResolvedValue(undefined),
        // 逻辑截断语义：总结走仓储 mutateContents（标记 + 插入），不再使用 insertContent
        getTranscriptRepository: jest.fn(() => ({
            mutateContents: jest.fn(async (mutator: (h: Content[]) => Content[]) => {
                const copy = JSON.parse(JSON.stringify(history)) as Content[];
                const next = mutator(copy);
                if (next !== copy) {
                    const persisted = JSON.parse(JSON.stringify(next)) as Content[];
                    history.splice(0, history.length, ...persisted);
                    return persisted;
                }
                return copy;
            })
        }))
    };
    const contextTrimService = {
        findLastSummaryIndex: jest.fn().mockReturnValue(-1),
        identifyRounds: jest.fn().mockReturnValue([
            { startIndex: 0, endIndex: 2 },
            { startIndex: 2, endIndex: 4 },
            { startIndex: 4, endIndex: 6 }
        ])
    };
    const settingsManager = {
        getSummarizeConfig: jest.fn().mockReturnValue({
            keepRecentRounds: 1,
            keepRecentTokens: 10000,
            useSeparateModel,
            summarizeChannelId: useSeparateModel ? 'dedicated' : '',
            summarizeModelId: useSeparateModel ? summarizeModelId : '',
            summarizePrompt: options.summarizePrompt ?? '',
            summarizeMaxInputRatio: 0.5
        })
    };
    const service = new SummarizeService(
        { getConfig: jest.fn(async (id: string) => configs[id]) } as any,
        { generate } as any,
        conversationManager as any,
        contextTrimService as any,
        settingsManager as any
    );

    return { service, generate };
}

describe('SummarizeService current conversation model override', () => {
    test('手动总结使用当前对话实际选中的模型', async () => {
        const { service, generate } = createHarness(false);

        const result = await service.handleSummarizeContext({
            conversationId: 'conv-1',
            configId: 'main',
            modelOverride: 'deepseek-v4-flash'
        });

        expect(result.success).toBe(true);
        expect(generate).toHaveBeenCalledWith(expect.objectContaining({
            configId: 'main',
            modelOverride: 'deepseek-v4-flash'
        }));
    });

    test('独立总结模型优先于当前对话模型', async () => {
        const { service, generate } = createHarness(true);

        const result = await service.handleSummarizeContext({
            conversationId: 'conv-1',
            configId: 'main',
            modelOverride: 'deepseek-v4-flash'
        });

        expect(result.success).toBe(true);
        expect(generate).toHaveBeenCalledWith(expect.objectContaining({
            configId: 'dedicated',
            modelOverride: 'summary-model'
        }));
    });

    test('独立渠道未指定模型时不错误继承主对话模型', async () => {
        const { service, generate } = createHarness(true, '');

        const result = await service.handleSummarizeContext({
            conversationId: 'conv-1',
            configId: 'main',
            modelOverride: 'deepseek-v4-flash'
        });

        expect(result.success).toBe(true);
        const generateOptions = generate.mock.calls[0][0] as { configId: string; modelOverride?: string };
        expect(generateOptions.configId).toBe('dedicated');
        expect(generateOptions.modelOverride).toBeUndefined();
    });

    test('未配置渠道级窗口时按当前对话 modelOverride 的 contextWindow 做总结预检', async () => {
        const configOverride = {
            models: [
                { id: 'tiny-model', contextWindow: 200 },
                { id: 'large-model', contextWindow: 100_000 }
            ]
        };
        const tiny = createHarness(false, 'summary-model', { mainConfig: configOverride });

        const rejected = await tiny.service.handleSummarizeContext({
            conversationId: 'conv-1',
            configId: 'main',
            modelOverride: 'tiny-model'
        });

        expect(rejected).toMatchObject({ success: false, error: { code: 'CONTEXT_OVERFLOW' } });
        expect(tiny.generate).not.toHaveBeenCalled();

        const large = createHarness(false, 'summary-model', { mainConfig: configOverride });
        const accepted = await large.service.handleSummarizeContext({
            conversationId: 'conv-1',
            configId: 'main',
            modelOverride: 'large-model'
        });

        expect(accepted.success).toBe(true);
        expect(large.generate).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: 'large-model' }));
    });

    test('手动总结预检计入总结提示词开销，超限时不发送必败 API 请求', async () => {
        const { service, generate } = createHarness(false, 'summary-model', {
            mainConfig: { maxContextTokens: 1_000 },
            summarizePrompt: 'very-long-summary-instruction '.repeat(200)
        });

        const result = await service.handleSummarizeContext({
            conversationId: 'conv-1',
            configId: 'main'
        });

        expect(result).toMatchObject({ success: false, error: { code: 'CONTEXT_OVERFLOW' } });
        expect(generate).not.toHaveBeenCalled();
    });
});
