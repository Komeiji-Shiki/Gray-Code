// Mock MCP server for GrayCode standalone E2E (JSON-RPC over stdio, newline-delimited).
process.stdin.setEncoding('utf8');
let buffer = '';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(method, params, id) {
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'e2e-mcp-mock', version: '1.0.0' },
          capabilities: { tools: {}, resources: {}, prompts: {} }
        }
      });
      break;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo the input text back',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text']
              }
            },
            {
              name: 'add',
              description: 'Add two numbers',
              inputSchema: {
                type: 'object',
                properties: {
                  a: { type: 'number' },
                  b: { type: 'number' }
                },
                required: ['a', 'b']
              }
            }
          ]
        }
      });
      break;
    case 'resources/list':
      send({ jsonrpc: '2.0', id, result: { resources: [] } });
      break;
    case 'prompts/list':
      send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      break;
    case 'tools/call': {
      const args = (params && params.arguments) || {};
      if (params.name === 'echo') {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'echo:' + String(args.text) }] }
        });
      } else if (params.name === 'add') {
        const sum = Number(args.a) + Number(args.b);
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'sum:' + sum }] }
        });
      } else {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Unknown tool: ' + params.name }
        });
      }
      break;
    }
    default:
      if (id !== undefined && id !== null) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
      }
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method) {
      handle(msg.method, msg.params, msg.id);
    }
  }
});
