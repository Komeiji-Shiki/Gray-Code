import { createHash } from 'crypto';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import type { Content } from '../../modules/conversation/types';
import { createOpenAIResponsesConfig } from '../__fixtures__/channelFixtures';


function createHistory(text = 'hello'): Content[] {
    return [
        {
            role: 'user',
            parts: [{ text }]
        }
    ];
}

function expectedPromptCacheKey(conversationId: string): string {
    return `graycode-cache-${createHash('sha256').update(conversationId, 'utf8').digest('hex')}`;
}

describe('OpenAIResponsesFormatter prompt_cache_key', () => {
    test('does not add prompt_cache_key by default even when conversationId is present', () => {
        const formatter = new OpenAIResponsesFormatter();
        const config = createOpenAIResponsesConfig();

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'conv_1700000000000_abc123'
        }, config);

        expect(request.body.prompt_cache_key).toBeUndefined();
    });

    test('adds a stable prompt_cache_key derived from conversationId when the channel option is enabled', () => {
        const formatter = new OpenAIResponsesFormatter();
        const config = createOpenAIResponsesConfig({ promptCacheKeyEnabled: true });
        const conversationId = 'conv_1700000000000_abc123';

        const firstRequest = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId
        }, config);
        const secondRequest = formatter.buildRequest({
            configId: config.id,
            history: createHistory('again'),
            conversationId
        }, config);

        expect(firstRequest.body.prompt_cache_key).toBe(expectedPromptCacheKey(conversationId));
        expect(secondRequest.body.prompt_cache_key).toBe(firstRequest.body.prompt_cache_key);
        expect(firstRequest.body.prompt_cache_key).toMatch(/^[a-zA-Z0-9\-_]+$/);
        expect(firstRequest.body.prompt_cache_key.length).toBeLessThanOrEqual(512);
    });

    test('uses a different prompt_cache_key for different conversations when enabled', () => {
        const formatter = new OpenAIResponsesFormatter();
        const config = createOpenAIResponsesConfig({ promptCacheKeyEnabled: true });

        const firstRequest = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'conv_first'
        }, config);
        const secondRequest = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'conv_second'
        }, config);

        expect(firstRequest.body.prompt_cache_key).not.toBe(secondRequest.body.prompt_cache_key);
    });

    test('does not add prompt_cache_key when conversationId is absent, even if the channel option is enabled', () => {
        const formatter = new OpenAIResponsesFormatter();
        const config = createOpenAIResponsesConfig({ promptCacheKeyEnabled: true });

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory()
        }, config);

        expect(request.body.prompt_cache_key).toBeUndefined();
    });

    test('uses the explicit promptCacheKey value when provided, regardless of the enabled flag', () => {
        const formatter = new OpenAIResponsesFormatter();
        const config = createOpenAIResponsesConfig({
            promptCacheKeyEnabled: false,
            promptCacheKey: 'my-custom-session-key'
        });

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'conv_any'
        }, config);

        expect(request.body.prompt_cache_key).toBe('my-custom-session-key');
    });

    test('falls back to conversationId-derived key when explicit key is blank/whitespace', () => {
        const formatter = new OpenAIResponsesFormatter();
        const config = createOpenAIResponsesConfig({
            promptCacheKeyEnabled: true,
            promptCacheKey: '   '
        });
        const conversationId = 'conv_blank_explicit';

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId
        }, config);

        expect(request.body.prompt_cache_key).toBe(expectedPromptCacheKey(conversationId));
    });

    test('adds prompt_cache_key without breaking other top-level body fields', () => {
        const formatter = new OpenAIResponsesFormatter();
        const config = createOpenAIResponsesConfig({ promptCacheKeyEnabled: true });

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory('hi'),
            conversationId: 'conv_body'
        }, config);

        expect(request.body.prompt_cache_key).toBe(expectedPromptCacheKey('conv_body'));
        expect(request.body.model).toBe(config.model);
        expect(Array.isArray(request.body.input)).toBe(true);
        expect(request.body.input.length).toBeGreaterThan(0);
    });
});
