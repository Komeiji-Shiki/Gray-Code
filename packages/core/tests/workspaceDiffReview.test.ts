import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { ModelInput, PlatformMessage, RunEvent } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('文件审查与运行等待状态', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication;
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  let resumed: ReturnType<typeof deferred>, finish: ReturnType<typeof deferred>;
  const writeCall = { id: 'write-once', name: 'write_file', args: { path: 'result.txt', content: '等待审查的内容' } };

  const nextEvent = (type: RunEvent['type']) => new Promise<RunEvent>(resolve => {
    const unsubscribe = app.runtime.subscribe(notification => {
      if (notification.type === 'event' && notification.event.type === type) {
        unsubscribe(); resolve(notification.event);
      }
    });
  });
  const start = async () => {
    const conversation = await app.createConversation('owner', '文件审查', 'project');
    return app.runtime.start({ actorId: 'owner', conversationId: conversation.id, agentId: 'diff-test', workspaceId: 'project',
      requestKey: conversation.id, message: { role: 'user', parts: [{ text: '写入文件' }] } });
  };
  const reviewEvents = async (runId: string) => (await app.storage.readRunEvents(runId))
    .filter(event => event.type.startsWith('diff.review.'));

  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    resumed = deferred(); finish = deferred();
    generate = async input => {
      if (!input.messages.some(message => message.isFunctionResponse)) return { role: 'model', parts: [{ functionCall: writeCall }] };
      resumed.resolve(); await finish.promise;
      return { role: 'model', parts: [{ text: '处理完成' }] };
    };
    app = await PlatformApplication.open({ dataDirectory: f.data,
      models: { supportsAsyncTools: () => true, generate: input => generate(input) } });
    const draft = app.settings.snapshot();
    draft.settings.workspaces.push({ id: 'project', name: '审查工作区', directory: f.source, deviceId: 'local' });
    draft.settings.agents.push({ id: 'diff-test', name: '审查测试', providerId: draft.settings.agents[0].providerId, systemPrompt: '',
      approvalMode: 'sensitive', maxIterations: 4, toolNames: ['write_file', 'read_file'],
      toolApproval: { write_file: 'auto', read_file: 'auto' } });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    const product = await app.product.draft();
    await product.settings.updateApplyDiffConfig({ autoSave: false });
    await app.product.save(product);
  });

  afterEach(async () => { finish.resolve(); await app.close(); await f.cleanup(); });

  test('等待文件审查时进入 awaiting_approval，接受后恢复 running 并正常完成', async () => {
    const requested = nextEvent('diff.review.requested');
    const run = await start(); const event = await requested; const diffId = String(event.payload.diffId);
    expect(event.payload).toMatchObject({ path: 'result.txt', status: 'pending', toolCallId: 'write-once', toolName: 'write_file' });
    expect((await app.storage.getRun(run.id))?.status).toBe('awaiting_approval');
    expect(app.runtime.pendingApprovals()).toEqual([]);
    await expect(readFile(path.join(f.source, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const resolved = nextEvent('diff.review.resolved');
    await app.diffs.resolve('owner', diffId, true);
    expect((await resolved).payload).toMatchObject({ diffId, status: 'accepted' });
    await resumed.promise;
    expect((await app.storage.getRun(run.id))?.status).toBe('running');
    expect(await readFile(path.join(f.source, 'result.txt'), 'utf8')).toBe(writeCall.args.content);
    finish.resolve(); expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    expect((await reviewEvents(run.id)).map(item => item.type)).toEqual(['diff.review.requested', 'diff.review.resolved']);
  });

  test.each(['rejected', 'cancelled'] as const)('%s 结束等待并保留原有文件与工具结果语义', async status => {
    const requested = nextEvent('diff.review.requested');
    const run = await start(); const diffId = String((await requested).payload.diffId);
    const resolved = nextEvent('diff.review.resolved');
    if (status === 'cancelled') await app.runtime.cancel(run.id, 'owner');
    else await app.diffs.resolve('owner', diffId, false);
    expect((await resolved).payload).toMatchObject({ diffId, status });
    if (status === 'rejected') {
      await resumed.promise;
      expect((await app.storage.getRun(run.id))?.status).toBe('running');
    }
    finish.resolve();
    expect((await app.runtime.wait(run.id))?.status).toBe(status === 'cancelled' ? 'cancelled' : 'completed');
    const responses = (await app.storage.readFullHistory(run.conversationId)).messages.flatMap(message => message.parts)
      .flatMap(part => part.functionResponse ? [part.functionResponse] : []);
    expect(responses).toEqual([expect.objectContaining({ id: 'write-once', response: expect.objectContaining({ success: false,
      cancelled: status === 'cancelled', data: expect.objectContaining({ results: [expect.objectContaining({ status })] }) }) })]);
    await expect(readFile(path.join(f.source, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await reviewEvents(run.id)).map(item => item.payload.status)).toEqual(['pending', status]);
    await expect(app.diffs.resolve('owner', diffId, true)).rejects.toThrow('DIFF_NOT_PENDING');
  });

  test.each(['automatic', 'automatic-preview', 'tool-confirmation'] as const)('%s 应用文件时不发送 diff 等待事件', async mode => {
    if (mode !== 'tool-confirmation') {
      const product = await app.product.draft();
      await product.settings.updateApplyDiffConfig({ autoSave: true, autoApplyWithoutDiffView: mode === 'automatic', autoSaveDelay: 50 });
      await app.product.save(product);
    } else {
      const draft = app.settings.snapshot();
      draft.settings.agents.find(agent => agent.id === 'diff-test')!.toolApproval!.write_file = 'ask';
      await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    }
    const approval = mode === 'tool-confirmation' ? nextEvent('approval.requested') : undefined;
    const run = await start();
    if (approval) await app.runtime.resolveApproval(String((await approval).payload.id), 'owner', true);
    await resumed.promise;
    expect((await app.storage.getRun(run.id))?.status).toBe('running');
    expect(await reviewEvents(run.id)).toEqual([]);
    expect(await readFile(path.join(f.source, 'result.txt'), 'utf8')).toBe(writeCall.args.content);
    finish.resolve(); expect((await app.runtime.wait(run.id))?.status).toBe('completed');
  });

  test.each(['diff', 'approval'] as const)('异步读取权限与文件审查并存，先结束 %s 后仍保持等待', async first => {
    const outside = path.join(f.root, 'outside.txt'); await writeFile(outside, '工作区外的读取内容');
    const product = await app.product.draft();
    await product.settings.updateToolConfig('read_file', { outsideWorkspaceAccess: 'ask' });
    await app.product.save(product);
    const approvalRequested = nextEvent('approval.requested');
    const diffRequested = nextEvent('diff.review.requested');
    const readCall = { id: 'read-outside', name: 'read_file', args: { path: outside, task_handle: 'read_outside' }, async: true };
    let generations = 0;
    generate = async input => {
      if (++generations === 1) {
        expect(input.onToolCallReady?.(readCall)).toBe(true);
        await approvalRequested;
        return { role: 'model', parts: [{ functionCall: readCall }, { functionCall: writeCall }] };
      }
      if (generations === 2) return { role: 'model', parts: [{ functionCall: {
        id: 'wait-read', name: 'wait_for_tasks', args: { task_handles: ['read_outside'] },
      } }] };
      resumed.resolve(); await finish.promise;
      return { role: 'model', parts: [{ text: '处理完成' }] };
    };
    const run = await start();
    const approvalId = String((await approvalRequested).payload.id), diffId = String((await diffRequested).payload.diffId);
    const resolveDiff = () => app.diffs.resolve('owner', diffId, true);
    const resolveApproval = () => app.runtime.resolveApproval(approvalId, 'owner', true);
    const firstResolved = nextEvent(first === 'diff' ? 'diff.review.resolved' : 'approval.resolved');
    await (first === 'diff' ? resolveDiff() : resolveApproval()); await firstResolved;
    expect((await app.storage.getRun(run.id))?.status).toBe('awaiting_approval');
    expect(app.runtime.hasPendingApproval(run.id)).toBe(true);
    const lastResolved = nextEvent(first === 'diff' ? 'approval.resolved' : 'diff.review.resolved');
    await (first === 'diff' ? resolveApproval() : resolveDiff()); await lastResolved;
    await resumed.promise;
    expect((await app.storage.getRun(run.id))?.status).toBe('running');
    expect(app.runtime.hasPendingApproval(run.id)).toBe(false);
    finish.resolve(); expect((await app.runtime.wait(run.id))?.status).toBe('completed');
  });
});
