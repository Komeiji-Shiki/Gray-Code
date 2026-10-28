import { authorizeEffects, type ToolContext } from '@graycode/core';
import type { AgentDefinition, ModelInput, RunRecord, WorkspaceDefinition } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { actorForBotRun } from '../../../apps/server/src/bots/permissions';
import { fixture } from './fixtures';

describe('Bot 子代理授权继承与异步身份读取', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, agent: AgentDefinition;
  let workspace: WorkspaceDefinition;
  let seen: ModelInput[];
  const rootId = 'bot-root';
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); seen = [];
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
      seen.push(input);
      return input.conversationId === rootId || input.messages.some(message => message.parts.some(part => part.functionResponse))
        ? { role: 'model', parts: [{ text: '完成' }] }
        : { role: 'model', parts: [{ functionCall: { id: 'read-child', name: 'fixture_scope', args: {} } }] };
    } } });
    app.tools.register({ declaration: { name: 'fixture_scope', description: '读取当前目录', parameters: { type: 'object', properties: {} } },
      effects: () => ['workspace_read'], execute: async (_args, context) => ({ success: true, data: context.workspace?.directory }) });
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ type: 'openai', enabled: true, timeout: 1000,
      url: 'http://127.0.0.1:9/v1', name: '隔离模型', model: 'fixture', apiKey: '' });
    await app.product.save(draft);
    const snapshot = app.settings.snapshot();
    workspace = { id: `workspace-${rootId}`, name: '频道目录', deviceId: 'local', directory: f.root };
    agent = { ...snapshot.settings.agents[0], id: 'scope-agent', name: '继承范围测试', providerId, toolNames: ['fixture_scope'], maxIterations: 3 };
    snapshot.settings.agents.push(agent);
    snapshot.settings.workspaces.push(workspace, { ...workspace, id: 'workspace-other', name: '其他频道' });
    snapshot.settings.accounts.push({ id: 'member', role: 'member', displayName: '成员', effects: ['workspace_read', 'workspace_write'], workspaceIds: [], mcpTools: ['mcp__fixture__allowed'] });
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    await app.storage.createConversation({ id: rootId, actorId: 'member', title: '频道', workspaceId: workspace.id,
      createdAt: 1, updatedAt: 1, custom: { botOrigin: { platform: 'discord' } } });
  });
  afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });
  const runScope = (): RunRecord => ({ id: 'identity-read', requestKey: 'identity-read', conversationId: rootId, workspaceId: `workspace-${rootId}`,
    actorId: 'member', agentId: 'scope-agent', status: 'running', createdAt: 1, updatedAt: 1, iteration: 1, catalogVersion: 'fixture' });

  test('派发的子代理继承当前频道目录，其他频道和显式关闭仍被拒绝', async () => {
    const parent = await app.runtime.start({ actorId: 'member', agentId: agent.id, conversationId: rootId, workspaceId: workspace.id,
      requestKey: 'parent', message: { role: 'user', parts: [{ text: '派发' }] } });
    await app.runtime.wait(parent.id);
    const context: ToolContext = { actorId: parent.actorId, runId: parent.id, conversationId: rootId, agent, workspace,
      modelSelection: { providerId: agent.providerId }, signal: new AbortController().signal, toolCallId: 'dispatch-child',
      askUser: async () => { throw new Error('unused'); }, progress: () => {} };
    const result = await app.subagents.dispatch({ agentName: 'General Worker', prompt: '读取当前目录' }, context);
    const child = (await app.subagents.get('member', String((result.data as { runId: string }).runId)))!;
    expect((await actorForBotRun(app, 'member', { conversationId: child.conversationId, workspaceId: workspace.id }))!.workspaceIds).toEqual([workspace.id]);
    expect(child.coreRunIds.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ success: true, error: undefined });
    const messages = (await app.storage.readFullHistory(child.conversationId)).messages;
    expect(messages.flatMap(message => message.parts).find(part => part.functionResponse)).toMatchObject({
      functionResponse: { response: { success: true, data: f.root } },
    });
    const scoped = { ...runScope(), conversationId: child.conversationId };
    const inherited = (await actorForBotRun(app, 'member', scoped))!;
    expect(inherited.workspaceIds).toEqual([workspace.id]);
    expect(authorizeEffects(inherited, ['workspace_read'], { ...workspace, id: 'workspace-other' })).not.toBeNull();
    const snapshot = app.settings.snapshot(); snapshot.settings.accounts.find(item => item.id === 'member')!.botWorkspaceAccess = false;
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    expect(authorizeEffects((await actorForBotRun(app, 'member', scoped))!, ['workspace_read'], workspace)).not.toBeNull();
  });

  test('异步路由读取期间收紧授权，返回当前账号而非旧快照', async () => {
    jest.spyOn(app.discord.sessions, 'routeForRun').mockImplementationOnce(async () => {
      const snapshot = app.settings.snapshot();
      const account = snapshot.settings.accounts.find(item => item.id === 'member')!;
      account.effects = []; account.mcpTools = [];
      await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
      return null;
    });
    expect(await actorForBotRun(app, 'member', runScope())).toMatchObject({ effects: [], mcpTools: [] });
  });

  test('异步会话读取期间关闭频道目录授权，返回的账号不带旧目录', async () => {
    const read = app.storage.getConversation.bind(app.storage);
    jest.spyOn(app.storage, 'getConversation').mockImplementationOnce(async id => {
      const value = await read(id);
      const snapshot = app.settings.snapshot(); snapshot.settings.accounts.find(item => item.id === 'member')!.botWorkspaceAccess = false;
      await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
      return value;
    });
    const actor = (await actorForBotRun(app, 'member', { conversationId: rootId, workspaceId: workspace.id }))!;
    expect(actor.botWorkspaceAccess).toBe(false);
    expect(actor.workspaceIds).toEqual([]);
  });
});
