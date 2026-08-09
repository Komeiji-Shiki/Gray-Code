import { MessageBuilderService } from '../../modules/api/chat/services/MessageBuilderService';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import type { BaseChannelConfig } from '../../modules/config/configs/base';
import type { Content } from '../../modules/conversation/types';

function createConfig(
    type: BaseChannelConfig['type'],
    sendHistoryThoughts: boolean,
    sendCurrentThoughts: boolean
): BaseChannelConfig {
    return {
        id: `${type}-thought-policy`,
        name: 'Thought policy test',
        type,
        enabled: true,
        url: 'https://example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        createdAt: 0,
        updatedAt: 0,
        timeout: 60000,
        sendHistoryThoughts,
        sendCurrentThoughts
    } as BaseChannelConfig;
}

function createTwoRoundHistory(): Content[] {
    return [
        {
            role: 'user',
            isUserInput: true,
            parts: [{ text: 'First question' }]
        },
        {
            role: 'model',
            parts: [
                { text: 'First reasoning', thought: true },
                { text: 'First answer' }
            ]
        },
        {
            role: 'user',
            isUserInput: true,
            parts: [{ text: 'Second question' }]
        },
        {
            role: 'model',
            parts: [
                { text: 'Second reasoning', thought: true },
                { text: 'Second answer' }
            ]
        }
    ];
}

function thoughtTexts(history: Content[]): string[] {
    return history.flatMap(message =>
        message.parts
            .filter(part => part.thought === true && typeof part.text === 'string')
            .map(part => part.text as string)
    );
}

describe('OpenAI thought backfill policy', () => {
    const messageBuilder = new MessageBuilderService();
    const conversationManager = new ConversationManager({} as any);

    it('uses the history setting for both current and historical OAI thought content', () => {
        const disabledOptions = messageBuilder.buildHistoryOptions(
            createConfig('openai', false, true)
        );
        expect(disabledOptions).toMatchObject({
            sendHistoryThoughts: false,
            sendCurrentThoughts: false
        });
        expect(thoughtTexts(
            conversationManager.getHistoryForAPIFrom(createTwoRoundHistory(), disabledOptions)
        )).toEqual([]);

        const enabledOptions = messageBuilder.buildHistoryOptions(
            createConfig('openai', true, false)
        );
        expect(enabledOptions).toMatchObject({
            sendHistoryThoughts: true,
            sendCurrentThoughts: true
        });
        expect(thoughtTexts(
            conversationManager.getHistoryForAPIFrom(createTwoRoundHistory(), enabledOptions)
        )).toEqual(['First reasoning', 'Second reasoning']);
    });

    it('keeps current and historical thought settings independent for other channel types', () => {
        const options = messageBuilder.buildHistoryOptions(
            createConfig('anthropic', false, true)
        );
        expect(options).toMatchObject({
            sendHistoryThoughts: false,
            sendCurrentThoughts: true
        });
        expect(thoughtTexts(
            conversationManager.getHistoryForAPIFrom(createTwoRoundHistory(), options)
        )).toEqual(['Second reasoning']);
    });
});
