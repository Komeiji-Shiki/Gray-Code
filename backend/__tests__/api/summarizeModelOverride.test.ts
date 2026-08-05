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

function createHarness(useSeparateModel = false, summarizeModelId = 'summary-model') {
    const configs: Record<string, any> = {
        main: {
            id: 'main',
            type: 'openai',
            enabled: true,
            model: '',
            maxContextTokens: 100_000
        },
        dedicated: {
            id: 'dedicated',
            type: 'openai',
            enabled: true,
            model: '',
            maxContextTokens: 100_000
        }
    };
    const generate = jest.fn().mockResolvedValue({
        content: {
            role: 'model',
            parts: [{ text: 'summary' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 }
        }
    });
    const conversationManager = {
        getHistory: jest.fn().mockResolvedValue(history),
        getHistoryRef: jest.fn().mockResolvedValue(history),
        insertContent: jest.fn().mockResolvedValue(undefined)
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
            keepRecentTokens: '10%',
            useSeparateModel,
            summarizeChannelId: useSeparateModel ? 'dedicated' : '',
            summarizeModelId: useSeparateModel ? summarizeModelId : '',
            summarizePrompt: ''
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
    it('手动总结使用当前对话实际选中的模型', async () => {
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

    it('独立总结模型优先于当前对话模型', async () => {
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

    it('独立渠道未指定模型时不错误继承主对话模型', async () => {
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
});
