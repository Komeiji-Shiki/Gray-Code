import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

describe('自动重试丢弃上一次只显示的思考', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let router: ApplicationRouter;
  let events: Record<string, any>[]; let generate: (input: ModelInput) => Promise<PlatformMessage>;
  const owner = { actorId: 'owner', clientId: 'retry-window' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); events = [];
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } });
    router = new ApplicationRouter(app); app.subscribe(event => { if (event.type === 'ui.message') events.push(event); });
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });
  const received = async () => (await Promise.all(events.map(async event => await router.mayReceive(owner, event) ? event.message : null))).filter(Boolean) as any[];

  test('重试后历史只保存成功的回复，界面先清空旧思考并收到重试状态', async () => {
    // 模拟适配器：第一次只推送思考就判空并请求重试，第二次正常输出。
    generate = async input => {
      input.onDelta?.([{ text: '第一次的思考', thought: true }]);
      input.onRetry?.({ attempt: 1, maxAttempts: 3, error: '模型返回了空内容', nextRetryIn: 0 });
      input.onDelta?.([{ text: '第二次的思考', thought: true }]);
      input.onDelta?.([{ text: '最终正文' }]);
      return { role: 'model', parts: [{ text: '第二次的思考', thought: true }, { text: '最终正文' }] };
    };
    const conversation = await app.createConversation('owner', '重试');
    const result = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'retry-stream', configId: 'fixture', message: '开始' }, await app.product.draft()) as { runId: string };
    expect((await app.runtime.wait(result.runId))?.status).toBe('completed');
    const models = (await app.storage.readFullHistory(conversation.id)).messages.filter(message => message.role === 'model');
    expect(models).toHaveLength(1);
    expect(JSON.stringify(models[0].parts)).not.toContain('第一次的思考');
    const messages = await received();
    const status = messages.filter(message => message.type === 'retryStatus').map(message => message.data);
    expect(status).toEqual([expect.objectContaining({ type: 'retrying', attempt: 1, maxAttempts: 3, conversationId: conversation.id }),
      expect.objectContaining({ type: 'retrySuccess', conversationId: conversation.id })]);
    const chunks = messages.filter(message => message.type === 'streamChunk').map(message => message.data);
    const reset = chunks.findIndex(chunk => chunk.chunk?.contentSnapshot && !chunk.chunk.contentSnapshot.parts.length);
    expect(reset).toBeGreaterThan(chunks.findIndex(chunk => JSON.stringify(chunk.chunk?.delta ?? []).includes('第一次的思考')));
    expect(chunks.slice(reset).some(chunk => JSON.stringify(chunk.chunk?.delta ?? []).includes('第一次的思考'))).toBe(false);
  });

  test('重试后仍然失败时界面收到重试失败，中断保存的部分回复不包含已丢弃的思考', async () => {
    generate = async input => {
      input.onDelta?.([{ text: '被丢弃的思考', thought: true }]);
      input.onRetry?.({ attempt: 1, maxAttempts: 1, error: '模型返回了空内容', nextRetryIn: 0 });
      throw Object.assign(new Error('模型返回了空内容'), { type: 'EMPTY_RESPONSE_ERROR' });
    };
    const conversation = await app.createConversation('owner', '重试失败');
    const result = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'retry-failed', configId: 'fixture', message: '开始' }, await app.product.draft()) as { runId: string };
    expect((await app.runtime.wait(result.runId))?.status).toBe('failed');
    const history = (await app.storage.readFullHistory(conversation.id)).messages;
    expect(JSON.stringify(history)).not.toContain('被丢弃的思考');
    const status = (await received()).filter(message => message.type === 'retryStatus').map(message => message.data.type);
    expect(status).toEqual(['retrying', 'retryFailed']);
  });
});
