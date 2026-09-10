import { botInboundParts } from '../../../apps/server/src/bots/media';
import { formatHistoryForAPI, toDisplayMessages } from '../../../backend/modules/conversation/manager/historyFormatting';
import { formatBotTimestamp } from '../../../shared/botMessagePresentation';
import type { Content } from '../../../backend/modules/conversation/types';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

test('Bot 发言和引用只展示名称及可读时间，不重复发送平台标识', async () => {
  const timestamp = Date.parse('2026-09-10T13:48:38Z');
  const parts = await botInboundParts({ id: '1111111111111111111', authorId: '2222222222222222222', authorName: '测试用户', channelId: '30',
    content: '111在吗', timestamp, direct: false, mentioned: true, references: [{ kind: 'reply', id: '1111111111111111112', authorId: '2222222222222222223', authorName: '小猫', timestamp, content: '引用原文' }] }, 'discord');
  const text = parts.map(part => part.text ?? '').join('\n');
  expect(text).toContain('测试用户'); expect(text).toContain('小猫'); expect(text).toContain('111在吗'); expect(text).toContain('引用原文');
  for (const value of ['1111111111111111111', '2222222222222222222', '1111111111111111112', '2222222222222222223', String(timestamp), 'authorId']) expect(text).not.toContain(value);
  const time = formatBotTimestamp(timestamp)!; expect(time).toMatch(/^2026-09-10 \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/);
  expect(Date.parse(time.replace(' UTC', '').replace(' ', 'T'))).toBe(timestamp);
});

test('旧 Bot 消息在显示和发送时转换，内部来源和普通用户原文保持原样', () => {
  const header = '[Discord 发言 {"id":"1111111111111111111","authorId":"2222222222222222222","displayName":"测试用户","timestamp":1789048118000}]\n旧消息';
  const messages = [{ role: 'user', parts: [{ text: header }], source: { platform: 'discord', messageId: '1111111111111111111', platformUserId: '2222222222222222222' } }] as unknown as Content[];
  for (const result of [formatHistoryForAPI(messages), toDisplayMessages(messages)]) {
    expect(result[0].parts[0].text).toContain('测试用户'); expect(result[0].parts[0].text).toContain('UTC');
    expect(result[0].parts[0].text).not.toContain('1111111111111111111'); expect(result[0].parts[0].text).not.toContain('timestamp');
  }
  expect(messages[0].parts[0].text).toBe(header);
  expect(formatHistoryForAPI([{ role: 'user', parts: [{ text: header }] }])[0].parts[0].text).toBe(header);
});

test('实际历史分页接口使用相同显示格式并保留绝对索引', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    const header = '[Discord 发言 {"id":"1111111111111111111","authorId":"2222222222222222222","displayName":"测试用户","timestamp":1789048118000}]\n旧消息';
    await app.storage.initializeConversation({ id: 'bot_history', actorId: 'owner', createdAt: 1, updatedAt: 1 }, [
      { id: 'first', role: 'user', parts: [{ text: '第一条' }] },
      { id: 'second', role: 'user', parts: [{ text: header }], source: { platform: 'discord' } },
    ]);
    const router = new ApplicationRouter(app);
    const result = await router.call({ actorId: 'owner', clientId: 'history-view' }, 'ui.request', { type: 'conversation.loadConversationForView', data: { conversationId: 'bot_history', offset: 1, limit: 1 } }) as any;
    expect(result.messages).toHaveLength(1); expect(result.messages[0].index).toBe(1);
    expect(result.messages[0].parts[0].text).toContain('UTC'); expect(result.messages[0].parts[0].text).not.toContain('2222222222222222222');
    expect((await app.storage.readFullHistory('bot_history')).messages[1].parts[0].text).toBe(header);
  } finally { await app.close(); await f.cleanup(); }
});
