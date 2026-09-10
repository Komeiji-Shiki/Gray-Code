import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ModelInput, ProviderDefinition } from '@graycode/contracts';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { applyProviderCapabilities, buildChannelConfig } from '../../../apps/server/src/model/capabilities';
import { OpenAIResponsesFormatter } from '../../../backend/modules/channel/formatters/openai-responses';
import { GeminiFormatter } from '../../../backend/modules/channel/formatters/gemini';
import { botRoundText } from '../../../apps/server/src/bots/rounds';

describe('real HTTP model adapter with existing provider codecs', () => {
  let server: Server;
  let profile: ProviderDefinition;
  let requests: { headers: Record<string, unknown>; body: any }[];
  let adapter: ProviderModelAdapter;
  const input = (): ModelInput => ({ providerId: 'test', conversationId: 'conversation', systemPrompt: 'Stable system',
    messages: [{ role: 'user', parts: [{ text: 'hello' }] }], tools: [{ name: 'inspect', description: 'inspect',
      parameters: { type: 'object', properties: { path: { type: 'string' }, optional: { type: 'string' } }, required: ['path'] } }],
    signal: new AbortController().signal });
  beforeEach(async () => {
    requests = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ headers: req.headers, body });
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of [
          { choices: [{ delta: { content: 'stream ' }, finish_reason: null }] },
          { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
        ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ model: 'test-model', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant',
          content: null, tool_calls: [{ id: 'call_http', type: 'function', function: { name: 'inspect', arguments: '{"path":"readme.md","optional":null}' } }] } }] }));
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    profile = { id: 'test', name: 'test', protocol: 'openai', endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: 'test-model', models: [], stream: false, timeoutMs: 5000, generation: { maxOutputTokens: 123, reasoningEffort: 'high' },
      capabilities: { outputTokenParameter: 'max_completion_tokens', strictTools: 'enabled', reasoningParameter: 'reasoning_effort',
        reasoningLevels: ['low', 'high'], reasoningSignature: 'native',
        compatibility: { deepSeekUserId: true, openCodeSession: true, deepSeekVision: false, nativePdf: false } } };
    adapter = new ProviderModelAdapter({ profile: async () => profile, credential: async () => '' });
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  test('centralizes token limits, strict schemas, reasoning and stable compatibility identities', async () => {
    const response = await adapter.generate(input());
    expect(response.responseDuration).toEqual(expect.any(Number));
    expect(response.ttft).toBeUndefined();
    expect(response.parts[0]).toMatchObject({ functionCall: { id: 'call_http', name: 'inspect', args: { path: 'readme.md', optional: null } } });
    const request = requests[0];
    expect(request.body).toMatchObject({ max_completion_tokens: 123, reasoning_effort: 'high' });
    expect(request.body.max_tokens).toBeUndefined();
    expect(request.body.tools[0].function).toMatchObject({ strict: true, parameters: { additionalProperties: false, required: ['path', 'optional'] } });
    expect(request.body.tools[0].function.parameters.properties.optional.anyOf).toContainEqual({ type: 'null' });
    expect(request.headers['x-opencode-session']).toMatch(/^[a-f0-9-]{36}$/);
    expect(request.body.user_id).not.toContain('conversation:');
    const other = input(); other.reasoningEffort = 'low';
    await adapter.generate(other);
    expect(requests[1].body.reasoning_effort).toBe('low');
    expect(requests[1].headers['x-opencode-session']).toBe(request.headers['x-opencode-session']);
  });

  test('accumulates real SSE and keeps usage chunks arriving after text completion', async () => {
    profile.stream = true;
    const deltas: unknown[] = [];
    const response = await adapter.generate({ ...input(), onDelta: parts => deltas.push(...parts) });
    expect(response.parts).toContainEqual({ text: 'stream answer' });
    expect(response.usageMetadata).toMatchObject({ totalTokenCount: 7 });
    expect(response.ttft).toEqual(expect.any(Number));
    expect(response.responseDuration).toEqual(expect.any(Number));
    expect(response.streamDuration).toBe(response.responseDuration);
    expect(Number(response.responseDuration)).toBeGreaterThanOrEqual(Number(response.ttft));
    expect(deltas.length).toBeGreaterThan(0);
  });

  test('总结指令只追加到实际 HTTP 请求末尾，系统、工具、动态上下文和缓存标识不变', async () => {
    const request = input();
    request.messages = [{ id: 'user-1', role: 'user', isUserInput: true, parts: [{ text: '原始任务' }] },
      { id: 'assistant-1', role: 'model', parts: [{ text: '已完成一部分' }] },
      { id: 'user-2', role: 'user', isUserInput: true, parts: [{ text: '继续' }] },
      { id: 'assistant-2', role: 'model', parts: [{ text: '已有进度' }] }];
    request.promptContext = { historyPlacement: 'entry', beforeHistoryMessages: [{ role: 'user', parts: [{ text: '固定环境' }] }],
      afterHistoryMessages: [{ role: 'user', parts: [{ text: '当前回合环境' }] }] };
    await adapter.generate(request);
    await adapter.generate({ ...request, purpose: 'summary', messages: [...request.messages,
      { role: 'user', contextControl: 'summary_request', parts: [{ text: '请总结当前全部对话。' }] }] });
    const previous = requests[0], summary = requests[1];
    expect(summary.body.messages.slice(0, previous.body.messages.length)).toEqual(previous.body.messages);
    expect(summary.body.messages.at(-1)).toMatchObject({ role: 'user', content: '请总结当前全部对话。' });
    expect({ ...summary.body, messages: undefined }).toEqual({ ...previous.body, messages: undefined });
    expect(summary.headers['x-opencode-session']).toBe(previous.headers['x-opencode-session']);
  });

  test('原生消息只发送正文，Discord 展示文字、思考耗时、用量和内部控制标记不会回传', () => {
    const message = { role: 'model', parts: [{ thought: true, text: '真实思考' }, { text: '工具调用前的实际输出' }],
      thinkingDuration: 1500, responseDuration: 2400, ttft: 300, usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 50 },
      contextControl: 'reminder', contextMethod: 'summary', isSummary: true };
    const rendered = botRoundText(message, { output: { showThoughts: true, showToolStatus: true } } as any, 1);
    expect(rendered).toContain('已进行思考'); expect(rendered).toContain('TTFT');
    profile.protocol = 'gemini';
    const request = input();
    const config = buildChannelConfig(profile, request, '');
    const body = new GeminiFormatter().buildRequest({ configId: profile.id, history: [
      { role: 'user', parts: [{ text: '原始任务' }] }, { ...message, characterDisplayParts: [{ text: rendered }] },
    ] } as any, config as any).body;
    expect(body.contents.every((content: Record<string, unknown>) => Object.keys(content).every(key => ['role', 'parts'].includes(key)))).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('工具调用前的实际输出');
    for (const field of ['thinkingDuration', 'responseDuration', 'usageMetadata', 'contextControl', 'contextMethod', 'characterDisplayParts', '已进行思考', 'TTFT']) expect(serialized).not.toContain(field);
  });

  test('selects Responses reasoning capabilities and explicitly disables strict mode without name guessing', () => {
    profile.protocol = 'openai-responses'; profile.capabilities.reasoningSignature = 'native';
    profile.capabilities.reasoningParameter = 'reasoning.effort'; profile.capabilities.outputTokenParameter = 'max_output_tokens';
    profile.capabilities.strictTools = 'disabled';
    const request = input();
    const config = buildChannelConfig(profile, request, '');
    expect(config.providerReasoningContentEnabled).toBe(false);
    const formatterRequest = { configId: 'test', conversationId: request.conversationId, history: request.messages as any };
    const body = applyProviderCapabilities(new OpenAIResponsesFormatter().buildRequest(formatterRequest, config as any, request.tools as any), profile, request, formatterRequest).body;
    expect(body).toMatchObject({ max_output_tokens: 123, reasoning: { effort: 'high' }, store: false });
    expect(body.tools[0].strict).toBe(false);
    expect(body.reasoning_effort).toBeUndefined();
  });
});
