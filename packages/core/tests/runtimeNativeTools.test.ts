import { PlatformRuntime, PlatformStorage, RuntimeToolRegistry } from '@graycode/core';
import type { ModelProvider, ToolOutcome } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

const call = { id: 'async-read', name: 'read', args: { task_handle: 'read_once' }, async: true };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function setup(models: ModelProvider, execute: (signal: AbortSignal) => Promise<ToolOutcome>, approval?: 'ask', native = false, stopAfterTools = false) {
  const f = await fixture(); const tools = new RuntimeToolRegistry();
  tools.register({ declaration: { name: 'read', description: '读取', parameters: { type: 'object', properties: {} } }, parallelRead: true,
    nativeAsync: native ? true : undefined,
    effects: () => native ? ['process_execute'] : ['public_read'], execute: (args, context) => { expect(args.task_handle).toBeUndefined(); return execute(context.signal); } });
  const runtime = new PlatformRuntime({ storage: f.store, tools, models: { supportsAsyncTools: () => true, ...models },
    ...(stopAfterTools ? { afterTools: async () => ({ stop: true }) } : {}),
    actor: async () => ({ id: 'owner', displayName: '测试', role: 'owner', effects: [], workspaceIds: '*' }), workspace: async () => null,
    agent: async () => ({ id: 'test', name: '测试', providerId: 'fixture', systemPrompt: '', approvalMode: 'sensitive',
      ...(approval ? { toolApproval: { read: approval } } : {}), maxIterations: 8, toolNames: ['read'] }) });
  await runtime.initialize(); await f.store.createConversation(metadata('native'));
  return { f, runtime, start: () => runtime.start({ actorId: 'owner', agentId: 'test', conversationId: 'native', requestKey: 'native', message: { role: 'user', parts: [{ text: '开始' }] } }) };
}

test('a native read runs before model completion, is executed once and is saved after its call', async () => {
  const entered = deferred(); let executions = 0, generations = 0, ended = 0;
  const context = await setup({ endRun: () => { ended++; }, generate: async input => {
    if (++generations === 2) return { role: 'model', parts: [{ functionCall: { id: 'wait-read', name: 'wait_for_tasks', args: { task_handles: ['read_once'] } } }] };
    if (generations === 3) { expect(input.messages.flatMap(message => message.parts).filter(part => (part.functionResponse as any)?.id === call.id)).toHaveLength(1); return { role: 'model', parts: [{ text: 'done' }] }; }
    expect(input.tools[0].async).toBe(true); expect(input.onToolCallReady?.(call)).toBe(true);
    await entered.promise;
    return { role: 'model', parts: [{ functionCall: call }, { text: 'independent work' }] };
  } }, async () => { executions++; entered.resolve(); return { success: true, data: 'file' }; });
  try {
    const run = await context.start(); expect((await context.runtime.wait(run.id))?.status).toBe('completed');
    expect(executions).toBe(1); expect(ended).toBe(1);
    const history = (await context.f.store.readFullHistory('native')).messages;
    expect(history[1].parts[0].functionCall).toMatchObject(call);
    expect(history[2].parts[0].functionResponse).toMatchObject({ id: call.id });
  } finally { await context.runtime.close(); await context.f.cleanup(); }
});

