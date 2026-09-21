import { PlatformRuntime, RuntimeToolRegistry } from '@graycode/core';
import { fixture, metadata } from './fixtures';

test('独立读取最多四个同时执行，写入保序，图片结果仍按调用顺序保存', async () => {
  const f = await fixture(); const tools = new RuntimeToolRegistry();
  let active = 0, maximum = 0, version = 0; const finished: number[] = [];
  tools.register({ declaration: { name: 'read', description: '读取', parameters: { type: 'object', properties: { index: { type: 'integer' } } } },
    parallelRead: true, effects: () => ['public_read'], execute: async args => {
      const index = Number(args.index); active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, (4 - index % 4) * 3));
      active--; finished.push(index);
      return { success: true, data: { index, version }, attachments: [{ mimeType: 'image/png', data: Buffer.from('image-' + index).toString('base64') }] };
    } });
  tools.register({ declaration: { name: 'write', description: '写入', parameters: { type: 'object', properties: {} } },
    parallelRead: true, effects: () => ['workspace_write'], execute: async () => { expect(active).toBe(0); version++; return { success: true }; } });
  const inputIds = [...Array.from({ length: 6 }, (_, index) => 'read-' + index), 'write', 'read-6'];
  const emitted: any[] = [];
  const runtime = new PlatformRuntime({ storage: f.store, tools,
    actor: async () => ({ id: 'owner', displayName: '测试', role: 'owner', effects: [], workspaceIds: '*' }),
    agent: async () => ({ id: 'test', name: '测试', providerId: 'fixture', systemPrompt: '固定', approvalMode: 'sensitive', toolApproval: { write: 'auto' }, maxIterations: 2, toolNames: ['read', 'write'] }),
    workspace: async () => null, models: { generate: async input => {
      if (input.messages.some(message => message.isFunctionResponse)) {
        const results = input.messages.flatMap(message => message.parts).filter(part => part.functionResponse).map(part => part.functionResponse as any);
        expect(results.map(result => result.id)).toEqual(inputIds);
        expect(results.slice(0, 6).every(result => result.response.data.version === 0)).toBe(true);
        expect(results.at(-1).response.data.version).toBe(1);
        return { role: 'model', parts: [{ text: '完成' }] };
      }
      for (let i = 0; i < 1000; i++) input.onDelta?.([{ text: '文' }]);
      return { role: 'model', parts: inputIds.map(id => ({ functionCall: { id, name: id === 'write' ? 'write' : 'read', args: id === 'write' ? {} : { index: Number(id.slice(5)) } } })) };
    } } });
  runtime.subscribe(event => { if (event.type === 'model.delta') emitted.push(event.parts); });
  try {
    await runtime.initialize(); await f.store.createConversation(metadata('schedule'));
    const run = await runtime.start({ actorId: 'owner', agentId: 'test', conversationId: 'schedule', requestKey: 'schedule', message: { role: 'user', parts: [{ text: '处理' }] } });
    expect((await runtime.wait(run.id))?.status).toBe('completed'); expect(maximum).toBe(4);
    expect(finished.slice(0, 4)).not.toEqual([0, 1, 2, 3]);
    expect(emitted.flat().map(part => part.text).join('')).toBe('文'.repeat(1000)); expect(emitted).toHaveLength(2);
    const events = await f.store.readRunEvents(run.id);
    expect(events.find(event => event.type === 'message.saved')?.payload.streaming).toEqual({ inputEvents: 1000, outputEvents: 2 });
  } finally { await runtime.close(); await f.cleanup(); }
});

test('取消并行读取后不执行后续写入，剩余调用都有成对结果', async () => {
  const f = await fixture(); const tools = new RuntimeToolRegistry();
  let entered = 0, ready!: () => void, writes = 0; const allStarted = new Promise<void>(resolve => { ready = resolve; });
  tools.register({ declaration: { name: 'read', description: '读取', parameters: { type: 'object', properties: {} } }, parallelRead: true,
    effects: () => ['public_read'], execute: async (_args, context) => {
      entered++; if (entered === 4) ready();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { success: false, code: 'CANCELLED' };
    } });
  tools.register({ declaration: { name: 'write', description: '写入', parameters: { type: 'object', properties: {} } },
    effects: () => ['workspace_write'], execute: async () => { writes++; return { success: true }; } });
  const runtime = new PlatformRuntime({ storage: f.store, tools,
    actor: async () => ({ id: 'owner', displayName: '测试', role: 'owner', effects: [], workspaceIds: '*' }),
    agent: async () => ({ id: 'test', name: '测试', providerId: 'fixture', systemPrompt: '', approvalMode: 'sensitive', toolApproval: { write: 'auto' }, maxIterations: 2, toolNames: ['read', 'write'] }),
    workspace: async () => null, models: { generate: async () => ({ role: 'model', parts: ['read', 'read', 'read', 'read', 'write'].map((name, index) => ({ functionCall: { id: String(index), name, args: {} } })) }) } });
  try {
    await runtime.initialize(); await f.store.createConversation(metadata('cancel-batch'));
    const run = await runtime.start({ actorId: 'owner', agentId: 'test', conversationId: 'cancel-batch', requestKey: 'cancel-batch', message: { role: 'user', parts: [{ text: '开始' }] } });
    await allStarted; await runtime.cancel(run.id, 'owner');
    expect((await runtime.wait(run.id))?.status).toBe('cancelled'); expect(writes).toBe(0);
    expect((await f.store.readFullHistory('cancel-batch')).messages.flatMap(message => message.parts).filter(part => part.functionResponse)).toHaveLength(5);
  } finally { await runtime.close(); await f.cleanup(); }
});
