import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ModelInput, ProviderDefinition } from '@graycode/contracts';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';

// 经过正式 adapter 与能力覆盖层检查线上请求，不能只验证 formatter 中间结果。
describe('Responses 工具 schema 的平台 HTTP 回归', () => {
  let server: Server;
  let profile: ProviderDefinition;
  let adapter: ProviderModelAdapter;
  let requests: any[];
  const input = (): ModelInput => ({
    providerId: 'responses', conversationId: 'schema-conversation', systemPrompt: 'Stable system',
    messages: [{ role: 'user', parts: [{ text: 'List topics without a cursor.' }] }],
    tools: [{ name: 'memory_topics', description: 'List available topics.', parameters: {
      type: 'object', properties: { cursor: { type: 'string', maxLength: 512 }, limit: { type: 'integer', minimum: 1 } }, required: [],
    } }], signal: new AbortController().signal,
  });

  beforeEach(async () => {
    requests = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'response_schema', status: 'completed', model: 'synthetic-model', output: [
        { type: 'message', id: 'message_schema', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] },
      ], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    profile = {
      id: 'responses', name: 'Responses', protocol: 'openai-responses',
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: 'synthetic-model', models: [], stream: false, timeoutMs: 5000, generation: {},
      capabilities: { outputTokenParameter: 'protocol_default', strictTools: 'protocol_default',
        reasoningParameter: 'protocol_default', reasoningLevels: [], reasoningSignature: 'native',
        compatibility: { deepSeekVision: false, nativePdf: false, deepSeekUserId: false, openCodeSession: false } },
    };
    adapter = new ProviderModelAdapter({ profile: async () => profile, credential: async () => '' });
  });
  afterEach(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test.each(['protocol_default', 'disabled', 'enabled'] as const)('%s 能力覆盖保留 optional 的含义且预览等于发送', async mode => {
    profile.capabilities.strictTools = mode;
    const request = input();
    const original = structuredClone(request.tools);
    const preview = await adapter.preview(request);
    await adapter.generate(request);
    expect(requests[0]).toEqual(preview.body);
    expect(request.tools).toEqual(original);
    const tool = requests[0].tools[0];
    expect(tool.strict).toBe(mode === 'enabled');
    if (mode === 'enabled') {
      expect(tool.parameters).toMatchObject({ additionalProperties: false, required: ['cursor', 'limit'] });
      expect(tool.parameters.properties.cursor.anyOf).toEqual([{ type: 'string', maxLength: 512 }, { type: 'null' }]);
    } else {
      expect(tool.parameters).toEqual(original[0].parameters);
      expect(tool.parameters.required).toEqual([]);
    }
  });

  test('单模型覆盖可关闭渠道 strict，不会残留渠道自动严格化', async () => {
    profile.capabilities.strictTools = 'enabled';
    profile.models = [{ id: 'optional-model', capabilities: { strictTools: 'disabled' } }];
    const request = input(); request.modelOverride = 'optional-model';
    await adapter.generate(request);
    expect(requests[0].tools[0]).toMatchObject({ strict: false, parameters: request.tools[0].parameters });
    expect(profile.capabilities.strictTools).toBe('enabled');
  });
});
