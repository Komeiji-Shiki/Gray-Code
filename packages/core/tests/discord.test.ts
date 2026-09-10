import type { DiscordGateway, DiscordInbound } from '../../../apps/server/src/bots/discordGateway';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

test('Discord shares the channel history while retaining each authenticated sender, deduplicating and delivering tasks', async () => {
  const f = await fixture(); await f.store.close();
  const sent: { channelId: string; content: string }[] = [];
  const calls: string[] = [];
  const gateway: DiscordGateway = {
    connect: async () => ({ id: '900', name: 'Fixture' }),
    disconnect: async () => {},
    send: async (channelId, content) => { sent.push({ channelId, content }); },
  };
  const app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root, discordGateway: () => gateway,
    models: { generate: async input => { calls.push(input.taskContext!.actor.id); return { role: 'model', parts: [{ text: 'Completed fixture task' }] }; } },
  });
  process.env.GRAYCODE_BOT_TEST_TOKEN = 'fixture-not-real';
  try {
    const settings = app.settings.snapshot();
    settings.settings.accounts.push({ id: 'guest', displayName: '主人', role: 'guest', workspaceIds: [], effects: ['public_read'] });
    settings.settings.bindings = [
      { id: 'owner-discord', platform: 'discord', platformUserId: '10', accountId: 'owner' },
      { id: 'guest-discord', platform: 'discord', platformUserId: '20', accountId: 'guest' },
    ];
    settings.settings.discord = { enabled: true, credentialRef: 'env:GRAYCODE_BOT_TEST_TOKEN', allowedChannelIds: ['30'], agentId: 'default', mentionOnly: true };
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await app.discord.start();
    const message = (id: string, authorId: string, override: Partial<DiscordInbound> = {}): DiscordInbound => ({ id, authorId, channelId: '30', content: '<@900> start', mentioned: true, direct: false, ...override });
    await app.discord.receive(message('1', 'unbound'));
    await app.discord.receive(message('2', '10', { channelId: '99' }));
    await app.discord.receive(message('3', '10', { mentioned: false }));
    expect(calls).toEqual([]);
    await Promise.all([app.discord.receive(message('4', '10')), app.discord.receive(message('5', '20'))]);
    let runs = await app.storage.listRuns({ limit: 10 });
    await Promise.all(runs.map(run => app.runtime.wait(run.id)));
    await app.discord.sessions.inbox.flush(runs[0].conversationId);
    runs = await app.storage.listRuns({ limit: 10 }); await Promise.all(runs.map(run => app.runtime.wait(run.id)));
    await app.discord.receive(message('4', '10'));
    expect(calls.sort()).toEqual(['guest', 'owner']);
    expect(new Set(runs.map(run => run.conversationId)).size).toBe(1);
    await app.discord.close();
    expect(sent.filter(item => item.content.startsWith('Completed fixture task'))).toHaveLength(2);
    expect(sent.every(item => item.channelId === '30')).toBe(true);
  } finally { delete process.env.GRAYCODE_BOT_TEST_TOKEN; await app.close(); await f.cleanup(); }
});

