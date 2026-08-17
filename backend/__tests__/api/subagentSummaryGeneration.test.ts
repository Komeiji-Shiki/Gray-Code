import { SummarizeService } from '../../modules/api/chat/services/SummarizeService';
import type { Content } from '../../modules/conversation/types';

function createService() {
    const generate = jest.fn().mockResolvedValue({
        content: {
            role: 'model',
            parts: [{
                text: 'A sufficiently detailed summary that preserves the task, completed work, current progress, next steps, constraints, and technical identifiers.'
            }],
            usageMetadata: { promptTokenCount: 420, candidatesTokenCount: 40 }
        }
    });
    const config = {
        id: 'summary-channel',
        name: 'Summary',
        type: 'openai',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        timeout: 1000,
        maxContextTokens: 10_000
    };
    const settingsManager = {
        getSummarizeConfig: () => ({
            autoSummarizePrompt: '',
            useSeparateModel: false,
            summarizeChannelId: '',
            summarizeModelId: '',
            summarizeMaxInputRatio: 0.5
        })
    };
    const service = new SummarizeService(
        { getConfig: jest.fn(async () => config) } as any,
        { generate } as any,
        {} as any,
        {} as any,
        settingsManager as any
    );
    return { service, generate };
}

function user(text: string, tokens: number): Content {
    return {
        role: 'user',
        parts: [{ text }],
        isUserInput: true,
        tokenCountByChannel: { openai: tokens }
    };
}

function model(text: string, tokens: number): Content {
    return {
        role: 'model',
        parts: [{ text }],
        usageMetadata: {
            promptTokenCount: 0,
            totalTokenCount: tokens,
            candidatesTokenCount: tokens
        }
    };
}

describe('SummarizeService.generateSummaryForHistory', () => {
    test('总结模型装不下全部候选时只消费最大安全前缀，不从开头丢失旧内容', async () => {
        const { service, generate } = createService();
        const history: Content[] = [
            user('initial-task-anchor', 100),
            model('old-completed-work', 100),
            user('second-requirement', 100),
            model('oversized-new-tail', 8_000)
        ];

        const result = await service.generateSummaryForHistory({
            history,
            configId: 'summary-channel'
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.consumedMessageCount).toBe(3);
        const requestHistory = generate.mock.calls[0][0].history as Content[];
        expect(requestHistory.slice(0, -1).map(message => message.parts[0]?.text)).toEqual([
            'initial-task-anchor',
            'old-completed-work',
            'second-requirement'
        ]);
        expect(JSON.stringify(requestHistory)).not.toContain('oversized-new-tail');
        expect(result.summaryRequestPromptTokens).toBe(420);
        expect(result.summaryTokenCount).toBe(40);
    });
});