test('跨多轮继续工作，只等待指定任务，完成结果只交付一次且句柄不能复用', async () => {
  const slow = deferred(), fast = deferred(); let executions = 0, generations = 0;
  const slowCall = { ...call, id: 'slow', args: { task_handle: 'slow' } };
  const fastCall = { ...call, id: 'fast', args: { task_handle: 'fast' } };
  const context = await setup({ generate: async input => {
    generations++;
    const responses = input.messages.flatMap(message => message.parts).flatMap(part => part.functionResponse ? [part.functionResponse as any] : []);
    if (generations === 1) {
      expect(input.onToolCallReady?.(slowCall)).toBe(true); expect(input.onToolCallReady?.(fastCall)).toBe(true);
      return { role: 'model', parts: [{ functionCall: slowCall }, { functionCall: fastCall }, { text: 'independent work' }] };
    }
    if (generations === 2) {
      expect(input.pendingToolCallIds).toEqual(['slow', 'fast']); expect(responses).toHaveLength(0);
      fast.resolve();
      return { role: 'model', parts: [{ functionCall: { id: 'wait-fast', name: 'wait_for_tasks', args: { task_handles: ['fast'] } } }] };
    }
    if (generations === 3) {
      expect(responses.some(value => value.id === 'fast')).toBe(true); expect(responses.some(value => value.id === 'slow')).toBe(false);
      slow.resolve();
      return { role: 'model', parts: [{ functionCall: { id: 'wait-slow', name: 'wait_for_tasks', args: { task_handles: ['slow'] } } }] };
    }
    if (generations === 4) return { role: 'model', parts: [{ functionCall: { ...fastCall, id: 'reused-handle' } }] };
    if (responses.some(value => value.id === 'reused-handle')) {
      expect(responses.find(value => value.id === 'reused-handle').response.code).toBe('INVALID_TASK_HANDLE');
      return { role: 'model', parts: [{ text: 'done' }] };
    }
    return { role: 'model', parts: [{ functionCall: { id: 'wait-invalid', name: 'wait_for_tasks', args: { task_handles: ['fast'] } } }] };
  } }, async () => { const index = executions++; await (index === 0 ? slow.promise : fast.promise); return { success: true }; });
  try {
    const run = await context.start(); expect((await context.runtime.wait(run.id))?.status).toBe('completed');
    expect(executions).toBe(2);
    const results = (await context.f.store.readFullHistory('native')).messages.flatMap(message => message.parts)
      .flatMap(part => part.functionResponse ? [part.functionResponse as any] : []);
    expect(results.filter(value => value.id === 'slow')).toHaveLength(1); expect(results.filter(value => value.id === 'fast')).toHaveLength(1);
    expect(await context.f.store.listRecords('native-tool-calls')).toEqual([]);
  } finally { slow.resolve(); fast.resolve(); await context.runtime.close(); await context.f.cleanup(); }
});

test('stream failure cancels an issued read and preserves a paired history for the next task', async () => {
  const entered = deferred(); let cancelled = false;
  const context = await setup({ generate: async input => {
    input.onToolCallReady?.(call); await entered.promise; throw new Error('synthetic stream failure');
  } }, async signal => { entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
    return { success: false, code: 'CANCELLED', error: 'stopped by fixture', data: { cleaned: true } }; });
  try {
    const run = await context.start(); expect((await context.runtime.wait(run.id))?.status).toBe('failed'); expect(cancelled).toBe(true);
    const history = (await context.f.store.readFullHistory('native')).messages;
    expect(history[1]).toMatchObject({ incompleteReason: 'interrupted', parts: [{ functionCall: call }] });
    // 工具已给出的取消结果（原因、清理情况）优先于通用的中断占位，且只保存一次
    const responses = history.flatMap(message => message.parts).flatMap(part => part.functionResponse ? [part.functionResponse as any] : []);
    expect(responses).toEqual([expect.objectContaining({ id: call.id, response: { success: false, code: 'CANCELLED', error: 'stopped by fixture', data: { cleaned: true } } })]);
  } finally { await context.runtime.close(); await context.f.cleanup(); }
});

test('工具在停止时抛出异常，仍只保存一个配对的失败结果', async () => {
  const entered = deferred();
  const context = await setup({ generate: async input => {
    input.onToolCallReady?.(call); await entered.promise; throw new Error('synthetic stream failure');
  } }, async () => { entered.resolve(); throw new Error('tool crashed while stopping'); });
  try {
    const run = await context.start(); expect((await context.runtime.wait(run.id))?.status).toBe('failed');
    const responses = (await context.f.store.readFullHistory('native')).messages.flatMap(message => message.parts)
      .flatMap(part => part.functionResponse ? [part.functionResponse as any] : []);
    expect(responses).toHaveLength(1); expect(responses[0]).toMatchObject({ id: call.id, response: { success: false } });
  } finally { await context.runtime.close(); await context.f.cleanup(); }
});

test('a read that requires approval cannot be started by the early callback', async () => {
  let executions = 0;
  const context = await setup({ generate: async input => {
    expect(input.tools[0].async).toBeUndefined(); expect(input.onToolCallReady?.(call)).toBe(false);
    return { role: 'model', parts: [{ text: 'done' }] };
  } }, async () => { executions++; return { success: true }; }, 'ask');
  try { const run = await context.start(); expect((await context.runtime.wait(run.id))?.status).toBe('completed'); expect(executions).toBe(0); }
  finally { await context.runtime.close(); await context.f.cleanup(); }
});

