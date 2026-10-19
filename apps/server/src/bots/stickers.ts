import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { RunRecord } from '@graycode/contracts';
import type { RuntimeTool } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { BotReply } from './gateway';
import { botImageId, imageMime, isPublicAddress, readLimited } from './media';

/** 表情包放在会话工作区的固定目录；去掉扩展名的相对路径就是引用名，子目录用来分类。 */
export const BOT_STICKER_DIRECTORY = '表情包';
const MARKER = /[ \t]*\[表情包[:：]\s*([^\]\n]{1,80}?)\s*\]/g;
const EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const LOOKUP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_REPLY = 3;
/** 访客触发的任务也能收藏聊天图片，数量上限防止目录被刷满。 */
const MAX_STICKERS = 1000;

/** 名称只能是表情包目录内的相对路径：逐段拒绝上级目录、保留字符和会截断标记的方括号。 */
function stickerSegments(input: unknown): string[] {
  const name = String(input ?? '').trim().replace(/\\/g, '/').replace(/\.(png|jpe?g|gif|webp)$/i, '');
  const segments = name.split('/').map(segment => segment.trim());
  if (!name || segments.length > 3 || segments.some(segment => !segment || segment.length > 40 || segment === '.' || segment === '..'
    || /[<>:"|?*[\]\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment)))
    throw new Error('表情包名称需要是 1 至 3 级、每级 40 字以内的相对名称，不能包含 <>:"|?*[] 或以点结尾。');
  return segments;
}
async function stickerRoot(app: PlatformApplication, conversationId: string): Promise<{ root: string; workspaceId: string }> {
  const workspaceId = (await app.storage.getConversation(conversationId))?.workspaceId;
  const workspace = typeof workspaceId === 'string' ? app.settings.find('workspaces', workspaceId) : undefined;
  if (!workspace) throw new Error('当前会话没有工作区，无法使用表情包文件夹。');
  return { root: path.join(workspace.directory, BOT_STICKER_DIRECTORY), workspaceId: workspace.id };
}
async function findSticker(root: string, segments: string[]): Promise<string | undefined> {
  const base = path.join(root, ...segments);
  for (const extension of LOOKUP_EXTENSIONS) {
    const file = base + extension;
    if ((await stat(file).catch(() => undefined))?.isFile()) return file;
  }
  return undefined;
}
async function listStickers(root: string): Promise<Array<{ name: string; file: string }>> {
  const stickers: Array<{ name: string; file: string }> = [];
  const walk = async (directory: string, prefix: string[], depth: number) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(file, [...prefix, entry.name], depth + 1);
      else if (entry.isFile() && LOOKUP_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
        stickers.push({ name: [...prefix, entry.name.slice(0, -path.extname(entry.name).length)].join('/'), file });
    }
  };
  await walk(root, [], 1);
  return stickers;
}
/** 先按字节数筛选，只对大小相同的文件比较内容，主动收藏时不重复保存同一张图。 */
async function sameSticker(stickers: Array<{ name: string; file: string }>, data: Buffer): Promise<string | undefined> {
  for (const sticker of stickers) {
    if ((await stat(sticker.file)).size === data.byteLength && data.equals(await readFile(sticker.file))) return sticker.name;
  }
  return undefined;
}

/** 只移除完整的表情包标记，供流式预览使用；未闭合的标记等待后续文字。 */
export function withoutBotStickerMarkers(text: string): string {
  return text.replace(MARKER, '');
}
/** 标记从正文移除，找到的图片按首次出现的顺序作为单独消息排在正文之后；找不到的名称直接忽略。 */
export async function botStickerReplies(app: PlatformApplication, run: Pick<RunRecord, 'conversationId'>, text: string): Promise<{ text: string; replies: BotReply[] }> {
  const names = [...text.matchAll(MARKER)].map(match => match[1]);
  if (!names.length) return { text, replies: [] };
  const stripped = withoutBotStickerMarkers(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd();
  const root = await stickerRoot(app, run.conversationId).then(value => value.root, () => undefined);
  const replies: BotReply[] = [];
  // 发送只读取表情包目录内的图片，不要求发言账号拥有工作区读取权限；访客触发的回复同样可以带表情包。
  for (const name of root ? [...new Set(names)] : []) {
    if (replies.length >= MAX_PER_REPLY) break;
    let file: string | undefined;
    try { file = await findSticker(root!, stickerSegments(name)); } catch { continue; }
    if (!file || (await stat(file)).size > MAX_BYTES) continue;
    const data = await readFile(file);
    const contentType = imageMime(data);
    if (contentType) replies.push({ content: '', files: [{ name: path.basename(file), data, contentType, sticker: true }] });
  }
  return { text: stripped, replies };
}

async function historyImage(app: PlatformApplication, conversationId: string, id: string): Promise<{ data: Buffer; mimeType: string } | undefined> {
  let beforeIndex: number | undefined;
  // 从最新消息往前找，最多翻 2000 条；图片编号来自消息中的标注。
  for (let page = 0; page < 20; page++) {
    const result = await app.storage.readHistory(conversationId, { limit: 100, beforeIndex });
    for (const message of [...result.messages].reverse()) for (const part of message.parts) {
      const image = part.inlineData as { mimeType?: string; data?: string } | undefined;
      if (typeof image?.data !== 'string' || !image.mimeType?.startsWith('image/')) continue;
      const data = Buffer.from(image.data, 'base64');
      if (botImageId(data) === id) return { data, mimeType: image.mimeType };
    }
    if (!result.startIndex) return undefined;
    beforeIndex = result.startIndex;
  }
  return undefined;
}
/** 网页图片只走 HTTPS；每一跳重定向都重新解析并核对地址，拒绝指向内网或本机的目标。 */
async function downloadImage(input: string, signal: AbortSignal): Promise<Buffer> {
  let url = new URL(input);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('只能下载不含账号信息的 HTTPS 图片地址。');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(item => item.address);
    if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error('图片地址指向内网、本机或保留地址，已拒绝。');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) { url = new URL(location, url); continue; }
    if (!response.ok || !response.body) throw new Error(`图片下载失败，HTTP ${response.status}`);
    return Buffer.from(await readLimited(response.body, MAX_BYTES));
  }
  throw new Error('图片地址重定向次数过多。');
}

export function botStickerTool(app: PlatformApplication): RuntimeTool {
  return {
    declaration: {
      name: 'bot_sticker',
      description:
        `管理当前 Bot 会话工作区“${BOT_STICKER_DIRECTORY}”文件夹中的图片。`
        + '回复正文写 [表情包:名称] 即发送对应图片，名称是该文件夹内不含扩展名的相对路径，可用子文件夹分类；'
        + `一次回复最多发送 ${MAX_PER_REPLY} 个，找不到的名称会被忽略。`
        + '看到聊天中适合当表情包的图片（表情包、梗图、反应图），不必等人要求，直接用 save 和图片编号收藏，按画面和情绪简短命名，例如 猫猫/震惊；'
        + '收藏无需在回复里提及，同一张图不会重复保存；私人照片和含个人信息的截图不要收藏。'
        + 'list 查看可用名称；save 也可下载 HTTPS 网页图片（url）；rename 改名或换分类；delete 删除。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'rename', 'delete'] },
          name: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1, description: 'rename 的新名称。' },
          image: { type: 'string', pattern: '^[0-9a-f]{12}$', description: '消息中标注的图片编号。' },
          url: { type: 'string', minLength: 1 },
          query: { type: 'string', description: 'list 时按名称筛选。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    // 收藏本会话已出现的图片只写入本频道的表情包目录，不要求发言账号的写入权限；下载、改名和删除仍按工作区写入授权。
    effects: args => args.action === 'list' || args.action === 'save' && !args.url ? []
      : args.action === 'delete' ? ['workspace_write', 'data_delete']
        : args.action === 'save' ? ['workspace_write', 'public_read'] : ['workspace_write'],
    execute: async (args, context) => {
      const conversationId = context.conversationId;
      if (!conversationId) throw new Error('表情包工具缺少当前会话。');
      await app.conversation(context.actorId, conversationId);
      const { root, workspaceId } = await stickerRoot(app, conversationId);
      if (args.action === 'list') {
        const query = String(args.query ?? '').trim().toLocaleLowerCase();
        const names = (await listStickers(root)).map(sticker => sticker.name).filter(name => !query || name.toLocaleLowerCase().includes(query));
        return { success: true, directory: root, total: names.length, stickers: names.slice(0, 300), ...(names.length > 300 ? { truncated: true } : {}) };
      }
      // 运行可能没有带工作区（例如账号只有频道目录的部分权限），需要授权的写入按会话工作区单独核对。
      if (args.action !== 'save' || args.url) app.workspace(context.actorId, workspaceId, args.action === 'delete' ? ['workspace_write', 'data_delete'] : ['workspace_write']);
      const segments = stickerSegments(args.name);
      if (args.action === 'save') {
        if (!args.image === !args.url) throw new Error('save 需要且只能提供 image 或 url 之一。');
        const source = args.image ? await historyImage(app, conversationId, String(args.image)) : undefined;
        if (args.image && !source) throw new Error('当前会话最近的消息中没有这个图片编号。');
        const data = source?.data ?? await downloadImage(String(args.url), context.signal);
        const mimeType = imageMime(data);
        if (!mimeType || data.byteLength > MAX_BYTES) throw new Error('表情包需要是 5 MiB 以内的 PNG、JPEG、GIF 或 WebP 图片。');
        const stickers = await listStickers(root);
        const existing = await sameSticker(stickers, data);
        if (existing) return { success: true, name: existing, duplicate: true };
        if (stickers.length >= MAX_STICKERS) throw new Error(`表情包已有 ${MAX_STICKERS} 张，请先整理或删除一些。`);
        if (await findSticker(root, segments)) throw new Error('已有同名表情包，请换一个名称或先改名。');
        const file = path.join(root, ...segments) + EXTENSIONS[mimeType];
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, data, { flag: 'wx' });
        return { success: true, name: segments.join('/'), path: file, sizeBytes: data.byteLength };
      }
      const file = await findSticker(root, segments);
      if (!file) throw new Error('没有这个表情包，可以先用 list 查看名称。');
      if (args.action === 'delete') {
        await rm(file);
        return { success: true, deleted: segments.join('/') };
      }
      const target = stickerSegments(args.to);
      if (await findSticker(root, target)) throw new Error('新名称已被其他表情包使用。');
      const destination = path.join(root, ...target) + path.extname(file);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(file, destination);
      return { success: true, name: target.join('/'), path: destination };
    },
  };
}
