import { createHash } from 'crypto';
import { OpenAIFormatter } from '../../modules/channel';
import type { Content } from '../../modules/conversation/types';
import { createOpenAIConfig } from '../__fixtures__/channelFixtures';


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
    test('does not add user_id by default even when endpoint and model are DeepSeek', () => {
        const formatter = new OpenAIFormatter();
        const config = createOpenAIConfig({ id: 'openai-compatible-test', name: 'OpenAI Compatible Test', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'conv_1700000000000_abc123'
        }, config);

        expect(request.body.user_id).toBeUndefined();
    });

    test('adds a stable DeepSeek user_id derived from conversationId when the channel option is enabled', () => {
        const formatter = new OpenAIFormatter();
        const config = createOpenAIConfig({ id: 'openai-compatible-test', name: 'OpenAI Compatible Test', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', deepSeekUserIdEnabled: true });
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

    test('uses a different DeepSeek user_id for different conversations when enabled', () => {
        const formatter = new OpenAIFormatter();
        const config = createOpenAIConfig({ id: 'openai-compatible-test', name: 'OpenAI Compatible Test', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', deepSeekUserIdEnabled: true });

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

    test('can add user_id for OpenAI-compatible proxies when the user explicitly enables the option', () => {
        const formatter = new OpenAIFormatter();
        const config = createOpenAIConfig({
            id: 'openai-compatible-test',
            name: 'OpenAI Compatible Test',
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

    test('does not add user_id when conversationId is absent, even if the channel option is enabled', () => {
        const formatter = new OpenAIFormatter();
        const config = createOpenAIConfig({ id: 'openai-compatible-test', name: 'OpenAI Compatible Test', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', deepSeekUserIdEnabled: true });

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory()
        }, config);

        expect(request.body.user_id).toBeUndefined();
    });

    test('uses the conversationId passed by caller as the user_id domain (续跑时 executor 传旧 runId，天然同域)', () => {
        const formatter = new OpenAIFormatter();
        const config = createOpenAIConfig({ id: 'openai-compatible-test', name: 'OpenAI Compatible Test', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', deepSeekUserIdEnabled: true });

        // 模拟续跑：executor 会把 conversationId 沿用旧 runId
        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'old_run_1690000000000_abc'
        }, config);

        expect(request.body.user_id).toBe(expectedDeepSeekUserId('old_run_1690000000000_abc'));
    });
});
