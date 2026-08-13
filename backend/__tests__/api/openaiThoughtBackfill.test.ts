import { MessageBuilderService } from '../../modules/api/chat/services/MessageBuilderService';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import type { BaseChannelConfig } from '../../modules/config/configs/base';
import type { Content } from '../../modules/conversation/types';

/**
 * 保持本地的 createConfig（createConfig 收敛批次）：
 * 唯一的位置参数形态（type / sendHistoryThoughts / sendCurrentThoughts 三个必填参数），
 * 返回 BaseChannelConfig（createdAt/updatedAt/timeout 60000，无 toolMode），与共享的
 * channelFixtures（createOpenAIConfig / createAnthropicConfig / createOpenAIResponsesConfig）
 * 形状差异过大，不收敛（见 ../__fixtures__/channelFixtures.ts 头注释）。
 */
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

    test('uses the history setting for both current and historical OAI thought content', () => {
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

    test('keeps current and historical thought settings independent for other channel types', () => {
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

    test('openai-responses 渠道：历史/当前思考开关保持独立（不回退 openai 的合并语义）', () => {
        // openai-responses 的 reasoning item 回传统一遍历，不区分当前/历史轮次：
        // sendCurrentThoughts 不随 sendHistoryThoughts 合并（与 openai 渠道不同），
        // 但 sendCurrentThoughtSignatures 合并到 sendHistoryThoughtSignatures。
        const historyDisabled = messageBuilder.buildHistoryOptions(
            createConfig('openai-responses', false, true)
        );
        expect(historyDisabled).toMatchObject({
            sendHistoryThoughts: false,
            sendCurrentThoughts: true
        });
        expect(thoughtTexts(
            conversationManager.getHistoryForAPIFrom(createTwoRoundHistory(), historyDisabled)
        )).toEqual(['Second reasoning']);

        const historyEnabled = messageBuilder.buildHistoryOptions(
            createConfig('openai-responses', true, false)
        );
        expect(historyEnabled).toMatchObject({
            sendHistoryThoughts: true,
            sendCurrentThoughts: false
        });
        expect(thoughtTexts(
            conversationManager.getHistoryForAPIFrom(createTwoRoundHistory(), historyEnabled)
        )).toEqual(['First reasoning']);

        // 签名开关：Responses 渠道 current 与 history 共用 sendHistoryThoughtSignatures
        expect(historyDisabled.sendCurrentThoughtSignatures).toBe(historyDisabled.sendHistoryThoughtSignatures);
        expect(historyEnabled.sendCurrentThoughtSignatures).toBe(historyEnabled.sendHistoryThoughtSignatures);
    });

    test('openai-responses 关闭 sendHistoryThoughts 时保留 Responses reasoning 元数据（普通裸 thought 仍过滤）', () => {
        const options = messageBuilder.buildHistoryOptions(
            createConfig('openai-responses', false, false)
        );

        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                parts: [{ text: 'First question' }]
            },
            {
                role: 'model',
                parts: [
                    {
                        text: 'First reasoning',
                        thought: true,
                        openaiResponsesReasoning: {
                            id: 'rs_1',
                            status: 'completed',
                            content: [{ type: 'reasoning_text', text: 'First reasoning' }]
                        }
                    },
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

        const forApi = conversationManager.getHistoryForAPIFrom(history, options);
        const modelParts = forApi.flatMap(message => message.parts);

        // 带 Responses reasoning 元数据的 part 保留，普通裸 thought 仍被过滤
        expect(modelParts.some(part =>
            part.text === 'First reasoning' && part.openaiResponsesReasoning?.content?.[0]?.type === 'reasoning_text'
        )).toBe(true);
        expect(thoughtTexts(forApi)).toEqual(['First reasoning']);
    });
});
