import type { PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

const answer = (text: string): PlatformMessage => ({ role: 'model', parts: [{ text }] });
const waitUntil = async (check: () => boolean) => {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('子代理未到达预期的并发状态。');
};

test('同一回复中的前台子代理一起派发，并按最大并发数排队', async () => {
  const f = await fixture(); await f.store.close();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Set<string>(); let rootId = '', rootCalls = 0;
  const callIds = ['worker-1', 'worker-2', 'worker-3'];
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
    if (input.conversationId !== rootId) {
      entered.add(input.conversationId); await gate; return answer('子任务完成');
    }
    if (rootCalls++) return answer('汇总完成');
    return { role: 'model', parts: callIds.map(id => ({ functionCall: { id, name: 'subagents', args: { agentName: 'General Worker', prompt: id } } })) };
  } } });
  try {
    const preferences = await app.product.draft();
    const providerId = await preferences.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000, url: 'http://127.0.0.1:9/v1',
      name: '并发隔离模型', model: 'fixture', apiKey: '' });
    await preferences.settings.updateSubAgentsConfig({ maxConcurrentAgents: 2 }); await app.product.save(preferences);
    const snapshot = app.settings.snapshot();
    const agent = { ...snapshot.settings.agents[0], id: 'concurrency-fixture', providerId, name: '并发测试', toolNames: ['subagents'], maxIterations: 4 };
    snapshot.settings.agents.push(agent); await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const root = await app.createConversation('owner', '并发子代理'); rootId = root.id;
    const run = await app.runtime.start({ actorId: 'owner', agentId: agent.id, conversationId: root.id, requestKey: 'concurrent-subagents',
      message: { role: 'user', parts: [{ text: '同时派发三个子代理' }] } });
    // 并发上限为 2：前两个同时进入模型，第三个在队列中等待空位。
    await waitUntil(() => entered.size === 2);
    await new Promise(resolve => setTimeout(resolve, 100)); expect(entered.size).toBe(2);
    release();
    expect((await app.runtime.wait(run.id))?.status).toBe('completed'); expect(entered.size).toBe(3);
    const responses = (await app.storage.readFullHistory(root.id)).messages.flatMap(message => message.parts)
      .flatMap(part => part.functionResponse ? [part.functionResponse as { id: string; response: { success: boolean } }] : []);
    expect(responses.map(response => response.id)).toEqual(callIds);
    expect(responses.every(response => response.response.success)).toBe(true);
  } finally { release(); await app.close(); await f.cleanup(); }
});
