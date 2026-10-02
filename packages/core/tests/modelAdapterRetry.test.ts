import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ModelInput, ProviderDefinition } from '@graycode/contracts';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { buildChannelConfig } from '../../../apps/server/src/model/capabilities';
import type { ChannelConfig } from '../../../backend/modules/config/types';

type Reply = { status?: number; chunks?: unknown[]; done?: boolean; body?: unknown };
const thinking = (text: string) => ({ choices: [{ delta: { reasoning_content: text }, finish_reason: null }] });
const content = (text: string) => ({ choices: [{ delta: { content: text }, finish_reason: null }] });
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };

describe('模型适配器按渠道设置重试空回复', () => {
  let server: Server; let replies: Reply[]; let requests: number; let profile: ProviderDefinition; let channel: ChannelConfig;
  const input = (overrides: Partial<ModelInput> = {}): ModelInput => ({ providerId: 'test', conversationId: 'conversation', systemPrompt: 'Stable system',
    messages: [{ role: 'user', parts: [{ text: 'hello' }] }], tools: [], signal: new AbortController().signal, ...overrides });
  const adapter = () => new ProviderModelAdapter({ profile: async () => profile, credential: async () => '', channel: async () => channel });

  beforeEach(async () => {
    replies = []; requests = 0;
    server = createServer(async (req, res) => {
      for await (const _ of req) { /* 读完请求正文 */ }
      const reply = replies[Math.min(requests, replies.length - 1)]; requests++;
      if (reply.body !== undefined) { res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply.body)); return; }
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'text/event-stream' });
      for (const chunk of reply.chunks ?? []) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end(reply.done === false ? '' : 'data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    profile = { id: 'test', name: 'test', protocol: 'openai', endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: 'test-model', models: [], stream: true, timeoutMs: 5000, generation: {},
      capabilities: { outputTokenParameter: 'protocol_default', strictTools: 'disabled', reasoningParameter: 'protocol_default',
        reasoningLevels: [], reasoningSignature: 'none', compatibility: { deepSeekUserId: false, openCodeSession: false, deepSeekVision: false, nativePdf: false } } };
    channel = { ...buildChannelConfig(profile, input(), ''), retryEnabled: true, retryCount: 2, retryInterval: 1 } as ChannelConfig;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  test('只有思考的回复按空回复重试，并通知调用方丢弃已显示的思考', async () => {
    replies = [{ chunks: [thinking('只想了一下'), stop] }, { chunks: [thinking('重新思考'), content('正文'), stop] }];
    const deltas: unknown[] = []; const retries: unknown[] = [];
    const response = await adapter().generate(input({ onDelta: parts => deltas.push(...parts), onRetry: status => { retries.push(status); deltas.length = 0; } }));
    expect(requests).toBe(2);
    expect(retries).toEqual([expect.objectContaining({ attempt: 1, maxAttempts: 2, nextRetryIn: 1 })]);
    expect(response.parts.filter(part => !part.thought)).toEqual([{ text: '正文' }]);
    expect(JSON.stringify(deltas)).not.toContain('只想了一下');
  });

  test('空回复连续出现时按设置的次数重试后报告空回复', async () => {
    replies = [{ chunks: [stop] }];
    await expect(adapter().generate(input())).rejects.toMatchObject({ type: 'EMPTY_RESPONSE_ERROR' });
    expect(requests).toBe(3);
  });

  test('关闭自动重试或渠道不可用时只请求一次，只有思考的回复仍报告为空回复', async () => {
    replies = [{ chunks: [thinking('只有思考'), stop] }];
    channel = { ...channel, retryEnabled: false } as ChannelConfig;
    await expect(adapter().generate(input())).rejects.toMatchObject({ type: 'EMPTY_RESPONSE_ERROR' });
    expect(requests).toBe(1);
    await expect(new ProviderModelAdapter({ profile: async () => profile, credential: async () => '' }).generate(input())).rejects.toMatchObject({ type: 'EMPTY_RESPONSE_ERROR' });
    expect(requests).toBe(2);
  });

  test('已经显示正文后中断不重试，避免重复输出', async () => {
    replies = [{ chunks: [content('已经显示的正文')], done: false }, { chunks: [content('不应出现'), stop] }];
    await expect(adapter().generate(input())).rejects.toMatchObject({ type: 'API_ERROR' });
    expect(requests).toBe(1);
  });

  test('没有任何输出就断开的流和 HTTP 错误按可重试错误处理', async () => {
    replies = [{ chunks: [thinking('思考到一半')], done: false }, { status: 503, body: { error: { message: 'busy' } } }, { chunks: [content('恢复'), stop] }];
    const response = await adapter().generate(input());
    expect(requests).toBe(3);
    expect(response.parts).toContainEqual({ text: '恢复' });
  });

  test('非流式空回复也会重试', async () => {
    profile.stream = false;
    replies = [{ body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }] } },
      { body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '非流式正文' } }] } }];
    const response = await adapter().generate(input());
    expect(requests).toBe(2);
    expect(response.parts).toContainEqual({ text: '非流式正文' });
  });

  test('等待重试间隔时取消会立即结束，不再发起请求', async () => {
    replies = [{ chunks: [stop] }];
    channel = { ...channel, retryInterval: 10_000 } as ChannelConfig;
    const controller = new AbortController();
    const pending = adapter().generate(input({ signal: controller.signal, onRetry: () => setTimeout(() => controller.abort(new Error('Cancelled by user.')), 5) }));
    await expect(pending).rejects.toThrow('Cancelled by user.');
    expect(requests).toBe(1);
  });
});
