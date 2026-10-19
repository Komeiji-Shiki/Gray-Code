import { WebSocketServer, WebSocket } from 'ws';
import type { OneBotSettings } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { createOneBotProtocol } from '../../../apps/server/src/bots/onebotProtocol';
import { fixture } from './fixtures';
import { OneBotGateway } from '../../../apps/server/src/bots/onebotGateway';
import { oneBotContent } from '../../../apps/server/src/bots/onebotContent';
import { botFinalReplies } from '../../../apps/server/src/bots/streaming';
import { plainBotText } from '../../../apps/server/src/bots/text';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until<T>(read: () => Promise<T> | T, label: string): Promise<T> {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(label);
}
function configuration(version: 11 | 12, endpoint: string): OneBotSettings {
  return { enabled: true, endpoint, protocolVersion: version, autoConnect: false, processingHint: true, mentionOnly: true, agentId: 'default',
    allowedChannelIds: [version === 11 ? 'group:30' : 'group:team%3Aone'],
    ...(version === 12 ? { self: { platform: 'fixture', userId: 'robot:0' } } : {}),
    defaultProfile: { workspaceId: null, toolsEnabled: false } };
}

test('OneBot 11 和 12 的附件、合并转发与心跳使用各自协议', async () => {
  const v11 = createOneBotProtocol(configuration(11, 'ws://127.0.0.1:1'));
  const action = v11.send('group:30', '', '-101');
  const reply = { files: [{ name: 'image.png', data: Buffer.from('image') }] };
  const bot = { id: '900', name: '灰魂' };
  const rich = await v11.prepareReply(action, reply, bot, async () => ({}));
  expect(rich.params.message).toEqual([{ type: 'reply', data: { id: '-101' } }, { type: 'image', data: { file: 'base64://aW1hZ2U=', name: 'image.png' } }]);
  const document = await v11.prepareReply(action, { files: [{ name: 'result.txt', data: Buffer.from('text') }] }, bot, async () => ({}));
  expect(document.params.message).toEqual([{ type: 'file', data: { file: 'base64://dGV4dA==', name: 'result.txt' } }]);
  const forward = await v11.prepareReply(action, { forward: ['第一段', '第二段'] }, bot, async () => ({}));
  expect(forward.action).toBe('send_group_forward_msg'); expect((forward.params.messages as unknown[]).length).toBe(2);
  expect((forward.params.messages as Array<{ data: Record<string, unknown> }>)[0].data).toMatchObject({ user_id: '900', nickname: '灰魂' });
  const v12 = createOneBotProtocol(configuration(12, 'ws://127.0.0.1:1'));
  const calls: unknown[] = [];
  const self = { id: '', name: '' };
  const file = await v12.prepareReply(v12.send('group:team%3Aone', ''), reply, self, async value => { calls.push(value); return { file_id: 'uploaded' }; });
  expect(calls[0]).toMatchObject({ action: 'upload_file', params: { type: 'data', data: 'aW1hZ2U=' } });
  expect(file.params.message).toEqual([{ type: 'image', data: { file_id: 'uploaded' } }]);
  await expect(v12.prepareReply(v12.send('group:team%3Aone', ''), { forward: ['不支持'] }, self, async () => ({}))).rejects.toThrow('不支持合并转发');
  const gateway = new OneBotGateway('ws://127.0.0.1:1', v11), close = jest.fn();
  (gateway as any).socket = { close }; (gateway as any).botId = '900';
  jest.useFakeTimers();
  try {
    (gateway as any).message({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 900, interval: 1000, status: { online: false } });
    expect(gateway.health().online).toBe(false);
    await jest.advanceTimersByTimeAsync(3000); expect(close).toHaveBeenCalledTimes(1);
  } finally { await gateway.disconnect(); jest.useRealTimers(); }
});

