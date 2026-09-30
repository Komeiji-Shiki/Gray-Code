import { PlatformRuntime, RuntimeToolRegistry } from '@graycode/core';
import type { ModelProvider, ToolOutcome } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

const call = { id: 'async-read', name: 'read', args: {}, async: true };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function setup(models: ModelProvider, execute: (signal: AbortSignal) => Promise<ToolOutcome>, approval?: 'ask') {
  const f = await fixture(); const tools = new RuntimeToolRegistry();
  tools.register({ declaration: { name: 'read', description: '读取', parameters: { type: 'object', properties: {} } }, parallelRead: true,
    effects: () => ['public_read'], execute: (_args, context) => execute(context.signal) });
  const runtime = new PlatformRuntime({ storage: f.store, tools, models,
    actor: async () => ({ id: 'owner', displayName: '测试', role: 'owner', effects: [], workspaceIds: '*' }), workspace: async () => null,
    agent: async () => ({ id: 'test', name: '测试', providerId: 'fixture', systemPrompt: '', approvalMode: 'sensitive',
      ...(approval ? { toolApproval: { read: approval } } : {}), maxIterations: 3, toolNames: ['read'] }) });
  await runtime.initialize(); await f.store.createConversation(metadata('native'));
  return { f, runtime, start: () => runtime.start({ actorId: 'owner', agentId: 'test', conversationId: 'native', requestKey: 'native', message: { role: 'user', parts: [{ text: '开始' }] } }) };
}

test('a native read runs before model completion, is executed once and is saved after its call', async () => {
  const entered = deferred(); let executions = 0, generations = 0, ended = 0;
  const context = await setup({ endRun: () => { ended++; }, generate: async input => {
    if (++generations === 2) { expect(input.messages.flatMap(message => message.parts).filter(part => part.functionResponse)).toHaveLength(1); return { role: 'model', parts: [{ text: 'done' }] }; }
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

test('stream failure cancels an issued read and preserves a paired history for the next task', async () => {
  const entered = deferred(); let cancelled = false;
  const context = await setup({ generate: async input => {
    input.onToolCallReady?.(call); await entered.promise; throw new Error('synthetic stream failure');
  } }, async signal => { entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true })); return { success: false, code: 'CANCELLED' }; });
  try {
    const run = await context.start(); expect((await context.runtime.wait(run.id))?.status).toBe('failed'); expect(cancelled).toBe(true);
    const history = (await context.f.store.readFullHistory('native')).messages;
    expect(history[1]).toMatchObject({ incompleteReason: 'interrupted', parts: [{ functionCall: call }] });
    expect(history[2].parts[0].functionResponse).toMatchObject({ id: call.id, response: { code: 'INTERRUPTED' } });
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
