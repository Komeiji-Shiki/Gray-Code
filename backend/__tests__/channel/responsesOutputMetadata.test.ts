import { GeminiFormatter } from '../../modules/channel/formatters/gemini';
import { StreamResponseProcessor } from '../../modules/api/chat/handlers/StreamResponseProcessor';
import type { StreamChunk } from '../../modules/channel/types';
import { TOOL_CALL_END, TOOL_CALL_START } from '../../tools/jsonFormatter';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { StreamAccumulator } from '../../modules/channel/StreamAccumulator';
import { formatHistoryForAPI } from '../../modules/conversation/manager/historyFormatting';
import { MessageBuilderService } from '../../modules/api/chat/services/MessageBuilderService';
import type { Content } from '../../modules/conversation/types';
import { createOpenAIResponsesConfig } from '../__fixtures__/channelFixtures';

const message = (id: string, phase: 'commentary' | 'final_answer', texts: string[]) => ({
    type: 'message', role: 'assistant', id, phase, status: 'completed',
    content: texts.map(text => ({ type: 'output_text', text, annotations: [], logprobs: [] }))
});
const reasoning = { type: 'reasoning', id: 'rs_test', summary: [{ type: 'summary_text', text: 'Summary' }], encrypted_content: 'synthetic-encrypted' };
const call = (id: string) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'read_file', arguments: '{"path":"a.txt"}' });
const done = (item: any, output_index: number) => ({ type: 'response.output_item.done', item, output_index });
const user: Content = { role: 'user', isUserInput: true, parts: [{ text: 'Task' }] };

function harness() {
    const formatter = new OpenAIResponsesFormatter();
    const accumulator = new StreamAccumulator();
    accumulator.setProviderType('openai-responses');
    const visible: any[] = [];
    const add = (event: any) => { visible.push(...accumulator.add(formatter.parseStreamChunk(event))); };
    const replay = (model: Content, tail: Content[] = []) => {
        const config = createOpenAIResponsesConfig({ sendHistoryThoughtSignatures: true, sendHistoryThoughts: true, historyThinkingRounds: 0 });
        const stored = JSON.parse(JSON.stringify([user, model, ...tail]));
        const history = formatHistoryForAPI(stored, new MessageBuilderService().buildHistoryOptions(config));
        return formatter.buildRequest({ configId: config.id, history }, config).body.input;
    };
    return { formatter, accumulator, visible, add, replay };
}

