import { createHash } from 'crypto';
import { OpenAIFormatter } from '../../modules/channel/formatters/openai';
import type { OpenAIConfig } from '../../modules/config/types';
import type { Content } from '../../modules/conversation/types';

function createConfig(overrides: Partial<OpenAIConfig> = {}): OpenAIConfig {
    return {
        id: 'openai-compatible-test',
        name: 'OpenAI Compatible Test',
        type: 'openai',
        enabled: true,
        url: 'https://api.deepseek.com/v1',
        apiKey: 'test-key',
        model: 'deepseek-chat',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call',
        deepSeekUserIdEnabled: false,
        ...overrides
    } as OpenAIConfig;
}

function createHistory(text = 'hello'): Content[] {
    return [
        {
            role: 'user',
            parts: [{ text }]
        }
    ];
}

function expectedDeepSeekUserId(conversationId: string): string {
    return `limcode-conversation-${createHash('sha256').update(conversationId, 'utf8').digest('hex')}`;
}

describe('OpenAIFormatter DeepSeek user_id', () => {
    it('does not add user_id by default even when endpoint and model are DeepSeek', () => {
        const formatter = new OpenAIFormatter();
        const config = createConfig();

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'conv_1700000000000_abc123'
        }, config);

        expect(request.body.user_id).toBeUndefined();
    });

    it('adds a stable DeepSeek user_id derived from conversationId when the channel option is enabled', () => {
        const formatter = new OpenAIFormatter();
        const config = createConfig({ deepSeekUserIdEnabled: true });
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

        expect(firstRequest.body.user_id).toBe(expectedDeepSeekUserId(conversationId));
        expect(secondRequest.body.user_id).toBe(firstRequest.body.user_id);
        expect(firstRequest.body.user_id).toMatch(/^[a-zA-Z0-9\-_]+$/);
        expect(firstRequest.body.user_id.length).toBeLessThanOrEqual(512);
    });

    it('uses a different DeepSeek user_id for different conversations when enabled', () => {
        const formatter = new OpenAIFormatter();
        const config = createConfig({ deepSeekUserIdEnabled: true });

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

        expect(firstRequest.body.user_id).not.toBe(secondRequest.body.user_id);
    });

    it('can add user_id for OpenAI-compatible proxies when the user explicitly enables the option', () => {
        const formatter = new OpenAIFormatter();
        const config = createConfig({
            url: 'https://proxy.example.com/v1',
            model: 'custom-model-name',
            deepSeekUserIdEnabled: true
        });
        const conversationId = 'conv_proxy';

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId
        }, config);

        expect(request.body.user_id).toBe(expectedDeepSeekUserId(conversationId));
    });

    it('does not add user_id when conversationId is absent, even if the channel option is enabled', () => {
        const formatter = new OpenAIFormatter();
        const config = createConfig({ deepSeekUserIdEnabled: true });

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory()
        }, config);

        expect(request.body.user_id).toBeUndefined();
    });
});
