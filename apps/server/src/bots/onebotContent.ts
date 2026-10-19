import type { BotAttachment, BotReference, BotMessageSegment } from './gateway';

const decode = (text: string) => text.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
export function oneBotSegments(value: unknown): Array<{ type: string; data: Record<string, any> }> {
  if (Array.isArray(value)) return value.filter(item => item && typeof item.type === 'string' && item.data && typeof item.data === 'object');
  if (typeof value !== 'string') return [];
  const segments: Array<{ type: string; data: Record<string, any> }> = []; let cursor = 0;
  for (const match of value.matchAll(/\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index! > cursor) segments.push({ type: 'text', data: { text: decode(value.slice(cursor, match.index)) } });
    const data: Record<string, string> = {};
    for (const item of match[2].slice(1).split(',')) { const split = item.indexOf('='); if (split > 0) data[item.slice(0, split)] = decode(item.slice(split + 1)); }
    segments.push({ type: match[1], data }); cursor = match.index! + match[0].length;
  }
  if (cursor < value.length) segments.push({ type: 'text', data: { text: decode(value.slice(cursor)) } });
  return segments;
}
const joined = (values: unknown[]) => [...new Set(values.filter((item): item is string => typeof item === 'string' && !!item.trim())
  .map(item => item.trim().slice(0, 200)))].join('｜');
/** 小程序与链接卡片只保留提示、标题、简介和跳转地址，原始 JSON 不进入模型输入。 */
function cardNote(raw: unknown): string {
  try {
    const card = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const detail = Object.values(card?.meta ?? {})[0] as Record<string, unknown> | undefined;
    const text = joined([card?.prompt, detail?.title, detail?.desc, detail?.qqdocurl ?? detail?.jumpUrl ?? detail?.url]);
    return text ? `[卡片：${text}]` : '[卡片消息]';
  } catch { return '[卡片消息]'; }
}
/** 非正文消息段转成简短说明，让模型知道对方发了什么；未列出的类型仍然忽略。 */
function segmentNote(type: string, data: Record<string, any>): string | undefined {
  switch (type) {
    case 'face': return typeof data.raw?.faceText === 'string' && data.raw.faceText ? `[表情${data.raw.faceText}]` : '[表情]';
    case 'dice': return data.result ? `[骰子：${data.result} 点]` : '[骰子]';
    case 'rps': return '[猜拳]';
    case 'poke': case 'shake': return '[戳一戳]';
    case 'json': return cardNote(data.data);
    case 'markdown': return typeof data.content === 'string' ? data.content : undefined;
    case 'share': return `[分享：${joined([data.title, data.content, data.url]) || '链接'}]`;
    case 'music': return `[音乐分享${data.title ? `：${data.title}` : ''}]`;
    case 'location': return `[位置：${joined([data.title, data.content]) || `${data.lat},${data.lon}`}]`;
    case 'contact': return `[推荐${data.type === 'group' ? '群' : '好友'}：${data.id ?? ''}]`;
    case 'onlinefile': return `[在线文件 ${JSON.stringify(String(data.fileName ?? ''))}：暂不支持读取]`;
  }
}
export function oneBotContent(value: unknown, botId: string, version: 11 | 12, depth = 0) {
  let content = ''; let mentioned = false;
  const attachments: BotAttachment[] = []; const references: BotReference[] = [];
  const segments: BotMessageSegment[] = [];
  const text = (value: string) => { content += value; segments.push({ type: 'text', text: value }); };
  for (const segment of oneBotSegments(value)) {
    const data = segment.data;
    if (segment.type === 'text' && typeof data.text === 'string') text(data.text);
    else if (segment.type === 'at' || segment.type === 'mention') {
      const id = String(version === 11 ? data.qq : data.user_id);
      if (id === botId) mentioned = true; else text(` @${id} `);
    } else if (['image', 'record', 'voice', 'audio', 'video', 'file'].includes(segment.type)) {
      segments.push({ type: 'attachment', index: attachments.length });
      attachments.push({ name: data.name || data.file_name || (segment.type === 'image' ? 'image.png' : segment.type),
        url: typeof data.url === 'string' ? data.url : typeof data.file === 'string' && /^https?:\/\//.test(data.file) ? data.file : undefined,
        fileId: String(data.file_id ?? data.file ?? ''), size: Number(data.file_size ?? data.size) || undefined,
        contentType: segment.type === 'image' ? 'image/*' : undefined });
    } else if (segment.type === 'reply' || segment.type === 'forward') {
      segments.push({ type: 'reference', index: references.length });
      references.push({ kind: segment.type, id: String(data.id ?? data.message_id ?? '') });
    }
    else if (segment.type === 'node') {
      segments.push({ type: 'reference', index: references.length });
      const id = String(data.id ?? `embedded-${references.length}`);
      const parsed = depth < 4 && data.content ? oneBotContent(data.content, botId, version, depth + 1) : undefined;
      references.push({ kind: 'forward', id, authorId: String(data.uin ?? data.user_id ?? ''), authorName: data.name ?? data.nickname,
        ...(parsed ? parsed : { unavailable: '转发节点内容未提供或嵌套超过 4 层' }) });
    } else {
      const note = segmentNote(segment.type, data);
      if (note) text(note);
    }
  }
  return { content: content.trim(), mentioned, attachments, references, segments };
}
