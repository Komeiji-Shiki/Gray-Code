const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, 'id')) return;
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'initialize') reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } });
  else if (request.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'Return the supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  else if (request.method === 'tools/call') {
    if (request.params.arguments.text === 'fixture error') {
      const structuredContent = { code: 'WINDOW_CLOSED', retryable: false };
      reply({ isError: true, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Xq0AAAAASUVORK5CYII=' }] });
      return;
    }
    const content = { content: [{ type: 'text', text: request.params.arguments.text },
      { type: 'resource', resource: { uri: 'fixture://binary', mimeType: 'application/octet-stream', blob: Buffer.from('fixture binary').toString('base64') } }], structuredContent: { echoed: request.params.arguments.text } };
    if (request.params.arguments.text === 'wait') setTimeout(() => reply(content), 10000); else reply(content);
  } else if (request.method === 'ping') reply({});
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
});
