/**
 * 思考强度 custom 档位回归测试
 *
 * 覆盖三个渠道 formatter 对 effort='custom' 的解析：
 * - effort=custom 时使用 effortCustom 的值原样透传
 * - effort=custom 但 effortCustom 为空 / 空白时，不发送 effort
 * - 预设档位（max / ultra / xhigh 等）不受影响，直接透传
 */
import { AnthropicFormatter } from '../../modules/channel';
import { OpenAIFormatter } from '../../modules/channel';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
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

describe('思考强度 custom 档位（OpenAIFormatter）', () => {
    const formatter = new OpenAIFormatter();


    test('effort=custom 时使用 effortCustom 的值原样透传', () => {
        const request = formatter.buildRequest({
            configId: 'openai-test',
            history: createHistory()
        }, createOpenAIConfig());

        expect(request.body.reasoning_effort).toBe('max');
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

    test('effort=none 显式禁用推理，不回退到供应商默认值', () => {
        const request = formatter.buildRequest({
            configId: 'openai-test',
            history: createHistory()
        }, createOpenAIConfig({
            options: {
                reasoning: { effort: 'none' }
            }
        }));

        expect(request.body.reasoning_effort).toBe('none');
    });

    test('预设档位不受影响：xhigh / max / ultra 直接透传', () => {
        for (const preset of ['xhigh', 'max', 'ultra'] as const) {
            const request = formatter.buildRequest({
                configId: 'openai-test',
                history: createHistory()
            }, createOpenAIConfig({
                options: {
                    reasoning: { effort: preset }
                }
            }));
            expect(request.body.reasoning_effort).toBe(preset);
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
});
