import type { AgentDefinition, ApprovalRequest, ModelInput, PlatformMessage, RunRecord } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const answer = (text: string): PlatformMessage => ({ role: 'model', parts: [{ text }] });
const sensitiveCall = { id: 'reused-call', name: 'approval_fixture', args: {} };
const waitUntil = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('等待隔离审批状态超时。');
};

describe('独立平台代理消息与原审批的运行边界', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let router: ApplicationRouter; let agent: AgentDefinition;
  let generate: (input: ModelInput) => Promise<PlatformMessage>; let executions: number; let notifications: Record<string, any>[];
  const client = { actorId: 'owner', clientId: 'approval-ui' };
  const gates: Array<ReturnType<typeof deferred>> = [];
  const hold = () => { const gate = deferred(); gates.push(gate); return gate; };
  const call = (type: string, data: Record<string, unknown>) => router.call(client, 'ui.request', { type, data });
  const start = (conversationId: string, message: PlatformMessage = { role: 'user', parts: [{ text: 'start' }] }) => app.runtime.start({
    actorId: 'owner', conversationId, agentId: agent.id, requestKey: `test:${Math.random()}`, message });
  const pending = async (runId: string): Promise<ApprovalRequest> => {
    await waitUntil(async () => (await app.storage.getRun(runId))?.status === 'awaiting_approval'
      && app.runtime.pendingApprovals().some(item => item.runId === runId));
    return app.runtime.pendingApprovals().find(item => item.runId === runId)!;
  };
  const response = (request: ApprovalRequest, confirmed: boolean) => ({ id: request.toolCallId, name: request.toolName,
    approvalId: request.id, runId: request.runId, confirmed });
  const confirm = (conversationId: string, toolResponse: Record<string, unknown>, streamId = 'confirmed-stream') =>
    call('toolConfirmation', { conversationId, streamId, toolResponses: [toolResponse] });
  const chunks = (runId: string) => notifications.filter(item => item.type === 'ui.message' && item.runId === runId
    && item.clientId === client.clientId && item.message.type === 'streamChunk').map(item => item.message.data);
  const idle = () => waitUntil(async () => app.subagents.activeIds().length === 0 && !app.subagents.hasPendingWork()
    && (await app.storage.listRuns({ activeOnly: true })).length === 0);

  beforeEach(async () => {
    f = await fixture(); await f.store.close(); executions = 0; notifications = []; generate = async () => answer('done');
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } });
    router = new ApplicationRouter(app);
    // 用真实审批 effect，但没有磁盘副作用，更不触及当前运行的用户数据。
    app.tools.register({ declaration: { name: sensitiveCall.name, description: 'isolated approval fixture', parameters: { type: 'object', properties: {} } },
      effects: () => ['data_delete'], execute: async () => { executions++; return { success: true }; } });
    const preferences = await app.product.draft();
    const providerId = await preferences.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000,
      url: 'http://127.0.0.1:9/v1', name: '审批隔离模型', model: 'fixture', apiKey: '' });
    await app.product.save(preferences);
    const snapshot = app.settings.snapshot();
    agent = { ...snapshot.settings.agents[0], id: 'approval-message-fixture', providerId, name: '审批消息测试',
      toolNames: ['subagents', 'agent_send_message', sensitiveCall.name], approvalMode: 'sensitive', maxIterations: 12 };
    snapshot.settings.agents.push(agent); await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    app.subscribe(event => notifications.push(event));
  });
  afterEach(async () => { for (const gate of gates.splice(0)) gate.resolve(); await app.close(); jest.restoreAllMocks(); await f.cleanup(); });

  test.each(['approve', 'decline', 'cancel', 'fail'] as const)('挂起时子代理发信并重复回执，原审批仍可 %s 且只结算一次', async action => {
    const root = await app.createConversation('owner', `approval-${action}`);
    const sendGate = hold(), childGate = hold(); let rootCalls = 0, childCalls = 0; const rootInputs: ModelInput[] = [];
    generate = async input => {
      if (input.conversationId === root.id) {
        rootInputs.push(input);
        if (++rootCalls === 1) return { role: 'model', parts: [
          { functionCall: { id: 'launch-child', name: 'subagents', args: { agentName: 'General Worker', prompt: 'send while parent awaits approval', background: true } } },
          { functionCall: sensitiveCall },
        ] };
        if (action === 'fail') throw new Error('isolated model failure after approval');
        return answer('parent finished');
      }
      if (++childCalls === 1) {
        await sendGate.promise;
        return { role: 'model', parts: [{ functionCall: { id: 'child-send', name: 'agent_send_message', args: { targetAgentName: 'main', message: '审批期间消息不是用户确认' } } }] };
      }
      await childGate.promise; return answer('child finished');
    };
    const run = await start(root.id); const approval = await pending(run.id);
    await call('chat.resumeConversationStream', { conversationId: root.id });
    const revision = (await app.storage.historyInfo(root.id)).revision;
    sendGate.resolve();
    await waitUntil(async () => (await app.subagents.feedback.pendingIds(root.id)).length === 1 && childCalls === 2);
    const child = (await app.subagents.manifests('owner', root.id))[0];
    const record = (await app.subagents.get('owner', child.runId))!;
    const childRun = (await app.storage.getRun(record.coreRunIds[0]))!;
    const context: ToolContext = { runId: childRun.id, conversationId: childRun.conversationId, actorId: 'owner', iteration: 1,
      toolCallId: 'child-send', signal: new AbortController().signal, askUser: async () => { throw new Error('unused'); }, progress: () => {} };
    const repeated = await app.subagents.messages.send({ targetAgentName: 'main', message: '审批期间消息不是用户确认' }, context);
    expect(repeated.success).toBe(true);
    expect(await app.subagents.feedback.pendingIds(root.id)).toHaveLength(1);
    expect(await app.storage.listRecords('agent-message-receipts', root.id)).toHaveLength(1);
    expect((await app.storage.historyInfo(root.id)).revision).toBe(revision);
    expect(app.runtime.pendingApprovals().filter(item => item.runId === run.id)).toEqual([approval]);
    expect((await app.storage.getRun(run.id))?.status).toBe('awaiting_approval');
    expect(rootCalls).toBe(1); expect(executions).toBe(0);
    // 共享前端旧信箱在独立平台是 no-op，不能领走或确认真实 runtime 审批。
    expect(await call('chat.claimAgentMessages', { conversationId: root.id })).toMatchObject({ messageCount: 0, claimId: null });
    expect(app.runtime.pendingApprovals().filter(item => item.runId === run.id)).toEqual([approval]);
    if (action === 'cancel') await call('cancelStream', { conversationId: root.id });
    else await confirm(root.id, response(approval, action !== 'decline'));
    const finished = await app.runtime.wait(run.id);
    expect(finished?.status).toBe(action === 'cancel' ? 'cancelled' : action === 'fail' ? 'failed' : 'completed');
    expect(executions).toBe(action === 'approve' || action === 'fail' ? 1 : 0);
    await expect(confirm(root.id, response(approval, true), 'stale-stream')).rejects.toThrow();
    expect(app.runtime.pendingApprovals().some(item => item.id === approval.id)).toBe(false);
    const history = (await app.storage.readFullHistory(root.id)).messages;
    const results = history.filter(message => message.runId === run.id).flatMap(message => message.parts)
      .filter(part => (part.functionResponse as { id?: string } | undefined)?.id === sensitiveCall.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ functionResponse: { response: action === 'decline' ? { success: false, code: 'PERMISSION_DENIED' }
      : action === 'cancel' ? { success: false, code: 'CANCELLED' } : { success: true } } });
    const events = await app.storage.readRunEvents(run.id);
    const resolved = events.filter(event => event.type === 'approval.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].payload).toMatchObject({ approvalId: approval.id, toolCallId: sensitiveCall.id,
      ...(action === 'cancel' ? { cancelled: true } : { accepted: action !== 'decline' }) });
    expect(events.at(-1)?.type).toBe(`run.${finished!.status}`);
    const finalChunks = chunks(run.id);
    expect(finalChunks.at(-1)?.type).toBe(action === 'cancel' ? 'cancelled' : action === 'fail' ? 'error' : 'complete');
    const resultChunk = finalChunks.find(chunk => chunk.type === 'toolStatus' && chunk.tool.id === sensitiveCall.id && chunk.tool.result);
    expect(resultChunk?.tool.status).toBe(action === 'decline' || action === 'cancel' ? 'error' : 'success');
    if (action !== 'cancel') {
      expect(resultChunk?.streamId).toBe('confirmed-stream');
      const messages = rootInputs[1].messages;
      const resultIndex = messages.findIndex(message => message.parts.some(part => (part.functionResponse as { id?: string } | undefined)?.id === sensitiveCall.id));
      const feedbackIndex = messages.findIndex(message => message.parts.some(part => typeof part.text === 'string' && part.text.includes('[Agent message received]')));
      expect(resultIndex).toBeGreaterThanOrEqual(0); expect(feedbackIndex).toBeGreaterThan(resultIndex);
      expect(history.filter(message => message.source === 'agent_message')).toHaveLength(1);
    }
    childGate.resolve(); await idle();
    expect(executions).toBe(action === 'approve' || action === 'fail' ? 1 : 0);
    expect((await app.storage.readFullHistory(root.id)).messages.filter(message => message.source === 'agent_message')).toHaveLength(1);
  });

  test('过期、缺失和不匹配的审批身份不能落到复用 toolCallId 的后续运行', async () => {
    const root = await app.createConversation('owner', 'reused tool identity');
    const other = await app.createConversation('owner', 'other'); let calls = 0;
    generate = async () => ++calls % 2 ? { role: 'model', parts: [{ functionCall: sensitiveCall }] } : answer('done');
    const first = await start(root.id); const old = await pending(first.id);
    await confirm(root.id, response(old, false)); await app.runtime.wait(first.id);
    const second = await start(root.id); const current = await pending(second.id);
    await call('chat.resumeConversationStream', { conversationId: root.id });
    const good = response(current, true);
    for (const [conversationId, invalid] of [
      [root.id, { ...good, approvalId: undefined }], [root.id, response(old, true)],
      [root.id, { ...good, id: 'other-call' }], [root.id, { ...good, name: 'other-tool' }],
      [root.id, { ...good, runId: first.id }], [other.id, good],
      [root.id, { ...good, confirmed: undefined }], [root.id, { ...good, confirmed: 'true' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(confirm(conversationId, invalid, 'invalid-stream')).rejects.toThrow();
      expect(app.runtime.pendingApprovals()).toEqual([current]);
      expect(executions).toBe(0);
    }
    await confirm(root.id, response(current, false), 'valid-stream');
    expect((await app.runtime.wait(second.id))?.status).toBe('completed');
    expect(chunks(second.id).at(-1)?.streamId).toBe('valid-stream');
  });

  test('并发重复确认只有胜出的回执能绑定后续流，失败回执不抢走终态', async () => {
    const root = await app.createConversation('owner', 'duplicate confirmation'); let calls = 0;
    generate = async () => ++calls === 1 ? { role: 'model', parts: [{ functionCall: sensitiveCall }] } : answer('done');
    const run = await start(root.id); const approval = await pending(run.id);
    await call('chat.resumeConversationStream', { conversationId: root.id });
    const both = hold(); let entered = 0;
    const resolve = app.runtime.resolveApproval.bind(app.runtime);
    jest.spyOn(app.runtime, 'resolveApproval').mockImplementation(async (...args) => {
      if (++entered === 2) both.resolve(); await both.promise; return resolve(...args);
    });
    const replies = await Promise.allSettled(['first-stream', 'duplicate-stream'].map(streamId => confirm(root.id, response(approval, true), streamId)));
    expect(replies.filter(reply => reply.status === 'fulfilled')).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 'rejected')).toHaveLength(1);
    const winningStream = ['first-stream', 'duplicate-stream'][replies.findIndex(reply => reply.status === 'fulfilled')];
    expect((await app.runtime.wait(run.id))?.status).toBe('completed'); expect(executions).toBe(1);
    const events = await app.storage.readRunEvents(run.id);
    expect(events.filter(event => event.type === 'approval.resolved')).toHaveLength(1);
    expect(chunks(run.id).filter(chunk => chunk.type === 'toolStatus' && chunk.tool.id === sensitiveCall.id)
      .every(chunk => chunk.streamId === winningStream)).toBe(true);
    expect(chunks(run.id).at(-1)?.streamId).toBe(winningStream);
  });

  test('取消挂起审批同步撤销原身份，迟到确认不能变成用户批准或拒绝', async () => {
    const root = await app.createConversation('owner', 'cancel consumes approval');
    generate = async () => ({ role: 'model', parts: [{ functionCall: sensitiveCall }] });
    const run = await start(root.id); const approval = await pending(run.id);
    await app.runtime.cancel(run.id, 'owner');
    expect(app.runtime.pendingApprovals().some(item => item.id === approval.id)).toBe(false);
    await expect(app.runtime.resolveApproval(approval.id, 'owner', true)).rejects.toThrow('expired');
    expect((await app.runtime.wait(run.id))?.status).toBe('cancelled'); expect(executions).toBe(0);
    const resolved = (await app.storage.readRunEvents(run.id)).filter(event => event.type === 'approval.resolved');
    expect(resolved).toHaveLength(1); expect(resolved[0].payload).toMatchObject({ approvalId: approval.id, cancelled: true });
  });

  test('独立忙时输入持久化正文和截图，与代理反馈同边界交付但不消费审批，重复回执跨重启去重', async () => {
    const root = await app.createConversation('owner', 'busy input with image'); const inputs: ModelInput[] = [];
    generate = async input => { inputs.push(input); return inputs.length === 1 ? { role: 'model', parts: [{ functionCall: sensitiveCall }] } : answer('answered newest user'); };
    const run = await start(root.id); const approval = await pending(run.id);
    await call('chat.resumeConversationStream', { conversationId: root.id });
    const revision = (await app.storage.historyInfo(root.id)).revision;
    await app.subagents.feedback.enqueueMessages([{ id: 'agent-before-user', conversationId: root.id, actorId: 'owner',
      message: { id: 'agent-before-user', role: 'user', source: 'agent_message', isUserInput: false, parts: [{ text: '代理后台反馈' }] } }]);
    const request = { conversationId: root.id, messageId: 'stable-busy-input', text: '请先看最新截图再回复', deepSeekVisionTileSplit: false,
      attachments: [{ id: 'screenshot', name: 'screenshot.png', type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] };
    const [receipt, repeated] = await Promise.all([call('chat.sendInterruptMessage', request), call('chat.sendInterruptMessage', request)]) as Record<string, any>[];
    expect(receipt).toMatchObject({ success: true, queued: true, runId: run.id, messageId: expect.any(String) });
    expect(repeated).toEqual(receipt);
    await expect(call('chat.sendInterruptMessage', { ...request, text: '不能改写已保存的输入' })).rejects.toThrow('改写');
    await expect(router.call({ actorId: 'unknown', clientId: 'unauthorized' }, 'ui.request', { type: 'chat.sendInterruptMessage', data: request })).rejects.toThrow();
    expect(app.runtime.pendingApprovals()).toEqual([approval]);
    expect((await app.storage.getRun(run.id))?.status).toBe('awaiting_approval');
    expect((await app.storage.historyInfo(root.id)).revision).toBe(revision);
    expect(await app.subagents.feedback.pendingIds(root.id)).toHaveLength(2);
    expect(executions).toBe(0); expect(inputs).toHaveLength(1);
    await confirm(root.id, response(approval, false));
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    expect(executions).toBe(0); expect(inputs).toHaveLength(2);
    const history = (await app.storage.readFullHistory(root.id)).messages;
    const user = history.find(message => message.id === receipt.messageId)!;
    expect(user).toMatchObject({ role: 'user', source: 'user', actorId: 'owner', isUserInput: true, runId: run.id, deepSeekVisionTileSplit: false });
    expect(user.agentMessage).toBeUndefined();
    // 沿普通消息构建器的既有顺序：附件在正文前；历史保留附件标识，模型投影去掉展示元数据。
    expect(user.parts).toEqual([{ inlineData: { id: 'screenshot', name: 'screenshot.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { text: request.text }]);
    expect(inputs[1].messages.find(message => message.id === receipt.messageId)?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { text: request.text },
    ]);
    const resultIndex = history.findIndex(message => message.isFunctionResponse);
    expect(history.findIndex(message => message.id === 'agent-before-user')).toBeGreaterThan(resultIndex);
    expect(history.findIndex(message => message.id === receipt.messageId)).toBeGreaterThan(history.findIndex(message => message.id === 'agent-before-user'));
    expect(chunks(run.id).filter(chunk => chunk.type === 'userFeedback' && chunk.feedbackContent?.id === receipt.messageId)).toHaveLength(1);
    await idle(); await app.close();
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } }); router = new ApplicationRouter(app);
    expect(await call('chat.sendInterruptMessage', request)).toEqual(receipt);
    expect(inputs).toHaveLength(2);
    expect((await app.storage.readFullHistory(root.id)).messages.filter(message => message.id === receipt.messageId)).toHaveLength(1);
  });

  test.each(['cancel', 'complete'] as const)('用户入队提交与 %s 收尾竞争，成功回执不丢图片且取消不自动复活', async ending => {
    const root = await app.createConversation('owner', `input-race-${ending}`); const modelGate = hold(), writeGate = hold();
    const modelStarted = deferred(), writeStarted = deferred(); const inputs: ModelInput[] = [];
    generate = async input => { inputs.push(input); if (inputs.length === 1) { modelStarted.resolve(); await modelGate.promise; } return answer('answer'); };
    const run = await start(root.id); await modelStarted.promise;
    const enqueue = app.subagents.feedback.enqueueMessages.bind(app.subagents.feedback);
    jest.spyOn(app.subagents.feedback, 'enqueueMessages').mockImplementation(async (pending, records) => {
      if (pending.some(value => value.message.source === 'user')) { writeStarted.resolve(); await writeGate.promise; }
      return enqueue(pending, records);
    });
    const request = { conversationId: root.id, messageId: 'racing-input', text: '不能丢的新输入',
      attachments: [{ id: 'racing-image', name: 'new.png', type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] };
    const sending = call('chat.sendInterruptMessage', request); void sending.catch(() => {}); await writeStarted.promise;
    if (ending === 'cancel') await app.runtime.cancel(run.id, 'owner');
    modelGate.resolve();
    if (ending === 'cancel') expect((await app.runtime.wait(run.id))?.status).toBe('cancelled');
    else {
      await waitUntil(() => notifications.some(item => item.type === 'message.persisted' && item.runId === run.id && item.content.role === 'model'));
      // 正常收尾须等已经开始的入队事务，不抢先关闭run让后台反馈独自启动下一模型。
      await new Promise(resolve => setTimeout(resolve, 50));
      expect((await app.storage.getRun(run.id))?.status).toBe('running');
    }
    writeGate.resolve(); const receipt = await sending as Record<string, any>;
    expect(receipt).toMatchObject({ success: true, queued: true });
    await app.runtime.wait(run.id); await idle();
    expect((await app.storage.listRuns({ conversationId: root.id }))).toHaveLength(1);
    expect(inputs).toHaveLength(ending === 'cancel' ? 1 : 2);
    const history = (await app.storage.readFullHistory(root.id)).messages;
    const user = history.find(message => message.id === receipt.messageId)!;
    expect(user.parts).toEqual([{ inlineData: { id: 'racing-image', name: 'new.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { text: request.text }]);
    if (ending === 'complete') expect(inputs[1].messages.find(message => message.id === receipt.messageId)).toBeDefined();
    else {
      expect(await app.storage.listRecords('background-followup-pending', root.id)).toEqual([]);
      await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } }); router = new ApplicationRouter(app);
      expect(await call('chat.sendInterruptMessage', request)).toEqual(receipt);
      await idle(); expect(inputs).toHaveLength(1);
    }
  });

  test.each(['text+image', 'image-only', 'long-text'] as const)('飞行中输入 %s 只排队，不改原请求；正常收尾前原run看到最新用户附件', async mode => {
    const root = await app.createConversation('owner', 'in flight input'); const gate = hold(); const started = deferred(); const inputs: ModelInput[] = [];
    const text = mode === 'image-only' ? '' : mode === 'long-text' ? '新'.repeat(4001) : '新的用户问题';
    generate = async input => { inputs.push(input); if (inputs.length === 1) { started.resolve(); await gate.promise; return answer('first response before new input'); } return answer('now answer new input'); };
    const run = await start(root.id); await started.promise;
    const inputBefore = structuredClone(inputs[0].messages);
    const receipt = await call('chat.sendInterruptMessage', { conversationId: root.id, messageId: 'in-flight-user', text,
      attachments: [{ id: 'screenshot', name: 'screen.png', type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }) as Record<string, any>;
    expect(receipt.success).toBe(true); expect(inputs[0].messages).toEqual(inputBefore); expect(inputs).toHaveLength(1);
    expect((await app.storage.listRuns({ conversationId: root.id }))).toHaveLength(1);
    gate.resolve(); expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    expect(inputs).toHaveLength(2);
    expect(inputs[1].messages.find(message => message.id === receipt.messageId)?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, ...(text ? [{ text }] : []),
    ]);
    expect((await app.storage.listRuns({ conversationId: root.id }))).toHaveLength(1);
    expect(await call('chat.sendInterruptMessage', { conversationId: root.id, messageId: 'idle-new-request', text: 'idle input should use ordinary send' }))
      .toMatchObject({ success: false, error: { code: 'INTERRUPT_NO_ACTIVE_RUN' } });
  });

  test('同一模型边界含最新用户文本/图片与后台反馈，输入不遗漏用户消息也不改写已有工具配对', async () => {
    const root = await app.createConversation('owner', 'latest user and feedback');
    const parts = [{ text: '最新用户要求：先回答这个问题' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }];
    await app.subagents.feedback.enqueueMessages([{ id: 'queued-agent-note', conversationId: root.id, actorId: 'owner',
      message: { id: 'queued-agent-note', role: 'user', isUserInput: false, source: 'agent_message', parts: [{ text: 'background feedback, not user consent' }] } }]);
    const inputs: ModelInput[] = [];
    generate = async input => { inputs.push(input); return inputs.length === 1 ? { role: 'model', parts: [{ functionCall: sensitiveCall }] } : answer('answered latest user'); };
    const run = await start(root.id, { id: 'latest-user', role: 'user', parts }); const approval = await pending(run.id);
    expect(inputs[0].messages.find(message => message.id === 'latest-user')?.parts).toEqual(parts);
    expect(inputs[0].messages.some(message => message.id === 'queued-agent-note')).toBe(true);
    expect(executions).toBe(0);
    await confirm(root.id, response(approval, false)); await app.runtime.wait(run.id);
    expect(inputs[1].messages.find(message => message.id === 'latest-user')?.parts).toEqual(parts);
    expect(inputs[1].messages.flatMap(message => message.parts).filter(part => part.functionCall)).toEqual([{ functionCall: sensitiveCall }]);
    expect(inputs[1].messages.flatMap(message => message.parts).filter(part => part.functionResponse)).toHaveLength(1);
  });
});
