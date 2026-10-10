import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { AutomationRecord, ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { PlatformPromptService } from '../../../apps/server/src/prompt/service';
import { nextScheduledTime, validateSchedule } from '../../../apps/server/src/automations/schedule';
import { fixture } from './fixtures';

describe('持久目标和定时触发', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, providerId: string;
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  let calls: ModelInput[];
  let now: number;
  const answer = (input = 10, output = 5): PlatformMessage => ({ role: 'model', parts: [{ text: '完成当前一轮。' }],
    usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, cachedContentTokenCount: 3 } });
  const complete = (): PlatformMessage => ({ ...answer(), parts: [{ functionCall: { id: 'goal-done', name: 'goal_update', args: { status: 'complete', summary: '目标已经完成，验证通过。' } } }] });
  const open = () => PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root,
    models: { generate: async input => { calls.push(input); return generate(input); } } });
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); calls = []; generate = async () => answer();
    now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
    app = await open();
    const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ name: '自动任务验证', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture-model', apiKey: '',
      enabled: true, contextManagementEnabled: false, timeout: 1000 });
    await draft.settings.savePromptMode({ id: 'automation-test', name: '自动任务预设', template: '完成用户指定的任务。', dynamicTemplate: '', dynamicTemplateEnabled: false });
    await app.product.save(draft);
    await app.createConversation('owner', '自动任务测试', undefined, { platformMode: 'chat' }, undefined, { id: 'auto-chat' });
  });
  afterEach(async () => { await app.close(); jest.restoreAllMocks(); await f.cleanup(); });
  const create = (overrides: Record<string, unknown> = {}) => app.automations.create('owner', { kind: 'goal', name: '长期工作', objective: '完成指定工作并报告验证结果。',
    conversationId: 'auto-chat', agentId: 'default', providerId, promptModeId: 'automation-test', ...overrides });
  async function until(id: string, condition: (record: AutomationRecord) => boolean) {
    for (let i = 0; i < 150; i++) {
      const record = (await app.automations.list('owner')).find(record => record.id === id)!;
      if (record && condition(record)) return record;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('自动任务状态未达到预期');
  }

  test.each(['terminal', 'process', 'subagent'])('空闲任务等待 %s 结束后重新计时，再按间隔重复发送', async activity => {
    let occupied = true;
    jest.spyOn(app.subagents, 'rootConversationId').mockImplementation(id => id === 'nested-child' ? 'auto-chat' : id);
    if (activity === 'terminal') jest.spyOn(app.terminals, 'list').mockImplementation(() => occupied
      ? [{ id: 'background-command', type: 'terminal', startTime: now, metadata: { conversationId: 'nested-child', runId: 'child-run' } }] : []);
    if (activity === 'process') jest.spyOn(app.processes, 'activeConversationIds').mockImplementation(() => new Set(occupied ? ['nested-child'] : []));
    if (activity === 'subagent') jest.spyOn(app.subagents, 'hasActiveConversation').mockImplementation(id => occupied && id === 'auto-chat');
    const task = await create({ kind: 'schedule', schedule: { type: 'idle', everyMinutes: 2 } });
    now += 90_000; await app.automations.tick(now);
    const waiting = (await app.automations.list('owner')).find(record => record.id === task.id)!;
    expect(waiting.idleSince).toBeUndefined(); expect(waiting.nextRunAt).toBeUndefined(); expect(calls).toHaveLength(0);
    occupied = false; now += 30_000; await app.automations.tick(now);
    now += 119_999; await app.automations.tick(now); expect(calls).toHaveLength(0);
    now++; await Promise.all([app.automations.tick(now), app.automations.tick(now)]);
    await until(task.id, record => record.completedRuns === 1 && !record.currentRequestKey);
    now += 120_000; await app.automations.tick(now);
    await until(task.id, record => record.completedRuns === 2 && !record.currentRequestKey);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.filter(message => message.isUserInput)).toHaveLength(2);
  });

  test('普通前台消息重置空闲等待而保留监听，暂停编辑和重启重新等待', async () => {
    const task = await create({ kind: 'schedule', schedule: { type: 'idle', everyMinutes: 2 } });
    let release!: () => void;
    generate = async () => { await new Promise<void>(resolve => { release = resolve; }); return answer(); };
    now += 60_000;
    const run = await app.runtime.start({ requestKey: 'idle-manual', actorId: 'owner', agentId: 'default', conversationId: 'auto-chat', providerId,
      promptModeId: 'automation-test', message: { role: 'user', parts: [{ text: '先处理这件事' }] } });
    await until(task.id, record => record.status === 'active' && record.idleSince === undefined);
    now += 180_000; await app.automations.tick(now); expect(calls).toHaveLength(1);
    release(); await app.runtime.wait(run.id); generate = async () => answer();
    await app.automations.tick(now);
    let saved = (await app.automations.list('owner')).find(record => record.id === task.id)!;
    expect(saved.nextRunAt).toBe(now + 120_000);
    await app.automations.pause('owner', task.id);
    await app.automations.update('owner', task.id, { kind: 'schedule', name: '空闲提醒', objective: '继续处理待办', agentId: 'default', providerId,
      schedule: { type: 'idle', everyMinutes: 3 } });
    await app.automations.resume('owner', task.id);
    now += 60_000; await app.close(); app = await open();
    saved = (await app.automations.list('owner')).find(record => record.id === task.id)!;
    expect(saved.schedule).toEqual({ type: 'idle', everyMinutes: 3 });
    expect(saved.status).toBe('active'); expect(saved.nextRunAt).toBe(now + 180_000);
    now += 179_999; await app.automations.tick(now); expect(calls).toHaveLength(1);
    now++; await app.automations.tick(now);
    await until(task.id, record => record.completedRuns === 1 && !record.currentRequestKey); expect(calls).toHaveLength(2);
  });

  test('事件来源的对话选项按列表摘要的归属账号筛选，不逐个读取元数据', async () => {
    await app.storage.createConversation({ id: 'guest-chat', title: '别人的对话', createdAt: now, updatedAt: now, actorId: 'guest', custom: { platformMode: 'chat' } });
    await app.storage.createConversation({ id: 'untitled-chat', createdAt: now, updatedAt: now, actorId: 'owner' });
    const metadataReads = jest.spyOn(app.storage, 'getConversation');
    const options = await app.automations.options('owner');
    expect(metadataReads).not.toHaveBeenCalled();
    expect(options.eventConversations).toEqual(expect.arrayContaining([{ id: 'auto-chat', title: '自动任务测试' }, { id: 'untitled-chat', title: 'untitled-chat' }]));
    expect(options.eventConversations.some(row => row.id === 'guest-chat')).toBe(false);
  });

  test('目标跨轮继续，完成工具结算后结束，并保留原目标消息与调用用量', async () => {
    generate = async () => calls.length === 1 ? answer() : complete();
    const goal = await create(); await app.automations.tick(now);
    await until(goal.id, record => record.completedRuns === 1 && !record.currentRequestKey);
    now += 1100; await Promise.all([app.automations.tick(now), app.automations.tick(now)]);
    const done = await until(goal.id, record => record.status === 'completed' && !record.currentRequestKey);
    expect(calls).toHaveLength(2); expect(done.completedRuns).toBe(2); expect(done.usage).toMatchObject({ requests: 2, inputTokens: 20, outputTokens: 10, cachedInputTokens: 6 });
    const history = await app.storage.readFullHistory('auto-chat');
    expect(history.messages.filter(message => message.isUserInput)).toHaveLength(1);
    expect(history.messages.at(-1)?.parts[0]).toMatchObject({ functionResponse: { name: 'goal_update', response: { success: true } } });
    const runs = await app.storage.listRuns({ conversationId: 'auto-chat' });
    expect(runs.every(run => run.automationId === goal.id)).toBe(true);
    expect((await app.storage.getRecord('run-configurations', runs[0].id) as any).automationId).toBe(goal.id);
    expect(calls[0].systemPrompt).toContain('长期目标'); expect(calls[0].tools.some(tool => tool.name === 'goal_update')).toBe(true);
    now += 100000; await app.automations.tick(now); expect(calls).toHaveLength(2);
  });

  test('总结和子任务的用量归属同一目标，旧请求中的预算字段不限制持续执行', async () => {
    await app.createConversation('owner', '子任务测试', undefined, undefined, undefined, { id: 'child-chat' });
    let primary = 0;
    generate = async input => {
      if (input.conversationId === 'child-chat') return answer();
      if (input.purpose === 'summary') return answer(20, 5);
      if (++primary > 1) return complete();
      const child = await app.runtime.start({ requestKey: 'usage-child', actorId: 'owner', agentId: 'default', conversationId: 'child-chat', providerId,
        promptModeId: 'automation-test', message: { role: 'user', parts: [{ text: '完成子任务。' }] } });
      await app.runtime.wait(child.id);
      await app.models.generate({ ...input, purpose: 'summary', tools: [], messages: [{ role: 'user', parts: [{ text: '总结当前资料。' }] }] });
      return answer();
    };
    const goal = await create({ tokenBudget: 40 }); await app.automations.tick(now);
    const running = await until(goal.id, record => record.completedRuns === 1 && !record.currentRequestKey);
    expect(running.status).toBe('active'); expect(running).not.toHaveProperty('tokenBudget');
    expect(running.usage).toMatchObject({ requests: 3, inputTokens: 40, outputTokens: 15 });
    expect((await app.storage.getRunByRequestKey('usage-child'))?.automationId).toBe(goal.id);
    expect(calls.find(call => call.conversationId === 'child-chat')?.tools.some(tool => tool.name === 'goal_update')).toBe(false);
    now += 1100; await app.automations.tick(now);
    await until(goal.id, record => record.status === 'completed' && !record.currentRequestKey); expect(primary).toBe(2);
  });

  test.each(['停止', '退出'])('自动任务%s会中断尚未提交的提示词准备', async action => {
    const goal = await create();
    let entered!: () => void, release!: () => void, signal: AbortSignal | undefined;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const prepare = PlatformPromptService.prototype.prepare;
    jest.spyOn(PlatformPromptService.prototype, 'prepare').mockImplementationOnce(async function (this: PlatformPromptService, input) {
      signal = input.signal; entered();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal!.reason);
        signal?.addEventListener('abort', abort, { once: true });
        void released.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
      });
      signal?.throwIfAborted(); return prepare.call(this, input);
    });
    const dispatching = app.automations.tick(now);
    try {
      await entering;
      const overlapping = app.automations.tick(now);
      const stopping = action === '停止' ? app.automations.pause('owner', goal.id, true) : app.automations.close();
      try {
        expect(signal?.aborted).toBe(true);
        await Promise.all([dispatching, overlapping, stopping]);
        expect(calls).toEqual([]);
        expect(await app.storage.listRuns({ conversationId: 'auto-chat' })).toEqual([]);
        expect((await app.storage.readHistory('auto-chat')).messages).toEqual([]);
        expect(await app.storage.getRecord('automations', goal.id)).toMatchObject(action === '停止'
          ? { status: 'paused', pauseReason: 'user' } : { status: 'active' });
      } finally { release(); await Promise.all([dispatching, overlapping, stopping]); }
    } finally { release(); await dispatching; }
  });

  test('重启保留长期目标进度并暂停，用户继续后才再次运行', async () => {
    const goal = await create(); await app.automations.tick(now);
    await until(goal.id, record => record.completedRuns === 1 && !record.currentRequestKey);
    await app.close(); app = await open(); now += 100000;
    const paused = (await app.automations.list('owner'))[0];
    expect(paused).toMatchObject({ id: goal.id, status: 'paused', pauseReason: 'restart', completedRuns: 1 });
    await app.automations.tick(now); expect(calls).toHaveLength(1);
    generate = async () => complete(); await app.automations.resume('owner', goal.id); await app.automations.tick(now);
    await until(goal.id, record => record.status === 'completed' && !record.currentRequestKey); expect(calls).toHaveLength(2);
  });

  test('旧记录的预算不会中断同一轮执行，工具结果和累计用量保持完整', async () => {
    generate = async () => calls.length === 1 ? { ...answer(), parts: [{ functionCall: { id: 'progress', name: 'goal_update', args: { status: 'progress', summary: '已经完成第一步。' } } }] } : complete();
    const goal = await create();
    await app.storage.putRecord({ namespace: 'automations', id: goal.id, ownerId: 'auto-chat', value: { ...goal, tokenBudget: 1 } });
    await app.automations.tick(now);
    const done = await until(goal.id, record => record.status === 'completed' && !record.currentRequestKey);
    expect(calls).toHaveLength(2); expect(done.completedRuns).toBe(1); expect(done.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    const history = await app.storage.readFullHistory('auto-chat');
    expect(history.messages.flatMap(message => message.parts).filter(part => part.functionResponse)).toHaveLength(2);
  });

  test('后台结果继续交给原目标处理，恢复运行保留用量归属', async () => {
    generate = async () => calls.length === 1 ? answer() : complete();
    const goal = await create(); await app.automations.tick(now);
    const first = await until(goal.id, record => record.completedRuns === 1 && !record.currentRequestKey);
    await app.storage.appendHistory('auto-chat', [{ id: 'background-result', role: 'user', userFeedback: true, isUserInput: false, parts: [{ text: '后台任务返回了验证结果。' }] }]);
    await app.storage.commitRecords([
      { namespace: 'background-followups', id: 'background-result', ownerId: 'auto-chat', value: { id: 'background-result', conversationId: 'auto-chat', actorId: 'owner',
        sourceRunId: first.lastRunId, status: 'pending', createdAt: now } },
      { namespace: 'background-followup-pending', id: 'background-result', ownerId: 'auto-chat', value: true },
    ]);
    app.subagents.feedback.continuation.schedule('auto-chat');
    await until(goal.id, record => record.followupPending === true); await app.automations.tick(now);
    const done = await until(goal.id, record => record.status === 'completed' && !record.currentRequestKey);
    expect(done.usage.requests).toBe(2); expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].messages)).toContain('后台任务返回了验证结果');
    expect((await app.storage.listRuns({ conversationId: 'auto-chat' })).every(run => run.automationId === goal.id)).toBe(true);
    expect(await app.subagents.feedback.continuation.hasPending('auto-chat')).toBe(false);
  });

  test('移除未运行的目标后可以退出后台，关联对话仍保留', async () => {
    const goal = await create(); expect(app.automations.keepsAlive).toBe(true);
    await app.automations.remove('owner', goal.id);
    expect(app.automations.keepsAlive).toBe(false); expect(await app.storage.getConversation('auto-chat')).not.toBeNull(); expect(calls).toEqual([]);
  });

  test('暂停后可以修改目标和模型选择，原用量与对话保持，保存本身不执行', async () => {
    const goal = await create(); await app.automations.tick(now);
    await until(goal.id, record => record.completedRuns === 1 && !record.currentRequestKey); await app.automations.pause('owner', goal.id);
    const updated = await app.automations.update('owner', goal.id, { kind: 'goal', name: '补充验证', objective: '完成原工作并补充最后检查。',
      agentId: 'default', providerId, modelOverride: 'another-model', promptModeId: 'automation-test' });
    expect(updated).toMatchObject({ status: 'paused', conversationId: 'auto-chat', completedRuns: 1, usage: { requests: 1 } });
    expect(calls).toHaveLength(1); generate = async () => complete(); await app.automations.resume('owner', goal.id); await app.automations.tick(now);
    await until(goal.id, record => record.status === 'completed' && !record.currentRequestKey);
    expect(calls[1].modelOverride).toBe('another-model'); expect(calls[1].systemPrompt).toContain('补充最后检查');
    const messages = (await app.storage.readFullHistory('auto-chat')).messages.filter(message => message.isUserInput);
    expect(messages).toHaveLength(2); expect(messages[1].parts).toEqual([{ text: '完成原工作并补充最后检查。' }]);
  });

  test('任务完成事件去重，两个任务之间传递来源并阻止循环，完成游标覆盖同毫秒分页', async () => {
    await app.createConversation('owner', '来源对话', undefined, { platformMode: 'chat' }, undefined, { id: 'event-source' });
    const event = { trigger: { type: 'run_completed', conversationId: 'event-source' }, busyPolicy: 'latest', restartPolicy: 'resume' };
    const first = await create({ kind: 'event', event });
    const source = await app.runtime.start({ actorId: 'owner', conversationId: 'event-source', agentId: 'default', providerId,
      requestKey: 'event-source-seed', message: { role: 'user', parts: [{ text: '执行来源任务。' }] } });
    await app.runtime.wait(source.id); await until(first.id, record => !!record.pendingEvent);
    app.publish({ type: 'event', event: { type: 'run.completed', runId: source.id } });
    const second = await create({ kind: 'event', conversationId: 'event-source', event: { ...event, trigger: { type: 'run_completed', conversationId: 'auto-chat' } } });
    await app.automations.tick(now); await until(second.id, record => !!record.pendingEvent);
    await app.automations.tick(now); const guarded = await until(first.id, record => !!record.recentEvents?.some(item => item.reason?.includes('循环')));
    expect(guarded.completedRuns).toBe(1); expect(guarded.pendingEvent).toBeUndefined();
    expect(guarded.recentEvents?.filter(item => item.sourceRunId === source.id)).toHaveLength(1);
    expect(calls).toHaveLength(3);
    let cursor = { timestamp: now, runId: '' }; const paged: string[] = [];
    for (;;) { const rows = await app.storage.listRuns({ completedAfter: cursor, limit: 1 }); if (!rows.length) break; paged.push(rows[0].id); cursor = { timestamp: rows[0].updatedAt, runId: rows[0].id }; }
    expect(new Set(paged).size).toBe(3);
  });

  test('补发读取期间切换来源，旧来源游标不能覆盖新配置或重放新来源的旧任务', async () => {
    for (const id of ['source-before', 'source-after']) await app.createConversation('owner', id, undefined, { platformMode: 'chat' }, undefined, { id });
    const event = { trigger: { type: 'run_completed', conversationId: 'source-before' }, busyPolicy: 'latest', restartPolicy: 'resume' };
    const created = await create({ kind: 'event', event });
    for (const conversationId of ['source-before', 'source-after']) {
      await app.storage.createRun({ id: 'completed-' + conversationId, requestKey: 'replay-' + conversationId, conversationId, actorId: 'owner',
        agentId: 'default', status: 'queued', createdAt: now, updatedAt: now, iteration: 0, catalogVersion: 'fixture' }, { role: 'user', parts: [{ text: '来源记录' }] });
      await app.storage.appendRunEvent({ runId: 'completed-' + conversationId, type: 'run.started', payload: {}, update: { status: 'running' } });
      await app.storage.appendRunEvent({ runId: 'completed-' + conversationId, type: 'run.completed', payload: {}, update: { status: 'completed' } });
    }
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const list = app.storage.listRuns.bind(app.storage);
    const reads = jest.spyOn(app.storage, 'listRuns').mockImplementationOnce(async options => {
      const rows = await list(options); entered(); await gate; return rows;
    });
    const events = (app.automations as any).eventSources;
    const replay = events.replayCompleted();
    let pausing: Promise<AutomationRecord> | undefined;
    try {
      await waiting; now += 1000;
      // 暂停已写入状态后仍在等待监听队列；另一个客户端可以继续编辑并恢复任务。
      pausing = app.automations.pause('owner', created.id); void pausing.catch(() => {});
      await until(created.id, record => record.status === 'paused');
      await app.automations.update('owner', created.id, { ...created, providerId, promptModeId: 'automation-test',
        event: { ...created.event!, trigger: { type: 'run_completed', conversationId: 'source-after' } } });
      await app.automations.resume('owner', created.id);
    } finally { release(); await Promise.all([replay, pausing]); reads.mockRestore(); }
    expect((await app.storage.getRecord('automations', created.id) as AutomationRecord).eventSourceState).toBe(String(now));
    await events.replayCompleted();
    expect((await app.storage.getRecord('automations', created.id) as AutomationRecord).pendingEvent).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test.each(['变化结果', '读取失败'])('文件校验期间切换到相同内容的新来源，旧来源的%s不影响新配置', async outcome => {
    const workspace = { id: 'switch-files', name: '切换来源', directory: f.source, deviceId: 'local' };
    const settings = app.settings.snapshot(); settings.settings.workspaces.push(workspace);
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await Promise.all(['before.txt', 'after.txt'].map(file => writeFile(path.join(f.source, file), '相同的初始内容')));
    const created = await create({ kind: 'event', event: { trigger: { type: 'file_changed', workspaceId: workspace.id, path: 'before.txt', debounceMs: 100 }, busyPolicy: 'latest', restartPolicy: 'resume' } });
    const events = (app.automations as any).eventSources;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const reads = jest.spyOn(events, 'sourceState').mockImplementationOnce(async () => {
      entered(); await gate;
      if (outcome === '读取失败') throw new Error('旧来源读取失败');
      return 'f'.repeat(64);
    });
    const checking = events.reconcile(); let pausing: Promise<AutomationRecord> | undefined;
    try {
      await waiting; pausing = app.automations.pause('owner', created.id); void pausing.catch(() => {});
      await until(created.id, record => record.status === 'paused');
      await app.automations.update('owner', created.id, { ...created, providerId, promptModeId: 'automation-test',
        event: { ...created.event!, trigger: { type: 'file_changed', workspaceId: workspace.id, path: 'after.txt', debounceMs: 100 } } });
      await app.automations.resume('owner', created.id);
    } finally { release(); await Promise.all([checking, pausing]); reads.mockRestore(); }
    const current = await app.storage.getRecord('automations', created.id) as AutomationRecord;
    expect(current.status).toBe('active'); expect(current.error).toBeUndefined(); expect(current.pendingEvent).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test('真实文件合并、原子替换、同任务写入防循环，暂停取消和重启后继续监听', async () => {
    const workspace = { id: 'event-files', name: '事件文件', directory: f.source, deviceId: 'local' };
    const settings = app.settings.snapshot(); settings.settings.workspaces.push(workspace, { ...workspace, id: 'event-execution', name: '独立执行目录', directory: f.root }); await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await app.createConversation('owner', '文件任务', 'event-execution', { platformMode: 'chat' }, undefined, { id: 'file-chat' });
    const file = path.join(f.source, 'input.txt'); await writeFile(file, '初始内容');
    const created = await create({ kind: 'event', conversationId: 'file-chat', event: { trigger: { type: 'file_changed', workspaceId: workspace.id, path: 'input.txt', debounceMs: 100 }, busyPolicy: 'latest', restartPolicy: 'resume' } });
    expect(calls).toHaveLength(0);
    await writeFile(file, '第一段'); await writeFile(file, '第二段');
    await until(created.id, record => !!record.pendingEvent);
    generate = async () => { await writeFile(file, '任务自己写入'); return answer(); };
    await app.automations.tick(now);
    const first = await until(created.id, record => record.completedRuns === 1 && !record.currentRequestKey);
    expect(first.pendingEvent).toBeUndefined(); expect(first.recentEvents?.some(item => item.reason?.includes('循环'))).toBe(true);
    generate = async () => answer();
    const replacement = path.join(f.source, 'replacement.txt'); await writeFile(replacement, '替换之后'); await rename(replacement, file);
    await until(created.id, record => !!record.pendingEvent);
    await app.automations.pause('owner', created.id); await app.automations.tick(now);
    expect(calls).toHaveLength(1); expect((await app.automations.list('owner')).find(row => row.id === created.id)?.recentEvents?.at(-1)?.status).toBe('cancelled');
    await app.automations.resume('owner', created.id); await app.close();
    await writeFile(file, '关闭期间的变化'); app = await open();
    await until(created.id, record => !!record.pendingEvent); await app.automations.tick(now);
    await until(created.id, record => record.completedRuns === 2 && !record.currentRequestKey);
    await app.close(); app = await open(); await app.automations.tick(now); expect(calls).toHaveLength(2);
  });

  test('已接收事件重启只执行一次，忙碌时按设置合并且停止取消待执行事件', async () => {
    await app.createConversation('owner', '连续来源', undefined, { platformMode: 'chat' }, undefined, { id: 'event-source' });
    const created = await create({ kind: 'event', event: { trigger: { type: 'run_completed', conversationId: 'event-source' }, busyPolicy: 'latest', restartPolicy: 'resume' } });
    async function source(key: string) { const run = await app.runtime.start({ actorId: 'owner', conversationId: 'event-source', agentId: 'default', providerId, requestKey: key,
      message: { role: 'user', parts: [{ text: '来源事件' }] } }); await app.runtime.wait(run.id); return run; }
    await source('event-1'); await until(created.id, record => !!record.pendingEvent);
    await source('event-2'); await until(created.id, record => record.recentEvents?.length === 2);
    await app.close(); app = await open();
    expect((await app.automations.list('owner'))[0].recentEvents?.filter(item => item.status === 'pending')).toHaveLength(1);
    await app.automations.tick(now); await until(created.id, record => record.completedRuns === 1 && !record.currentRequestKey);
    expect(calls).toHaveLength(3);
    await source('event-3'); await until(created.id, record => !!record.pendingEvent);
    await app.automations.pause('owner', created.id, true); await app.close(); app = await open();
    await app.automations.tick(now); expect(calls).toHaveLength(4);
    const paused = (await app.automations.list('owner'))[0]; expect(paused.status).toBe('paused'); expect(paused.pendingEvent).toBeUndefined();
  });

  test('频繁读取状态不会推迟调度计时器，真实等待后按时执行', async () => {
    const created = await create({ kind: 'schedule', schedule: { type: 'once', at: now + 1000 }, missedRunPolicy: 'once' });
    now += 2000;
    const done = await until(created.id, record => record.status === 'completed' && !record.currentRequestKey);
    expect(done.completedRuns).toBe(1); expect(calls).toHaveLength(1);
  });

  test('一次定时任务并发触发只建立一个运行，关闭后的补跑策略按用户选择执行', async () => {
    const first = await create({ kind: 'schedule', schedule: { type: 'once', at: now + 1000 }, missedRunPolicy: 'once' });
    await app.close(); now += 10000; app = await open();
    await Promise.all([app.automations.tick(now), app.automations.tick(now)]);
    await until(first.id, record => record.status === 'completed' && !record.currentRequestKey); expect(calls).toHaveLength(1);
    const skipped = await create({ kind: 'schedule', schedule: { type: 'once', at: now + 1000 }, missedRunPolicy: 'skip' });
    await app.close(); now += 10000; app = await open(); await app.automations.tick(now);
    expect((await app.automations.list('owner')).find(record => record.id === skipped.id)?.status).toBe('completed'); expect(calls).toHaveLength(1);
  });
});

test('间隔保持原始节奏，工作日按用户时区计算下一次触发', () => {
  expect(nextScheduledTime({ type: 'interval', startAt: 1000, everyMinutes: 1 }, 130000)).toBe(181000);
  const schedule = validateSchedule({ type: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', weekDays: [1, 2, 3, 4, 5] });
  expect(new Date(nextScheduledTime(schedule, Date.parse('2026-09-11T02:00:00Z'))!).toISOString()).toBe('2026-09-14T01:00:00.000Z');
  expect(() => validateSchedule({ type: 'daily', time: '09:00', timeZone: '', weekDays: [1] })).toThrow('时区');
});
