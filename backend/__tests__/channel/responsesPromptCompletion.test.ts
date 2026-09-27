import { StreamAccumulator } from '../../modules/channel/StreamAccumulator';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { TOOL_CALL_END, TOOL_CALL_START } from '../../tools/jsonFormatter';

describe.each(['xml', 'json'] as const)('Responses %s 工具的结束事件补全', mode => {
    test.each(['terminal-only', 'item-done', 'partial-delta'] as const)('%s 只解析未接收的后缀', source => {
        const formatter = new OpenAIResponsesFormatter();
        const accumulator = new StreamAccumulator(mode);
        accumulator.setProviderType('openai-responses');
        const markup = mode === 'xml'
            ? '<tool_use><tool_name>read_file</tool_name><parameters><path>a.txt</path></parameters></tool_use>'
            : `${TOOL_CALL_START}\n{"tool":"read_file","parameters":{"path":"a.txt"}}\n${TOOL_CALL_END}`;
        const text = `Before ${markup} After`;
        const item = { type: 'message', role: 'assistant', id: 'msg_test', status: 'completed', phase: 'commentary',
            content: [{ type: 'output_text', text }] };
        const emitted: Record<string, any>[] = [];
        const add = (event: any) => {
            const chunk = formatter.parseStreamChunk(event);
            emitted.push(...accumulator.add(chunk));
            return chunk;
        };
        if (source !== 'terminal-only') {
            add({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
            if (source === 'partial-delta') add({ type: 'response.output_text.delta', output_index: 0, item_id: item.id,
                content_index: 0, delta: text.slice(0, text.indexOf('a.txt')) });
            add({ type: 'response.output_item.done', output_index: 0, item });
        }
        const terminal = add({ type: 'response.completed', response: { status: 'completed', output: [item] } });
        const content = accumulator.getFinalContent();
        expect(content.parts.filter(part => part.functionCall)).toHaveLength(1);
        expect(content.parts.find(part => part.functionCall)?.functionCall).toMatchObject({ name: 'read_file', args: { path: 'a.txt' } });
        expect(content.parts.map(part => part.text ?? '').join('')).toBe('Before  After');
        expect(emitted.filter(part => part.functionCall)).toHaveLength(1);
        expect(terminal.contentSnapshot?.parts.find(part => part.functionCall)?.functionCall?.id)
            .toBe(content.parts.find(part => part.functionCall)?.functionCall?.id);
        expect(emitted.map(part => part.text ?? '').join('')).toBe('Before  After');

        accumulator.reset();
        accumulator.setProviderType('openai-responses');
        add({ type: 'response.completed', response: { output: [{ ...item, content: [{ type: 'output_text', text: 'Fresh response' }] }] } });
        expect(accumulator.getFinalContent().parts.map(part => part.text ?? '').join('')).toBe('Fresh response');
    });
});
