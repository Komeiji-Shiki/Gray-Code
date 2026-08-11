/**
 * 思考强度 custom 档位回归测试
 *
 * 覆盖三个渠道 formatter 对 effort='custom' 的解析：
 * - effort=custom 时使用 effortCustom 的值原样透传
 * - effort=custom 但 effortCustom 为空 / 空白时，不发送 effort
 * - 预设档位（max / ultra / xhigh 等）不受影响，直接透传
 */
import { AnthropicFormatter, GeminiFormatter, OpenAIFormatter } from '../../modules/channel';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters';
import type { AnthropicConfig, GeminiConfig, OpenAIConfig } from '../../modules/config';
import type { OpenAIResponsesConfig } from '../../modules/config/configs/openai-responses';
import type { Content } from '../../modules/conversation/types';
import { createAnthropicConfig } from '../__fixtures__/channelFixtures';
import { createOpenAIConfig } from '../__fixtures__/channelFixtures';
import { createOpenAIResponsesConfig } from '../__fixtures__/channelFixtures';

function createHistory(text = 'hello'): Content[] {
    return [
        {
            role: 'user',
            parts: [{ text }]
        }
    ];
}

describe('思考强度 custom 档位（AnthropicFormatter）', () => {
    const formatter = new AnthropicFormatter();


    test('effort=custom 时使用 effortCustom 的值原样透传', () => {
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            history: createHistory()
        }, createAnthropicConfig({ model: 'claude-opus-4-6', optionsEnabled: { thinking: true }, options: { thinking: { type: 'adaptive', effort: 'custom', effortCustom: 'ultra' } } }));

        expect(request.body.output_config).toEqual({ effort: 'ultra' });
    });

    test('effort=custom 但 effortCustom 为空白时不发送 output_config', () => {
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            history: createHistory()
        }, createAnthropicConfig({
            model: 'claude-opus-4-6',
            optionsEnabled: { thinking: true },
            options: {
                thinking: { type: 'adaptive', effort: 'custom', effortCustom: '   ' }
            }
        }));

        expect(request.body.output_config).toBeUndefined();
    });

    test('effort=custom 但未配置 effortCustom 时不发送 output_config', () => {
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            history: createHistory()
        }, createAnthropicConfig({
            model: 'claude-opus-4-6',
            optionsEnabled: { thinking: true },
            options: {
                thinking: { type: 'adaptive', effort: 'custom' }
            }
        }));

        expect(request.body.output_config).toBeUndefined();
    });

    test('预设档位不受影响：max / ultra 直接透传', () => {
        const maxRequest = formatter.buildRequest({
            configId: 'anthropic-test',
            history: createHistory()
        }, createAnthropicConfig({
            model: 'claude-opus-4-6',
            optionsEnabled: { thinking: true },
            options: {
                thinking: { type: 'adaptive', effort: 'max' }
            }
        }));
        expect(maxRequest.body.output_config).toEqual({ effort: 'max' });

        const ultraRequest = formatter.buildRequest({
            configId: 'anthropic-test',
            history: createHistory()
        }, createAnthropicConfig({
            model: 'claude-opus-4-6',
            optionsEnabled: { thinking: true },
            options: {
                thinking: { type: 'adaptive', effort: 'ultra' }
            }
        }));
        expect(ultraRequest.body.output_config).toEqual({ effort: 'ultra' });
    });
});

describe('思考显式关闭（AnthropicFormatter）', () => {
    const formatter = new AnthropicFormatter();

    function createConfig(overrides: Partial<AnthropicConfig> = {}): AnthropicConfig {
        return {
            id: 'anthropic-test',
            name: 'Anthropic Test',
            type: 'anthropic',
            enabled: true,
            url: 'https://api.anthropic.com/v1',
            apiKey: 'test-key',
            model: 'claude-opus-4-6',
            preferStream: false,
            timeout: 30000,
            toolMode: 'function_call',
            optionsEnabled: { thinking: true },
            options: {
                thinking: { type: 'disabled', effort: 'high' }
            },
            ...overrides
        } as AnthropicConfig;
    }

    it('type=disabled 时请求显式携带 {"thinking": {"type": "disabled"}}，不发送 effort', () => {
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            history: createHistory()
        }, createConfig());

        expect(request.body.thinking).toEqual({ type: 'disabled' });
        expect(request.body.output_config).toBeUndefined();
    });

    it('type=disabled 时闸门关闭同样显式携带（不依赖闸门分支差异）', () => {
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            history: createHistory()
        }, createConfig({
            optionsEnabled: { thinking: false },
            options: { thinking: { type: 'disabled', effort: 'high' } }
        }));

        expect(request.body.thinking).toBeUndefined();
    });
});

