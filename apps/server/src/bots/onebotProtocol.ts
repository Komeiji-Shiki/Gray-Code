import type { OneBotSettings } from '@graycode/contracts';
import type { BotInbound, BotAttachment, BotReference, BotMessageReceipt } from './gateway';
import { oneBotContent } from './onebotContent';
export interface OneBotAction { action: string; params: Record<string, unknown>; self?: { platform: string; user_id: string } }
export interface OneBotProtocol {
  login(): OneBotAction;
  identity(data: Record<string, any>): { id: string; name: string };
  inbound(value: Record<string, any>, botId: string): BotInbound | undefined;
  send(channelId: string, text: string, replyToMessageId?: string): OneBotAction;
  receipt(data: Record<string, any>): BotMessageReceipt;
  hydrate(message: BotInbound, call: (action: OneBotAction) => Promise<Record<string, any>>): Promise<BotInbound>;
}
const numericId = (value: unknown): string | undefined => typeof value === 'string' && /^\d+$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
const textId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const signedNumericId = (value: unknown): string | undefined => typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
  : typeof value === 'string' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? value : undefined;
const messageSegments = (text: string, replyToMessageId: string | undefined, version: 11 | 12) => [
  ...(replyToMessageId !== undefined ? [{ type: 'reply', data: { [version === 11 ? 'id' : 'message_id']: replyToMessageId } }] : []),
  { type: 'text', data: { text } },
];

function v11(): OneBotProtocol {
  return {
    login: () => ({ action: 'get_login_info', params: {} }),
    identity: data => {
      const id = numericId(data.user_id); if (!id) throw new Error('OneBot 11 登录账号无效。');
      return { id, name: typeof data.nickname === 'string' ? data.nickname : id };
    },
    inbound: (value, botId) => {
      if (value.post_type !== 'message' || numericId(value.self_id) !== botId || value.anonymous) return;
      const authorId = numericId(value.user_id); if (!authorId || authorId === botId) return;
      const direct = value.message_type === 'private';
      const channel = direct ? authorId : value.message_type === 'group' ? numericId(value.group_id) : undefined;
      const sourceMessageId = signedNumericId(value.message_id);
      if (!channel || sourceMessageId === undefined) return;
      const channelId = `${direct ? 'private' : 'group'}:${channel}`;
      return { id: `${botId}:${channelId}:${sourceMessageId}`, sourceMessageId, authorId, channelId, network: 'qq', direct,
        authorName: value.sender?.card || value.sender?.nickname, timestamp: Number(value.time) ? Number(value.time) * 1000 : undefined,
        ...oneBotContent(value.message, botId, 11) };
    },
    send: (channelId, text, replyToMessageId) => {
      const match = /^(group|private):(\d+)$/.exec(channelId); if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('OneBot 11 目标格式无效。');
      return { action: match[1] === 'group' ? 'send_group_msg' : 'send_private_msg',
        params: { [match[1] === 'group' ? 'group_id' : 'user_id']: Number(match[2]), message: messageSegments(text, replyToMessageId, 11) } };
    },
    receipt: data => {
      const id = signedNumericId(data.message_id);
      if (id === undefined) throw new Error('OneBot 11 未返回有效的发送回执。');
      return { id };
    },
    hydrate: (message, call) => hydrateOneBot(message, 11, call),
  };
}

