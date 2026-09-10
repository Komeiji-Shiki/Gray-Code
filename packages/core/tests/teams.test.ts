import type { AgentDefinition, ModelInput, PlatformMessage, RunRecord, TeamTask, TeamWaitResult, ToolOutcome } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { teamTools } from '../../../apps/server/src/teams/tools';
import { configuredAgent } from '../../../apps/server/src/settings/agent';
import { fixture } from './fixtures';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const answer = (text: string): PlatformMessage => ({ role: 'model', parts: [{ text }] });
const invoke = (id: string, name: string, args: Record<string, unknown>): PlatformMessage => ({ role: 'model', parts: [{ functionCall: { id, name, args } }] });
const waitUntil = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('隔离团队任务未到达预期状态。');
};

describe('共享任务、事件等待与消息顺序', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, agent: AgentDefinition;
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  const modelEntered = new Set<string>();
  const gates: Array<ReturnType<typeof deferred>> = [];
  const hold = () => { const gate = deferred(); gates.push(gate); return gate; };
  const context = (run: RunRecord, toolCallId = 'test'): ToolContext => ({ runId: run.id, conversationId: run.conversationId,
    actorId: run.actorId, iteration: run.iteration, toolCallId, agent, modelSelection: { providerId: agent.providerId },
    signal: new AbortController().signal, askUser: async () => { throw new Error('unused'); }, progress: () => {} });
  const tasks = async (ctx: ToolContext, args: Record<string, unknown>) => teamTools(app)[0].execute(args, ctx) as Promise<ToolOutcome & {
    task: TeamTask | null; sequence: number; tasks: TeamTask[]; readyTaskIds: string[]; hasMore: boolean; nextAfterCreatedSequence?: number;
  }>;
  const wait = async (ctx: ToolContext, afterSequence: number, timeoutMs = 1000) => teamTools(app)[1].execute({ afterSequence, timeoutMs }, ctx) as Promise<ToolOutcome & TeamWaitResult>;
  const start = (conversationId: string) => app.runtime.start({ actorId: 'owner', agentId: agent.id, conversationId,
    requestKey: `start-${Math.random()}`, message: { role: 'user', parts: [{ text: '协作任务' }] } });
  const root = async () => {
    const conversation = await app.createConversation('owner', '团队测试'); const run = await start(conversation.id);
    await waitUntil(async () => (await app.storage.getRun(run.id))?.status === 'running');
    await waitUntil(() => modelEntered.has(conversation.id));
    await app.teams.memberChanged(conversation.id, 'main', `${run.id}:running`, 'running');
    return context(run);
  };
  const spawn = async (parent: ToolContext, prompt: string) => {
    const result = await app.subagents.dispatch({ agentName: 'General Worker', prompt, background: true }, parent);
    const record = (await app.subagents.get('owner', (result.data as { runId: string }).runId))!;
    await waitUntil(() => !!record.coreRunIds.length);
    const run = (await app.storage.getRun(record.coreRunIds.at(-1)!))!;
    await waitUntil(async () => (await app.storage.getRun(run.id))?.status === 'running');
    await app.teams.memberChanged(record.conversationId, record.id, `${record.taskId}:running`, 'running');
    return context(run);
  };
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); const gate = hold(); generate = async () => { await gate.promise; return answer('done'); };
    modelEntered.clear();
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => { modelEntered.add(input.conversationId); return generate(input); } } });
    const preferences = await app.product.draft();
    const providerId = await preferences.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000, url: 'http://127.0.0.1:9/v1', name: '团队隔离模型', model: 'fixture', apiKey: '' });
    await preferences.settings.updateSubAgentsConfig({ maxConcurrentAgents: 2 }); await app.product.save(preferences);
    const snapshot = app.settings.snapshot();
    agent = { ...snapshot.settings.agents[0], id: 'team-fixture', providerId, name: '团队测试', toolNames: ['subagents', 'agent_send_message', 'team_tasks', 'team_wait'], maxIterations: 16 };
    snapshot.settings.agents.push(agent); await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
  });
  afterEach(async () => { for (const gate of gates.splice(0)) gate.resolve(); await app.close(); jest.restoreAllMocks(); await f.cleanup(); });

  test('两个真实成员并发领取只成功一次，依赖、循环、版本与执行所有权均生效', async () => {
    const main = await root(); const peers = await Promise.all([spawn(main, 'worker A'), spawn(main, 'worker B')]);
    const a = (await tasks(main, { action: 'create', title: '读取接口' })).task!;
    const b = (await tasks(main, { action: 'create', title: '修改实现', dependencies: [a.id] })).task!;
    const c = (await tasks(main, { action: 'create', title: '检查结果', dependencies: [b.id] })).task!;
    await expect(tasks(main, { action: 'set_dependencies', taskId: a.id, expectedRevision: a.revision, dependencies: [c.id] })).rejects.toThrow('循环');
    await expect(tasks(main, { action: 'create', title: '未知依赖', dependencies: ['foreign-task'] })).rejects.toThrow('已存在');
    await expect(tasks(peers[0], { action: 'claim', taskId: b.id, expectedRevision: b.revision })).rejects.toThrow('依赖');
    const claims = await Promise.all(Array.from({ length: 32 }, (_, i) => tasks(peers[i % 2], { action: 'claim_ready' })));
    expect(claims.filter(value => value.task)).toHaveLength(1);
    const claimed = claims.find(value => value.task)!.task!;
    expect(claimed.id).toBe(a.id);
    const owner = peers.find(peer => peer.runId === claimed.ownerRunId)!, other = peers.find(peer => peer !== owner)!;
    await expect(tasks(other, { action: 'complete', taskId: a.id, expectedRevision: claimed.revision })).rejects.toThrow('当前执行');
    await expect(tasks(owner, { action: 'complete', taskId: a.id, expectedRevision: a.revision })).rejects.toThrow('版本');
    const completed = await tasks(owner, { action: 'complete', taskId: a.id, expectedRevision: claimed.revision, result: '接口确认完毕' });
    expect(completed.readyTaskIds).toEqual([b.id]);
    const next = (await tasks(other, { action: 'claim_ready' })).task!; expect(next.id).toBe(b.id);
    const released = (await tasks(main, { action: 'release', taskId: b.id, expectedRevision: next.revision })).task!;
    await expect(tasks(other, { action: 'complete', taskId: b.id, expectedRevision: next.revision })).rejects.toThrow('版本');
    expect(released.owner).toBeUndefined(); expect(released.status).toBe('pending');
    const page = await tasks(main, { action: 'list', limit: 2 }); expect(page.tasks).toHaveLength(2); expect(page.hasMore).toBe(true);
    expect((await tasks(main, { action: 'list', afterCreatedSequence: page.nextAfterCreatedSequence })).tasks.map(task => task.id)).toEqual([c.id]);
    const foreign = await root(); await expect(tasks(foreign, { action: 'get', taskId: a.id })).rejects.toThrow('没有这个任务');
    await expect(tasks({ ...owner, conversationId: foreign.conversationId }, { action: 'list' })).rejects.toThrow('身份');
    expect(configuredAgent(app, app.settings.snapshot().settings.agents[0]).toolNames).toEqual(expect.arrayContaining(['team_tasks', 'team_wait']));
    expect(configuredAgent(app, { ...agent, toolNames: ['subagents'] }).toolNames).toEqual(['subagents']);
  });

  test('等待补读已发生事件，注册与提交之间没有丢失，取消会清理订阅且不会定时轮询', async () => {
    const main = await root(); await spawn(main, '继续工作');
    let cursor = (await tasks(main, { action: 'list' })).sequence;
    const pageReads = jest.spyOn(app.storage, 'readRecordPage');
    const pending = wait(main, cursor, 3000);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(pageReads).not.toHaveBeenCalled();
    await app.subagents.feedback.enqueueMessages([{ id: 'wake-z', conversationId: main.conversationId!, actorId: 'owner', displayOnly: true,
      message: { id: 'wake-z', role: 'user', timestamp: 42, parts: [{ text: '唤醒' }] } }]);
    const received = await pending;
    expect(received.reason).toBe('events'); expect(received.events.some(event => event.messageId === 'wake-z')).toBe(true);
    expect(pageReads).toHaveBeenCalledTimes(1);
    const replay = await wait(main, cursor); expect(replay.events).toEqual(received.events);
    cursor = received.sequence;
    const controller = new AbortController(); const cancelled = wait({ ...main, signal: controller.signal }, cursor, 3000);
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort(new Error('测试取消')); await expect(cancelled).rejects.toThrow('测试取消');
    // 同一轮发起等待和提交，覆盖读取游标与注册订阅相邻的边界。
    const raced = wait(main, cursor, 3000);
    await app.subagents.feedback.enqueueMessages([{ id: 'race-a', conversationId: main.conversationId!, actorId: 'owner', displayOnly: true,
      message: { id: 'race-a', role: 'user', timestamp: 42, parts: [{ text: '边界事件' }] } }]);
    expect((await raced).events.some(event => event.messageId === 'race-a')).toBe(true);
    const current = (await tasks(main, { action: 'list' })).sequence;
    expect((await wait(main, current, 0)).reason).toBe('timeout');
  });

  test('没有其他成员或可执行任务时立即报告无法推进；有就绪工作时提示领取', async () => {
    const main = await root(); const cursor = (await tasks(main, { action: 'list' })).sequence;
    const result = await wait(main, cursor, 60000); expect(result.reason).toBe('no_progress'); expect(result.noProgress).toBe(true);
    const created = await tasks(main, { action: 'create', title: '独立工作' });
    const ready = await wait(main, created.sequence, 60000); expect(ready.reason).toBe('ready_work'); expect(ready.readyTaskIds).toEqual([created.task!.id]);
    const claimed = await tasks(main, { action: 'claim_ready' });
    expect((await wait(main, claimed.sequence, 60000)).noProgress).toBe(true);
  });

  test('共享任务和序号跨重启保留，同毫秒消息按接收顺序投递并保持幂等', async () => {
    const main = await root(); const task = (await tasks(main, { action: 'create', title: '重启后继续', description: '保存详细信息' })).task!;
    const claimed = (await tasks(main, { action: 'claim_ready' })).task!;
    const pending = (id: string) => ({ id, conversationId: main.conversationId!, actorId: 'owner', displayOnly: true,
      message: { id, role: 'user', timestamp: 42, parts: [{ text: id }] } });
    await app.subagents.feedback.enqueueMessages([pending('z-first')]);
    await app.subagents.feedback.enqueueMessages([pending('a-second')]);
    const first = await app.storage.getRecord('subagent-feedback', 'z-first') as { sequence: number };
    const second = await app.storage.getRecord('subagent-feedback', 'a-second') as { sequence: number };
    expect(first.sequence).toBeLessThan(second.sequence);
    await app.subagents.feedback.enqueueMessages([pending('z-first')]);
    expect((await app.storage.getRecord('subagent-feedback', 'z-first') as { sequence: number }).sequence).toBe(first.sequence);
    await app.subagents.feedback.flush(main.conversationId!, (await app.storage.getRun(main.runId))!);
    expect((await app.storage.readFullHistory(main.conversationId!)).messages.filter(message => ['z-first', 'a-second'].includes(message.id!)).map(message => message.id)).toEqual(['z-first', 'a-second']);
    for (const gate of gates.splice(0)) gate.resolve(); await app.runtime.wait(main.runId); await app.close();
    const gate = hold(); generate = async () => { await gate.promise; return answer('done'); };
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } });
    const resumed = context(await start(main.conversationId!));
    await waitUntil(async () => (await app.storage.getRun(resumed.runId))?.status === 'running');
    const restored = (await tasks(resumed, { action: 'get', taskId: task.id })).task!;
    expect(restored).toEqual(claimed); expect(restored.description).toBe('保存详细信息');
    await expect(tasks(resumed, { action: 'complete', taskId: task.id, expectedRevision: restored.revision })).rejects.toThrow('当前执行');
    const released = (await tasks(resumed, { action: 'release', taskId: task.id, expectedRevision: restored.revision })).task!;
    const reclaimed = (await tasks(resumed, { action: 'claim', taskId: task.id, expectedRevision: released.revision })).task!;
    expect(reclaimed.ownerRunId).toBe(resumed.runId);
    await tasks(resumed, { action: 'complete', taskId: task.id, expectedRevision: reclaimed.revision });
    await app.subagents.feedback.enqueueMessages([pending('b-third'), pending('z-first')]);
    expect((await app.storage.getRecord('subagent-feedback', 'b-third') as { sequence: number }).sequence).toBeGreaterThan(second.sequence);
    expect(await app.storage.getRecord('subagent-feedback', 'z-first')).toBeNull();
    await app.subagents.feedback.enqueueMessages(Array.from({ length: 54 }, (_, i) => pending(`page-${String(i).padStart(2, '0')}`)));
    const events = await wait(resumed, 0, 0); expect(events.events.some(event => event.type === 'task.created' && event.taskId === task.id)).toBe(true);
    expect(events.events).toHaveLength(50); expect(events.hasMore).toBe(true);
    const nextEvents = await wait(resumed, events.sequence, 0); expect(nextEvents.hasMore).toBe(false);
    const sequences = [...events.events, ...nextEvents.events].map(event => event.sequence);
    expect(sequences).toEqual(Array.from({ length: nextEvents.sequence }, (_, i) => i + 1));
  });

  test('单并发子代理等待时让出席位，排队成员推进任务并唤醒等待成员', async () => {
    const preferences = await app.product.draft(); await preferences.settings.updateSubAgentsConfig({ maxConcurrentAgents: 1 }); await app.product.save(preferences);
    const main = await root(); const waiterEntered = deferred(), workerEntered = deferred();
    const calls = new Map<string, number>(); let waitResult: TeamWaitResult | undefined;
    generate = async input => {
      const n = (calls.get(input.conversationId) ?? 0) + 1; calls.set(input.conversationId, n);
      const text = input.messages.flatMap(message => message.parts.map(part => part.text ?? '')).join('\n');
      if (text.includes('等待成员')) {
        if (n === 1) {
          waiterEntered.resolve(); await workerEntered.promise;
          const run = (await app.storage.listRuns({ conversationId: input.conversationId, activeOnly: true }))[0];
          const cursor = (await tasks(context(run), { action: 'list' })).sequence;
          return invoke('wait-for-peer', 'team_wait', { afterSequence: cursor, timeoutMs: 3000 });
        }
        waitResult = input.messages.flatMap(message => message.parts).map(part => part.functionResponse as { name?: string; response?: TeamWaitResult } | undefined).find(part => part?.name === 'team_wait')?.response;
        return answer('等待成员结束');
      }
      if (n === 1) return invoke('create-work', 'team_tasks', { action: 'create', title: '排队成员已经启动' });
      return answer('排队成员结束');
    };
    const first = await app.subagents.dispatch({ agentName: 'General Worker', prompt: '等待成员', background: true }, main);
    await waiterEntered.promise;
    const second = await app.subagents.dispatch({ agentName: 'General Worker', prompt: '推进成员', background: true }, main);
    workerEntered.resolve();
    const ids = [(first.data as { runId: string }).runId, (second.data as { runId: string }).runId];
    await waitUntil(async () => (await Promise.all(ids.map(id => app.subagents.get('owner', id)))).every(record => record?.status === 'completed'));
    expect(waitResult?.reason).toBe('events'); expect(waitResult?.noProgress).toBe(false);
    expect((await tasks(main, { action: 'list' })).tasks.some(task => task.title === '排队成员已经启动')).toBe(true);
  });
});
