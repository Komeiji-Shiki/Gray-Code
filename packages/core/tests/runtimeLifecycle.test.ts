import { PlatformRuntime, RuntimeToolRegistry, type RuntimeServices } from '@graycode/core';
import type { AgentDefinition } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('运行器启动、关闭和工具准备的取消边界', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let runtime: PlatformRuntime;
  let services: RuntimeServices;
  const agent: AgentDefinition = { id: 'agent', name: '测试', providerId: 'fixture', systemPrompt: '',
    approvalMode: 'sensitive', maxIterations: 2, toolNames: ['read'] };
  const input = { actorId: 'owner', conversationId: 'lifecycle', requestKey: 'start', agentId: agent.id,
    message: { role: 'user', parts: [{ text: '开始' }] } };
  beforeEach(async () => {
    f = await fixture(); await f.store.createConversation({ ...metadata(input.conversationId), actorId: 'owner' });
    services = { storage: f.store, tools: new RuntimeToolRegistry(),
      actor: async () => ({ id: 'owner', role: 'owner', displayName: '主人', effects: [], workspaceIds: '*' }),
      agent: async () => agent, workspace: async () => null,
      models: { generate: jest.fn(async () => ({ role: 'model', parts: [{ text: '完成' }] })) } };
    services.tools.register({ declaration: { name: 'read', description: '读取', parameters: { type: 'object', properties: {} } },
      effects: () => ['public_read'], execute: async () => ({ success: true }) });
    runtime = new PlatformRuntime(services);
  });
  afterEach(async () => { await runtime.close(); await f.cleanup(); });

  test('关闭等待已受理的启动准备结束，并拒绝将其写成新任务', async () => {
    const entered = deferred(), release = deferred();
    const preparations: string[] = []; runtime.subscribe(event => { if (event.type === 'runtime.preparation.changed') preparations.push(event.type); });
    services.preparePrompt = async () => { entered.resolve(); await release.promise; return { systemPrompt: '', toolNames: ['read'] }; };
    const started = runtime.start(input); const rejected = expect(started).rejects.toThrow('Runtime is closing');
    await entered.promise;
    expect(runtime.preparingCount).toBe(1); expect(runtime.activeCount).toBe(0);
    let closed = false; const closing = runtime.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    try { expect(closed).toBe(false); } finally { release.resolve(); }
    await rejected; await closing;
    expect(runtime.preparingCount).toBe(0); expect(preparations).toEqual(['runtime.preparation.changed']);
    expect(await f.store.listRuns()).toEqual([]);
    expect(services.models.generate).not.toHaveBeenCalled();
  });

  test('关闭发生在存储提交期间时，已写入的任务结算取消且不再调用模型', async () => {
    const committed = deferred(), release = deferred();
    const original = f.store.commitConversation.bind(f.store);
    jest.spyOn(f.store, 'commitConversation').mockImplementationOnce(async value => {
      const result = await original(value); committed.resolve(); await release.promise; return result;
    });
    const started = runtime.start(input); await committed.promise;
    let closed = false; const closing = runtime.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    try { expect(closed).toBe(false); } finally { release.resolve(); }
    const run = await started; await closing;
    expect((await f.store.getRun(run.id))?.status).toBe('cancelled');
    expect(runtime.activeCount).toBe(0);
    expect(services.models.generate).not.toHaveBeenCalled();
  });

  test('启动准备期间的可信取消信号保持原身份，准备退出后不提交任务或历史', async () => {
    const entered = deferred(), release = deferred(); const controller = new AbortController();
    services.preparePrompt = async input => {
      expect(input.signal).toBe(controller.signal); entered.resolve(); await release.promise;
      return { systemPrompt: '', toolNames: ['read'] };
    };
    const started = runtime.start(input, undefined, { clientId: 'window', signal: controller.signal });
    const rejected = expect(started).rejects.toThrow('Cancelled by user');
    await entered.promise;
    controller.abort(new Error('Cancelled by user.')); release.resolve(); await rejected;
    expect(await f.store.listRuns()).toEqual([]);
    expect((await f.store.readFullHistory(input.conversationId)).messages).toEqual([]);
    expect(services.models.generate).not.toHaveBeenCalled();
  });

  test('取消发生在任务提交期间时，持久化输入保留且任务结算取消，不再调用模型', async () => {
    const committed = deferred(), release = deferred(); const controller = new AbortController();
    const original = f.store.commitConversation.bind(f.store);
    jest.spyOn(f.store, 'commitConversation').mockImplementationOnce(async value => {
      const result = await original(value); committed.resolve(); await release.promise; return result;
    });
    const started = runtime.start(input, undefined, { signal: controller.signal }); await committed.promise;
    controller.abort(new Error('Cancelled by user.')); release.resolve();
    const run = await started;
    expect((await runtime.wait(run.id))?.status).toBe('cancelled');
    expect(runtime.activeRunIds(input.conversationId)).toEqual([]);
    expect((await f.store.readFullHistory(input.conversationId)).messages).toEqual([
      expect.objectContaining({ role: 'user', runId: run.id, parts: input.message.parts }),
    ]);
    expect(services.models.generate).not.toHaveBeenCalled();
  });

  test('正式运行准备成功结束时清理准备计数，并发出不落库的生命周期通知', async () => {
    const entered = deferred(), release = deferred(); const preparations: string[] = [];
    services.preparePrompt = async () => { entered.resolve(); await release.promise; return { systemPrompt: '', toolNames: ['read'] }; };
    runtime.subscribe(event => { if (event.type === 'runtime.preparation.changed') preparations.push(event.type); });
    const started = runtime.start(input); await entered.promise;
    expect(runtime.preparingCount).toBe(1); expect(runtime.activeCount).toBe(0); expect(preparations).toEqual([]);
    release.resolve(); const run = await started; await runtime.wait(run.id);
    expect(runtime.preparingCount).toBe(0); expect(preparations).toEqual(['runtime.preparation.changed']);
    expect((await f.store.readRunEvents(run.id)).map(event => event.type)).not.toContain('runtime.preparation.changed');
  });

  test('模型前检查点等待期间取消，边界结束后不调用模型', async () => {
    const entered = deferred(), release = deferred();
    services.modelBoundary = async (_run, _workspace, _signal, phase) => {
      if (phase === 'before') { entered.resolve(); await release.promise; }
    };
    const run = await runtime.start(input);
    try {
      await entered.promise;
      await runtime.cancel(run.id, 'owner'); release.resolve();
      expect((await runtime.wait(run.id))?.status).toBe('cancelled');
      expect(services.models.generate).not.toHaveBeenCalled();
    } finally { release.resolve(); await runtime.wait(run.id); }
  });

  test('工具准备期间取消只结算该调用，不执行尚未开始的工具', async () => {
    const entered = deferred(), release = deferred();
    const execute = jest.fn(async () => ({ success: true }));
    services.tools = new RuntimeToolRegistry();
    services.tools.register({ declaration: { name: 'read', description: '读取', parameters: { type: 'object', properties: {} } },
      effects: () => ['public_read'], execute });
    services.models.generate = async () => ({ role: 'model', parts: [{ functionCall: { id: 'call', name: 'read', args: {} } }] });
    services.beforeTool = async () => { entered.resolve(); await release.promise; };
    const run = await runtime.start(input); await entered.promise;
    const fullHistory = jest.spyOn(f.store, 'readFullHistory');
    await runtime.cancel(run.id, 'owner'); release.resolve();
    expect((await runtime.wait(run.id))?.status).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
    expect(fullHistory).not.toHaveBeenCalled();
    fullHistory.mockRestore();
    const responses = (await f.store.readFullHistory(input.conversationId)).messages.flatMap(message => message.parts)
      .filter(part => part.functionResponse);
    expect(responses).toEqual([{ functionResponse: expect.objectContaining({ id: 'call', response: expect.objectContaining({ code: 'CANCELLED' }) }) }]);
  });
});
