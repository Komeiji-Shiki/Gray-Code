import { PlatformApplication } from '../../../apps/server/src/application';
import { BOT_CHANNEL_ACCESS } from '../../../apps/server/src/bots/channelAccess';
import type { BotContext } from '../../../apps/server/src/bots/sessions';
import { fixture } from './fixtures';

const context: BotContext = { platform: 'discord', botId: 'fixture', channelId: 'channel', authorId: 'owner', id: 'list', direct: false };
let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication;
beforeEach(async () => { f = await fixture(); await f.store.close(); app = await PlatformApplication.open({ dataDirectory: f.data }); });
afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });

function conversation(id: string, updatedAt: number, channelId?: string) {
  return app.storage.initializeConversation({ id, actorId: 'owner', title: id, createdAt: 0, updatedAt }, [],
    channelId ? [{ namespace: BOT_CHANNEL_ACCESS, id, value: { version: 1, context: { ...context, channelId }, participants: [] } }] : []);
}

test('较旧的本频道对话不会被全局最新 200 项挤出，其他频道和普通对话不读取权限元数据', async () => {
  await conversation('old-visible', 1, context.channelId);
  await conversation('other-channel', 2, 'elsewhere');
  await Promise.all(Array.from({ length: 210 }, (_, index) => conversation('personal-' + index, index + 10)));
  const access = jest.spyOn(app, 'findConversation');
  const values = await app.discord.sessions.conversations('owner', context);
  expect(values.map(value => value.id)).toEqual(['old-visible']);
  expect(access.mock.calls).toEqual([['owner', 'old-visible']]);
});

test('最近 200 项的上限应用于当前频道的可见对话，跨页仍保持时间顺序', async () => {
  await Promise.all(Array.from({ length: 199 }, (_, index) => conversation('visible-' + index, 1000 - index, context.channelId)));
  await Promise.all(Array.from({ length: 10 }, (_, index) => conversation('other-' + index, 700 - index, 'elsewhere')));
  await conversation('last-visible', 2, context.channelId);
  await conversation('outside-limit', 1, context.channelId);
  const values = await app.discord.sessions.conversations('owner', context);
  expect(values).toHaveLength(200);
  expect(values.at(-1)?.id).toBe('last-visible');
  expect(values.every((value, index) => index === 0 || values[index - 1].updatedAt >= value.updatedAt)).toBe(true);
});

test('频道授权记录读取失败会报告异常，而不是显示没有可选对话', async () => {
  await conversation('candidate', 1, context.channelId);
  const failure = new Error('fixture channel index unavailable');
  const original = app.storage.getRecord.bind(app.storage);
  jest.spyOn(app.storage, 'getRecord').mockImplementation((namespace, id) => namespace === BOT_CHANNEL_ACCESS
    ? Promise.reject(failure) : original(namespace, id));
  await expect(app.discord.sessions.conversations('owner', context)).rejects.toBe(failure);
});

test('元数据读取异常会向上传递，真正不可访问的对话仍被过滤', async () => {
  await conversation('candidate', 1, context.channelId);
  expect(await app.discord.sessions.conversations('missing-actor', context)).toEqual([]);
  const failure = new Error('fixture conversation metadata unavailable');
  jest.spyOn(app.storage, 'getConversation').mockRejectedValueOnce(failure);
  await expect(app.discord.sessions.conversations('owner', context)).rejects.toBe(failure);
});
