import { get_encoding } from 'tiktoken';
import { SummaryAlgorithms } from '../../modules/api/chat/services/SummaryAlgorithms';
import type { Content } from '../../modules/conversation/types';

describe('SummaryAlgorithms summary token statistics', () => {
    test('separates main-context compression from summarizer request usage', () => {
        const service = new SummaryAlgorithms();
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

        const tokenizer = get_encoding('o200k_base');
        const sourceTokens = [user, model].reduce((total, message) =>
            total + tokenizer.encode(message.parts[0].text!, [], []).length, 0);
        tokenizer.free();
        const providerSummaryTokens = 40;

        const stats = service.buildSummaryTokenStats({
            fullHistory: [user, model],
            messagesToSummarize: [user, model],
            summaryText: 'short summary',
            channelType: 'custom',
            providerSummaryTokens
        });

        // 压缩源按真实正文计数，主模型历史 usage 只用于记录原上下文用量；摘要沿用供应方报告值。
        expect(sourceTokens).toBeGreaterThan(providerSummaryTokens);
        expect(stats.sourceTokenCount).toBe(sourceTokens);
        expect(stats.summaryTokenCount).toBe(providerSummaryTokens);
        expect(stats.estimatedTokensSaved).toBe(sourceTokens - providerSummaryTokens);
        expect(stats.contextTokenCountBefore).toBe(10_000);
        expect(stats.estimatedContextTokenCountAfter).toBe(10_000 - sourceTokens + providerSummaryTokens);
    });
});
