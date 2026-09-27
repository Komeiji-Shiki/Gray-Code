import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PlatformStorage } from '@graycode/core';
import type { ModelInput, PlatformMessage, ProviderDefinition } from '@graycode/contracts';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { buildChannelConfig } from '../../../apps/server/src/model/capabilities';
import { formatHistoryForAPI } from '../../../backend/modules/conversation/manager/historyFormatting';
import { MessageBuilderService } from '../../../backend/modules/api/chat/services/MessageBuilderService';
import type { Content } from '../../../backend/modules/conversation/types';
import { fixture, metadata } from './fixtures';

const output = [
    { type: 'reasoning', id: 'rs_platform', summary: [], encrypted_content: 'synthetic-secret-reasoning' },
    { type: 'message', id: 'msg_commentary', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.', annotations: [] }] },
    { type: 'function_call', id: 'fc_platform', call_id: 'call_platform', name: 'inspect', arguments: '{}' }
];

test.each([true, false])('Responses phase/reasoning survive adapter -> SQLite reopen -> request, stream=%s', async stream => {
    const f = await fixture();
    const requests: unknown[] = [];
    const response = { status: 'completed', model: 'synthetic-model', output, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
    const server = createServer(async (request, res) => {
        const buffers: Buffer[] = []; for await (const chunk of request) buffers.push(chunk);
        requests.push(JSON.parse(Buffer.concat(buffers).toString()));
        if (!stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response)); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // encrypted_content 故意仅在 completed 的权威 output 出现。
        for (const event of [
            { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_platform', summary: [] } },
            { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_commentary', content_index: 0, delta: 'Checking.' },
            { type: 'response.output_item.done', output_index: 1, item: output[1] },
            { type: 'response.output_item.done', output_index: 2, item: output[2] },
            { type: 'response.completed', response }
        ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
        res.end();
    });
    try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const profile: ProviderDefinition = { id: 'test', name: 'Synthetic', protocol: 'openai-responses', endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            model: 'synthetic-model', models: [], stream, timeoutMs: 5000, generation: {}, capabilities: {
                outputTokenParameter: 'protocol_default', strictTools: 'protocol_default', reasoningParameter: 'protocol_default', reasoningLevels: [], reasoningSignature: 'native',
                compatibility: { deepSeekUserId: false, openCodeSession: false, deepSeekVision: false, nativePdf: false }
            } };
        const credential = jest.fn(async () => { throw new Error('No credential access in fixture'); });
        const adapter = new ProviderModelAdapter({ profile: async () => profile, credential });
        const user: PlatformMessage = { id: 'user', role: 'user', isUserInput: true, parts: [{ text: 'Task' }] };
        const input: ModelInput = { providerId: profile.id, conversationId: 'roundtrip', systemPrompt: 'Synthetic system', messages: [user], tools: [], signal: new AbortController().signal };
        const deltas: Record<string, unknown>[] = [];
        const generated = await adapter.generate({ ...input, onDelta: parts => deltas.push(...parts) });
        expect(generated.parts[0].thoughtSignatures).toEqual({ 'openai-responses': 'synthetic-secret-reasoning' });
        expect(generated.parts[1].openaiResponsesMessage).toMatchObject({ id: 'msg_commentary', phase: 'commentary', status: 'completed' });
        if (stream) expect(deltas.filter(part => !part.thought).map(part => part.text ?? '').join('')).toBe('Checking.');
        const tool: PlatformMessage = { id: 'tool', role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_platform', name: 'inspect', response: { ok: true } } }] };
        await f.store.createConversation(metadata('roundtrip'));
        await f.store.appendHistory('roundtrip', [user, { ...generated, id: 'assistant' }, tool]);
        await f.store.close(); f.store = await PlatformStorage.open(f.data);
        const stored = (await f.store.readHistory('roundtrip')).messages;
        expect(stored[1].parts).toEqual(generated.parts);
        const config = buildChannelConfig(profile, input, '');
        const prepare = (messages: PlatformMessage[]) => formatHistoryForAPI(messages as Content[], new MessageBuilderService().buildHistoryOptions(config)) as PlatformMessage[];
        const before = await adapter.preview({ ...input, messages: prepare(stored) });
        const after = await adapter.preview({ ...input, messages: prepare([...stored, { role: 'user', source: 'agent_message', isUserInput: false, parts: [{ text: 'Agent result' }] }]) });
        const items = (before.body as any).input;
        expect(items[1]).toEqual(output[0]); expect(items[2]).toEqual(output[1]);
        expect((after.body as any).input.slice(0, items.length)).toEqual(items);
        expect(requests).toHaveLength(1); expect(credential).not.toHaveBeenCalled();
    } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        await f.cleanup();
    }
});
