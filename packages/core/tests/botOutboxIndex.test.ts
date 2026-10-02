import type { PlatformApplication } from '../../../apps/server/src/application';
import type { BotGateway, BotReply } from '../../../apps/server/src/bots/gateway';
import { BotOutbox } from '../../../apps/server/src/bots/outbox';
import { BotSessions, type BotRoute } from '../../../apps/server/src/bots/sessions';
import { fixture } from './fixtures';

describe('Bot 待发送索引', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let sent: BotReply[]; let connected: boolean; let admitted: number;
  let gateway: BotGateway;
  const route: BotRoute = { platform: 'discord', botId: '900', channelId: '30', actorId: 'owner', conversationId: 'conversation', platformUserId: '10', direct: false };
  const outbox = () => new BotOutbox(app, 'discord', () => connected ? { gateway, botId: '900' } : undefined, async () => { admitted++; return true; });
  beforeEach(async () => {
    f = await fixture(); app = { storage: f.store } as PlatformApplication; sent = []; connected = true; admitted = 0;
    gateway = { connect: async () => ({ id: '900', name: '测试 Bot' }), disconnect: async () => {}, send: async () => {},
      sendReply: async (_channel, reply) => { sent.push(reply); return { id: String(sent.length) }; }, editReply: async () => {} };
  });
  afterEach(async () => { await f.cleanup(); });

  test('流式更新不再列举整个队列，锁内每个条目只读取一次，发送状态与回执不变', async () => {
    const value = outbox();
    connected = false;
    for (let index = 0; index < 5; index++) await value.put(`waiting-${index}`, route, [{ content: `等待 ${index}` }], false);
    const list = jest.spyOn(f.store, 'listRecords'), get = jest.spyOn(f.store, 'getRecord');
    expect(value.status().pendingMessages).toBe(5);
    // 断线时排队的条目不读取正文。
    await value.flush();
    expect(list).not.toHaveBeenCalled();
    expect(get.mock.calls.filter(([namespace]) => namespace === 'discord-outbox')).toEqual([]);
    connected = true; get.mockClear(); admitted = 0;
    await value.put('stream', route, [{ content: '第一帧' }], false);
    expect(list).not.toHaveBeenCalled();
    // put 自身读取一次旧记录；投递时 6 个条目各在锁内读取一次。
    expect(get.mock.calls.filter(([namespace, id]) => namespace === 'discord-outbox' && id === 'stream')).toHaveLength(2);
    expect(get.mock.calls.filter(([namespace]) => namespace === 'discord-outbox')).toHaveLength(7);
    // 每个条目投递前检查一次准入，每条消息发送前再复查一次。
    expect(admitted).toBe(12);
    // 同一毫秒创建的条目按编号排序，跨毫秒按创建时间；这里只要求排队的条目按原顺序且都已发出。
    expect(sent.map(item => item.content).filter(content => content!.startsWith('等待'))).toEqual(['等待 0', '等待 1', '等待 2', '等待 3', '等待 4']);
    expect(sent.map(item => item.content)).toContain('第一帧');
    await value.put('stream', route, [{ content: '最终' }]);
    expect(await value.list()).toHaveLength(5);
    expect(await f.store.getRecord('discord-delivered', 'stream')).toMatchObject({ messageIds: [String(sent.findIndex(item => item.content === '第一帧') + 1)] });
    await value.put('stream', route, [{ content: '重复终结' }]);
    expect(sent).toHaveLength(6);
  });

  test('重启后从存储载入一次，中断的发送标记为未确认且不会自动重发', async () => {
    await f.store.putRecord({ namespace: 'discord-outbox', id: 'interrupted', value: { version: 2, route, messages: [{ content: '可能已送达' }], next: 0,
      messageIds: [], sentHashes: [], phase: 'sending', final: true, createdAt: 1 } });
    const value = outbox();
    const list = jest.spyOn(f.store, 'listRecords');
    await value.flush(); await value.flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]); expect(value.status()).toMatchObject({ pendingMessages: 1, deliveryError: expect.stringContaining('尚未确认') });
    expect((await value.list())[0].phase).toBe('unknown');
    await value.retry('interrupted', true);
    expect(sent.map(item => item.content)).toEqual(['可能已送达']); expect(await value.list()).toEqual([]);
  });

  test('发送前权限判断只复制所需字段，不克隆完整设置', async () => {
    const settings = { accounts: [{ id: 'owner', role: 'owner', effects: [], workspaceIds: '*' }], bindings: [{ id: 'b', platform: 'discord', platformUserId: '10', accountId: 'owner' }],
      discord: { enabled: true, allowedChannelIds: ['30'] }, onebot: { enabled: false, allowedChannelIds: [] } };
    const snapshot = jest.fn(), read = jest.fn((...keys: string[]) => structuredClone(Object.fromEntries(keys.map(key => [key, (settings as Record<string, unknown>)[key]]))));
    const sessions = new BotSessions({ settings: { snapshot, read } } as unknown as PlatformApplication);
    await expect(sessions.admitted(route)).resolves.toBe(true);
    await expect(sessions.admitted({ ...route, channelId: '31' })).resolves.toBe(false);
    settings.bindings[0].platformUserId = '11';
    await expect(sessions.admitted(route)).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(3); expect(snapshot).not.toHaveBeenCalled();
  });
});
