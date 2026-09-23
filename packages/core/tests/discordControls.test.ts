import type { ApprovalRequest, ModelInput, ProviderDefinition } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import type { BotGateway, BotInteraction, BotModal, BotPanel, BotReply } from '../../../apps/server/src/bots/gateway';
import { discordModal, discordPanel } from '../../../apps/server/src/bots/discordComponents';
import { botKey } from '../../../apps/server/src/bots/sessions';
import { fixture } from './fixtures';

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const provider: ProviderDefinition = {
  id: 'fixture', name: '测试渠道', protocol: 'openai', endpoint: 'http://127.0.0.1:1/v1', model: 'model-0',
  models: Array.from({ length: 30 }, (_, index) => ({ id: `model-${index}`, name: `模型 ${index}` })), stream: true, timeoutMs: 60000,
  generation: {}, capabilities: { outputTokenParameter: 'protocol_default', strictTools: 'protocol_default', reasoningParameter: 'disabled',
    reasoningLevels: [], reasoningSignature: 'none', compatibility: { deepSeekUserId: false, openCodeSession: false, deepSeekVision: false, nativePdf: false } },
};
describe('Discord 原生操作与共享运行流程', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication;
  let handler: (input: BotInteraction) => Promise<void>;
  let generated: ModelInput[]; let hold: Promise<void> | undefined; let started: ReturnType<typeof deferred<ModelInput>>;
  let sent: Array<{ channelId: string; reply: BotReply }>; let serial: number;
  const context = (id: string, channelId = '30', authorId = '10', direct = false) => ({ platform: 'discord' as const, botId: '900', id, channelId, authorId, direct });
  test('源码和帮助指令不发起模型任务', async () => {
    const source = await app.discord.sessions.perform(context('source-notice'), { kind: 'source' });
    const help = await app.discord.sessions.perform(context('help-notice'), { kind: 'help' });
    expect(source.reply).toContain('AGPL-3.0-only');
    expect(help.reply).toContain('/gray source');
    expect(generated).toHaveLength(0);
    expect(await app.storage.listRuns({ limit: 1 })).toEqual([]);
  });
  async function menu(overrides: Partial<BotInteraction> = {}) {
    let panel!: BotPanel; let modal!: BotModal; const acknowledgements: string[] = [];
    await handler({ id: `interaction-${++serial}`, authorId: '10', channelId: '30', direct: false, kind: 'command',
      defer: async () => { acknowledgements.push('defer'); }, respond: async value => { panel = value; acknowledgements.push('respond'); },
      showModal: async value => { modal = value; acknowledgements.push('modal'); }, ...overrides });
    return { panel, modal, acknowledgements };
  }
  const button = (panel: BotPanel, label: string) => panel.rows!.flatMap(row => 'buttons' in row ? row.buttons : []).find(item => item.label === label)!;
  beforeEach(async () => {
    serial = 0; generated = []; sent = []; hold = undefined; started = deferred<ModelInput>(); f = await fixture(); await f.store.close();
    const gateway: BotGateway = { connect: async () => ({ id: '900', name: '隔离 Bot', controlsReady: true }), disconnect: async () => {},
      setInteractionHandler: value => { handler = value; }, send: async (channelId, content) => { sent.push({ channelId, reply: { content } }); },
      sendReply: async (channelId, reply) => { sent.push({ channelId, reply }); return { id: String(sent.length) }; },
      listGuilds: async () => [{ id: '100', name: '隔离服务器', unavailable: false }],
    };
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root, discordGateway: () => gateway,
      models: { generate: async input => { generated.push(input); started.resolve(input); if (hold) await hold;
        return { role: 'model', parts: [{ text: '隔离任务完成' }] }; } },
    });
    process.env.GRAYCODE_NATIVE_BOT_TEST_TOKEN = 'fixture-not-real';
    const value = app.settings.snapshot();
    value.settings.providers = [provider]; value.settings.agents[0].providerId = provider.id;
    value.settings.workspaces = [{ id: 'one', name: '工作区一', deviceId: 'local', directory: f.source }, { id: 'two', name: '工作区二', deviceId: 'local', directory: f.root }];
    value.settings.accounts.push({ id: 'member', displayName: '群聊成员', role: 'member', effects: ['public_read'], workspaceIds: [] });
    value.settings.bindings = [{ id: 'owner', platform: 'discord', platformUserId: '10', accountId: 'owner' }, { id: 'member', platform: 'discord', platformUserId: '20', accountId: 'member' }];
    value.settings.discord = { enabled: true, credentialRef: 'env:GRAYCODE_NATIVE_BOT_TEST_TOKEN', allowedChannelIds: ['30', '31'], agentId: 'default', mentionOnly: true,
      defaultProfile: { toolsEnabled: false }, directMessages: { enabled: true } };
    await app.settings.save({ settings: value.settings, expectedRevision: value.revision }); await app.discord.start();
  });

  test('权限选项分页保留完整说明和原始选项身份', async () => {
    const state = await app.discord.sessions.snapshot(context('choice-state'));
    const request: ApprovalRequest = { id: 'approval-choice', runId: 'unused', actorId: 'owner', toolCallId: 'external', toolName: 'external_fixture',
      args: { command: 'fixture' }, effects: [], reason: '完整的操作说明', choices: Array.from({ length: 30 }, (_, index) => ({
        id: `opaque/${index}==`, label: `选项 ${index + 1} 的完整说明`, kind: index === 26 ? 'allow_always' : 'allow_once',
      })) };
    state.approvals = [request];
    jest.spyOn(app.discord.sessions, 'snapshot').mockResolvedValue(state);
    const performed = jest.spyOn(app.discord.sessions, 'perform').mockResolvedValue({ reply: '已选择' });
    const home = await menu();
    const list = await menu({ kind: 'button', customId: button(home.panel, '待确认 1').id });
    const row = list.panel.rows!.find(value => 'select' in value)!;
    if (!('select' in row)) throw new Error('Expected approval menu');
    const detail = await menu({ kind: 'select', customId: row.select.id, values: ['0'] });
    expect(Buffer.from(detail.panel.files![0].data).toString()).toContain('完整的操作说明');
    const page = await menu({ kind: 'button', customId: button(detail.panel, '下一页').id });
    const choices = page.panel.rows!.find(value => 'select' in value)!;
    if (!('select' in choices)) throw new Error('Expected choice menu');
    expect(choices.select.options[0].label).toContain('26.');
    await menu({ kind: 'select', customId: choices.select.id, values: ['1'] });
    expect(performed).toHaveBeenCalledWith(expect.anything(), { kind: 'approval', approvalId: request.id, accepted: true, choiceId: 'opaque/26==' });
  });
  afterEach(async () => { delete process.env.GRAYCODE_NATIVE_BOT_TEST_TOKEN; await app.close(); await f.cleanup(); });

  test('原生菜单分页、单次操作票据、模型选择和表单均使用真实身份，私聊只允许主人', async () => {
    const initial = await menu(); expect(initial.acknowledgements).toEqual(['defer', 'respond']);
    expect((await app.storage.listConversations({ limit: 10 })).items).toHaveLength(0);
    const newButton = button(initial.panel, '新建对话');
    expect((await menu({ kind: 'button', customId: newButton.id, authorId: '20' })).panel.content).toContain('不属于当前账号');
    const created = await menu({ kind: 'button', customId: newButton.id });
    expect((await menu({ kind: 'button', customId: newButton.id })).panel.content).toContain('已经过期');
    expect((await app.storage.listConversations({ limit: 10 })).items).toHaveLength(1);
    const models = await menu({ kind: 'button', customId: button(created.panel, '切换模型').id });
    const payload = discordPanel(models.panel); expect(payload.components[0].toJSON().components[0]).toMatchObject({ type: 3 });
    expect('select' in models.panel.rows![0] && models.panel.rows![0].select.options).toHaveLength(25);
    const next = await menu({ kind: 'button', customId: button(models.panel, '下一页').id });
    const row = next.panel.rows![0]; if (!('select' in row)) throw new Error('缺少模型菜单');
    const picked = await menu({ kind: 'select', customId: row.select.id, values: [row.select.options[2].value] });
    expect((await app.discord.sessions.snapshot(context('read'))).model).toBe('model-27');
    const ask = await menu({ kind: 'button', customId: button(picked.panel, '发消息').id });
    expect(ask.acknowledgements).toEqual(['modal']); expect(discordModal(ask.modal).toJSON().components).toHaveLength(1);
    const response = await menu({ kind: 'modal', customId: ask.modal.id, fields: { text: '菜单发起的消息' } });
    expect(response.panel.content).toContain('任务已经开始');
    const run = (await app.storage.listRuns({ limit: 1 }))[0]; expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    expect(generated[0].modelOverride).toBe('model-27');
    expect((await menu({ direct: true, channelId: '99', authorId: '20' })).panel.content).toContain('只对主人开放');
    expect((await menu({ direct: true, channelId: '99' })).panel.content).toContain('操作面板');
    expect((await menu({ authorId: '20' })).panel.rows!.flatMap(row => 'buttons' in row ? row.buttons : []).some(item => item.label === '切换模型')).toBe(false);
  });

  test('任务保存来源和模型配置，切换频道与默认工作区不改变正在执行的任务', async () => {
    const gate = deferred<void>(); hold = gate.promise;
    try {
      const value = app.settings.snapshot(); value.settings.discord.defaultProfile = { workspaceId: 'one', modelId: 'model-2', toolsEnabled: false };
      await app.settings.save({ settings: value.settings, expectedRevision: value.revision });
      const result = await app.discord.sessions.perform(context('message-original'), { kind: 'message', text: '检查原目录' });
      await started.promise;
      const run = result.run!; expect(run.workspaceId).toBe('one'); expect(generated[0].modelOverride).toBe('model-2');
      expect(await app.discord.sessions.perform(context('message-original'), { kind: 'message', text: '重复事件' })).toEqual({ reply: '' });
      await expect(app.discord.sessions.perform(context('switch-channel', '31'), { kind: 'conversation', conversationId: run.conversationId })).rejects.toThrow('这个频道');
      const changed = app.settings.snapshot(); changed.settings.discord.defaultProfile!.workspaceId = 'two';
      await app.settings.save({ settings: changed.settings, expectedRevision: changed.revision });
      gate.resolve(); expect((await app.runtime.wait(run.id))?.status).toBe('completed'); hold = undefined;
      const next = await app.discord.sessions.perform(context('next-message'), { kind: 'message', text: '继续原对话' });
      expect(next.run!.workspaceId).toBe('two'); expect(next.run!.conversationId).toBe(run.conversationId); await app.runtime.wait(next.run!.id);
      const history = await app.storage.readFullHistory(run.conversationId);
      expect(history.messages[0].source).toMatchObject({ platform: 'discord', messageId: 'message-original', platformUserId: '10' });
      await app.discord.close(); expect(sent.filter(item => item.reply.content?.startsWith('隔离任务完成')).map(item => item.channelId)).toEqual(['30', '30']);
    } finally { gate.resolve(); }
  });

  test('连接可以先于频道选择；旧版已处理事件不会因会话迁移重放', async () => {
    expect(app.discord.keepsAlive).toBe(true);
    const connectionEvents: unknown[] = [];
    const unsubscribe = app.subscribe(event => { if (event.type === 'bot.connection.changed') connectionEvents.push(event); });
    await app.discord.stop(); expect(app.discord.keepsAlive).toBe(false);
    expect(connectionEvents.length).toBeGreaterThan(0); unsubscribe();
    const value = app.settings.snapshot(); value.settings.discord.allowedChannelIds = [];
    await app.settings.save({ settings: value.settings, expectedRevision: value.revision });
    expect((await app.discord.start()).status).toBe('connected'); expect(app.discord.keepsAlive).toBe(true); expect(await app.discord.guilds()).toHaveLength(1);
    await expect(app.discord.sessions.perform(context('blocked'), { kind: 'message', text: '未启用频道' })).rejects.toThrow('尚未启用');
    await app.storage.putRecord({ namespace: 'discord-receipts', id: 'old-message', value: { receivedAt: 1 } });
    expect(await app.discord.sessions.perform(context('old-message', '99', '10', true), { kind: 'new' })).toEqual({ reply: '' });
    expect((await app.storage.listConversations({ limit: 10 })).items).toHaveLength(0);
    const owner = await menu({ channelId: '99', direct: true });
    const revoked = app.settings.snapshot(); revoked.settings.bindings = revoked.settings.bindings.filter(item => item.accountId !== 'owner');
    await app.settings.save({ settings: revoked.settings, expectedRevision: revoked.revision });
    expect((await menu({ kind: 'button', customId: button(owner.panel, '新建对话').id, channelId: '99', direct: true })).panel.content).toContain('尚未绑定');
    expect(await app.storage.getRecord('bot-receipts', botKey('discord', '900', 'old-message'))).toBeNull();
  });
});
