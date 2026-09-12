import type { AutomationRecord, ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
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

  test('目标跨轮继续，完成工具结算后结束，并保留原目标消息与调用用量', async () => {
    generate = async () => calls.length === 1 ? answer() : complete();
    const goal = await create({ tokenBudget: 100 }); await app.automations.tick(now);
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

  test('总结和子任务都计入同一预算，达到预算后暂停并允许增加预算继续', async () => {
    await app.createConversation('owner', '子任务测试', undefined, undefined, undefined, { id: 'child-chat' });
    let primary = 0;
    generate = async input => {
      if (input.conversationId === 'child-chat') return answer();
      if (input.purpose === 'summary') return answer(20, 5);
      if (++primary > 1) return complete();
      const child = await app.runtime.start({ requestKey: 'budget-child', actorId: 'owner', agentId: 'default', conversationId: 'child-chat', providerId,
        promptModeId: 'automation-test', message: { role: 'user', parts: [{ text: '完成子任务。' }] } });
      await app.runtime.wait(child.id);
      await app.models.generate({ ...input, purpose: 'summary', tools: [], messages: [{ role: 'user', parts: [{ text: '总结当前资料。' }] }] });
      return answer();
    };
    const goal = await create({ tokenBudget: 40 }); await app.automations.tick(now);
    const paused = await until(goal.id, record => record.status === 'paused' && !record.currentRequestKey);
    expect(paused.pauseReason).toBe('budget'); expect(paused.usage).toMatchObject({ requests: 3, inputTokens: 40, outputTokens: 15 });
    expect((await app.storage.getRunByRequestKey('budget-child'))?.automationId).toBe(goal.id);
    expect(calls.find(call => call.conversationId === 'child-chat')?.tools.some(tool => tool.name === 'goal_update')).toBe(false);
    now += 100000; await app.automations.tick(now); expect(primary).toBe(1);
    await expect(app.automations.resume('owner', goal.id)).rejects.toThrow('预算');
    await app.automations.resume('owner', goal.id, 100); await app.automations.tick(now);
    await until(goal.id, record => record.status === 'completed' && !record.currentRequestKey); expect(primary).toBe(2);
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

  test('同一轮的预算用完后，保留已经完成的工具结果且不再请求模型', async () => {
    generate = async () => ({ ...answer(), parts: [{ functionCall: { id: 'progress', name: 'goal_update', args: { status: 'progress', summary: '已经完成第一步。' } } }] });
    const goal = await create({ tokenBudget: 10 }); await app.automations.tick(now);
    const paused = await until(goal.id, record => record.status === 'paused' && !record.currentRequestKey);
    expect(calls).toHaveLength(1); expect(paused.pauseReason).toBe('budget'); expect(paused.progress).toBe('已经完成第一步。');
    expect((await app.storage.readFullHistory('auto-chat')).messages.at(-1)?.parts[0]).toHaveProperty('functionResponse');
  });

  test('后台结果继续交给原目标处理，恢复运行保留预算归属', async () => {
    generate = async () => calls.length === 1 ? answer() : complete();
    const goal = await create({ tokenBudget: 100 }); await app.automations.tick(now);
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
      agentId: 'default', providerId, modelOverride: 'another-model', promptModeId: 'automation-test', tokenBudget: 500 });
    expect(updated).toMatchObject({ status: 'paused', conversationId: 'auto-chat', completedRuns: 1, tokenBudget: 500, usage: { requests: 1 } });
    expect(calls).toHaveLength(1); generate = async () => complete(); await app.automations.resume('owner', goal.id); await app.automations.tick(now);
    await until(goal.id, record => record.status === 'completed' && !record.currentRequestKey);
    expect(calls[1].modelOverride).toBe('another-model'); expect(calls[1].systemPrompt).toContain('补充最后检查');
    const messages = (await app.storage.readFullHistory('auto-chat')).messages.filter(message => message.isUserInput);
    expect(messages).toHaveLength(2); expect(messages[1].parts).toEqual([{ text: '完成原工作并补充最后检查。' }]);
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
