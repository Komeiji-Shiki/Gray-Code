import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ModelInput, RunRecord } from '@graycode/contracts';
import { authorizeEffects } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { actorForBotRun, resolveBotGuestActor, resolveBotUser } from '../../../apps/server/src/bots/permissions';
import { SettingsTransfer } from '../../../apps/server/src/settings/transfer';
import { fixture } from './fixtures';

describe('Bot 默认访客、逐工具授权与单人黑名单', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication;
  let generated: ModelInput[], executed: string[];
  let hold: { promise: Promise<void>; entered: () => void } | undefined;
  let release = () => {};
  const search = 'mcp__permission__search', other = 'mcp__permission__other';
  const inbound = (id: string, authorId = '100') => ({ id, authorId, authorName: '群成员', channelId: '30', content: '查询示例', mentioned: true, direct: false, timestamp: Date.now() });
  const context = (authorId = '100') => ({ ...inbound('context', authorId), platform: 'discord' as const, botId: '900' });
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); generated = []; executed = []; hold = undefined; release = () => {};
    process.env.GRAYCODE_PERMISSION_TEST_TOKEN = 'fixture-only';
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: path.join(f.root, 'documents'),
      discordGateway: () => ({ connect: async () => ({ id: '900', name: '隔离 Bot' }), disconnect: async () => {}, send: async () => {} }),
      models: { generate: async input => {
        generated.push(input);
        if (hold) { const current = hold; hold = undefined; current.entered(); await current.promise; input.signal.throwIfAborted(); }
        const user = input.messages.map(message => message.isUserInput === true).lastIndexOf(true);
        if (input.messages.slice(user).some(message => message.isFunctionResponse)) return { role: 'model', parts: [{ text: '完成' }] };
        return { role: 'model', parts: [search, other].map((name, index) => ({ functionCall: { id: `tool-${index}`, name, args: { query: '示例' } } })) };
      } } });
    const saved = app.settings.snapshot();
    saved.settings.accounts.push({ id: 'visitor', displayName: '默认访客', role: 'guest', effects: ['public_read'], workspaceIds: [], mcpTools: [search] },
      { id: 'individual', displayName: '单独权限', role: 'member', effects: ['public_read', 'high_risk'], workspaceIds: [], mcpTools: [other] });
    saved.settings.bindings = [{ id: 'owner', platform: 'discord', platformUserId: '10', accountId: 'owner' }];
    saved.settings.discord = { enabled: true, credentialRef: 'env:GRAYCODE_PERMISSION_TEST_TOKEN', allowedChannelIds: ['30'], agentId: 'default', mentionOnly: true };
    await app.settings.save({ settings: saved.settings, expectedRevision: saved.revision });
    jest.spyOn(app.mcp.manager, 'getAllTools').mockReturnValue([{ serverId: 'permission', serverName: '权限测试', cleanSchema: false, tools: ['search', 'other'].map(name => ({
      name, description: name, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    })) }]);
    jest.spyOn(app.mcp.manager, 'callTool').mockImplementation(async request => { executed.push(request.toolName); return { success: true, content: [{ type: 'text', text: '工具完成' }] }; });
    await app.mcp.synchronize(); await app.discord.start();
  });
  afterEach(async () => { release(); delete process.env.GRAYCODE_PERMISSION_TEST_TOKEN; await app.close(); await f.cleanup(); });
  async function update(change: (settings: ReturnType<typeof app.settings.snapshot>['settings']) => void) {
    const value = app.settings.snapshot(); change(value.settings); await app.settings.save({ settings: value.settings, expectedRevision: value.revision });
  }
  async function receive(id: string, authorId = '100'): Promise<RunRecord> {
    await app.discord.receive(inbound(id, authorId));
    const conversation = (await app.discord.sessions.snapshot(context(authorId))).conversation!;
    const run = (await app.storage.listRuns({ conversationId: conversation.id })).find(item => item.requestKey === `discord:${id}`)!;
    expect(run).toBeDefined(); await app.runtime.wait(run.id); return (await app.storage.getRun(run.id))!;
  }

  test('默认关闭，选定权限后未绑定成员可对话和搜索，其他 MCP 不会连带开放', async () => {
    await app.discord.receive(inbound('disabled')); expect(generated).toHaveLength(0);
    await update(settings => { settings.botGuestAccountId = 'visitor'; });
    const first = await receive('first'); expect(first.status).toBe('completed'); expect(executed).toEqual(['search']);
    const second = await receive('second', '101'); expect(second.actorId).not.toBe(first.actorId); expect(executed).toEqual(['search', 'search']);
    expect(app.runtime.pendingApprovals()).toEqual([]);
    const history = await app.storage.readFullHistory(first.conversationId);
    expect(history.messages.some(message => message.parts.some(part => (part.functionResponse as any)?.response?.code === 'PERMISSION_DENIED'))).toBe(true);
    expect((history.messages.find(message => message.isUserInput)?.source as any).platformUserId).toBe('100');
    expect(generated.flatMap(input => input.messages.flatMap(message => message.parts.map(part => part.text ?? ''))).join('\n')).not.toContain('"authorId"');
    const qq = resolveBotUser(app.settings.snapshot().settings, { platform: 'onebot', platformUserId: '100', network: 'qq' })!;
    expect(qq.id).not.toBe(first.actorId); expect(qq.mcpTools).toEqual([search]);
    expect(resolveBotGuestActor(app.settings.snapshot().settings, qq.id)?.id).toBe(qq.id);
    const draft = await app.product.draft();
    await new SettingsTransfer(app).import(draft, { format: 'graycode-platform', version: 1, settings: { botGuestAccountId: 'owner' } });
    expect(draft.app.botGuestAccountId).toBe('visitor');
    await expect(update(settings => { settings.botGuestAccountId = 'owner'; })).rejects.toThrow('非主人');
  });

  test('单人授权独立于默认权限，拉黑及删除账号不会回退到访客权限', async () => {
    await update(settings => { settings.botGuestAccountId = 'visitor'; settings.bindings.push({ id: 'individual-user', platform: 'discord', platformUserId: '200', accountId: 'individual' }); });
    await receive('individual', '200'); expect(executed).toEqual(['other']);
    await receive('visitor'); expect(executed).toEqual(['other', 'search']);
    await update(settings => { settings.bindings.find(binding => binding.id === 'individual-user')!.blocked = true; });
    const count = generated.length; await app.discord.receive(inbound('blocked', '200')); expect(generated).toHaveLength(count);
    expect(() => app.discord.sessions.authorize(context('200'))).toThrow('拉黑');
    const router = new ApplicationRouter(app);
    await router.call({ actorId: 'owner', clientId: 'account-test' }, 'ui.request', { type: 'platform.accounts.delete', data: { id: 'individual' } });
    expect(app.settings.snapshot().settings.bindings.find(binding => binding.platformUserId === '200')).toMatchObject({ accountId: '', blocked: true });
    expect(resolveBotUser(app.settings.snapshot().settings, { platform: 'discord', platformUserId: '200' })).toBeNull();
  });

  test('模型等待期间拉黑用户，后续工具及回复立即失去授权', async () => {
    await update(settings => { settings.botGuestAccountId = 'visitor'; });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    hold = { promise: new Promise<void>(resolve => { release = resolve; }), entered };
    await app.discord.receive(inbound('held')); await ready;
    const conversation = (await app.discord.sessions.snapshot(context())).conversation!;
    const run = (await app.storage.listRuns({ conversationId: conversation.id })).find(item => item.requestKey === 'discord:held')!;
    await update(settings => { settings.bindings.push({ id: 'blocked-visitor', platform: 'discord', platformUserId: '100', accountId: '', blocked: true }); });
    release(); await app.runtime.wait(run.id);
    expect(executed).toEqual([]); expect(await actorForBotRun(app, run.actorId, run)).toBeNull();
  });

  test('工作区默认仅对应当前机器人会话，不能借此访问其他频道或普通项目', async () => {
    await update(settings => { settings.botGuestAccountId = 'visitor'; const visitor = settings.accounts.find(account => account.id === 'visitor')!; visitor.role = 'member'; visitor.effects.push('workspace_read'); });
    const run = await receive('workspace'); expect(run.workspaceId).toBe(`workspace-${run.conversationId}`);
    const root = path.join(f.root, 'private-project'); await mkdir(root);
    const value = app.settings.snapshot(); value.settings.workspaces.push({ id: 'private', name: '私人项目', deviceId: 'local', directory: root });
    await app.settings.save({ settings: value.settings, expectedRevision: value.revision });
    const actor = (await actorForBotRun(app, run.actorId, run))!;
    expect(actor.workspaceIds).toContain(run.workspaceId);
    expect(authorizeEffects(actor, ['workspace_read'], app.settings.snapshot().settings.workspaces.find(workspace => workspace.id === 'private')!)).not.toBeNull();
    const otherWorkspace = await app.botWorkspaces.get({ platform: 'discord', botId: '900', channelId: '31', direct: false }, 'bot_other_channel');
    expect(authorizeEffects(actor, ['workspace_read'], app.settings.snapshot().settings.workspaces.find(workspace => workspace.id === otherWorkspace)!)).not.toBeNull();
    await expect(app.runtime.start({ actorId: run.actorId, conversationId: run.conversationId, agentId: 'default', workspaceId: otherWorkspace, requestKey: 'other-channel-attempt', message: { role: 'user', parts: [{ text: '拒绝另一个频道的目录' }] } })).rejects.toThrow('selected workspace');
    await expect(app.runtime.start({ actorId: run.actorId, conversationId: run.conversationId, agentId: 'default', workspaceId: 'private', requestKey: 'private-attempt', message: { role: 'user', parts: [{ text: '拒绝范围外工作区' }] } })).rejects.toThrow('selected workspace');
    await update(settings => { settings.accounts.find(account => account.id === 'visitor')!.botWorkspaceAccess = false; });
    expect((await receive('workspace-disabled')).workspaceId).toBeUndefined();
  });

  test('主人在自动工作区配置失效后仍能继续 Discord 对话', async () => {
    const first = await receive('owner-first', '10');
    expect(first.status).toBe('completed');
    expect(first.workspaceId).toBe(`workspace-${first.conversationId}`);

    await update(settings => {
      settings.workspaces = settings.workspaces.filter(workspace => workspace.id !== first.workspaceId);
    });

    const continued = await receive('owner-continued', '10');
    expect(continued.conversationId).toBe(first.conversationId);
    expect(continued.workspaceId).toBeUndefined();
    expect(continued.status).toBe('completed');
  });
});
