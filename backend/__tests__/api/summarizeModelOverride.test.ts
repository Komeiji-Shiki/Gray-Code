import { SummaryAlgorithms, MANUAL_SUMMARY_MAX_INPUT_RATIO } from '../../modules/api/chat/services/SummaryAlgorithms';
import type { BaseChannelConfig } from '../../modules/config/configs/base';

describe('SummaryAlgorithms 总结输入预算', () => {
    test('未配置渠道级窗口时按当前对话 modelOverride 的 contextWindow 做总结预检', () => {
        const algorithms = new SummaryAlgorithms();
        const config = {
            type: 'openai',
            models: [
                { id: 'tiny-model', contextWindow: 200 },
                { id: 'large-model', contextWindow: 100_000 },
            ],
        } as BaseChannelConfig;
        const tiny = algorithms.resolveSummaryInputBudget(config, 'tiny-model', MANUAL_SUMMARY_MAX_INPUT_RATIO, '');
        const large = algorithms.resolveSummaryInputBudget(config, 'large-model', MANUAL_SUMMARY_MAX_INPUT_RATIO, '');

        expect(tiny.modelMaxContextTokens).toBe(200);
        expect(tiny.maxHistoryTokens).toBe(0);
        expect(large.modelMaxContextTokens).toBe(100_000);
        expect(large.maxHistoryTokens).toBeGreaterThan(0);
    });

    test('手动总结预检计入总结提示词开销，超限时没有可用历史预算', () => {
        const algorithms = new SummaryAlgorithms();
        const budget = algorithms.resolveSummaryInputBudget(
            { type: 'openai', maxContextTokens: 1_000 } as BaseChannelConfig,
            undefined,
            MANUAL_SUMMARY_MAX_INPUT_RATIO,
            'very-long-summary-instruction '.repeat(200),
        );

        expect(budget.fixedRequestTokens).toBeGreaterThan(budget.maxInputTokens);
        expect(budget.maxHistoryTokens).toBe(0);
    });
});
