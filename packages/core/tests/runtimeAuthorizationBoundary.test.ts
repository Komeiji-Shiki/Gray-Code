import { PlatformRuntime, RuntimeToolRegistry } from '@graycode/core';
import type { ActorIdentity, AgentDefinition, WorkspaceDefinition } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test.each(['effects', 'workspaceIds', 'mcpTools'] as const)('工具准备期间撤销 %s 后不使用旧授权执行', async grant => {
  const f = await fixture(); const entered = deferred(), release = deferred();
  const name = grant === 'mcpTools' ? 'mcp__fixture__read' : 'read';
  let actor: ActorIdentity = { id: 'member', role: 'member', displayName: '成员', effects: ['workspace_read'],
    workspaceIds: ['workspace'], mcpTools: [name] };
  const workspace: WorkspaceDefinition = { id: 'workspace', name: '隔离工作区', deviceId: 'local', directory: f.root };
  const agent: AgentDefinition = { id: 'agent', name: '代理', providerId: 'fixture', systemPrompt: '', approvalMode: 'sensitive', maxIterations: 2, toolNames: [name] };
  const tools = new RuntimeToolRegistry(); const execute = jest.fn(async () => ({ success: true }));
  tools.register({ declaration: { name, description: '测试权限', parameters: { type: 'object', properties: {} } }, effects: () => ['workspace_read'], execute });
  const runtime = new PlatformRuntime({ storage: f.store, tools,
    actor: async () => structuredClone(actor), agent: async () => agent, workspace: async () => workspace,
    beforeTool: async () => { entered.resolve(); await release.promise; },
    models: { generate: async input => input.messages.some(message => message.isFunctionResponse)
      ? { role: 'model', parts: [{ text: '结束' }] }
      : { role: 'model', parts: [{ functionCall: { id: 'read-call', name, args: {} } }] } } });
  try {
    await f.store.createConversation({ ...metadata('permission-boundary'), actorId: actor.id, workspaceId: workspace.id });
    const run = await runtime.start({ actorId: actor.id, conversationId: 'permission-boundary', agentId: agent.id,
      workspaceId: workspace.id, requestKey: grant, message: { role: 'user', parts: [{ text: '开始' }] } });
    await entered.promise;
    actor = { ...actor, [grant]: [] }; release.resolve();
    await runtime.wait(run.id);
    expect(execute).not.toHaveBeenCalled();
    const results = (await f.store.readFullHistory('permission-boundary')).messages.flatMap(message => message.parts)
      .flatMap(part => part.functionResponse ? [part.functionResponse] : []);
    expect(results).toEqual([expect.objectContaining({ id: 'read-call', response: expect.objectContaining({ success: false, code: 'PERMISSION_DENIED' }) })]);
  } finally { release.resolve(); await runtime.close(); await f.cleanup(); }
});
