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
    services.preparePrompt = async () => { entered.resolve(); await release.promise; return { systemPrompt: '', toolNames: ['read'] }; };
    const started = runtime.start(input); const rejected = expect(started).rejects.toThrow('Runtime is closing');
    await entered.promise;
    let closed = false; const closing = runtime.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    try { expect(closed).toBe(false); } finally { release.resolve(); }
    await rejected; await closing;
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

  test('工具准备期间取消只结算该调用，不执行尚未开始的工具', async () => {
    const entered = deferred(), release = deferred();
    const execute = jest.fn(async () => ({ success: true }));
    services.tools = new RuntimeToolRegistry();
    services.tools.register({ declaration: { name: 'read', description: '读取', parameters: { type: 'object', properties: {} } },
      effects: () => ['public_read'], execute });
    services.models.generate = async () => ({ role: 'model', parts: [{ functionCall: { id: 'call', name: 'read', args: {} } }] });
    services.beforeTool = async () => { entered.resolve(); await release.promise; };
    const run = await runtime.start(input); await entered.promise;
    await runtime.cancel(run.id, 'owner'); release.resolve();
    expect((await runtime.wait(run.id))?.status).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
    const responses = (await f.store.readFullHistory(input.conversationId)).messages.flatMap(message => message.parts)
      .filter(part => part.functionResponse);
    expect(responses).toEqual([{ functionResponse: expect.objectContaining({ id: 'call', response: expect.objectContaining({ code: 'CANCELLED' }) }) }]);
  });
});
