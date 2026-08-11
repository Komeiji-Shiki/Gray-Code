import { OpenAIFormatter } from '../../modules/channel';
import type { Content } from '../../modules/conversation/types';
import { serializePromptContextCache } from '../../modules/prompt/promptContextCache';
import { createOpenAIConfig } from '../__fixtures__/channelFixtures';


describe('OpenAIFormatter dynamic context preserve', () => {
    test('keeps preserved turnDynamicContext after thought-signature conversion', () => {
        const formatter = new OpenAIFormatter();
        const oldCache = serializePromptContextCache({
            messages: [{ role: 'user', parts: [{ text: 'old cached full ctx' }] }],
            dynamicSnapshotMessages: [{ role: 'user', parts: [{ text: 'old cached dynamic ctx' }] }],
            text: 'old cached full ctx',
            dynamicSnapshotText: 'old cached dynamic ctx'
        });
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: oldCache,
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'old user' }]
            },
            {
                role: 'model',
                parts: [{ text: 'old answer' }]
            },
            {
                role: 'user',
                isUserInput: true,
                parts: [{ text: 'current user' }]
            }
        ];

        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history,
            promptContext: {
                beforeHistoryMessages: [{ role: 'user', parts: [{ text: 'current ctx' }] }],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'preserve'
        }, createOpenAIConfig({ url: 'https://example.test/v1', model: 'test-model' }));

        expect(request.body.messages.map((message: any) => ({
            role: message.role,
            content: message.content
        }))).toEqual([
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'old cached dynamic ctx' },
            { role: 'user', content: 'old user' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'current ctx' },
            { role: 'user', content: 'current user' }
        ]);
    });
});
