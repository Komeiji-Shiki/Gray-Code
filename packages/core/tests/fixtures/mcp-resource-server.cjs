const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));
createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(request, 'id')) return;
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  const fail = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message } }) + '\n');
  const params = request.params ?? {};
  if (request.method === 'initialize') reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'ResourceFixture', version: '1' } });
  else if (request.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'Return the supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  else if (request.method === 'tools/call') {
    const content = { content: [{ type: 'text', text: params.arguments?.text ?? '' }], structuredContent: { echoed: params.arguments?.text ?? '' } };
    reply(content);
  } else if (request.method === 'resources/list') reply({ resources: [
    { uri: 'fixture://hello', name: 'Hello', description: 'Fixture resource', mimeType: 'text/plain' },
    { uri: 'fixture://slow', name: 'Slow', description: 'Delayed resource for cancellation', mimeType: 'text/plain' },
  ] });
  else if (request.method === 'resources/read') {
    if (params.uri === 'fixture://hello') reply({ contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'hello resource content' }] });
    else if (params.uri === 'fixture://slow') setTimeout(() => reply({ contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'slow resource content' }] }), 5000);
    else fail(`Unknown resource: ${params.uri}`);
  } else if (request.method === 'prompts/list') reply({ prompts: [
    { name: 'greet', description: 'Greet template', arguments: [{ name: 'name', description: 'Name to greet', required: true }, { name: 'style', description: 'Optional style', required: false }] },
  ] });
  else if (request.method === 'prompts/get') {
    if (params.name !== 'greet') fail(`Unknown prompt: ${params.name}`);
    else if (!params.arguments?.name) fail('Missing required argument: name');
    else {
      const style = params.arguments.style ? ` Style: ${params.arguments.style}` : '';
      reply({ messages: [{ role: 'user', content: { type: 'text', text: `Hello, ${params.arguments.name}!${style}` } }] });
    }
  } else if (request.method === 'ping') reply({});
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
});
