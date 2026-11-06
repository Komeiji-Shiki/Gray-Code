import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelRequestSnapshot } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

test.each([true, false])('请求记录补写上游追踪编号，不保存其他响应头（流式：%s）', async preferStream => {
  const f = await fixture(); await f.store.close();
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      const headers = { 'cf-ray': '8f2a-HKG', 'x-request-id': 'req_fixture', 'set-cookie': 'session=secret' };
      const message = { role: 'assistant', content: '完成。' };
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      if (body.stream) {
        response.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: 'stop' }], usage })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { ...headers, 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }], usage }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root });
  try {
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ name: '模拟接口', type: 'openai', options: { stream: preferStream },
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'fixture-model', apiKey: '',
      enabled: true, contextManagementEnabled: false, timeout: 10000 });
    await app.product.save(draft);
    await app.storage.createConversation({ id: 'trace-chat', actorId: 'owner', createdAt: Date.now(), updatedAt: Date.now(), custom: { platformMode: 'chat' } });
    const started = await app.productUi.call({ actorId: 'owner', clientId: 'trace-test' }, 'chatStream',
      { conversationId: 'trace-chat', configId: providerId, message: '你好', streamId: 'trace' }) as { runId: string };
    const finished = await app.runtime.wait(started.runId);
    expect(finished?.error).toBeUndefined();
    expect(finished?.status).toBe('completed');
    const record = await app.storage.getRecord('model-requests', `${started.runId}:1`) as ModelRequestSnapshot;
    expect(record.response).toEqual({ status: 200, ids: { 'cf-ray': '8f2a-HKG', 'x-request-id': 'req_fixture' } });
    expect(record.body).toMatchObject({ model: 'fixture-model' });
  } finally {
    await app.close();
    await new Promise(resolve => server.close(resolve));
    await f.cleanup();
  }
});