/** v12 以 platform + user_id 标识机器人，不将 v11 字段或 QQ 数字 ID 规则套用到其它平台。 */
function v12(identity: NonNullable<OneBotSettings['self']>): OneBotProtocol {
  if (!identity?.platform || !identity.userId) throw new Error('OneBot 12 需要明确填写机器人平台标识和用户 ID。');
  const self = { platform: identity.platform, user_id: identity.userId };
  const key = JSON.stringify([self.platform, self.user_id]);
  return {
    login: () => ({ action: 'get_self_info', params: {}, self }),
    identity: data => {
      if (data.user_id !== self.user_id) throw new Error('OneBot 12 返回的机器人身份与配置不一致。');
      return { id: key, name: data.user_displayname || data.user_name || self.user_id };
    },
    inbound: (value, botId) => {
      if (botId !== key || value.type !== 'message' || value.self?.platform !== self.platform || value.self?.user_id !== self.user_id
        || !textId(value.user_id) || value.user_id === self.user_id || !textId(value.id) || !textId(value.message_id) || !Array.isArray(value.message)) return;
      let channelId: string;
      if (value.detail_type === 'private') channelId = `private:${encodeURIComponent(value.user_id)}`;
      else if (value.detail_type === 'group' && textId(value.group_id)) channelId = `group:${encodeURIComponent(value.group_id)}`;
      else if (value.detail_type === 'channel' && textId(value.guild_id) && textId(value.channel_id)) channelId = `channel:${encodeURIComponent(value.guild_id)}:${encodeURIComponent(value.channel_id)}`;
      else return;
      return { id: `${key}:${value.id}`, sourceMessageId: value.message_id, authorId: value.user_id, network: self.platform, channelId,
        direct: value.detail_type === 'private', timestamp: Number(value.time) ? Number(value.time) * 1000 : undefined,
        ...oneBotContent(value.message, self.user_id, 12) };
    },
    send: (channelId, text, replyToMessageId) => {
      const [detail_type, ...encoded] = channelId.split(':'); const ids = encoded.map(decodeURIComponent);
      if (!ids.every(Boolean) || !(['private', 'group'].includes(detail_type) && ids.length === 1 || detail_type === 'channel' && ids.length === 2)) throw new Error('OneBot 12 目标格式无效。');
      return { action: 'send_message', self, params: { detail_type, message: messageSegments(text, replyToMessageId, 12),
        ...(detail_type === 'private' ? { user_id: ids[0] } : detail_type === 'group' ? { group_id: ids[0] } : { guild_id: ids[0], channel_id: ids[1] }) } };
    },
    receipt: data => {
      if (!textId(data.message_id)) throw new Error('OneBot 12 未返回有效的发送回执。');
      return { id: data.message_id };
    },
    hydrate: (message, call) => hydrateOneBot(message, 12, action => call({ ...action, self })),
  };
}
export function createOneBotProtocol(settings: OneBotSettings): OneBotProtocol { return settings.protocolVersion === 12 ? v12(settings.self!) : v11(); }

async function hydrateOneBot(message: BotInbound, version: 11 | 12, call: (action: OneBotAction) => Promise<Record<string, any>>): Promise<BotInbound> {
  const attachment = async (item: BotAttachment): Promise<BotAttachment> => {
    if (item.url || !item.fileId) return item;
    try {
      const action = version === 12 ? { action: 'get_file', params: { file_id: item.fileId, type: 'url' } }
        : item.contentType?.startsWith('image/') ? { action: 'get_image', params: { file: item.fileId } }
          : { action: 'get_file', params: { file_id: item.fileId } };
      const value = await call(action);
      return { ...item, url: value.url, name: value.name || value.file_name || item.name };
    } catch { return item; }
  };
  const seen = new Set<string>();
  const refs = async (values: BotReference[], depth: number): Promise<BotReference[]> => {
    const result: BotReference[] = [];
    for (const item of values.slice(0, 40)) {
      let resolved = item;
      if (depth >= 4 || seen.has(item.id)) { result.push({ ...item, unavailable: '引用层数已达上限或存在循环引用' }); continue; }
      seen.add(item.id);
      if (item.content === undefined && !item.unavailable) {
        try {
          if (version === 12) throw new Error('OneBot 12 标准没有通用的历史消息读取接口，事件也未提供原文');
          const value = await call(item.kind === 'forward' ? { action: 'get_forward_msg', params: { message_id: item.id } }
            : { action: 'get_msg', params: { message_id: /^-?\d+$/.test(item.id) ? Number(item.id) : item.id } });
          if (item.kind === 'forward') resolved = { ...item, content: '', references: (value.messages ?? []).slice(0, 40).map((node: Record<string, any>, index: number) => ({
            kind: 'forward', id: String(node.message_id ?? `${item.id}-${index}`), authorId: String(node.sender?.user_id ?? ''), authorName: node.sender?.nickname,
            ...oneBotContent(node.content ?? node.message, '', version) })) };
          else resolved = { ...item, authorId: String(value.sender?.user_id ?? value.user_id ?? ''), authorName: value.sender?.nickname,
            ...oneBotContent(value.message, '', version) };
        } catch (error) { resolved = { ...item, unavailable: `原消息无法读取：${(error as Error).message}` }; }
      }
      result.push({ ...resolved, attachments: await Promise.all((resolved.attachments ?? []).map(attachment)),
        references: await refs(resolved.references ?? [], depth + 1) });
    }
    if (values.length > 40) result.push({ kind: 'forward', id: 'truncated', unavailable: '转发条目超过 40 条，后续未读取' });
    return result;
  };
  return { ...message, attachments: await Promise.all((message.attachments ?? []).map(attachment)), references: await refs(message.references ?? [], 0) };
}