describe('Responses output item metadata roundtrip', () => {
    test.each(['stream', 'nonstream'])('two assistant phases and content boundaries survive JSON history: %s', mode => {
        const h = harness();
        const output = [message('msg_commentary', 'commentary', ['Working. ', 'Checking. ']), message('msg_final', 'final_answer', ['Done.'])];
        if (mode === 'stream') {
            for (const [output_index, item] of output.entries()) {
                h.add({ type: 'response.output_item.added', output_index, item: { ...item, content: [], status: 'in_progress' } });
                for (const [content_index, part] of item.content.entries()) {
                    const locator = { item_id: item.id, output_index, content_index };
                    h.add({ type: 'response.output_text.delta', ...locator, delta: part.text });
                    h.add({ type: 'response.output_text.done', ...locator, text: part.text });
                }
                h.add(done(item, output_index));
            }
            h.add({ type: 'response.completed', response: { status: 'completed', output } });
            expect(h.visible.map(part => part.text ?? '').join('')).toBe('Working. Checking. Done.');
        }
        const model = mode === 'stream' ? h.accumulator.getFinalContent() : h.formatter.parseResponse({ output }).content;
        expect(h.replay(model).slice(1)).toEqual(output);
        expect(model.parts).toHaveLength(3);
        // 正文只有一个来源：用户编辑 text 后不会被 provider 元数据中的旧副本覆盖。
        model.parts[0].text = 'Edited. ';
        expect(h.replay(model)[1].content[0].text).toBe('Edited. ');
    });

    test.each([true, false])('output_index-only text events keep one message when item ID arrives early=%s', earlyId => {
        const h = harness();
        const item = message('msg_index', 'commentary', ['Hello']);
        h.add({ type: 'response.output_item.added', output_index: 0, item: {
            type: 'message', role: 'assistant', status: 'in_progress', content: [], ...(earlyId ? { id: item.id } : {})
        } });
        h.add({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello' });
        h.add({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hello' });
        h.add(done(item, 0));
        // 兼容端点可能不提供终态 output；不能依赖它事后消除重复，更不能重复播放可见增量。
        h.add({ type: 'response.completed', response: { status: 'completed' } });
        expect(h.visible.map(part => part.text ?? '').join('')).toBe('Hello');
        expect(h.replay(h.accumulator.getFinalContent()).slice(1)).toEqual([item]);
    });

    test.each(['xml', 'json'] as const)('terminal snapshots keep parsed %s tool structure instead of restoring raw tool markup', async toolMode => {
        const formatter = new OpenAIResponsesFormatter();
        const processor = new StreamResponseProcessor({ providerType: 'openai-responses', toolMode,
            conversationId: 'prompt-tools', requestStartTime: Date.now() });
        const markup = toolMode === 'xml'
            ? '<tool_use><tool_name>read_file</tool_name><parameters><path>a.txt</path></parameters></tool_use>'
            : `${TOOL_CALL_START}\n{"tool":"read_file","parameters":{"path":"a.txt"}}\n${TOOL_CALL_END}`;
        const text = `Before ${markup} After`;
        const item = message('msg_prompt', 'commentary', [text]);
        const events = [
            { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
            { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text },
            { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text },
            done(item, 0),
            { type: 'response.completed', response: { status: 'completed', output: [item] } },
        ];
        async function* stream() { for (const event of events) yield formatter.parseStreamChunk(event); }
        const received: StreamChunk[] = [];
        for await (const update of processor.processStream(stream())) received.push(update.chunk);
        const snapshot = received.at(-1)?.contentSnapshot;
        expect(snapshot?.parts.filter(part => part.functionCall)).toHaveLength(1);
        expect(snapshot?.parts.find(part => part.functionCall)?.functionCall).toMatchObject({ name: 'read_file', args: { path: 'a.txt' } });
        expect(snapshot?.parts.map(part => part.text ?? '').join('')).toBe('Before  After');
        expect(processor.getContent().parts.filter(part => part.functionCall)).toHaveLength(1);
        expect(received.flatMap(chunk => chunk.delta).filter(part => part.functionCall)).toHaveLength(1);
    });

    test('completed backfills encrypted reasoning and phase, replacing in canonical output order without duplicate tools/text', () => {
        const h = harness();
        const commentary = message('msg_1', 'commentary', ['Working.']);
        h.add(done({ ...reasoning, encrypted_content: undefined }, 0));
        h.add({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Working.' });
        h.add(done(call('call_b'), 3));
        h.add(done(call('call_a'), 2));
        expect(h.accumulator.getNewCompletedFunctionCalls()).toHaveLength(2);
        h.add({ type: 'response.completed', response: {
            status: 'completed', model: 'test-model', output: [reasoning, commentary, call('call_a'), call('call_b')],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 64 } }
        } });
        const model = h.accumulator.getFinalContent();
        expect(model.parts.map(part => part.openaiResponsesReasoning?.id ?? part.openaiResponsesMessage?.id ?? part.functionCall?.id)).toEqual(['rs_test', 'msg_1', 'call_a', 'call_b']);
        expect(model.parts[0].thoughtSignatures?.['openai-responses']).toBe('synthetic-encrypted');
        expect(model.parts[1].openaiResponsesMessage?.phase).toBe('commentary');
        expect(h.visible.filter(part => !part.thought).map(part => part.text ?? '').join('')).toBe('Working.');
        expect(h.accumulator.getNewCompletedFunctionCalls()).toEqual([]);
        expect(h.accumulator.getFinishReason()).toBe('completed');
        expect(model.usageMetadata).toMatchObject({ totalTokenCount: 120, cacheReadTokenCount: 64 });
    });

    test('incomplete terminal snapshot preserves partial output, usage and finish reason; missing output never erases accumulated text', () => {
        const h = harness();
        const partial = { ...message('msg_partial', 'commentary', ['Partial']), status: 'incomplete' };
        h.add({ type: 'response.incomplete', response: { output: [partial], status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } });
        expect(h.accumulator.isComplete()).toBe(true);
        expect(h.accumulator.getFinishReason()).toBe('max_output_tokens');
        expect(h.replay(h.accumulator.getFinalContent())[1]).toEqual(partial);
        expect(h.accumulator.getFinalContent().usageMetadata?.totalTokenCount).toBe(6);
        expect(h.visible).toEqual([{ text: 'Partial' }]);
        h.add({ type: 'response.completed', response: { status: 'completed', output: [] } });
        expect(h.accumulator.getFinalContent().parts[0].text).toBe('Partial');
    });

    test.each(['agent_message', 'background_task'] as const)('appending %s keeps every previous reasoning/message/tool input byte stable', source => {
        const h = harness();
        h.add(done(reasoning, 0)); h.add(done(message('msg_1', 'commentary', ['Working.']), 1)); h.add(done(call('call_1'), 2));
        const model = h.accumulator.getFinalContent();
        const tool: Content = { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_1', name: 'read_file', response: { content: 'ok' } } }] };
        const before = h.replay(model, [tool]);
        const after = h.replay(model, [tool, { role: 'user', isUserInput: false, source, parts: [{ text: 'Agent feedback' }] }]);
        expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
        expect(after[1].encrypted_content).toBe(reasoning.encrypted_content);
        expect(after[2].phase).toBe('commentary');
    });

    test('reasoning added reserves its position before a late encrypted item.done', () => {
        const h = harness();
        h.add({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_test' } });
        h.add(done(message('msg_1', 'commentary', ['Working.']), 1));
        h.add(done(reasoning, 0));
        h.add({ type: 'response.completed', response: { status: 'completed' } });
        expect(h.replay(h.accumulator.getFinalContent()).slice(1).map((item: any) => item.type)).toEqual(['reasoning', 'message']);
    });

    test('legacy text has no invented phase and id-less text.done cannot duplicate delta', () => {
        const h = harness();
        h.add({ type: 'response.output_text.delta', delta: 'Legacy' });
        h.add({ type: 'response.output_text.done', text: 'Legacy' });
        h.add({ type: 'response.completed', response: { status: 'completed' } });
        expect(h.replay(h.accumulator.getFinalContent())[1]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Legacy' }] });
    });

    test('empty message, empty text and refusal retain distinct native content and phase', () => {
        const h = harness();
        const output = [message('msg_empty', 'commentary', []), message('msg_empty_text', 'commentary', ['']),
            { ...message('msg_refusal', 'final_answer', []), content: [{ type: 'refusal', refusal: 'Cannot comply.' }] }];
        h.add({ type: 'response.completed', response: { status: 'completed', output } });
        expect(h.replay(h.accumulator.getFinalContent()).slice(1)).toEqual(output);
    });

    test('switching a saved Responses message to Gemini strips only provider metadata', () => {
        const h = harness();
        const model = h.formatter.parseResponse({ output: [message('msg_1', 'commentary', ['Working.'])] }).content;
        const body = new GeminiFormatter().buildRequest({ configId: 'gemini', history: [user, model] }, {
            id: 'gemini', type: 'gemini', url: 'https://example.invalid', model: 'test-model', options: {}, optionsEnabled: {}, toolMode: 'function_call'
        } as any).body;
        expect(body.contents[1].parts).toEqual([{ text: 'Working.' }]);
        expect(model.parts[0].openaiResponsesMessage?.phase).toBe('commentary');
    });

    test('other providers ignore a Responses-style terminal content snapshot', () => {
        const accumulator = new StreamAccumulator(); accumulator.setProviderType('openai');
        accumulator.add({ delta: [{ text: 'Kept' }], done: false });
        accumulator.add({ delta: [], done: true, contentSnapshot: { role: 'model', parts: [{ text: 'Other' }] } });
        expect(accumulator.getFinalContent().parts).toEqual([{ text: 'Kept' }]);
    });
});
