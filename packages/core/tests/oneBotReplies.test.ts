import { WebSocketServer, WebSocket } from 'ws';
import type { OneBotSettings } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { createOneBotProtocol } from '../../../apps/server/src/bots/onebotProtocol';
import { fixture } from './fixtures';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until<T>(read: () => Promise<T> | T, label: string): Promise<T> {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(label);
}
function configuration(version: 11 | 12, endpoint: string): OneBotSettings {
  return { enabled: true, endpoint, protocolVersion: version, autoConnect: false, mentionOnly: true, agentId: 'default',
    allowedChannelIds: [version === 11 ? 'group:30' : 'group:team%3Aone'],
    ...(version === 12 ? { self: { platform: 'fixture', userId: 'robot:0' } } : {}),
    defaultProfile: { workspaceId: null, toolsEnabled: false } };
}

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
  const sent: Array<Record<string, any>> = []; let socket!: WebSocket; let dropNext = false, generated = 0;
  const release = deferred();
  server.on('connection', client => { socket = client; client.on('message', raw => {
    const action = JSON.parse(raw.toString()); let data: Record<string, unknown> = {};
    if (action.action === 'get_login_info') data = { user_id: 900, nickname: 'OneBot 验收' };
    else if (action.action === 'get_self_info') data = { user_id: 'robot:0', user_name: 'OneBot 验收' };
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
