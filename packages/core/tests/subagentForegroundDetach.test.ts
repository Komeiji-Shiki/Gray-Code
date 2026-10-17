import type { PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

const answer = (text: string): PlatformMessage => ({ role: 'model', parts: [{ text }] });
const waitUntil = async (check: () => boolean) => {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('子代理未进入前台运行状态。');
};

test('用户发送新消息时前台子代理转入后台，工具结果说明去向', async () => {
  const f = await fixture(); await f.store.close();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let childEntered = false; let rootId = '', rootCalls = 0;
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
    if (input.conversationId !== rootId) { childEntered = true; await gate; return answer('子任务完成'); }
    return rootCalls++ ? answer('主模型处理完成') : { role: 'model', parts: [{ functionCall: { id: 'worker-call', name: 'subagents',
      args: { agentName: 'General Worker', prompt: '长任务' } } }] };
  } } });
  try {
    const preferences = await app.product.draft();
    const providerId = await preferences.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000, url: 'http://127.0.0.1:9/v1',
      name: '前台转后台模型', model: 'fixture', apiKey: '' });
    await app.product.save(preferences);
    const snapshot = app.settings.snapshot();
    const agent = { ...snapshot.settings.agents[0], id: 'foreground-detach-fixture', providerId, name: '前台转后台测试',
      toolNames: ['subagents'], maxIterations: 4 };
    snapshot.settings.agents.push(agent); await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const root = await app.createConversation('owner', '前台子代理转后台'); rootId = root.id;
    const run = await app.runtime.start({ actorId: 'owner', agentId: agent.id, conversationId: root.id, requestKey: 'foreground-detach',
      message: { role: 'user', parts: [{ text: '开始长任务' }] } });
    await waitUntil(() => childEntered);

    const detached = await app.subagents.detachForeground('owner', root.id);
    expect(detached.success).toBe(true);
    expect(detached.detached).toHaveLength(1);

    // 主模型立即拿回控制权，工具结果明确说明子代理去了后台且未被取消。
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    const response = (await app.storage.readFullHistory(root.id)).messages.flatMap(message => message.parts)
      .flatMap(part => part.functionResponse ? [part.functionResponse as { id: string; response: Record<string, unknown> }] : [])
      .find(item => item.id === 'worker-call');
    expect(response?.response).toMatchObject({ success: true, data: { background: true, detached: true } });
    expect(String((response?.response.data as { message?: string })?.message)).toContain('转入后台');
    expect(app.subagents.backgroundTasks().some(task => task.type === 'background_subagent')).toBe(true);

    // 子代理没有被终止：释放闸门后照常完成，结果以后台回执回到主对话。
    release();
    await waitUntil(() => app.subagents.backgroundTasks().length === 0);
    let report = '';
    for (let i = 0; i < 500 && !report; i++) {
      const { messages } = await app.storage.readFullHistory(root.id);
      report = messages.flatMap(message => message.parts)
        .map(part => typeof part.text === 'string' ? part.text : '').find(text => text.includes('[Background task completed]')) ?? '';
      if (!report) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(report).toContain('子任务完成');
  } finally { release(); await app.close(); await f.cleanup(); }
});