describe('思考强度 custom 档位（OpenAIFormatter）', () => {
    const formatter = new OpenAIFormatter();


    test('effort=custom 时使用 effortCustom 的值原样透传', () => {
        const request = formatter.buildRequest({
            configId: 'openai-test',
            history: createHistory()
        }, createOpenAIConfig());

        expect(request.body.reasoning).toEqual({ effort: 'max' });
    });

    test('effort=custom 但 effortCustom 为空白时不发送 reasoning', () => {
        const request = formatter.buildRequest({
            configId: 'openai-test',
            history: createHistory()
        }, createOpenAIConfig({
            options: {
                reasoning: { effort: 'custom', effortCustom: '' }
            }
        }));

        expect(request.body.reasoning).toBeUndefined();
    });

    test('effort=none 时仍不发送 effort（不回归）', () => {
        const request = formatter.buildRequest({
            configId: 'openai-test',
            history: createHistory()
        }, createOpenAIConfig({
            options: {
                reasoning: { effort: 'none' }
            }
        }));

        expect(request.body.reasoning).toBeUndefined();
    });

    it('Off（闸门关闭）请求显式携带 {"thinking":{"type":"disabled"}}，不传递任何 effort', () => {
        const request = formatter.buildRequest({
            configId: 'openai-test',
            history: createHistory()
        }, createOpenAIConfig({
            optionsEnabled: { reasoning: false },
            options: {
                reasoning: { effort: 'none', summaryEnabled: true, summary: 'concise' }
            }
        }));

        expect(request.body.thinking).toEqual({ type: 'disabled' });
        expect(request.body.reasoning).toBeUndefined();
    });

    it('闸门未定义（未配置 reasoning）时不强制传递（保持原行为）', () => {
        const request = formatter.buildRequest({
            configId: 'openai-test',
            history: createHistory()
        }, createOpenAIConfig({
            optionsEnabled: {},
            options: {
                reasoning: { effort: 'high' }
            }
        }));

        expect(request.body.thinking).toBeUndefined();
        expect(request.body.reasoning).toBeUndefined();
    });

    it('预设档位不受影响：xhigh / max / ultra 直接透传', () => {
        for (const preset of ['xhigh', 'max', 'ultra'] as const) {
            const request = formatter.buildRequest({
                configId: 'openai-test',
                history: createHistory()
            }, createOpenAIConfig({
                options: {
                    reasoning: { effort: preset }
                }
            }));
            expect(request.body.reasoning).toEqual({ effort: preset });
        }
    });
});

describe('思考强度 custom 档位（OpenAIResponsesFormatter）', () => {
    const formatter = new OpenAIResponsesFormatter();


    test('effort=custom 时使用 effortCustom 的值原样透传', () => {
        const request = formatter.buildRequest({
            configId: 'openai-responses-test',
            history: createHistory()
        }, createOpenAIResponsesConfig());

        expect(request.body.reasoning).toEqual({ effort: 'ultra' });
    });

    test('effort=custom 但 effortCustom 为空时不发送 reasoning', () => {
        const request = formatter.buildRequest({
            configId: 'openai-responses-test',
            history: createHistory()
        }, createOpenAIResponsesConfig({
            options: {
                reasoning: { effort: 'custom', effortCustom: '   ' }
            }
        }));

        expect(request.body.reasoning).toBeUndefined();
    });

    test('预设档位不受影响：max 直接透传', () => {
        const request = formatter.buildRequest({
            configId: 'openai-responses-test',
            history: createHistory()
        }, createOpenAIResponsesConfig({
            options: {
                reasoning: { effort: 'max' }
            }
        }));

        expect(request.body.reasoning).toEqual({ effort: 'max' });
    });

    it('Off（闸门关闭）请求显式携带 {"thinking":{"type":"disabled"}}，不传递任何 effort', () => {
        const request = formatter.buildRequest({
            configId: 'openai-responses-test',
            history: createHistory()
        }, createOpenAIResponsesConfig({
            optionsEnabled: { reasoning: false },
            options: {
                reasoning: { effort: 'none' }
            }
        }));

        expect(request.body.thinking).toEqual({ type: 'disabled' });
        expect(request.body.reasoning).toBeUndefined();
    });
});

describe('思考显式关闭（GeminiFormatter）', () => {
    const formatter = new GeminiFormatter();

    function createConfig(overrides: Partial<GeminiConfig> = {}): GeminiConfig {
        return {
            id: 'gemini-test',
            name: 'Gemini Test',
            type: 'gemini',
            enabled: true,
            url: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: 'test-key',
            model: 'gemini-2.5-pro',
            preferStream: false,
            timeout: 30000,
            toolMode: 'function_call',
            optionsEnabled: { thinkingConfig: true },
            options: {
                thinkingConfig: { includeThoughts: false }
            },
            ...overrides
        } as GeminiConfig;
    }

    it('includeThoughts=false（Off 档）时请求显式携带 {"thinkingConfig":{"includeThoughts":false}}', () => {
        const request = formatter.buildRequest({
            configId: 'gemini-test',
            history: createHistory()
        }, createConfig());

        expect(request.body.generationConfig.thinkingConfig).toEqual({ includeThoughts: false });
    });

    it('includeThoughts=true + level 模式时发送等级，不受影响', () => {
        const request = formatter.buildRequest({
            configId: 'gemini-test',
            history: createHistory()
        }, createConfig({
            options: {
                thinkingConfig: { includeThoughts: true, mode: 'level', thinkingLevel: 'high' }
            }
        }));

        expect(request.body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'high' });
    });
});