test('OneBot 消息编号与事件编号分离，回复和回执按各版本使用真实编号', () => {
  const v11 = createOneBotProtocol(configuration(11, 'ws://127.0.0.1:1'));
  const received = v11.inbound({ post_type: 'message', message_type: 'group', self_id: 900, user_id: 11, group_id: 30, message_id: -101, message: [] }, '900');
  expect(received).toMatchObject({ id: '900:group:30:-101', sourceMessageId: '-101' });
  expect(v11.send('group:30', '[CQ:at,qq=all] 正文', received!.sourceMessageId).params.message).toEqual([
    { type: 'reply', data: { id: '-101' } }, { type: 'text', data: { text: '[CQ:at,qq=all] 正文' } },
  ]);
  expect(v11.receipt({ message_id: 0 })).toEqual({ id: '0' });
  expect(v11.receipt({ message_id: -9 })).toEqual({ id: '-9' });
  expect(() => v11.receipt({})).toThrow('发送回执');
  const v12 = createOneBotProtocol(configuration(12, 'ws://127.0.0.1:1'));
  const botId = JSON.stringify(['fixture', 'robot:0']);
  const message = { id: 'event-id', type: 'message', detail_type: 'group', self: { platform: 'fixture', user_id: 'robot:0' }, user_id: 'person:one', group_id: 'team:one', message_id: 'native:message:101', message: [] };
  expect(v12.inbound(message, botId)).toMatchObject({ id: botId + ':event-id', sourceMessageId: 'native:message:101' });
  expect(v12.send('group:team%3Aone', '正文', 'native:message:101')).toMatchObject({ action: 'send_message', self: message.self,
    params: { group_id: 'team:one', message: [{ type: 'reply', data: { message_id: 'native:message:101' } }, { type: 'text', data: { text: '正文' } }] } });
  expect(v12.receipt({ message_id: 'sent:id' })).toEqual({ id: 'sent:id' });
  expect(() => v12.receipt({ message_id: 123 })).toThrow('发送回执');
  expect(v12.inbound({ ...message, message_id: undefined }, botId)).toBeUndefined();
});