test('原生异步的进程操作在审批后执行，等待不会跳过原审批入口', async () => {
  const asked = deferred<string>(); let executions = 0, generations = 0;
  const context = await setup({ generate: async input => {
    if (++generations === 1) {
      expect(input.tools[0].async).toBe(true); expect(input.onToolCallReady?.(call)).toBe(true);
      return { role: 'model', parts: [{ functionCall: call }] };
    }
    if (generations === 2) {
      const approvalId = await asked.promise; expect(executions).toBe(0);
      await context.runtime.resolveApproval(approvalId, 'owner', true);
      return { role: 'model', parts: [{ functionCall: { id: 'approved-wait', name: 'wait_for_tasks', args: { task_handles: ['read_once'] } } }] };
    }
    return { role: 'model', parts: [{ text: 'done' }] };
  } }, async () => { executions++; return { success: true }; }, 'ask', true);
  context.runtime.subscribe(event => { if (event.type === 'event' && event.event.type === 'approval.requested') asked.resolve(String(event.event.payload.id)); });
  try { const run = await context.start(); expect((await context.runtime.wait(run.id))?.status).toBe('completed'); expect(executions).toBe(1); }
  finally { await context.runtime.close(); await context.f.cleanup(); }
});

test('重启从 SQLite 恢复异步终态与附件，不重放操作或重复补齐结果', async () => {
  const context = await setup({ generate: async () => ({ role: 'model', parts: [{ text: 'done' }] }) }, async () => { throw new Error('不能重放'); });
  try {
    const run = await context.start(); await context.runtime.wait(run.id);
    await context.f.store.appendHistory('native', [{ id: 'saved-native-call', role: 'model', runId: run.id, parts: [{ functionCall: call }] }]);
    await context.f.store.putRecord({ namespace: 'native-tool-calls', id: `${run.id}:${call.id}`, ownerId: 'native',
      value: { run, call, handle: 'read_once', detached: false, published: true,
        outcome: { success: true, data: 'saved', attachments: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }] } } });
    const unpublished = { ...call, id: 'unpublished-read', args: { task_handle: 'unpublished' } };
    await context.f.store.putRecord({ namespace: 'native-tool-calls', id: `${run.id}:${unpublished.id}`, ownerId: 'native',
      value: { run, call: unpublished, handle: 'unpublished', detached: false, published: false,
        outcome: { success: true, data: 'unpublished-result' } } });
    await context.runtime.close(); await context.f.store.close(); context.f.store = await PlatformStorage.open(context.f.data);
    const recovery = new PlatformRuntime({ storage: context.f.store, tools: new RuntimeToolRegistry(),
      models: { generate: async () => { throw new Error('不能重新生成'); } }, actor: async () => null, agent: async () => null, workspace: async () => null });
    const outlines = jest.spyOn(context.f.store, 'readHistoryOutline');
    const fullReads = jest.spyOn(context.f.store, 'readFullHistory');
    await recovery.initialize(); await recovery.initialize();
    expect(outlines).toHaveBeenCalledTimes(1);
    expect(fullReads).not.toHaveBeenCalled();
    fullReads.mockRestore(); outlines.mockRestore();
    const history = (await context.f.store.readFullHistory('native')).messages;
    expect(history.flatMap(message => message.parts).filter(part => (part.functionResponse as any)?.id === call.id)).toHaveLength(1);
    const response = history.find(message => message.parts.some(part => (part.functionResponse as any)?.id === call.id));
    expect(response!.parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } });
    const unpublishedCall = history.findIndex(message => message.parts.some(part => (part.functionCall as any)?.id === unpublished.id));
    expect(history[unpublishedCall].parentId).toBe(response!.id);
    expect(history[unpublishedCall + 1]).toMatchObject({ parentId: history[unpublishedCall].id,
      parts: [{ functionResponse: { id: unpublished.id, response: { success: true, data: 'unpublished-result' } } }] });
    expect(await context.f.store.listRecords('native-tool-calls')).toEqual([]); await recovery.close();
  } finally { await context.runtime.close(); await context.f.cleanup(); }
});

test('宿主确认后结束任务会取消剩余观察，并保存配对结果', async () => {
  const entered = deferred(); let cancelled = false;
  const context = await setup({ generate: async input => {
    input.onToolCallReady?.(call); await entered.promise;
    return { role: 'model', parts: [{ functionCall: call }] };
  } }, async signal => {
    entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
    return { success: false, code: 'CANCELLED' };
  }, undefined, false, true);
  try {
    const run = await context.start(); expect((await context.runtime.wait(run.id))?.status).toBe('completed'); expect(cancelled).toBe(true);
    const responses = (await context.f.store.readFullHistory('native')).messages.flatMap(message => message.parts)
      .flatMap(part => part.functionResponse ? [part.functionResponse as any] : []);
    expect(responses).toHaveLength(1); expect(responses[0]).toMatchObject({ id: call.id, response: { code: 'CANCELLED' } });
  } finally { await context.runtime.close(); await context.f.cleanup(); }
});
