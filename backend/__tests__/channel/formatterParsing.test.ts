/**
 * Channel formatter 核心解析测试
 *
 * 覆盖 OpenAI / Gemini / Anthropic 三个 formatter 的：
 * 1. parseResponse：文本、思考内容、原生工具调用、usage 换算
 * 2. convertTools：各 API 的工具声明格式转换
 * 3. 无效响应的报错行为
 */

import { OpenAIFormatter } from '../../modules/channel/formatters/openai';
import { GeminiFormatter } from '../../modules/channel/formatters/gemini';
import { AnthropicFormatter } from '../../modules/channel/formatters/anthropic';

const sampleTools = [
    {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path' }
            },
            required: ['path']
        }
    }
] as any;

describe('OpenAIFormatter.parseResponse', () => {
    const formatter = new OpenAIFormatter();

    it('parses a plain text response with usage conversion', () => {
        const result = formatter.parseResponse({
            model: 'gpt-4o',
            choices: [
                {
                    message: { role: 'assistant', content: 'Hello world' },
                    finish_reason: 'stop'
                }
            ],
            usage: {
                prompt_tokens: 100,
                completion_tokens: 30,
                total_tokens: 130,
                completion_tokens_details: { reasoning_tokens: 10 },
                prompt_tokens_details: { cached_tokens: 40 }
            }
        });

        expect(result.content.role).toBe('model');
        expect(result.content.parts).toEqual([{ text: 'Hello world' }]);
        expect(result.content.modelVersion).toBe('gpt-4o');
        expect(result.finishReason).toBe('stop');
        expect(result.model).toBe('gpt-4o');
        expect(result.content.usageMetadata).toEqual({
            promptTokenCount: 100,
            candidatesTokenCount: 20, // completion - reasoning
            totalTokenCount: 130,
            thoughtsTokenCount: 10,
            cachedContentTokenCount: 40
        });
    });

    it('parses reasoning_content as a thought part', () => {
        const result = formatter.parseResponse({
            model: 'deepseek-reasoner',
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: 'Answer',
                        reasoning_content: 'thinking...'
                    },
                    finish_reason: 'stop'
                }
            ]
        });

        expect(result.content.parts[0]).toEqual({ text: 'thinking...', thought: true });
        expect(result.content.parts[1]).toEqual({ text: 'Answer' });
    });

    it('parses native tool_calls into functionCall parts', () => {
        const result = formatter.parseResponse({
            model: 'gpt-4o',
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: {
                                    name: 'read_file',
                                    arguments: '{"path":"a.ts"}'
                                }
                            }
                        ]
                    },
                    finish_reason: 'tool_calls'
                }
            ]
        });

        const fcPart = result.content.parts.find(p => (p as any).functionCall) as any;
        expect(fcPart).toBeDefined();
        expect(fcPart.functionCall.name).toBe('read_file');
        expect(fcPart.functionCall.args).toEqual({ path: 'a.ts' });
        expect(fcPart.functionCall.id).toBe('call_1');
    });

    it('throws on an invalid response', () => {
        expect(() => formatter.parseResponse({})).toThrow();
        expect(() => formatter.parseResponse({ choices: [] })).toThrow();
    });

    it('converts tool declarations to OpenAI function format', () => {
        const converted = formatter.convertTools(sampleTools) as any[];
        expect(converted).toHaveLength(1);
        expect(converted[0].type).toBe('function');
        expect(converted[0].function.name).toBe('read_file');
        expect(converted[0].function.description).toBe('Read a file');
        expect(converted[0].function.parameters.properties.path.type).toBe('string');
    });
});