test.each([11, 12] as const)('OneBot %s 经真实 WebSocket 保存排队原消息，重启后未知发送只能确认重试且引用不变', async version => {
  const f = await fixture(); await f.store.close();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sent: Array<Record<string, any>> = []; const hints: Array<Record<string, any>> = [];
  let socket!: WebSocket; let dropNext = false, generated = 0;
  const release = deferred();
  server.on('connection', client => { socket = client; client.on('message', raw => {
    const action = JSON.parse(raw.toString()); let data: Record<string, unknown> = {};
    if (action.action === 'get_login_info') data = { user_id: 900, nickname: 'OneBot 验收' };
    else if (action.action === 'get_self_info') data = { user_id: 'robot:0', user_name: 'OneBot 验收' };
    else if (action.action.startsWith('set_')) hints.push(action);
    else if (action.action.startsWith('send_')) {
      sent.push(action);
      if (dropNext) { dropNext = false; client.close(1012, '验收：回执丢失'); return; }
      data = { message_id: version === 11 ? -70000 - sent.length : 'sent:' + sent.length };
    }
    client.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: action.echo }));
  }); });
  const options = { dataDirectory: f.data, documentsDirectory: f.root, models: { generate: async () => {
    const turn = ++generated; if (turn === 1) await release.promise;
    return { role: 'model' as const, parts: [{ text: `真实运行器回复 ${turn}` }] };
  } } };
  let app = await PlatformApplication.open(options);
  const author = (owner: boolean) => version === 11 ? owner ? '11' : '22' : owner ? 'person:one' : 'person:two';
  const nativeId = (index: number) => version === 11 ? String(-100 - index) : 'native:message:' + index;
  const emit = (index: number, owner: boolean, text = '请回复当前消息') => socket.send(JSON.stringify(version === 11
    ? { post_type: 'message', message_type: 'group', self_id: 900, user_id: Number(author(owner)), group_id: 30, message_id: Number(nativeId(index)), sender: { nickname: '同名用户' }, message: [{ type: 'at', data: { qq: '900' } }, { type: 'text', data: { text } }] }
    : { id: 'event:' + index, self: { platform: 'fixture', user_id: 'robot:0' }, type: 'message', detail_type: 'group', sub_type: '', time: Date.now() / 1000,
      user_id: author(owner), group_id: 'team:one', message_id: nativeId(index), message: [{ type: 'mention', data: { user_id: 'robot:0' } }, { type: 'text', data: { text } }] }));
  const replyId = (action: Record<string, any>) => action.params.message.find((part: any) => part.type === 'reply')?.data[version === 11 ? 'id' : 'message_id'];
  try {
    const snapshot = app.settings.snapshot();
    snapshot.settings.accounts.push({ id: 'member', displayName: '同名用户', role: 'member', effects: ['public_read'], workspaceIds: [] });
    snapshot.settings.bindings = [{ id: 'owner', platform: 'onebot', network: version === 11 ? 'qq' : 'fixture', platformUserId: author(true), accountId: 'owner' },
      { id: 'member', platform: 'onebot', network: version === 11 ? 'qq' : 'fixture', platformUserId: author(false), accountId: 'member' }];
    snapshot.settings.onebot = configuration(version, endpoint);
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision }); await app.onebot.start();
    emit(1, true); await until(() => generated === 1, '主人消息没有通过当前平台的身份匹配'); emit(2, false);
    await until(async () => (await app.storage.listRecords('bot-inbox-pending')).length === 1, '第二位用户没有进入持久队列');
    const pending = await app.storage.getRecord('bot-inbox-pending', (await app.storage.listRecords('bot-inbox-pending'))[0]) as any;
    expect(pending.context.sourceMessageId).toBe(nativeId(2)); release.resolve();
    await until(() => sent.length === 2, '两条回复未完成');
    expect(sent.map(replyId)).toEqual([nativeId(1), nativeId(2)]);
    // 群聊每个任务只贴一次表情；v12 标准没有对应动作。
    if (version === 11) await until(() => hints.length === 2, '群聊没有提示处理中');
    expect(hints.map(hint => [hint.action, hint.params.message_id, hint.params.emoji_id]))
      .toEqual(version === 11 ? [['set_msg_emoji_like', -101, 124], ['set_msg_emoji_like', -102, 124]] : []);
    const runs = await app.storage.listRuns(); expect(runs.map(run => run.actorId).sort()).toEqual(['member', 'owner']);
    for (const run of runs) expect((await app.onebot.sessions.routeForRun('onebot', run))?.replyToMessageId).toBe(nativeId(run.actorId === 'owner' ? 1 : 2));
    dropNext = true; emit(3, true);
    await until(async () => (await app.onebot.outbox.list()).some(value => value.phase === 'unknown'), '回执丢失未保留未知状态');
    expect(replyId(sent[2])).toBe(nativeId(3));
    await app.close(); app = await PlatformApplication.open(options); await app.onebot.start();
    const waiting = await app.onebot.outbox.list(); expect(waiting).toHaveLength(1); expect(waiting[0].phase).toBe('unknown');
    expect(generated).toBe(3); expect(sent).toHaveLength(3);
    await expect(app.onebot.outbox.retry(waiting[0].id)).rejects.toThrow('明确确认');
    await app.onebot.outbox.retry(waiting[0].id, true);
    expect(sent).toHaveLength(4); expect(replyId(sent[3])).toBe(nativeId(3)); expect(generated).toBe(3);
    expect(await app.onebot.outbox.list()).toEqual([]);
    emit(4, true, '/gray help'); await until(() => sent.length === 5, '命令响应没有发送');
    expect(replyId(sent[4])).toBe(nativeId(4)); expect(generated).toBe(3);
  } finally {
    release.resolve(); await app.close(); for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await f.cleanup();
  }
});

