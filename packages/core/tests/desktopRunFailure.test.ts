import type { ModelInput } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

// 回归场景：失败状态提示原本对所有对话无条件注入，桌面/Web 普通对话会因此拿到
// “[GrayCode 运行状态] 上一轮任务执行失败…”。它只应面向 Bot 频道对话。
test('桌面普通对话不注入上一轮失败状态', async () => {
  const f = await fixture(); await f.store.close();
  const seen: ModelInput[] = [];
  let fail = true;
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
    seen.push(input);
    if (fail) throw new Error('HTTP 503: upstream busy');
    return { role: 'model', parts: [{ text: 'ok' }] };
  } } });
  try {
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ type: 'openai', name: '失败夹具', enabled: true,
      url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', timeout: 1000 });
    await app.product.save(draft);
    await app.storage.createConversation({ id: 'desktop-failure', actorId: 'owner', title: '普通对话', createdAt: Date.now(), updatedAt: Date.now() });
    const start = (key: string) => app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: 'desktop-failure', providerId,
      requestKey: key, message: { id: key, role: 'user', parts: [{ text: '继续任务' }] } });
    const first = await start('first');
    expect((await app.runtime.wait(first.id))?.status).toBe('failed');
    fail = false;
    const second = await start('second');
    expect((await app.runtime.wait(second.id))?.status).toBe('completed');
    const contextText = (seen[1].promptContext?.afterHistoryMessages ?? [])
      .flatMap(message => message.parts.map(part => part.text ?? '')).join('\n');
    expect(contextText).not.toContain('GrayCode 运行状态');
  } finally { await app.close(); await f.cleanup(); }
});
