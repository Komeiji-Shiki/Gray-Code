import { StreamAccumulator } from '../../modules/channel';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';

function createSummaryStream() {
    const formatter = new OpenAIResponsesFormatter();
    const accumulator = new StreamAccumulator();
    accumulator.setProviderType('openai-responses');
    const visibleText: string[] = [];
    const feed = (event: Record<string, unknown>) => {
        const delta = accumulator.add(formatter.parseStreamChunk({ output_index: 0, item_id: 'rs_1', ...event }));
        visibleText.push(...delta.filter(part => part.thought).map(part => part.text || ''));
    };
    feed({ type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning', summary: [] } });
    for (const [summary_index, text] of ['第一段', '第二段'].entries()) {
        feed({ type: 'response.reasoning_summary_part.added', summary_index, part: { type: 'summary_text', text: '' } });
        feed({ type: 'response.reasoning_summary_text.delta', summary_index, delta: text.slice(0, 1) });
        feed({ type: 'response.reasoning_summary_text.delta', summary_index, delta: text.slice(1) });
        feed({ type: 'response.reasoning_summary_text.done', summary_index, text });
        feed({ type: 'response.reasoning_summary_part.done', summary_index, part: { type: 'summary_text', text } });
    }
    return { formatter, accumulator, feed, visibleText };
}

describe('Responses 多段摘要的完成事件', () => {
    test('第二段完成后、最终 item 前中断仍保留已经展示的所有摘要', () => {
        const { formatter, accumulator, visibleText } = createSummaryStream();
        expect(visibleText.join('')).toContain('第一段');
        expect(visibleText.join('')).toContain('第二段');
        expect(() => formatter.parseStreamChunk({ type: 'error', message: 'stream interrupted' })).toThrow();
        expect(accumulator.getFinalContent().parts[0]).toMatchObject({
            text: '第一段\n第二段',
            openaiResponsesReasoning: { summary: [
                { type: 'summary_text', text: '第一段' },
                { type: 'summary_text', text: '第二段' }
            ] }
        });
    });

    test('正常 output_item.done 仍使用上游完整摘要作为权威结果', () => {
        const { accumulator, feed } = createSummaryStream();
        feed({ type: 'response.output_item.done', item: {
            id: 'rs_1', type: 'reasoning', status: 'completed', encrypted_content: 'encrypted',
            summary: [{ type: 'summary_text', text: '第一段' }, { type: 'summary_text', text: '第二段' }]
        } });
        expect(accumulator.getFinalContent().parts[0]).toMatchObject({
            text: '第一段\n第二段',
            thoughtSignatures: { 'openai-responses': 'encrypted' },
            openaiResponsesReasoning: { summary: [
                { type: 'summary_text', text: '第一段' },
                { type: 'summary_text', text: '第二段' }
            ] }
        });
    });
});
