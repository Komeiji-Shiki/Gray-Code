import type { PlatformMessage } from '@graycode/contracts';
import type { BotAttachment, BotInbound, BotReference } from './gateway';
import type { BotDocument } from './documents';

function imageMime(bytes: Uint8Array): string | undefined {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}
/** 仅接受消息平台提供的附件 CDN，不携带账号凭据，不读取任意 URL 或本地路径。 */
export async function downloadBotAttachment(attachment: BotAttachment, platform: 'discord' | 'onebot'): Promise<Uint8Array> {
  if (!attachment.url) throw new Error('平台没有提供可下载的附件地址');
  const url = new URL(attachment.url);
  const allowed = platform === 'discord' ? ['cdn.discordapp.com', 'media.discordapp.net'] : ['qq.com', 'qpic.cn', 'gtimg.cn'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !allowed.some(domain => url.hostname === domain || platform === 'onebot' && url.hostname.endsWith('.' + domain))) throw new Error('附件地址不是受支持的平台 CDN');
  const limit = /\.(txt|md|markdown)$/i.test(attachment.name) ? 32 * 1024 * 1024 : 12 * 1024 * 1024;
  if (attachment.size && attachment.size > limit) throw new Error(`附件超过 ${limit / 1024 / 1024} MiB 读取上限`);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw new Error(`附件下载失败，HTTP ${response.status}`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const result = await reader.read(); if (result.done) break; total += result.value.length;
      if (total > limit) throw new Error('附件实际大小超过读取上限'); chunks.push(result.value); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export async function botInboundParts(message: BotInbound, platform: 'discord' | 'onebot',
  download: (attachment: BotAttachment, platform: 'discord' | 'onebot') => Promise<Uint8Array> = downloadBotAttachment,
  saveDocument?: (attachment: BotAttachment, bytes: Uint8Array) => Promise<BotDocument>): Promise<PlatformMessage['parts']> {
  const parts: PlatformMessage['parts'] = [];
  const cached = new Map<string, Promise<PlatformMessage['parts']>>(); let attachmentsRead = 0;
  const attachmentParts = (attachment: BotAttachment) => {
    const key = JSON.stringify([attachment.url, attachment.fileId, attachment.name]);
    const existing = cached.get(key); if (existing) return existing;
    const work = (async (): Promise<PlatformMessage['parts']> => {
      const label = `附件 ${JSON.stringify(attachment.name)}`;
      if (++attachmentsRead > 20) return [{ text: `[${label}：本条消息附件超过 20 个，未读取]` }];
      if (!/\.(txt|md|markdown|png|jpe?g|webp|gif)$/i.test(attachment.name) && !attachment.contentType?.startsWith('image/')) return [{ text: `[${label}：此格式尚不支持自动读取]` }];
      try {
        const bytes = await download(attachment, platform);
        if (/\.(txt|md|markdown)$/i.test(attachment.name)) {
          if (!saveDocument) throw new Error('当前宿主没有可用的本地文档保存器');
          const document = await saveDocument(attachment, bytes);
          return [{ text: `[本地文档 ${JSON.stringify(document)}]\n正文未自动加入上下文。先用 bot_read_attachment 的 stat 查看大小，再用 read 按 offset 和 limit 分段读取；有权限时也可用命令检查这个本地文件。` }];
        }
        const mimeType = imageMime(bytes); if (!mimeType) throw new Error('实际文件不是受支持的图片');
        return [{ text: `[${label}]` }, { inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } }];
      } catch (error) { return [{ text: `[${label}：未读取，${(error as Error).message}]` }]; }
    })(); cached.set(key, work); return work;
  };
  const references = async (values: BotReference[], depth: number) => {
    for (const ref of values.slice(0, 40)) {
      parts.push({ text: `[${ref.kind === 'forward' ? '转发' : '引用'}消息 ${JSON.stringify({ id: ref.id, channelId: ref.channelId, authorId: ref.authorId, displayName: ref.authorName })}，以下是原来源内容]` });
      if (ref.unavailable) parts.push({ text: `[未读取：${ref.unavailable}]` });
      else {
        if (ref.content) parts.push({ text: ref.content });
        for (const attachment of ref.attachments ?? []) parts.push(...await attachmentParts(attachment));
        if (ref.references?.length) { if (depth < 4) await references(ref.references, depth + 1); else parts.push({ text: '[嵌套引用超过 4 层，后续未读取]' }); }
      }
      parts.push({ text: '[原来源内容结束]' });
    }
    if (values.length > 40) parts.push({ text: '[转发条目超过 40 条，后续未读取]' });
  };
  parts.push({ text: `[${platform === 'discord' ? 'Discord' : message.network ?? 'QQ'} 发言 ${JSON.stringify({ id: message.id, authorId: message.authorId,
    displayName: message.authorName, timestamp: message.timestamp })}]\n${message.content}` });
  for (const attachment of message.attachments ?? []) parts.push(...await attachmentParts(attachment));
  await references(message.references ?? [], 0);
  return parts;
}
