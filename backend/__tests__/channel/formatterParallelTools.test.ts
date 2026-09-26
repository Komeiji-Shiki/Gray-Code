/**
 * H2/H3 回归测试：流式工具调用参数完整性
 *
 * - H2：Anthropic 并行工具调用。formatter 必须透传 content_block_* 事件的顶层 index，
 *   否则累加器把多个工具的 input_json_delta 全部拼进最后一个空工具壳，参数全部丢失。
 * - H3：OpenAI Responses。done 事件携带完整 arguments，formatter 必须设置 finalArgs: true，
 *   累加器才会"覆盖"而非"追加"到已累积的半截增量 JSON 上。
 */

import { AnthropicFormatter } from '../../modules/channel';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { StreamAccumulator } from '../../modules/channel';

function makeIdFactory(): () => string {
    let n = 0;
    return () => `test_fc_${++n}`;
}

describe('Anthropic 并行工具调用参数透传', () => {
    test('两个并行工具的参数增量按 index 各自合并，不丢失不串味', () => {
        const formatter = new AnthropicFormatter();
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType('anthropic');

        const feed = (chunk: any) => {
            acc.add(formatter.parseStreamChunk(chunk));
        };

        feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } });
        feed({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'write_file', input: {} } });
        feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"paths":["a.txt"]}' } });
        feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b.txt","content":"hi"}' } });

        const content = acc.getFinalContent();
        const calls = content.parts.filter(p => p.functionCall).map(p => p.functionCall);
        expect(calls).toHaveLength(2);

        const read = calls.find(c => c?.name === 'read_file');
        const write = calls.find(c => c?.name === 'write_file');
        expect(read?.args).toEqual({ paths: ['a.txt'] });
        expect(write?.args).toEqual({ path: 'b.txt', content: 'hi' });
    });

    test('分片到达的增量 JSON 也能正确拼接（index 稳定）', () => {
        const formatter = new AnthropicFormatter();
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType('anthropic');

        const feed = (chunk: any) => {
            acc.add(formatter.parseStreamChunk(chunk));
        };

        feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } });
        feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"paths"' } });
        feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':["a.txt","b.txt"]}' } });

        const content = acc.getFinalContent();
        const fc = content.parts.find(p => p.functionCall)?.functionCall;
        expect(fc?.name).toBe('read_file');
        expect(fc?.args).toEqual({ paths: ['a.txt', 'b.txt'] });
    });
});

describe('OpenAI Responses 参数完整覆盖', () => {
    test('done 事件携带完整 arguments 时覆盖增量而非追加', () => {
        const formatter = new OpenAIResponsesFormatter();
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType('openai-responses');

        const feed = (chunk: any) => {
            acc.add(formatter.parseStreamChunk(chunk));
        };

        feed({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' } });
        feed({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"paths":' });
        feed({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '["a.txt"]}' });
        feed({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', name: 'read_file', arguments: '{"paths":["a.txt"]}' });
        feed({ type: 'response.completed' });

        const content = acc.getFinalContent();
        const fc = content.parts.find(p => p.functionCall)?.functionCall;
        expect(fc?.name).toBe('read_file');
        expect(fc?.args).toEqual({ paths: ['a.txt'] });
        expect(fc?.id).toBe('call_1');
    });

    test('最终 item 补齐 call_id 前不上报，补齐后只执行一次', () => {
        const formatter = new OpenAIResponsesFormatter();
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType('openai-responses');
        const feed = (chunk: any) => acc.add(formatter.parseStreamChunk(chunk));

        feed({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_late', type: 'function_call', name: 'read_file', arguments: '' } });
        feed({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_late', arguments: '{"paths":["a.txt"]}' });
        expect(acc.getNewCompletedFunctionCalls()).toEqual([]);

        const finalItem = { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_late', type: 'function_call', call_id: 'call_late', name: 'read_file', arguments: '{"paths":["a.txt"]}' } };
        feed(finalItem);
        expect(acc.getNewCompletedFunctionCalls()).toEqual([
            { index: 0, id: 'call_late', name: 'read_file', args: { paths: ['a.txt'] } }
        ]);
        feed(finalItem);
        expect(acc.getNewCompletedFunctionCalls()).toEqual([]);
        expect(acc.getFinalContent().parts).toEqual([
            { functionCall: { id: 'call_late', name: 'read_file', args: { paths: ['a.txt'] } } }
        ]);
    });

    test('省略 output_index 的交错增量按 item_id 匹配对应工具', () => {
        const formatter = new OpenAIResponsesFormatter();
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType('openai-responses');
        const feed = (chunk: any) => acc.add(formatter.parseStreamChunk(chunk));

        feed({ type: 'response.output_item.added', item: { id: 'fc_read', type: 'function_call', call_id: 'call_read', name: 'read_file' } });
        feed({ type: 'response.output_item.added', item: { id: 'fc_write', type: 'function_call', call_id: 'call_write', name: 'write_file' } });
        feed({ type: 'response.function_call_arguments.delta', item_id: 'fc_read', delta: '{"path":"a.txt"}' });
        feed({ type: 'response.function_call_arguments.done', item_id: 'fc_write', arguments: '{"path":"b.txt"}' });
        feed({ type: 'response.function_call_arguments.done', item_id: 'fc_read', arguments: '{"path":"a.txt"}' });

        expect(acc.getFinalContent().parts).toEqual([
            { functionCall: { id: 'call_read', name: 'read_file', args: { path: 'a.txt' } } },
            { functionCall: { id: 'call_write', name: 'write_file', args: { path: 'b.txt' } } }
        ]);
    });

    test('仅最终 item 提供完整工具参数时仍保留调用', () => {
        const formatter = new OpenAIResponsesFormatter();
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType('openai-responses');
        acc.add(formatter.parseStreamChunk({
            type: 'response.output_item.done', output_index: 0,
            item: { id: 'fc_final', type: 'function_call', call_id: 'call_final', name: 'read_file', arguments: '{"path":"a.txt"}' }
        }));
        expect(acc.getFinalContent().parts).toEqual([
            { functionCall: { id: 'call_final', name: 'read_file', args: { path: 'a.txt' } } }
        ]);
    });
});
