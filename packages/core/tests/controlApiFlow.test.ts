import type { AgentDefinition, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { startControlServer } from '../../../apps/server/src/control/server';
import { fixture } from './fixtures';

const token = 'c'.repeat(64);
const authorization = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const json = (response: Response): Promise<any> => response.json();
const text = (value: string): PlatformMessage => ({ role: 'model', parts: [{ text: value }] });

/** 真实应用、真实运行时与存储，只把模型换成按脚本回复的合成实现。 */
describe('外部控制接口驱动真实任务', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let server: Awaited<ReturnType<typeof startControlServer>>;
  let agent: AgentDefinition;
  let script: PlatformMessage[];
  let executions: number;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { ...authorization, ...init.headers } });
  const post = (path: string, value: unknown, headers: Record<string, string> = {}) =>
    api(path, { method: 'POST', body: JSON.stringify(value), headers });
  const conversation = async (title: string) => (await json(await post('/v1/conversations', { title }))).id as string;

  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    executions = 0; script = [];
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async () => script.shift() ?? text('多余的模型调用') } });
    // 真实的敏感 effect 触发审批，执行体只计数，不碰磁盘。
    app.tools.register({ declaration: { name: 'control_fixture', description: 'control api approval fixture', parameters: { type: 'object', properties: {} } },
      effects: () => ['data_delete'], execute: async () => { executions++; return { success: true }; } });
    const preferences = await app.product.draft();
    const providerId = await preferences.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000,
      url: 'http://127.0.0.1:9/v1', name: '控制接口模型', model: 'fixture', apiKey: '' });
    await app.product.save(preferences);
    const snapshot = app.settings.snapshot();
    agent = { ...snapshot.settings.agents[0], id: 'control-flow', providerId, name: '控制接口测试',
      toolNames: ['control_fixture', 'ask_user'], approvalMode: 'sensitive', maxIterations: 8 };
    snapshot.settings.agents.push(agent);
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    server = await startControlServer(app, { port: 0, token, allowLan: false });
  });
  afterEach(async () => { await server.close(); await app.close(); await f.cleanup(); });

  test('等待超时时列出待审批项，代理批准后拿到最终回复，重复批准返回 404', async () => {
    script = [{ role: 'model', parts: [{ functionCall: { id: 'delete-call', name: 'control_fixture', args: { target: 'old.log' } } }] },
      text('清理完成。')];
    const id = await conversation('审批');
    const started = await post(`/v1/conversations/${id}/messages`, { text: '清理日志', agentId: agent.id, wait: 1 });
    expect(started.status).toBe(202);
    const waiting = await json(started);
    expect(waiting).toMatchObject({ done: false, run: { status: 'awaiting_approval' } });
    const [approval] = waiting.pending.approvals;
    expect(approval).toMatchObject({ toolName: 'control_fixture', input: { text: '{"target":"old.log"}' }, effects: ['data_delete'] });
    expect(executions).toBe(0);

    const path = `/v1/runs/${waiting.run.id}/approvals/${approval.id}`;
    expect((await post(path, {})).status).toBe(400);
    expect((await post(path, { accepted: true })).status).toBe(200);
    expect(await json(await api(`/v1/runs/${waiting.run.id}?wait=10`)))
      .toMatchObject({ done: true, reply: '清理完成。', run: { status: 'completed' } });
    expect(executions).toBe(1);
    expect((await post(path, { accepted: true })).status).toBe(404);
  });

  test('同一个幂等键重发返回同一任务，历史只有一轮且以紧凑形态返回', async () => {
    script = [text('你好，**已收到**。')];
    const id = await conversation('幂等');
    const send = () => post(`/v1/conversations/${id}/messages`, { text: '打个招呼', agentId: agent.id, wait: true }, { 'Idempotency-Key': 'greet-1' });
    const first = await send();
    expect(first.status).toBe(200);
    const result = await json(first);
    expect(result).toMatchObject({ done: true, reply: '你好，**已收到**。' });
    const again = await json(await send());
    expect(again.run.id).toBe(result.run.id);
    const history = await json(await api(`/v1/conversations/${id}/messages`));
    expect(history.messages.map((message: any) => [message.role, message.text])).toEqual([['user', '打个招呼'], ['assistant', '你好，**已收到**。']]);
    expect(history.messages.every((message: any) => message.runId === result.run.id)).toBe(true);
  });

  test('模型提问时列出问题，代理回答后任务继续完成', async () => {
    script = [
      { role: 'model', parts: [{ functionCall: { id: 'question', name: 'ask_user', args: { questions: [{ title: '选择颜色', options: ['蓝色', '红色'] }] } } }] },
      text('先处理别的部分。'),
      text('选了蓝色。'),
    ];
    const id = await conversation('提问');
    const waiting = await json(await post(`/v1/conversations/${id}/messages`, { text: '开始', agentId: agent.id, wait: 1 }));
    expect(waiting.run.status).toBe('awaiting_input');
    const [question] = waiting.pending.questions;
    expect(question.questions).toEqual([{ title: '选择颜色', options: ['蓝色', '红色'] }]);
    const path = `/v1/runs/${waiting.run.id}/questions/${question.id}`;
    expect((await post(path, { answers: [] })).status).toBe(400);
    expect((await post(path, { answers: ['蓝色'] })).status).toBe(200);
    expect(await json(await api(`/v1/runs/${waiting.run.id}?wait=10`))).toMatchObject({ done: true, reply: '选了蓝色。' });
  });
});
