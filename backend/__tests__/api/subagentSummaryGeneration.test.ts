import { get_encoding } from 'tiktoken';
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
            model('oversized-new-tail '.repeat(400), 8_000),
        ];
        const tokenizer = get_encoding('o200k_base');
        const messageTokens = history.map(message => tokenizer.encode(message.parts[0].text!, [], []).length);
        tokenizer.free();
        const prefixBudget = messageTokens.slice(0, 3).reduce((total, tokens) => total + tokens, 0);
        const fullBudget = prefixBudget + messageTokens[3];
        const service = new SummaryAlgorithms();

        // 使用正文分词边界，不能靠旧 usage 的 8000 把短文本伪装成超大尾段。
        expect(messageTokens[3]).toBeGreaterThan(prefixBudget);
        const result = service.fitSummaryHistoryPrefixToBudget(history, prefixBudget, 'openai');

        expect(result?.consumedMessageCount).toBe(3);
        expect(result?.estimatedTokens).toBe(prefixBudget);
        expect(result?.messages).toEqual(history.slice(0, 3));
        expect(result?.messages.map((message) => message.parts[0]?.text)).toEqual([
            'initial-task-anchor',
            'old-completed-work',
            'second-requirement',
        ]);
        expect(JSON.stringify(result?.messages)).not.toContain('oversized-new-tail');

        // 完整正文恰好落在预算边界时，四条都应保留，避免把等于预算误判为溢出。
        const fullResult = service.fitSummaryHistoryPrefixToBudget(history, fullBudget, 'openai');
        expect(fullResult?.consumedMessageCount).toBe(4);
        expect(fullResult?.estimatedTokens).toBe(fullBudget);
        expect(fullResult?.messages).toEqual(history);
    });
});