describe('GeminiFormatter.parseResponse', () => {
    const formatter = new GeminiFormatter();

    it('parses a standard candidate response and keeps usage metadata', () => {
        const result = formatter.parseResponse({
            modelVersion: 'gemini-2.0-flash',
            candidates: [
                {
                    content: {
                        role: 'model',
                        parts: [{ text: 'Hi there' }]
                    },
                    finishReason: 'STOP'
                }
            ],
            usageMetadata: {
                promptTokenCount: 50,
                candidatesTokenCount: 20,
                totalTokenCount: 70,
                thoughtsTokenCount: 5
            }
        });

        expect(result.content.parts).toEqual([{ text: 'Hi there' }]);
        expect(result.finishReason).toBe('STOP');
        expect(result.model).toBe('gemini-2.0-flash');
        expect(result.content.modelVersion).toBe('gemini-2.0-flash');
        expect(result.content.usageMetadata?.promptTokenCount).toBe(50);
        expect(result.content.usageMetadata?.thoughtsTokenCount).toBe(5);
    });

    it('normalizes thoughtSignature into multi-provider thoughtSignatures', () => {
        const result = formatter.parseResponse({
            candidates: [
                {
                    content: {
                        role: 'model',
                        parts: [{ text: 'x', thoughtSignature: 'sig-abc' }]
                    },
                    finishReason: 'STOP'
                }
            ]
        });

        const part = result.content.parts[0] as any;
        expect(part.thoughtSignature).toBeUndefined();
        expect(part.thoughtSignatures).toEqual({ gemini: 'sig-abc' });
    });

    it('throws on an invalid response', () => {
        expect(() => formatter.parseResponse({})).toThrow();
        expect(() => formatter.parseResponse({ candidates: [] })).toThrow();
    });

    it('converts tool declarations to Gemini function_declarations format', () => {
        const converted = formatter.convertTools(sampleTools) as any;
        expect(converted).toHaveLength(1);
        expect(converted[0].function_declarations).toHaveLength(1);
        expect(converted[0].function_declarations[0].name).toBe('read_file');
    });
});

describe('AnthropicFormatter.parseResponse', () => {
    const formatter = new AnthropicFormatter();

    it('parses text + thinking + tool_use blocks and converts usage', () => {
        const result = formatter.parseResponse({
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'tool_use',
            content: [
                { type: 'thinking', thinking: 'let me think', signature: 'sig-1' },
                { type: 'text', text: 'Calling a tool' },
                { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'b.ts' } }
            ],
            usage: {
                input_tokens: 10,
                output_tokens: 20,
                cache_creation_input_tokens: 30,
                cache_read_input_tokens: 60
            }
        });

        expect(result.content.role).toBe('model');
        expect(result.finishReason).toBe('tool_use');
        expect(result.model).toBe('claude-sonnet-4-20250514');

        const parts = result.content.parts as any[];
        expect(parts).toContainEqual({ text: 'let me think', thought: true });
        expect(parts).toContainEqual({ thoughtSignatures: { anthropic: 'sig-1' } });
        expect(parts).toContainEqual({ text: 'Calling a tool' });
        expect(parts).toContainEqual({
            functionCall: { name: 'read_file', args: { path: 'b.ts' }, id: 'toolu_1' }
        });

        // prompt = input + cache_creation + cache_read; total = prompt + output
        expect(result.content.usageMetadata).toEqual({
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            totalTokenCount: 120,
            cachedContentTokenCount: 90
        });
    });

    it('keeps redacted_thinking data for later turns', () => {
        const redactedBlob = 'encrypted-blob';
        const redactedBlock: any = { type: 'redacted_thinking' };
        redactedBlock['data'] = redactedBlob;
        const result = formatter.parseResponse({
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
            content: [
                redactedBlock,
                { type: 'text', text: 'ok' }
            ]
        });

        expect(result.content.parts).toContainEqual({ redactedThinking: redactedBlob });
    });

    it('throws on an invalid response', () => {
        expect(() => formatter.parseResponse(null)).toThrow();
        expect(() => formatter.parseResponse({})).toThrow();
    });

    it('converts tool declarations to Anthropic input_schema format', () => {
        const converted = formatter.convertTools(sampleTools) as any[];
        expect(converted).toHaveLength(1);
        expect(converted[0].name).toBe('read_file');
        expect(converted[0].input_schema.properties.path.type).toBe('string');
    });
});
