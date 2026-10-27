import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { PlatformMessage } from '@graycode/contracts';
import type { BotAttachment, BotInbound, BotReference } from './gateway';
import type { BotDocument, BotImageFile } from './documents';
import { formatBotMention, formatBotSourceHeader } from '../../../../shared/botMessagePresentation';

export function imageMime(bytes: Uint8Array): string | undefined {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}
/** 模型输入里的动图只保留第 1 帧：缩到 1024 像素以内并量化为调色板 PNG，帧数多、体积大的 GIF 也只有几十 KB。 */
async function gifFirstFrame(bytes: Uint8Array): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp(bytes, { limitInputPixels: 64 * 1024 * 1024, failOn: 'error' })
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).png({ palette: true }).toBuffer();
}
/** 收到的图片按内容散列编号，表情包工具据此取回原图。 */
export function botImageId(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}
// QQ NT 的图片地址在 multimedia.nt.qq.com.cn，不属于 qq.com 后缀。
const attachmentCdn = { discord: ['cdn.discordapp.com', 'media.discordapp.net'], onebot: ['qq.com', 'qq.com.cn', 'qpic.cn', 'gtimg.cn'] };
const reservedIPv4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) reservedIPv4.addSubnet(address, prefix, 'ipv4');
// BlockList 把 IPv4 与其映射形式视为同一地址，IPv6 规则必须单独成表；映射与 NAT64 地址整段拒绝，避免绕过 IPv4 网段。
const reservedIPv6 = new BlockList();
for (const [address, prefix] of [['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const)
  reservedIPv6.addSubnet(address, prefix, 'ipv6');
/** 下载目标只允许公网地址：回环、私有、CGNAT、链路本地、组播与保留网段都拒绝。 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !reservedIPv4.check(address, 'ipv4') : family === 6 && !reservedIPv6.check(address, 'ipv6');
}
function trustedAttachmentUrl(url: URL, platform: 'discord' | 'onebot'): boolean {
  if (url.username || url.password) return false;
  // NapCat 给私聊文件的是 QQ 文件服务器的 http://公网 IPv4:端口；内网、回环与保留地址仍拒绝，附件不能用来访问本机或局域网服务。
  if (platform === 'onebot' && isIP(url.hostname) === 4) return ['http:', 'https:'].includes(url.protocol) && isPublicAddress(url.hostname);
  if (url.protocol !== 'https:' || url.port && url.port !== '443') return false;
  return attachmentCdn[platform].some(domain => url.hostname === domain || platform === 'onebot' && url.hostname.endsWith('.' + domain));
}
/** 仅接受消息平台提供的附件地址，不携带账号凭据，不读取任意 URL 或本地路径。 */
export async function downloadBotAttachment(attachment: BotAttachment, platform: 'discord' | 'onebot'): Promise<Uint8Array> {
  if (!attachment.url) throw new Error('平台没有提供可下载的附件地址');
  const url = new URL(attachment.url);
  if (!trustedAttachmentUrl(url, platform)) throw new Error('附件地址不是受支持的平台 CDN');
  const limit = /\.(txt|md|markdown)$/i.test(attachment.name) ? 32 * 1024 * 1024 : 12 * 1024 * 1024;
  if (attachment.size && attachment.size > limit) throw new Error(`附件超过 ${limit / 1024 / 1024} MiB 读取上限`);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw new Error(`附件下载失败，HTTP ${response.status}`);
  return readLimited(response.body, limit);
}
/** 边读边计数，超过上限立即停止，不先把整个响应读进内存。 */
export async function readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.length;
      if (total > limit) throw new Error('附件实际大小超过读取上限');
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export async function botInboundParts(message: BotInbound, platform: 'discord' | 'onebot',
  download: (attachment: BotAttachment, platform: 'discord' | 'onebot') => Promise<Uint8Array> = downloadBotAttachment,
  saveDocument?: (attachment: BotAttachment, bytes: Uint8Array) => Promise<BotDocument>,
  saveImage?: (attachment: BotAttachment, bytes: Uint8Array, mimeType: string) => Promise<BotImageFile | undefined>): Promise<PlatformMessage['parts']> {
  const parts: PlatformMessage['parts'] = [];
  const cached = new Map<string, Promise<PlatformMessage['parts']>>(); let attachmentsRead = 0;
  const attachmentParts = (attachment: BotAttachment) => {
    const key = JSON.stringify([attachment.url, attachment.fileId, attachment.name]);
    const existing = cached.get(key); if (existing) return existing;
    const work = (async (): Promise<PlatformMessage['parts']> => {
      const sticker = attachment.sticker ? `，QQ 表情包${attachment.summary ? ' ' + attachment.summary : ''}` : '';
      const label = `附件 ${JSON.stringify(attachment.name)}${sticker}`;
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
        const id = botImageId(bytes);
        // 动图的整张 GIF 会随历史进入每一轮请求，而模型只看第 1 帧；原文件留在工作区，图片编号仍按原文件计算。
        const still = mimeType === 'image/gif' ? await gifFirstFrame(bytes) : undefined;
        // 工作区保存失败不影响图片进入本轮上下文；标签会说明未能保存，方便之后排查权限或磁盘问题。
        let location = '';
        if (saveImage) {
          try {
            const saved = await saveImage(attachment, bytes, mimeType);
            if (saved) location = `，工作区路径 ${JSON.stringify(saved.relativePath)}`;
          } catch { location = '，未能保存到工作区'; }
        }
        return [{ text: `[${label}${still ? '，动图只提供第 1 帧' : ''}，图片编号 ${id}${location}]` },
          { inlineData: { mimeType: still ? 'image/png' : mimeType, data: Buffer.from(still ?? bytes).toString('base64') } }];
      } catch (error) { return [{ text: `[${label}：未读取，${(error as Error).message}]` }]; }
    })(); cached.set(key, work); return work;
  };
  // 下载可以并行，加入模型输入的顺序仍由原消息段决定。
  const assets: BotAttachment[] = [];
  const collect = (source: BotInbound | BotReference, depth: number) => {
    assets.push(...source.attachments ?? []);
    if (depth < 4) for (const reference of (source.references ?? []).slice(0, 40)) if (!reference.unavailable) collect(reference, depth + 1);
  };
  collect(message, 0);
  const unique = [...new Map(assets.map(item => [JSON.stringify([item.url, item.fileId, item.name]), item])).values()].slice(0, 20);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, unique.length) }, async () => {
    while (cursor < unique.length) await attachmentParts(unique[cursor++]);
  }));
  const content = async (source: BotInbound | BotReference, depth: number): Promise<void> => {
    if (source.segments) {
      for (const segment of source.segments) {
        if (segment.type === 'text') parts.push({ text: segment.text });
        else if (segment.type === 'mention') parts.push({ text: formatBotMention(segment.id, segment.name) });
        else if (segment.type === 'attachment') {
          const attachment = source.attachments?.[segment.index];
          if (attachment) parts.push(...await attachmentParts(attachment));
        } else {
          const reference = source.references?.[segment.index];
          if (reference) await references([reference], depth);
        }
      }
    } else {
      if (source.content) parts.push({ text: source.content });
      for (const attachment of source.attachments ?? []) parts.push(...await attachmentParts(attachment));
      await references(source.references ?? [], depth);
    }
  };
  const references = async (values: BotReference[], depth: number): Promise<void> => {
    for (const ref of values.slice(0, 40)) {
      parts.push({ text: formatBotSourceHeader(`${ref.kind === 'forward' ? '转发' : '引用'}消息`, { displayName: ref.authorName, timestamp: ref.timestamp }).slice(0, -1) + '，以下是原来源内容]' });
      if (ref.unavailable) parts.push({ text: `[未读取：${ref.unavailable}]` });
      else if (depth <= 4) await content(ref, depth + 1);
      else parts.push({ text: '[嵌套引用超过 4 层，后续未读取]' });
      parts.push({ text: '[原来源内容结束]' });
    }
    if (values.length > 40) parts.push({ text: '[转发条目超过 40 条，后续未读取]' });
  };
  const header = formatBotSourceHeader(`${platform === 'discord' ? 'Discord' : message.network ?? 'QQ'} 发言`, {
    displayName: message.authorName, timestamp: message.timestamp });
  if (message.segments) { parts.push({ text: header }); await content(message, 0); }
  else {
    parts.push({ text: `${header}\n${message.content}` });
    for (const attachment of message.attachments ?? []) parts.push(...await attachmentParts(attachment));
    await references(message.references ?? [], 0);
  }
  return parts;
}
