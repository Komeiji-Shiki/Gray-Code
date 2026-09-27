import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { PlatformRuntime, RuntimeToolRegistry } from '@graycode/core';
import type { AgentDefinition, ModelInput, ProviderDefinition } from '@graycode/contracts';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { buildChannelConfig } from '../../../apps/server/src/model/capabilities';
import { fixture, metadata } from './fixtures';

// 真正的“附件已保存”与“供应方请求里含图”是两条边界：用隔离存储和本机 HTTP 检查，
// 不读取用户渠道/凭据，也不把合成端点收到了图片等同于真实模型已经理解图片。
test('浏览器附件经运行器存储与四种模型协议 HTTP 请求保持字节和顺序', async () => {
  const f = await fixture();
  const images = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=',
    (await readFile('resources/icon.png')).toString('base64'),
  ];
  const registry = new RuntimeToolRegistry();
  registry.register({ declaration: { name: 'browser_read', description: 'fixture screenshot', parameters: { type: 'object', properties: { frame: { type: 'integer' } } } },
    effects: () => ['public_read'], execute: async args => ({ success: true, data: { frame: args.frame },
      attachments: [{ mimeType: 'image/png', data: images[Number(args.frame)], name: 'browser.png' }] }) });
  const agent: AgentDefinition = { id: 'browser-fixture', name: 'Browser fixture', providerId: 'fixture', systemPrompt: 'Inspect browser screenshots.',
    approvalMode: 'sensitive', maxIterations: 3, toolNames: ['browser_read'] };
  let following: ModelInput | undefined;
  const runtime = new PlatformRuntime({ storage: f.store, tools: registry,
    actor: async () => ({ id: 'owner', displayName: 'Owner', role: 'owner', effects: [], workspaceIds: '*' }),
    agent: async () => agent, workspace: async () => null,
    models: { generate: async input => {
      if (input.messages.some(message => message.isFunctionResponse)) {
        following = input; return { role: 'model', parts: [{ text: 'Fixture complete.' }] };
      }
      return { role: 'model', parts: images.map((_data, frame) => ({ functionCall: { id: `frame-${frame}`, name: 'browser_read', args: { frame } } })) };
    } },
  });
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('Content-Type', 'application/json');
    // 所有字段均为合成响应；每个适配器只解析自己的协议形状，不需要真实上游服务。
    res.end(JSON.stringify({ id: 'fixture', model: 'fixture', role: 'assistant', type: 'message', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 },
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], status: 'completed',
      candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
    }));
  });
  try {
    await runtime.initialize(); await f.store.createConversation({ ...metadata('browser-images'), actorId: 'owner' });
    const run = await runtime.start({ actorId: 'owner', conversationId: 'browser-images', requestKey: 'browser-images', agentId: agent.id,
      message: { role: 'user', parts: [{ text: 'Inspect both frames.' }] } });
    expect((await runtime.wait(run.id))?.status).toBe('completed');
    const stored = (await f.store.readFullHistory('browser-images')).messages;
    expect(stored.filter(message => message.isFunctionResponse).flatMap(message => message.parts.flatMap(part =>
      (part.inlineData as { data?: string } | undefined)?.data ?? []))).toEqual(images);
    expect(following).toBeDefined();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    for (const protocol of ['openai', 'openai-responses', 'anthropic', 'gemini'] as const) {
      const profile: ProviderDefinition = { id: 'fixture', name: 'Fixture', protocol, model: 'fixture', models: [], stream: false, timeoutMs: 5000,
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, generation: {}, capabilities: {
          outputTokenParameter: 'max_tokens', strictTools: 'disabled', reasoningParameter: 'disabled', reasoningLevels: [], reasoningSignature: 'native',
          compatibility: { deepSeekVision: false, nativePdf: false, deepSeekUserId: false, openCodeSession: false },
        } };
      const request = { ...following!, signal: new AbortController().signal };
      // 走桌面实际使用的 channel 分支，并验证旧多模态工具开关不应追溯删除已保存的截图。
      const adapter = new ProviderModelAdapter({ profile: async () => profile, credential: async () => '',
        channel: async () => ({ ...buildChannelConfig(profile, request, ''), multimodalToolsEnabled: false }) });
      const preview = await adapter.preview(request); await adapter.generate(request);
      expect(requests.at(-1)).toEqual(preview.body);
      const body = JSON.stringify(preview.body);
      expect(body.indexOf(images[0])).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(images[1])).toBeGreaterThan(body.indexOf(images[0]));
      // 禁止只把 base64 塞进工具文本冒充视觉输入；逐协议检查模型能消费的图片内容块。
      if (protocol === 'openai') expect(preview.body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((part: any) => part.type === 'image_url')).toHaveLength(2);
      if (protocol === 'openai-responses') expect(preview.body.input.flatMap((message: any) => message.content ?? []).filter((part: any) => part.type === 'input_image')).toHaveLength(2);
      if (protocol === 'anthropic') expect(preview.body.messages.flatMap((message: any) => message.content ?? []).filter((part: any) => part.type === 'image')).toHaveLength(2);
      if (protocol === 'gemini') expect(preview.body.contents.flatMap((message: any) => message.parts ?? []).filter((part: any) => part.inlineData?.mimeType === 'image/png')).toHaveLength(2);
    }
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close(); await f.cleanup();
  }
});
