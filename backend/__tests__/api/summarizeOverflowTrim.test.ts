import { SummaryAlgorithms } from '../../modules/api/chat/services/SummaryAlgorithms';
import type { Content } from '../../modules/conversation/types';

const summary = (text: string, summarizedMessageCount?: number): Content => ({
    role: 'user',
    parts: [{ text }],
    isSummary: true,
    summarizedMessageCount,
});

describe('SummaryAlgorithms.resolvePreviousSummarizedCount', () => {
    test('从旧总结开始的范围：previousSummarizedCount 从最后一个总结消息读取', () => {
        const history: Content[] = [summary('sum1', 4), { role: 'model', parts: [{ text: 'new work' }] }];
        expect(new SummaryAlgorithms().resolvePreviousSummarizedCount(history, 0)).toBe(4);
    });

    test('最后一个总结缺 summarizedMessageCount：往前找更早总结的累计值，不回退数组下标', () => {
        const history: Content[] = [summary('sum1', 3), { role: 'model', parts: [{ text: 'm1' }] }, summary('sum2')];
        expect(new SummaryAlgorithms().resolvePreviousSummarizedCount(history, 2)).toBe(3);
    });
});
