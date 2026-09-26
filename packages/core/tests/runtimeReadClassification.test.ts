import { PlatformRuntime, RuntimeToolRegistry } from '@graycode/core';
import { fixture, metadata } from './fixtures';

test('按参数判定只读，混合工具的修改动作即使无权限effects也保持串行屏障', async () => {
  const f = await fixture(); const tools = new RuntimeToolRegistry();
  let active = 0, maximum = 0, version = 0;
  const versions: number[] = [];
  tools.register({ declaration: { name: 'notes', description: 'mixed scoped notes', parameters: {
    type: 'object', properties: { action: { type: 'string', enum: ['read', 'append'] } }, required: ['action'],
  } }, parallelRead: args => args.action === 'read', effects: () => [], execute: async args => {
    if (args.action === 'append') { expect(active).toBe(0); version++; return { success: true }; }
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    versions.push(version); active--; return { success: true, data: { version } };
  } });
  const actions = ['read', 'read', 'append', 'read', 'read'];
  const runtime = new PlatformRuntime({ storage: f.store, tools,
    actor: async () => ({ id: 'owner', displayName: 'fixture', role: 'owner', effects: [], workspaceIds: '*' }),
    agent: async () => ({ id: 'test', name: 'fixture', providerId: 'fixture', systemPrompt: '', approvalMode: 'sensitive', maxIterations: 2, toolNames: ['notes'] }),
    workspace: async () => null, models: { generate: async input => input.messages.some(message => message.isFunctionResponse)
      ? { role: 'model', parts: [{ text: 'done' }] }
      : { role: 'model', parts: actions.map((action, index) => ({ functionCall: { id: `call-${index}`, name: 'notes', args: { action } } })) } },
  });
  try {
    await runtime.initialize(); await f.store.createConversation(metadata('mixed-read'));
    const run = await runtime.start({ actorId: 'owner', agentId: 'test', conversationId: 'mixed-read', requestKey: 'mixed-read', message: { role: 'user', parts: [{ text: 'read and append' }] } });
    expect((await runtime.wait(run.id))?.status).toBe('completed');
    expect(maximum).toBe(2); expect(versions).toEqual([0, 0, 1, 1]);
    const results = (await f.store.readFullHistory('mixed-read')).messages.flatMap(message => message.parts).flatMap(part => part.functionResponse ? [part.functionResponse as { id: string }] : []);
    expect(results.map(result => result.id)).toEqual(actions.map((_action, index) => `call-${index}`));
  } finally { await runtime.close(); await f.cleanup(); }
});
