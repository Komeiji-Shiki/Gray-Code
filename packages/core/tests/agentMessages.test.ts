import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AgentDefinition, ModelInput, PlatformMessage, RunRecord } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { configuredAgent } from '../../../apps/server/src/settings/agent';
import { subagentSettingsHandlers } from '../../../apps/server/src/subagents/settingsUi';
import { fixture } from './fixtures';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const answer = (text: string): PlatformMessage => ({ role: 'model', parts: [{ text }] });
const invoke = (id: string, name: string, args: Record<string, unknown>): PlatformMessage => ({ role: 'model', parts: [{ functionCall: { id, name, args } }] });
const textOf = (input: ModelInput) => input.messages.flatMap(message => message.parts.map(part => part.text ?? '')).join('\n');
const waitUntil = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('等待隔离任务状态超时。');
};

describe('独立代理消息的持久化与调度', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let agent: AgentDefinition;
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  const gates: Array<ReturnType<typeof deferred>> = [];
  const hold = () => { const gate = deferred(); gates.push(gate); return gate; };
  const context = (run: RunRecord, toolCallId: string): ToolContext => ({ runId: run.id, conversationId: run.conversationId,
    actorId: run.actorId, iteration: run.iteration, toolCallId, agent, modelSelection: { providerId: agent.providerId },
    signal: new AbortController().signal, askUser: async () => { throw new Error('unused'); }, progress: () => {} });
  const start = (conversationId: string, text = 'start', workspaceId?: string) => app.runtime.start({ conversationId,
    actorId: 'owner', agentId: agent.id, requestKey: `request-${Date.now()}-${Math.random()}`, workspaceId, message: { role: 'user', parts: [{ text }] } });
  const idle = () => waitUntil(async () => app.subagents.activeIds().length === 0 && !app.subagents.hasPendingWork()
    && (await app.storage.listRuns({ activeOnly: true })).length === 0);

  beforeEach(async () => {
    f = await fixture(); await f.store.close(); generate = async () => answer('done');
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } });
    app.tools.register({ declaration: { name: 'fixture_scope', description: 'fixture', parameters: { type: 'object', properties: {} } },
      effects: () => ['workspace_read'], execute: async (_args, ctx) => ({ success: true, data: {
        directory: ctx.workspace?.directory, content: ctx.workspace ? await readFile(path.join(ctx.workspace.directory, 'marker.txt'), 'utf8') : 'none' } }) });
    const preferences = await app.product.draft();
    const providerId = await preferences.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000, url: 'http://127.0.0.1:9/v1', name: '隔离模型', model: 'fixture', apiKey: '' });
    await app.product.save(preferences);
    const snapshot = app.settings.snapshot();
    agent = { ...snapshot.settings.agents[0], id: 'message-fixture', providerId, name: '消息测试', toolNames: ['subagents', 'agent_send_message', 'fixture_scope'], maxIterations: 16 };
    snapshot.settings.agents.push(agent); await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const draft = await app.product.draft(); await draft.settings.updateSubAgentsConfig({ maxConcurrentAgents: 1 }); await app.product.save(draft);
  });
  afterEach(async () => { for (const gate of gates.splice(0)) gate.resolve(); await app.close(); jest.restoreAllMocks(); await f.cleanup(); });

  test('默认 Agent 自动包含新增内置工具，自定义范围与显式禁用保持有效', async () => {
    const original = app.settings.snapshot().settings.agents[0];
    expect(configuredAgent(app, original).toolNames).toContain('agent_send_message');
    expect(configuredAgent(app, original).toolNames).toContain('fixture_scope');
    expect(configuredAgent(app, { ...agent, toolNames: ['subagents'] }).toolNames).toEqual(['subagents']);
    const draft = await app.product.draft(); await draft.settings.setToolEnabled('agent_send_message', false); await app.product.save(draft);
    expect(configuredAgent(app, original).toolNames).not.toContain('agent_send_message');
    expect(configuredAgent(app, agent).toolNames).not.toContain('agent_send_message');
  });

  test('通用 Worker 使用可保存的默认时长，并允许单次派发和接续覆盖', async () => {
    const root = await app.createConversation('owner', '时长配置');
    const parent = await start(root.id);
    await app.runtime.wait(parent.id);
    const dispatch = async (args: Record<string, unknown> = {}) => {
      const result = await app.subagents.dispatch({ agentName: 'General Worker', prompt: '完成隔离任务', ...args }, context(parent, 'runtime-override'));
      expect(result.success).toBe(true);
      return (await app.subagents.get('owner', String((result.data as any).runId)))!;
    };
    const initial = await dispatch();
    expect(initial.maxRuntime).toBe(2400);
    const draft = await app.product.draft();
    const handlers = subagentSettingsHandlers(draft, app);
    await handlers['subagents.updateGlobalConfig']({ generalWorkerMaxRuntimeSeconds: 7200 });
    await app.product.save(draft);
    expect((await app.subagents.get('owner', initial.id))!.maxRuntime).toBe(2400);
    expect((await dispatch()).maxRuntime).toBe(7200);
    const overridden = await dispatch({ maxRuntime: 3600 });
    expect(overridden.maxRuntime).toBe(3600);
    expect(app.product.runtimeSettings().getSubAgentsConfig().generalWorkerMaxRuntimeSeconds).toBe(7200);
    expect((await dispatch({ continueFromRunId: overridden.id, maxRuntime: -1 })).maxRuntime).toBe(-1);
    expect((await dispatch({ continueFromRunId: overridden.id })).maxRuntime).toBe(7200);
    await expect(app.subagents.dispatch({ agentName: 'General Worker', prompt: '不能启动', maxRuntime: 0 }, context(parent, 'invalid-runtime'))).rejects.toThrow('正整数');
  });

  test('监视器实际暂停后不消耗运行时长，恢复仍可完成原任务', async () => {
    const root = await app.createConversation('owner', '暂停时长');
    const parent = await start(root.id); await app.runtime.wait(parent.id);
    const modelGate = hold(); const modelReady = deferred(); let calls = 0;
    generate = async input => {
      if (input.conversationId === root.id) return answer('收到结果');
      if (++calls === 1) { modelReady.resolve(); await modelGate.promise; return invoke('after-pause', 'fixture_scope', {}); }
      return answer('暂停后完成');
    };
    const result = await app.subagents.dispatch({ agentName: 'General Worker', prompt: '暂停验收', background: true, maxRuntime: 2 }, context(parent, 'pause-runtime'));
    const id = String((result.data as any).runId);
    await modelReady.promise;
    await app.subagents.control('owner', id, 'pause'); modelGate.resolve();
    await waitUntil(async () => (await app.subagents.get('owner', id))?.status === 'paused');
    await new Promise(resolve => setTimeout(resolve, 2_100));
    expect((await app.subagents.get('owner', id))?.status).toBe('paused');
    await app.subagents.control('owner', id, 'resume'); await idle();
    expect((await app.subagents.get('owner', id))?.status).toBe('completed');
    expect(calls).toBe(2);
  });

  test('嵌套前台子代理发信解除主任务等待，单并发可继续且工具配对完整', async () => {
    const root = await app.createConversation('owner', '嵌套协作'); const gate = hold(); const replied = deferred();
    const childCalls = new Map<string, number>(); let rootCalls = 0; let recipientId = '';
    generate = async input => {
      if (input.conversationId === root.id) {
        rootCalls++;
        if (rootCalls === 1) return invoke('dispatch-parent', 'subagents', { agentName: 'General Worker', prompt: 'parent' });
        // 模型只读取协议正文，界面卡片元数据由请求格式化器正常移除。
        const note = input.messages.flatMap(message => message.parts).find(part => typeof part.text === 'string'
          && part.text.includes('[Agent message received]') && part.text.includes('需要主模型处理'))?.text as string | undefined;
        const address = note?.match(/From: .* \(([^)]+)\)\nThread ID: ([^\n]+)/);
        if (rootCalls === 2) {
          if (!address) throw new Error(`代理回信未到达：${JSON.stringify(input.messages.flatMap(message => message.parts).filter(part => part.functionResponse))}`);
          recipientId = address[1];
          expect(input.messages.some(message => message.parts.some(part => (part.functionResponse as { id?: string } | undefined)?.id === 'dispatch-parent'))).toBe(true);
          return invoke('reply-child', 'agent_send_message', { targetRunId: recipientId, threadId: address![2], message: '主模型答复' });
        }
        replied.resolve(); return answer('主任务已处理');
      }
      const count = (childCalls.get(input.conversationId) ?? 0) + 1; childCalls.set(input.conversationId, count);
      const initial = input.messages.find(message => message.isUserInput)?.parts.map(part => part.text ?? '').join('') ?? '';
      if (initial.includes('## Task\nparent')) return count === 1
        ? invoke('dispatch-child', 'subagents', { agentName: 'General Worker', prompt: 'child' }) : answer('父子代理完成');
      if (count === 1) return invoke('notify-main', 'agent_send_message', { targetAgentName: 'main', message: '需要主模型处理' });
      if (count === 2) { await gate.promise; return answer('正在完成'); }
      expect(textOf(input)).toContain('主模型答复'); return answer('已收到主模型答复');
    };
    const run = await start(root.id);
    await Promise.race([replied.promise, app.runtime.wait(run.id).then(done => { if (done?.status !== 'completed') throw new Error(done?.error); })]);
    expect((await app.subagents.get('owner', recipientId))?.background).toBe(true);
    expect(app.subagents.activeIds()).toContain(recipientId);
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    gate.resolve(); await idle();
    const child = (await app.subagents.get('owner', recipientId))!;
    expect(child.status).toBe('completed'); expect(childCalls.get(child.conversationId)).toBe(3);
    const history = (await app.storage.readFullHistory(root.id)).messages;
    expect(history.filter(message => (message.agentMessage as { text?: string } | undefined)?.text === '主模型答复')).toHaveLength(1);
    expect(history.find(message => (message.agentMessage as { text?: string } | undefined)?.text === '主模型答复')?.parts).toEqual([]);
    const invocation = history.find(message => message.parts.some(part => (part.functionResponse as { id?: string } | undefined)?.id === 'dispatch-parent'))!;
    expect(invocation.parts[0]).toMatchObject({ functionResponse: { response: { success: true, data: { background: true, detached: true } } } });
  });

  test('收件方刚结束模型调用时仍接受消息，并由原调度器继续一次', async () => {
    const root = await app.createConversation('owner', '完成边界'); const rootGate = hold(); const boundaryGate = hold();
    const boundary = deferred(); const rootReady = deferred(); const childInputs: ModelInput[] = [];
    generate = async input => {
      if (input.conversationId === root.id) { rootReady.resolve(); await rootGate.promise; return answer('主任务'); }
      childInputs.push(input); return answer(childInputs.length === 1 ? '初次完成' : '处理边界消息');
    };
    const run = await start(root.id); await rootReady.promise;
    const originalFlush = app.subagents.feedback.flush.bind(app.subagents.feedback); let childBoundaries = 0;
    jest.spyOn(app.subagents.feedback, 'flush').mockImplementation(async (id, active) => {
      const result = await originalFlush(id, active);
      if (active && id !== root.id && ++childBoundaries === 2) { boundary.resolve(); await boundaryGate.promise; }
      return result;
    });
    const dispatched = await app.subagents.dispatch({ agentName: 'General Worker', prompt: 'boundary', background: true }, context(run, 'dispatch'));
    const childId = (dispatched.data as { runId: string }).runId; await boundary.promise;
    const sent = await app.subagents.messages.send({ targetRunId: childId, message: '最后边界收到' }, context(run, 'late-send'));
    expect(sent.success).toBe(true); boundaryGate.resolve();
    await waitUntil(() => !app.subagents.activeIds().includes(childId));
    expect(childInputs).toHaveLength(2); expect(textOf(childInputs[1])).toContain('最后边界收到');
    const child = (await app.subagents.get('owner', childId))!;
    expect(child.coreRunIds).toHaveLength(2); expect(await app.storage.listRecords('background-followups', child.conversationId)).toEqual([]);
    expect((await app.subagents.messages.send({ targetRunId: childId, message: '迟到消息' }, context(run, 'too-late'))).success).toBe(false);
    rootGate.resolve(); await idle();
  });

  test('同名寻址、回执去重、容量与循环限制持久化，隔离其他对话和账号', async () => {
    const root = await app.createConversation('owner', '消息规则'); const rootGate = hold(); const childGate = hold(); const rootReady = deferred();
    generate = async input => { if (input.conversationId === root.id) { rootReady.resolve(); await rootGate.promise; } else await childGate.promise; return answer('done'); };
    const run = await start(root.id); await rootReady.promise;
    const first = await app.subagents.dispatch({ agentName: 'General Worker', prompt: 'first', background: true }, context(run, 'first'));
    const second = await app.subagents.dispatch({ agentName: 'General Worker', prompt: 'second', background: true }, context(run, 'second'));
    const firstId = (first.data as { runId: string }).runId; const secondId = (second.data as { runId: string }).runId;
    const secondChild = (await app.subagents.get('owner', secondId))!;
    const args = { targetAgentName: 'General Worker', message: '给最后启动者', threadId: 'one-thread' };
    const sendContext = context(run, 'same-call');
    const sent = await app.subagents.messages.send(args, sendContext);
    expect(sent).toMatchObject({ success: true, data: { toRunId: secondId, hopDepth: 1 } });
    expect(await app.subagents.messages.send(args, sendContext)).toEqual(sent);
    await expect(app.subagents.messages.send({ ...args, message: '改写' }, sendContext)).rejects.toThrow('改写');
    for (let hop = 2; hop <= 5; hop++) expect(await app.subagents.messages.send(args, context(run, `hop-${hop}`))).toMatchObject({ success: true, data: { hopDepth: hop } });
    for (let hop = 6; hop <= 7; hop++) expect(await app.subagents.messages.send(args, context(run, `hop-${hop}`))).toMatchObject({ success: false, error: expect.stringContaining('maximum hop depth') });
    const filler = Array.from({ length: 45 }, (_, index) => ({ id: `agentmsg-fixture-${index}`, conversationId: secondChild.conversationId, actorId: 'owner',
      message: { id: `agentmsg-fixture-${index}`, role: 'user' as const, parts: [{ text: `fixture-${index}` }], isUserInput: false } }));
    await app.subagents.feedback.enqueueMessages(filler);
    expect(await app.subagents.messages.send({ targetRunId: secondId, message: '满时不增加深度', threadId: 'capacity' }, context(run, 'full')))
      .toMatchObject({ success: false, error: expect.stringContaining('inbox is full') });
    expect(await app.storage.getRecord('agent-message-threads', root.id)).not.toContainEqual(['capacity', 1]);
    expect(await app.subagents.messages.send({ targetRunId: firstId, message: 'x'.repeat(16001) }, context(run, 'too-long')))
      .toMatchObject({ success: false, error: expect.stringContaining('16000') });
    const other = await app.createConversation('owner', '另一个对话');
    const otherRun = await start(other.id); // 模型在 childGate 上等待，保持为真实活动任务。
    expect((await app.subagents.messages.send({ targetRunId: secondId, message: '跨对话' }, context(otherRun, 'cross-family'))).success).toBe(false);
    await expect(app.subagents.messages.send(args, { ...sendContext, actorId: 'someone-else' })).rejects.toThrow('经过认证');
    await app.subagents.control('owner', firstId, 'exit'); await app.subagents.control('owner', secondId, 'exit');
    rootGate.resolve(); childGate.resolve(); await idle();
    expect((await app.subagents.get('owner', secondId))?.status).toBe('cancelled');
    expect(await app.subagents.feedback.pendingIds(secondChild.conversationId)).toHaveLength(50);
    const models = jest.fn(async () => answer('不应自动执行'));
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: models } });
    expect(models).not.toHaveBeenCalled(); expect(await app.subagents.feedback.pendingIds(secondChild.conversationId)).toHaveLength(50);
    expect(await app.storage.getRecord('agent-message-threads', root.id)).toContainEqual(['one-thread', 7]);
    expect(await app.subagents.messages.send(args, sendContext)).toEqual(sent); expect(models).not.toHaveBeenCalled();
  });

  test('排队子代理与后台自动继续都保持原工作区，新的运行仍检查当前授权', async () => {
    const original = path.join(f.root, 'original'); const replacement = path.join(f.root, 'replacement');
    await Promise.all([mkdir(original), mkdir(replacement)]);
    await Promise.all([writeFile(path.join(original, 'marker.txt'), 'original'), writeFile(path.join(replacement, 'marker.txt'), 'replacement')]);
    let snapshot = app.settings.snapshot(); snapshot.settings.workspaces.push({ id: 'project', name: 'fixture', directory: original, deviceId: 'local' });
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const root = await app.createConversation('owner', '排队目录', 'project'); const gate = hold(); const queued = deferred();
    let rootCalls = 0; const childCounts = new Map<string, number>(); const inputs: ModelInput[] = [];
    generate = async input => {
      inputs.push(input);
      if (input.conversationId === root.id) {
        if (++rootCalls === 1) return { role: 'model', parts: [
          { functionCall: { id: 'first-queued', name: 'subagents', args: { agentName: 'General Worker', prompt: 'held', background: true } } },
          { functionCall: { id: 'second-queued', name: 'subagents', args: { agentName: 'General Worker', prompt: 'queued', background: true } } },
        ] };
        queued.resolve(); return answer('parent finished');
      }
      const count = (childCounts.get(input.conversationId) ?? 0) + 1; childCounts.set(input.conversationId, count);
      if (textOf(input).includes('## Task\nheld') && count === 1) await gate.promise;
      return count === 1 ? invoke('read-original', 'fixture_scope', {}) : answer('child finished');
    };
    const run = await start(root.id, 'queue', 'project'); await queued.promise; await app.runtime.wait(run.id);
    expect(app.subagents.activeIds()).toHaveLength(2);
    snapshot = app.settings.snapshot(); snapshot.settings.workspaces[0].directory = replacement;
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    gate.resolve(); await idle();
    const children = await app.subagents.manifests('owner', root.id);
    for (const manifest of children) {
      const record = (await app.subagents.get('owner', manifest.runId))!;
      const history = (await app.storage.readFullHistory(record.conversationId)).messages;
      expect(history.flatMap(message => message.parts).find(part => part.functionResponse)).toMatchObject({ functionResponse: { response: { success: true, data: { directory: original, content: 'original' } } } });
    }
    expect(rootCalls).toBeGreaterThan(2);
    expect(inputs.every(input => input.taskContext?.workspace?.directory === original)).toBe(true);
    expect(await app.storage.getRecord('run-configurations', run.id)).toMatchObject({ workspace: { directory: original } });
    snapshot = app.settings.snapshot(); snapshot.settings.accounts.push({ id: 'revoked-member', displayName: '撤销测试', role: 'member', effects: [], workspaceIds: [], revoked: true });
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    await expect(app.runtime.start({ actorId: 'revoked-member', agentId: agent.id, requestKey: 'revoked', conversationId: root.id, workspaceId: 'project',
      message: { role: 'user', parts: [{ text: 'no' }] } }, undefined, { workspace: { id: 'project', name: 'old', directory: original, deviceId: 'local' } })).rejects.toThrow('unavailable');
  });
});
