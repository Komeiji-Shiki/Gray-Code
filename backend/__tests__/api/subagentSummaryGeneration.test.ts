import { SummaryAlgorithms } from '../../modules/api/chat/services/SummaryAlgorithms';
import type { Content } from '../../modules/conversation/types';

function user(text: string, tokens: number): Content {
    return { role: 'user', parts: [{ text }], isUserInput: true, tokenCountByChannel: { openai: tokens } };
}

function model(text: string, tokens: number): Content {
    return { role: 'model', parts: [{ text }], usageMetadata: { promptTokenCount: 0, totalTokenCount: tokens, candidatesTokenCount: tokens } };
}

describe('SummaryAlgorithms.fitSummaryHistoryPrefixToBudget', () => {
    test('总结模型装不下全部候选时只消费最大安全前缀，不从开头丢失旧内容', () => {
        const history = [
            user('initial-task-anchor', 100),
            model('old-completed-work', 100),
            user('second-requirement', 100),
            model('oversized-new-tail', 8_000),
        ];
        const result = new SummaryAlgorithms().fitSummaryHistoryPrefixToBudget(history, 5_000, 'openai');

        expect(result?.consumedMessageCount).toBe(3);
        expect(result?.messages.map((message) => message.parts[0]?.text)).toEqual([
            'initial-task-anchor',
            'old-completed-work',
            'second-requirement',
        ]);
        expect(JSON.stringify(result?.messages)).not.toContain('oversized-new-tail');
    });
});