test('QQ 回复转成纯文本，文档仍保存 Markdown 原文，处理中提示按会话类型选择 NapCat 扩展', () => {
  const markdown = [
    '# 标题', '**加粗** 与 *斜体*，`snake_case` 和 2 * 3 * 4 保持原样', '- [x] 已完成', '* 列表项', '> 引用',
    '| 名称 | 值 |', '| --- | :-: |', '| a | b |', '[文档](https://example.com) \\*转义\\*', '```ts', '  const value = **raw**;', '```',
  ].join('\n');
  expect(plainBotText(markdown)).toBe([
    '【标题】', '加粗 与 斜体，snake_case 和 2 * 3 * 4 保持原样', '☑ 已完成', '• 列表项', '｜引用',
    '名称 | 值', 'a | b', '文档（https://example.com） *转义*', '  const value = **raw**;',
  ].join('\n'));
  const route = { platform: 'onebot' as const, botId: '900', channelId: 'group:30', actorId: 'owner', conversationId: 'c',
    output: { streaming: false, updateIntervalMs: 1000, showThoughts: false, showToolStatus: false, longReplies: 'file' as const } };
  expect(botFinalReplies('**短回复**', route)).toEqual([{ content: '短回复' }]);
  const long = `## 长文\n${'内容'.repeat(1000)}`;
  const document = botFinalReplies(long, route);
  expect(Buffer.from(document[1].files![0].data).toString()).toBe(long);
  expect(botFinalReplies(long, { ...route, output: { ...route.output, longReplies: 'forward' } })[0].forward![0]).toMatch(/^【长文】\n内容/);

  const v11 = createOneBotProtocol(configuration(11, 'ws://127.0.0.1:1'));
  expect(v11.processing({ channelId: 'private:11', direct: true, first: false }))
    .toEqual({ action: 'set_input_status', params: { user_id: '11', event_type: 1 } });
  expect(v11.processing({ channelId: 'group:30', direct: false, messageId: '-101', first: true }))
    .toEqual({ action: 'set_msg_emoji_like', params: { message_id: -101, emoji_id: 124 } });
  expect(v11.processing({ channelId: 'group:30', direct: false, messageId: '-101', first: false })).toBeUndefined();
  expect(createOneBotProtocol(configuration(12, 'ws://127.0.0.1:1')).processing({ channelId: 'private:a', direct: true, first: true })).toBeUndefined();
});

test('QQ 卡片、表情等消息段转成说明，相邻发送至少间隔一秒', async () => {
  const card = JSON.stringify({ prompt: '[QQ小程序]哔哩哔哩', meta: { detail_1: { title: '哔哩哔哩', desc: '视频标题', qqdocurl: 'https://b23.tv/abc' } } });
  const content = oneBotContent([{ type: 'json', data: { data: card } }, { type: 'face', data: { id: '14' } }, { type: 'dice', data: { result: '6' } },
    { type: 'json', data: { data: '{broken' } }], '900', 11);
  expect(content.content).toBe('[卡片：[QQ小程序]哔哩哔哩｜哔哩哔哩｜视频标题｜https://b23.tv/abc][表情][骰子：6 点][卡片消息]');

  const gateway = new OneBotGateway('ws://127.0.0.1:1', createOneBotProtocol(configuration(11, 'ws://127.0.0.1:1')));
  const times: number[] = [];
  (gateway as any).botId = '900';
  (gateway as any).call = async () => { times.push(Date.now()); return { message_id: times.length }; };
  jest.useFakeTimers();
  try {
    const replies = Promise.all([1, 2, 3].map(index => gateway.sendReply('group:30', { content: `第 ${index} 条` })));
    await jest.advanceTimersByTimeAsync(2500);
    expect(await replies).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000); expect(times[2] - times[1]).toBeGreaterThanOrEqual(1000);
  } finally { jest.useRealTimers(); }
});
