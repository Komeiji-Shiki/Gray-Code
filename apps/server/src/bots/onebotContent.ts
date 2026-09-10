import type { BotAttachment, BotReference } from './gateway';

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
export function oneBotContent(value: unknown, botId: string, version: 11 | 12, depth = 0) {
  let content = ''; let mentioned = false;
  const attachments: BotAttachment[] = []; const references: BotReference[] = [];
  for (const segment of oneBotSegments(value)) {
    const data = segment.data;
    if (segment.type === 'text' && typeof data.text === 'string') content += data.text;
    else if (segment.type === 'at' || segment.type === 'mention') {
      const id = String(version === 11 ? data.qq : data.user_id);
      if (id === botId) mentioned = true; else content += ` @${id} `;
    } else if (['image', 'record', 'voice', 'audio', 'video', 'file'].includes(segment.type)) {
      attachments.push({ name: data.name || data.file_name || (segment.type === 'image' ? 'image.png' : segment.type),
        url: typeof data.url === 'string' ? data.url : typeof data.file === 'string' && /^https?:\/\//.test(data.file) ? data.file : undefined,
        fileId: String(data.file_id ?? data.file ?? ''), size: Number(data.file_size ?? data.size) || undefined,
        contentType: segment.type === 'image' ? 'image/*' : undefined });
    } else if (segment.type === 'reply') references.push({ kind: 'reply', id: String(data.id ?? data.message_id ?? '') });
    else if (segment.type === 'forward') references.push({ kind: 'forward', id: String(data.id ?? '') });
    else if (segment.type === 'node') {
      const id = String(data.id ?? `embedded-${references.length}`);
      const parsed = depth < 4 && data.content ? oneBotContent(data.content, botId, version, depth + 1) : undefined;
      references.push({ kind: 'forward', id, authorId: String(data.uin ?? data.user_id ?? ''), authorName: data.name ?? data.nickname,
        ...(parsed ? parsed : { unavailable: '转发节点内容未提供或嵌套超过 4 层' }) });
    }
  }
  return { content: content.trim(), mentioned, attachments, references };
}
