import { OpenAIFormatter } from '../../modules/channel/formatters/openai';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { AnthropicFormatter } from '../../modules/channel/formatters/anthropic';
import { ChannelManager } from '../../modules/channel/ChannelManager';
import { StreamAccumulator } from '../../modules/channel/StreamAccumulator';
import { createOpenAIConfig, createOpenAIResponsesConfig, createAnthropicConfig } from '../__fixtures__/channelFixtures';

const request = { configId: 'test', history: [{ role: 'user' as const, parts: [{ text: 'hello' }] }] };

describe('provider protocol boundaries', () => {
    test('Chat Completions sends reasoning_effort including none and omits Responses-only summary', () => {
        const result = new OpenAIFormatter().buildRequest(request, createOpenAIConfig({
            optionsEnabled: { reasoning: true },
            options: { reasoning: { effort: 'none', summaryEnabled: true, summary: 'auto' } }
        }));
        expect(result.body.reasoning_effort).toBe('none');
        expect(result.body).not.toHaveProperty('reasoning');
    });

    test('Responses preserves an explicit none reasoning setting', () => {
        const result = new OpenAIResponsesFormatter().buildRequest(request, createOpenAIResponsesConfig({
            optionsEnabled: { reasoning: true }, options: { reasoning: { effort: 'none' } }
        }));
        expect(result.body.reasoning).toEqual({ effort: 'none' });
    });

    test.each([false, true])('custom stream=%s selects the same transport and payload across protocols', async stream => {
        const override = { options: { stream: !stream }, customBodyEnabled: true, customBody: { mode: 'advanced' as const, json: JSON.stringify({ stream }) } };
        for (const [formatter, config] of [
            [new OpenAIFormatter(), createOpenAIConfig(override)],
            [new OpenAIResponsesFormatter(), createOpenAIResponsesConfig(override)],
            [new AnthropicFormatter(), createAnthropicConfig(override)]
        ] as const) {
            const result = formatter.buildRequest(request, config as never);
            expect(result.body.stream).toBe(stream);
            expect(result.stream).toBe(stream);
            const manager = Object.create(ChannelManager.prototype) as any;
            manager.configManager = { getConfig: jest.fn().mockResolvedValue(config) };
            manager.generateStream = jest.fn().mockReturnValue('stream');
            manager.generateNonStream = jest.fn().mockResolvedValue('json');
            await expect(manager.generate(request)).resolves.toBe(stream ? 'stream' : 'json');
        }
    });

    test.each(['https://example.org/v1', 'https://example.org/v1/', 'https://example.org/v1/chat/completions', 'https://example.org/v1/chat/completions/'])('normalizes complete Chat Completions URL %s', url => {
        expect(new OpenAIFormatter().buildRequest(request, createOpenAIConfig({ url })).url).toBe('https://example.org/v1/chat/completions');
    });

    test('refusal responses stay visible in JSON and streaming modes', () => {
        const chat = new OpenAIFormatter();
        const responses = new OpenAIResponsesFormatter();
        expect(chat.parseResponse({ choices: [{ message: { refusal: 'Unable to comply.' }, finish_reason: 'stop' }] }).content.parts).toEqual([{ text: 'Unable to comply.' }]);
        expect(chat.parseStreamChunk({ choices: [{ delta: { refusal: 'Unable to comply.' } }] }).delta).toEqual([{ text: 'Unable to comply.' }]);
        expect(responses.parseResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Unable to comply.' }] }] }).content.parts).toEqual([{ text: 'Unable to comply.' }]);
        expect(responses.parseStreamChunk({ type: 'response.refusal.delta', delta: 'Unable to comply.' }).delta).toEqual([{ text: 'Unable to comply.' }]);
    });

    test('incomplete Responses preserve usage, cache tokens and finish reason', () => {
        const chunk = new OpenAIResponsesFormatter().parseStreamChunk({ type: 'response.incomplete', response: {
            incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 40 } }
        } });
        expect(chunk).toMatchObject({ done: true, finishReason: 'max_output_tokens', usage: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110, cacheReadTokenCount: 40 } });
    });

    test.each(['{"path":', 'null', '[]', '123', '"text"', ''])('rejects invalid complete tool arguments %p', args => {
        expect(() => new OpenAIResponsesFormatter().parseResponse({ output: [{ type: 'function_call', name: 'file_tool', call_id: 'call_1', arguments: args }] })).toThrow();
        expect(() => new OpenAIFormatter().parseResponse({ choices: [{ message: { tool_calls: [{ type: 'function', id: 'call_1', function: { name: 'file_tool', arguments: args } }] } }] })).toThrow();
    });

    test('malformed streaming arguments can be displayed while pending but never become a final empty invocation', () => {
        const accumulator = new StreamAccumulator();
        accumulator.add({ delta: [{ functionCall: { name: 'file_tool', id: 'call_1', args: {}, partialArgs: '{"path":', index: 0 } }], done: false });
        expect(() => accumulator.getStreamingContent()).not.toThrow();
        expect(() => accumulator.getFinalContent()).toThrow('Invalid JSON');
    });
});
