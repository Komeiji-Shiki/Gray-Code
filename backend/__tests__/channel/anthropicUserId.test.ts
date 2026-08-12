import { createHash } from 'crypto';
import { AnthropicFormatter } from '../../modules/channel';
import type { Content } from '../../modules/conversation/types';
import { createAnthropicConfig } from '../__fixtures__/channelFixtures';


function createHistory(text = 'hello'): Content[] {
    return [
        {
            role: 'user',
            parts: [{ text }]
        }
    ];
}

function expectedAnthropicUserId(domainId: string): string {
    return `graycode-conversation-${createHash('sha256').update(domainId, 'utf8').digest('hex')}`;
}

describe('AnthropicFormatter metadata.user_id', () => {
    test('does not add metadata.user_id by default', () => {
        const formatter = new AnthropicFormatter();
        const config = createAnthropicConfig();

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'conv_1700000000000_abc123'
        }, config);

        expect(request.body.metadata?.user_id).toBeUndefined();
    });

    test('adds a stable metadata.user_id derived from conversationId when the channel option is enabled', () => {
        const formatter = new AnthropicFormatter();
        const config = createAnthropicConfig({ anthropicUserIdEnabled: true });
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

        expect(firstRequest.body.metadata?.user_id).toBe(expectedAnthropicUserId(conversationId));
        expect(secondRequest.body.metadata?.user_id).toBe(firstRequest.body.metadata?.user_id);
        expect(firstRequest.body.metadata?.user_id).toMatch(/^[a-zA-Z0-9\-_]+$/);
    });

    test('uses the conversationId passed by caller as the user_id domain（续跑时 executor 传旧 runId，天然同域）', () => {
        const formatter = new AnthropicFormatter();
        const config = createAnthropicConfig({ anthropicUserIdEnabled: true });

        // 模拟续跑：executor 会把 conversationId 沿用旧 runId
        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory(),
            conversationId: 'old_run_1690000000000_abc'
        }, config);

        expect(request.body.metadata?.user_id).toBe(expectedAnthropicUserId('old_run_1690000000000_abc'));
    });

    test('does not add metadata.user_id when conversationId is absent', () => {
        const formatter = new AnthropicFormatter();
        const config = createAnthropicConfig({ anthropicUserIdEnabled: true });

        const request = formatter.buildRequest({
            configId: config.id,
            history: createHistory()
        }, config);

        expect(request.body.metadata?.user_id).toBeUndefined();
    });
});