test('真实运行器的三轮工具调用逐轮投递统计并在最终回复汇总', async () => {
  const f = await fixture(); await f.store.close(); const sent: string[] = []; let generated = 0; const executed: string[] = [];
  const gateway: DiscordGateway = { connect: async () => ({ id: '900', name: 'Fixture' }), disconnect: async () => {},
    send: async (_channel, content) => { sent.push(content); } };
  const app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root, discordGateway: () => gateway,
    models: { generate: async () => {
      const round = ++generated;
      return { role: 'model', thinkingDuration: round * 400, responseDuration: 2100, ttft: 100, chunkCount: 3,
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: round * 10, totalTokenCount: 100 + round * 10, cacheReadTokenCount: 10 },
        parts: [{ text: '隐藏的思考正文', thought: true }, ...(round === 3 ? [{ text: '三轮任务完成' }]
          : (round === 1 ? ['fixture_first', 'fixture_second'] : ['fixture_first']).map((name, index) => ({ functionCall: { id: `call-${round}-${index}`, name, args: {} } })))],
      };
    } },
  });
  process.env.GRAYCODE_ROUNDS_TEST_TOKEN = 'fixture-not-real';
  try {
    for (const name of ['fixture_first', 'fixture_second']) app.tools.register({ declaration: { name, description: '隔离测试的只读工具', parameters: { type: 'object', properties: {} } },
      effects: () => ['public_read'], execute: async () => { executed.push(name); return { success: true }; } });
    const settings = app.settings.snapshot(); settings.settings.agents[0].toolNames.push('fixture_first', 'fixture_second');
    settings.settings.bindings = [{ id: 'owner', platform: 'discord', platformUserId: '10', accountId: 'owner' }];
    settings.settings.discord = { enabled: true, credentialRef: 'env:GRAYCODE_ROUNDS_TEST_TOKEN', allowedChannelIds: ['30'], agentId: 'default', mentionOnly: true,
      output: { streaming: false, updateIntervalMs: 1000, showThoughts: true, showToolStatus: true, longReplies: 'split' } };
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision }); await app.discord.start();
    await app.discord.receive({ id: 'request', authorId: '10', channelId: '30', content: '<@900> 三轮测试', mentioned: true, direct: false });
    const run = (await app.storage.listRuns({ limit: 1 }))[0]; expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    await app.discord.close(); const text = sent.join('\n');
    expect(executed).toEqual(['fixture_first', 'fixture_second', 'fixture_first']);
    expect(text).toContain('第 1 轮 · 调用「fixture_first」、「fixture_second」'); expect(text).toContain('第 2 轮 · 调用「fixture_first」');
    expect(text).toContain('三轮任务完成'); expect(text).toContain('已进行思考 1.2 秒'); expect(text).not.toContain('隐藏的思考正文');
    expect(text).toContain('共 3 轮 · 合计 360 token · 输入 300 · 输出 60 · 缓存 30'); expect(text).toContain('TPS 10.0');
  } finally { delete process.env.GRAYCODE_ROUNDS_TEST_TOKEN; await app.close(); await f.cleanup(); }
});

test('自动连接遵从已保存的默认与开关，一个平台失败仍保留另一个连接', async () => {
  const f = await fixture(); await f.store.close(); let discordConnections = 0; let onebotConnections = 0;
  const options = { dataDirectory: f.data, documentsDirectory: f.root,
    discordGateway: () => ({ connect: async () => { discordConnections++; return { id: '900', name: 'Fixture' }; }, disconnect: async () => {}, send: async () => {} }),
    onebotGateway: () => ({ connect: async () => { onebotConnections++; throw new Error('模拟网关暂不可用'); }, disconnect: async () => {}, send: async () => {} }) };
  process.env.GRAYCODE_AUTOCONNECT_TEST_TOKEN = 'fixture-not-real';
  let app = await PlatformApplication.open(options);
  try {
    const settings = app.settings.snapshot();
    settings.settings.discord = { enabled: true, credentialRef: 'env:GRAYCODE_AUTOCONNECT_TEST_TOKEN', allowedChannelIds: [], agentId: 'default', mentionOnly: true };
    settings.settings.onebot = { enabled: true, endpoint: 'ws://127.0.0.1:1', allowedChannelIds: ['group:123'], agentId: 'default', mentionOnly: true };
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision }); await app.close();
    app = await PlatformApplication.open(options); await Promise.all([app.discord.autoConnect(), app.onebot.autoConnect()]);
    expect(discordConnections).toBe(1); expect(onebotConnections).toBe(1); expect(app.discord.status().status).toBe('connected');
    expect(app.onebot.status()).toMatchObject({ status: 'failed', error: '模拟网关暂不可用' });
    const next = app.settings.snapshot(); next.settings.discord.autoConnect = false; next.settings.onebot!.enabled = false;
    await app.settings.save({ settings: next.settings, expectedRevision: next.revision }); await app.close();
    app = await PlatformApplication.open(options); await Promise.all([app.discord.autoConnect(), app.onebot.autoConnect()]);
    expect(discordConnections).toBe(1); expect(onebotConnections).toBe(1); expect(app.discord.status().status).toBe('stopped');
  } finally { delete process.env.GRAYCODE_AUTOCONNECT_TEST_TOKEN; await app.close(); await f.cleanup(); }
});
