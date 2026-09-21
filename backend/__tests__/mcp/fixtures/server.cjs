const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');

const version = '2026-07-28';
const protocolKey = 'io.modelcontextprotocol/protocolVersion';
const subscriptionKey = 'io.modelcontextprotocol/subscriptionId';
const capabilities = { tools: { listChanged: true }, resources: {}, prompts: {} };
const tool = name => ({ name, inputSchema: { type: 'object', properties: { action: { type: 'string' } } } });

function handler(mode, send) {
    let subscription, revision = 0;
    return request => {
        const reply = result => send({ jsonrpc: '2.0', id: request.id,
            result: mode === 'modern' ? { resultType: 'complete',
                ...(/\/list$/.test(request.method) || request.method === 'resources/read' ? { ttlMs: 60000, cacheScope: 'private' } : {}),
                ...result } : result });
        const error = (code, message) => send({ jsonrpc: '2.0', id: request.id, error: { code, message } });
        if (request.id === undefined) return;
        if (mode === 'quiet') return;
        if (request.method === 'server/discover') {
            if (mode === 'exit-legacy') return process.exit(0);
            if (mode !== 'modern') return error(-32601, 'Method not found');
            return reply({ supportedVersions: [version], capabilities,
                _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1' } } });
        }
        if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities,
            serverInfo: { name: 'fixture', version: '1' } });
        if (request.method === 'subscriptions/listen') {
            subscription = request.id;
            return send({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: {
                notifications: request.params.notifications,
                _meta: { [subscriptionKey]: subscription, [protocolKey]: version },
            } });
        }
        if (request.method === 'tools/list') return reply(request.params?.cursor === 'second/+=页'
            ? { tools: [tool('second')] } : { tools: [tool(`echo${revision || ''}`)], nextCursor: 'second/+=页' });
        if (request.method === 'resources/list') return reply({ resources: [{ uri: 'test://resource', name: 'fixture' }] });
        if (request.method === 'prompts/list') return reply({ prompts: [{ name: 'prompt' }] });
        if (request.method === 'resources/read') return reply({ contents: [{ uri: request.params.uri, text: 'text' }] });
        if (request.method === 'prompts/get') return reply({ messages: [{ role: 'user', content: { type: 'text', text: 'prompt' } }] });
        if (request.method === 'tools/call') {
            const action = request.params.arguments?.action;
            if (action === 'wait') return;
            if (action === 'input') return reply({ resultType: 'input_required', requestState: 'opaque/状态==',
                inputRequests: { answer: { method: 'elicitation/create', params: { message: 'Choose', requestedSchema: {
                    type: 'object', properties: { value: { type: 'string' } }, required: ['value'],
                } } } } });
            if (action === 'notify') {
                revision++;
                send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', ...(mode === 'modern' ? {
                    params: { _meta: { [subscriptionKey]: subscription, [protocolKey]: version } },
                } : {}) });
            }
            return reply({ content: [{ type: 'text', text: '中文' }, { type: 'image', mimeType: 'image/png', data: 'cG5n' }],
                structuredContent: { pid: process.pid, arguments: request.params.arguments } });
        }
        if (request.method === 'ping') return reply({});
        error(-32601, 'Method not found');
    };
}

if (require.main === module) {
    if (process.argv[3]) writeFileSync(process.argv[3], String(process.pid));
    const receive = handler(process.argv[2], value => process.stdout.write(JSON.stringify(value) + '\n'));
    createInterface({ input: process.stdin }).on('line', line => receive(JSON.parse(line)));
}
module.exports = { handler };
