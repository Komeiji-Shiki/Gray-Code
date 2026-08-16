import {
    resolveMaxContextTokensForConfig,
    resolveMaxOutputTokensForConfig
} from '../../modules/api/chat/services/contextTrim/contextWindowResolution';
import type { BaseChannelConfig } from '../../modules/config/configs/base';

function config(overrides: Record<string, unknown> = {}): BaseChannelConfig {
    return {
        id: 'context-test',
        name: 'Context test',
        type: 'openai',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        timeout: 120000,
        model: 'gpt-test',
        maxContextTokens: 500000,
        ...overrides
    } as BaseChannelConfig;
}

describe('context window input/output budget resolution', () => {
    test('OpenRouter/OpenAI 500k组合窗口会扣除模型128k最大输出', () => {
        const result = resolveMaxContextTokensForConfig(config({
            models: [{ id: 'gpt-test', contextWindow: 500000, maxOutputTokens: 128000 }]
        }));

        expect(result.maxContextTokens).toBe(500000);
        expect(result.maxOutputTokens).toBe(128000);
        expect(result.maxInputTokens).toBe(372000);
        expect(result.contextWindowIncludesOutput).toBe(true);
        expect(resolveMaxOutputTokensForConfig(config({
            models: [{ id: 'gpt-test', contextWindow: 500000, maxOutputTokens: 128000 }]
        }))).toBe(128000);
    });

    test('显式启用较小 max_tokens 时使用请求实际上限，而不是模型最大值', () => {
        const result = resolveMaxContextTokensForConfig(config({
            models: [{ id: 'gpt-test', contextWindow: 500000, maxOutputTokens: 128000 }],
            options: { max_tokens: 32000 },
            optionsEnabled: { max_tokens: true }
        } as any));

        expect(result.maxOutputTokens).toBe(32000);
        expect(result.maxInputTokens).toBe(468000);
        expect(result.outputTokenSource).toBe('config.options');
    });

    test('Gemini 原生 inputTokenLimit 已是输入上限，不重复扣除 outputTokenLimit', () => {
        const result = resolveMaxContextTokensForConfig(config({
            type: 'gemini',
            models: [{
                id: 'gpt-test',
                contextWindow: 500000,
                maxOutputTokens: 128000,
                contextWindowIncludesOutput: false
            }]
        }));

        expect(result.maxInputTokens).toBe(500000);
        expect(result.maxOutputTokens).toBe(128000);
        expect(result.contextWindowIncludesOutput).toBe(false);
    });

    test('没有模型元数据时保持原有默认窗口，不臆造 provider 输出上限', () => {
        const result = resolveMaxContextTokensForConfig(config({
            models: [],
            maxContextTokens: undefined
        }));

        expect(result.maxContextTokens).toBe(256000);
        expect(result.maxInputTokens).toBe(256000);
        expect(result.maxOutputTokens).toBeUndefined();
    });
});
