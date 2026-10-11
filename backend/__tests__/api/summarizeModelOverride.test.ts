import { SummaryAlgorithms, MANUAL_SUMMARY_MAX_INPUT_RATIO } from '../../modules/api/chat/services/SummaryAlgorithms';
import type { BaseChannelConfig } from '../../modules/config/configs/base';

/** 模型列表属于各渠道的具体配置，基础类型不声明；测试只给出预算解析会读取的字段。 */
const channel = (fields: Partial<BaseChannelConfig> & Record<string, unknown>) => fields as BaseChannelConfig;

describe('SummaryAlgorithms 总结输入预算', () => {
    test('未配置渠道级窗口时按当前对话 modelOverride 的 contextWindow 做总结预检', () => {
        const algorithms = new SummaryAlgorithms();
        const config = channel({
            type: 'openai',
            models: [
                { id: 'tiny-model', contextWindow: 200 },
                { id: 'large-model', contextWindow: 100_000 },
            ],
        });
        const tiny = algorithms.resolveSummaryInputBudget(config, 'tiny-model', MANUAL_SUMMARY_MAX_INPUT_RATIO, '');
        const large = algorithms.resolveSummaryInputBudget(config, 'large-model', MANUAL_SUMMARY_MAX_INPUT_RATIO, '');

        expect(tiny.modelMaxContextTokens).toBe(200);
        expect(large.modelMaxContextTokens).toBe(100_000);
        // 空总结提示词只扣除固定请求结构；历史预算随所选模型的窗口而不是渠道默认值变化。
        expect(tiny.maxHistoryTokens).toBeLessThanOrEqual(200 * MANUAL_SUMMARY_MAX_INPUT_RATIO);
        expect(large.maxHistoryTokens).toBeGreaterThan(tiny.maxHistoryTokens * 100);
    });

    test('手动总结预检计入总结提示词开销，超限时没有可用历史预算', () => {
        const algorithms = new SummaryAlgorithms();
        const budget = algorithms.resolveSummaryInputBudget(
            channel({ type: 'openai', maxContextTokens: 1_000 }),
            undefined,
            MANUAL_SUMMARY_MAX_INPUT_RATIO,
            'very-long-summary-instruction '.repeat(200),
        );

        expect(budget.fixedRequestTokens).toBeGreaterThan(budget.maxInputTokens);
        expect(budget.maxHistoryTokens).toBe(0);
    });
});
