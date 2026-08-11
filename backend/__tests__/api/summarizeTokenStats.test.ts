import { SummarizeService } from '../../modules/api/chat/services/SummarizeService';
import type { Content } from '../../modules/conversation/types';

describe('SummarizeService summary token statistics', () => {
    test('separates main-context compression from summarizer request usage', () => {
        const service = new SummarizeService({} as any, {} as any, {} as any, {} as any);
        const user: Content = { role: 'user', parts: [{ text: 'x'.repeat(400) }] };
        const model: Content = {
            role: 'model',
            parts: [{ text: 'answer' }],
            usageMetadata: {
                promptTokenCount: 10_000,
                candidatesTokenCount: 100,
                totalTokenCount: 10_100
            }
        };

        const stats = (service as any).buildSummaryTokenStats({
            fullHistory: [user, model],
            messagesToSummarize: [user, model],
            summaryText: 'short summary',
            channelType: 'custom',
            providerSummaryTokens: 40
        });

        // user 本地估算 150 + model 输出 100；这里不应使用总结 API 的 promptTokenCount。
        expect(stats.sourceTokenCount).toBe(250);
        expect(stats.summaryTokenCount).toBe(40);
        expect(stats.estimatedTokensSaved).toBe(210);
        expect(stats.contextTokenCountBefore).toBe(10_000);
        expect(stats.estimatedContextTokenCountAfter).toBe(9_790);
    });
});
