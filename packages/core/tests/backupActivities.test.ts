import type { ModelInput, PlatformMessage, RunRecord, SavedRunConfiguration } from '@graycode/contracts';
import { PlatformStorage } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { pauseRestoredActivities } from '../../../apps/server/src/backups/resources';
import type { BackgroundFollowup } from '../../../apps/server/src/subagents/continuation';
import type { PendingFeedback } from '../../../apps/server/src/subagents/feedback';
import type { PlatformSubagent } from '../../../apps/server/src/subagents/types';
import { fixture, metadata } from './fixtures';

describe('备份恢复后的后台结果与自动接续', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, parent: RunRecord, conversationId: string;
  let inputs: ModelInput[];
  const open = () => PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root,
    models: { generate: async input => { inputs.push(input); return { role: 'model', parts: [{ text: '合成模型已处理。' }] }; } } });
  const message = (id: string): PlatformMessage => ({ id, role: 'user', parts: [{ text: `后台结果 ${id}` }],
    timestamp: 42, isUserInput: false, source: 'background_task' });
  const followup = (id: string): BackgroundFollowup => ({ id, conversationId, actorId: 'owner', sourceRunId: parent.id,
    status: 'pending', createdAt: 42 });
  const idle = async () => {
    for (let index = 0; index < 500; index++) {
      if (!app.subagents.activeIds().length && !app.subagents.hasPendingWork()
        && !(await app.storage.listRuns({ activeOnly: true })).length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('等待后台回执与合成模型结束超时。');
  };
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); inputs = []; app = await open();
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ name: '恢复回归模型', type: 'openai', enabled: true,
      url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', timeout: 1000, contextManagementEnabled: false });
    await app.product.save(draft);
    conversationId = (await app.createConversation('owner', '后台恢复夹具')).id;
    parent = await app.runtime.start({ actorId: 'owner', conversationId, agentId: 'default', providerId,
      requestKey: 'original-parent', message: { role: 'user', parts: [{ text: '原始任务。' }] } });
    expect((await app.runtime.wait(parent.id))?.status).toBe('completed');
    await app.close(); inputs = [];
    f.store = await PlatformStorage.open(f.data);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test.each([
    { phase: '待交付', restored: false }, { phase: '待交付', restored: true },
    { phase: '待接续', restored: false }, { phase: '待接续', restored: true },
  ])('$phase 回执在普通重启后继续，备份恢复后仅保留结果（恢复：$restored）', async ({ phase, restored }) => {
    const id = 'saved-background-result', content = message(id);
    if (phase === '待交付') {
      const value: PendingFeedback = { id, conversationId, actorId: 'owner', sourceRunId: parent.id, message: content, sequence: 1 };
      await f.store.putRecord({ namespace: 'subagent-feedback', id, ownerId: conversationId, value });
    } else {
      await f.store.appendHistory(conversationId, [content]);
      await f.store.commitRecords([
        { namespace: 'background-followups', id, ownerId: conversationId, value: followup(id) },
        { namespace: 'background-followup-pending', id, ownerId: conversationId, value: { id } },
      ]);
    }
    if (restored) await pauseRestoredActivities(f.store);
    await f.store.close(); app = await open(); await idle();
    expect(inputs.length).toBe(restored ? 0 : 1);
    const restoredMessage = (await app.storage.readFullHistory(conversationId)).messages.filter(item => item.id === id);
    expect(restoredMessage).toHaveLength(1);
    expect(restoredMessage[0].parts).toEqual(content.parts);
    expect(await app.storage.listRecords('background-followup-pending', conversationId)).toEqual([]);
    const saved = await app.storage.getRecord('background-followups', id);
    if (restored && phase === '待交付') expect(saved).toBeNull();
    else expect(saved).toMatchObject(restored ? { status: 'obsolete', error: expect.stringContaining('备份') } : { status: 'started' });
  });

  test.each([
    { kind: '子代理', restored: false }, { kind: '子代理', restored: true },
    { kind: '终端', restored: false }, { kind: '终端', restored: true },
  ])('$kind 在重启时才补生成的回执也服从恢复暂停（恢复：$restored）', async ({ kind, restored }) => {
    const output = '备份中已经存在的任务输出。';
    const configuration = await f.store.getRecord('run-configurations', parent.id) as SavedRunConfiguration;
    let resultId: string;
    if (kind === '子代理') {
      const child: PlatformSubagent = { id: 'restored-child', actorId: 'owner', parentConversationId: conversationId,
        parentRunId: parent.id, conversationId: 'restored-child-chat', agentName: '恢复子任务',
        profile: { ...app.settings.snapshot().settings.agents[0], id: 'restored-child-profile', providerId: configuration.providerId },
        selection: { providerId: configuration.providerId },
        invocation: message('child-invocation'), depth: 1, background: true, taskId: 'restored-child:1',
        createdAt: 42, updatedAt: 42, status: 'completed', contentRevision: 1, eventSequence: 0, contentCount: 1,
        coreRunIds: ['child-original-core'], maxRuntime: 120, failureMode: 'fail_parent_tool' };
      await f.store.initializeConversation({ ...metadata(child.conversationId), actorId: 'owner',
        parentConversationId: conversationId, custom: { platformSubagentId: child.id } }, [
        { id: 'child-reply', role: 'model', runId: 'child-original-core', parts: [{ text: output }] },
      ], [{ namespace: 'platform-subagents', id: child.id, ownerId: conversationId, value: child }]);
      resultId = `subagent-${child.taskId}`;
    } else {
      const value = { id: 'restored-terminal', actorId: 'owner', conversationId, runId: parent.id, workspaceId: 'original-workspace',
        status: 'running', startTime: 42, updatedAt: 42, data: { background: true, command: 'fixture-only', output } };
      await f.store.commitRecords([
        { namespace: 'terminal-records', id: value.id, ownerId: conversationId, value },
        { namespace: 'terminal-active', id: value.id, ownerId: conversationId, value: { id: value.id } },
      ]);
      resultId = `terminal-result-${value.id}`;
    }
    expect(await f.store.getRecord('subagent-feedback', resultId)).toBeNull();
    if (restored) await pauseRestoredActivities(f.store);
    await f.store.close(); app = await open(); await idle();
    expect(inputs.length).toBe(restored ? 0 : 1);
    const result = (await app.storage.readFullHistory(conversationId)).messages.find(item => item.id === resultId);
    expect(result?.parts.some(part => typeof part.text === 'string' && part.text.includes(output))).toBe(true);
    expect(await app.storage.listRecords('background-followup-pending', conversationId)).toEqual([]);
    if (restored) expect(await app.storage.getRecord('background-followups', resultId)).toBeNull();
    if (restored && kind === '子代理') {
      expect(await app.storage.getRecord('platform-subagents', 'restored-child')).toMatchObject({ restoredFeedbackOnly: true });
      const dispatched = await app.subagents.dispatch({ agentName: '恢复子任务', continueFromRunId: 'restored-child',
        prompt: '明确要求继续这个已恢复的任务。', background: true }, {
        runId: parent.id, conversationId, actorId: 'owner', toolCallId: 'manual-continue',
        agent: app.settings.snapshot().settings.agents[0], modelSelection: { providerId: configuration.providerId },
        signal: new AbortController().signal, progress() {}, askUser: async () => { throw new Error('合成模型不会请求审批。'); },
      });
      expect(dispatched.success).toBe(true);
      await idle();
      expect(inputs.length).toBe(2);
      expect(await app.storage.getRecord('platform-subagents', 'restored-child')).not.toHaveProperty('restoredFeedbackOnly');
      const taskId = (dispatched.data as { taskId: string }).taskId;
      expect(taskId).not.toBe('restored-child:1');
      expect(await app.storage.getRecord('background-followups', `subagent-${taskId}`)).toMatchObject({ status: 'started' });
    }
  });

  test('部分已结算claim保留剩余CAS版本，同会话未认领结果仍暂停', async () => {
    const done = followup('claimed-done'), claimed = followup('claimed-pending'), unclaimed = followup('unclaimed-new');
    await f.store.appendHistory(conversationId, [done, claimed, unclaimed].map(value => message(value.id)));
    for (const value of [done, claimed, unclaimed]) await f.store.commitRecords([
      { namespace: 'background-followups', id: value.id, ownerId: conversationId, value },
      { namespace: 'background-followup-pending', id: value.id, ownerId: conversationId, value: { id: value.id } },
    ]);
    const reserved: RunRecord = { id: 'reserved-followup', requestKey: 'reserved-request', actorId: 'owner', conversationId,
      agentId: 'default', catalogVersion: 'fixture', iteration: 0, status: 'queued', createdAt: 43, updatedAt: 43 };
    const state = await f.store.getConversationInfo(conversationId);
    await f.store.commitConversation({ conversationId, expectedRevision: state!.historyRevision, startRun: { run: reserved } });
    const completedValue = { ...done, status: 'started', requestKey: reserved.requestKey, runId: reserved.id };
    const claimedValue = { ...claimed, status: 'started', requestKey: reserved.requestKey, runId: reserved.id };
    await f.store.commitRecords([
      { namespace: 'background-followups', id: done.id, ownerId: conversationId, value: completedValue },
      { namespace: 'background-followup-pending', id: done.id, delete: true },
    ]);
    const protectedRecord = await f.store.getVersionedRecord('background-followups', claimed.id);
    const claim = { completed: 1, entries: [{ revision: 1, value: completedValue },
      { revision: protectedRecord.revision, value: claimedValue }] };
    await f.store.putRecord({ namespace: 'background-followup-claims', id: conversationId, ownerId: conversationId, value: claim });
    await pauseRestoredActivities(f.store);
    expect(await f.store.getVersionedRecord('background-followups', claimed.id)).toEqual(protectedRecord);
    expect(await f.store.getRecord('background-followup-claims', conversationId)).toEqual(claim);
    expect(await f.store.getRecord('background-followups', unclaimed.id)).toMatchObject({ status: 'obsolete' });
    await f.store.close(); app = await open(); await idle();
    expect(inputs.length).toBe(0);
    expect(await app.storage.getRecord('background-followup-claims', conversationId)).toBeNull();
    expect(await app.storage.listRecords('background-followup-pending', conversationId)).toEqual([]);
    expect(await app.storage.getRecord('background-followups', done.id)).toEqual(completedValue);
    expect(await app.storage.getRecord('background-followups', claimed.id)).toEqual(claimedValue);
    expect(await app.storage.getRun(reserved.id)).toMatchObject({ requestKey: reserved.requestKey, status: 'interrupted' });
    expect((await app.storage.readFullHistory(conversationId)).messages.filter(item => [done.id, claimed.id, unclaimed.id].includes(item.id!)))
      .toHaveLength(3);
  });
});
