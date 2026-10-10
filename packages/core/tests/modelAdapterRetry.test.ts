import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ModelInput, ProviderDefinition } from '@graycode/contracts';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { buildChannelConfig } from '../../../apps/server/src/model/capabilities';
import type { ChannelConfig } from '../../../backend/modules/config/types';
import { ChannelHttpExecutor } from '../../../backend/modules/channel/channelManager/channelHttpExecutor';
import { ChannelError, ErrorType } from '../../../backend/modules/channel/types';
import { ResponsesWebSocket } from '../../../apps/server/src/model/responsesWebSocket';

type Reply = { status?: number; chunks?: unknown[]; done?: boolean; body?: unknown; headers?: Record<string, string> };
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
      if (reply.body !== undefined) { res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers }); res.end(JSON.stringify(reply.body)); return; }
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
  afterEach(async () => { jest.useRealTimers(); jest.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  test.each(['stream', 'non-stream', 'native'])('%s 网络故障按 5、15、30 分钟补试三次后结束', async transport => {
    profile.stream = transport !== 'non-stream';
    const failure = new ChannelError(ErrorType.NETWORK_ERROR, '连接失败');
    const request = transport === 'native' ? jest.spyOn(ResponsesWebSocket, 'connect').mockRejectedValue(failure)
      : transport === 'non-stream' ? jest.spyOn(ChannelHttpExecutor.prototype, 'executeRequest').mockRejectedValue(failure)
      : jest.spyOn(ChannelHttpExecutor.prototype, 'executeStreamRequest').mockImplementation(async function* () { throw failure; });
    if (transport === 'native') {
      profile.protocol = 'openai-responses';
      channel = { ...buildChannelConfig(profile, input(), ''), retryEnabled: true, retryCount: 2, responsesWebSocketEnabled: true } as ChannelConfig;
    }
    jest.useFakeTimers();
    const retries: Array<{ attempt: number; maxAttempts: number; nextRetryIn: number }> = [];
    const started = Date.now();
    const pending = expect(adapter().generate(input({ ...(transport === 'native' ? { runId: 'network-retry' } : {}), onRetry: status => retries.push(status) })))
      .rejects.toBe(failure);
    await jest.runAllTimersAsync(); await pending;
    expect(request).toHaveBeenCalledTimes(4);
    expect(retries.map(status => [status.attempt, status.maxAttempts, status.nextRetryIn])).toEqual([[1, 3, 300_000], [2, 3, 900_000], [3, 3, 1_800_000]]);
    expect(Date.now() - started).toBe(3_000_000);
  });

  test('网络等待可立即取消，关闭重试后不再进入等待', async () => {
    const failure = new ChannelError(ErrorType.TIMEOUT_ERROR, '请求超时');
    const request = jest.spyOn(ChannelHttpExecutor.prototype, 'executeStreamRequest').mockImplementation(async function* () { throw failure; });
    const controller = new AbortController();
    await expect(adapter().generate(input({ signal: controller.signal, onRetry: () => controller.abort(new Error('停止等待')) }))).rejects.toThrow('停止等待');
    expect(request).toHaveBeenCalledTimes(1);
    channel.retryEnabled = false;
    const retry = jest.fn();
    await expect(adapter().generate(input({ onRetry: retry }))).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(2); expect(retry).not.toHaveBeenCalled();
  });

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
  // HTTP 限流沿用真实本机夹具，避免只验证错误字符串。
  test('429 尊重 Retry-After，余额错误不重试，接续预算不会重新增加', async () => {
    replies = [{ status: 429, headers: { 'Retry-After': '0.02' }, body: { error: { code: 'rate_limit_exceeded', message: 'rate limit' } } },
      { chunks: [content('恢复'), stop] }];
    const retries: Array<{ nextRetryIn: number }> = [];
    expect((await adapter().generate(input({ onRetry: status => retries.push(status) }))).parts).toContainEqual({ text: '恢复' });
    expect(requests).toBe(2); expect(retries[0].nextRetryIn).toBe(20);
    requests = 0; replies = [{ status: 429, body: { error: { code: 'insufficient_quota', message: 'no balance' } } }];
    await expect(adapter().generate(input())).rejects.toMatchObject({ type: 'API_ERROR' }); expect(requests).toBe(1);
    requests = 0; replies = [{ status: 429, headers: { 'Retry-After': '0' }, body: { error: { message: 'rate limit' } } }];
    await expect(adapter().generate(input({ retryCount: 1 }))).rejects.toMatchObject({ modelRetry: { remainingRetries: 0 } });
    expect(requests).toBe(2);
  });
  test('原生连接握手限流保留状态和等待时间，供子代理按剩余次数接续', async () => {
    profile.protocol = 'openai-responses';
    channel = { ...buildChannelConfig(profile, input(), ''), responsesWebSocketEnabled: true, retryEnabled: true, retryCount: 1, retryInterval: 1 } as ChannelConfig;
    server.on('upgrade', (_req, socket) => { requests++; socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    await expect(adapter().generate(input({ runId: 'native-rate-limit' }))).rejects.toMatchObject({
      httpStatus: 429, modelRetry: { remainingRetries: 1, resumeSafe: true, delayMs: 0 } });
    expect(requests).toBe(1);
  });

});

