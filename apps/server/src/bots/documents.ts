import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import type { RuntimeTool } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { BotAttachment } from './gateway';
import { FileReadAccess } from '../workspace/readAccess';

export interface BotDocument { id: string; name: string; path: string; sizeBytes: number; encoding: string }
const recordKey = (conversationId: string, id: string) => JSON.stringify([conversationId, id]);

/** 附件随程序数据目录移动，历史记录中的旧绝对路径只用于取回文件名。 */
function currentDocument(app: PlatformApplication, conversationId: string, document: BotDocument): BotDocument {
  const name = document.path.includes('\\') ? path.win32.basename(document.path) : path.basename(document.path);
  return { ...document, path: path.join(app.storage.directory, 'bot-documents', createHash('sha256').update(conversationId).digest('hex'), name) };
}

function documentEncoding(bytes: Uint8Array): string {
  if (bytes[0] === 255 && bytes[1] === 254) return 'utf-16le';
  if (bytes[0] === 254 && bytes[1] === 255) return 'utf-16be';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return 'utf-8'; }
  catch { new TextDecoder('gb18030', { fatal: true }).decode(bytes); return 'gb18030'; }
}

/** 原文件按内容散列保存，消息和模型输入只携带描述，不携带文档正文。 */
export async function saveBotDocument(app: PlatformApplication, conversationId: string, attachment: BotAttachment, bytes: Uint8Array): Promise<BotDocument> {
  const id = createHash('sha256').update(attachment.name).update('\0').update(bytes).digest('hex');
  const key = recordKey(conversationId, id);
  const existing = await app.storage.getRecord('bot-documents', key) as BotDocument | null;
  if (existing) return currentDocument(app, conversationId, existing);
  const directory = path.join(app.storage.directory, 'bot-documents', createHash('sha256').update(conversationId).digest('hex'));
  const name = attachment.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120).replace(/[. ]+$/, '') || 'document.txt';
  const document: BotDocument = { id, name: attachment.name, path: path.join(directory, `${id.slice(0, 16)}-${name}`), sizeBytes: bytes.byteLength, encoding: documentEncoding(bytes) };
  await mkdir(directory, { recursive: true });
  await writeFile(document.path, bytes, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  await app.storage.putRecord({ namespace: 'bot-documents', id: key, ownerId: conversationId, value: document });
  return document;
}

export function botDocumentTools(app: PlatformApplication): RuntimeTool[] {
  return [{
    declaration: { name: 'bot_read_attachment', description: 'Inspect or read TXT/MD documents received in this Bot conversation. Documents are not added to context automatically. Use list or stat to check the byte size first, then read only the ranges you need with a character offset and limit. read returns 4000 characters by default; when nextOffset is returned, pass it as offset to read the next part. If the account has permission, the returned local path can also be opened with shell or file tools.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'stat', 'read'] }, id: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 12000 } }, required: ['action'], additionalProperties: false } },
    effects: () => [],
    execute: async (args, context) => {
      const conversationId = context.conversationId;
      if (!conversationId) throw new Error('附件读取缺少当前会话。');
      await app.conversation(context.actorId, conversationId);
      const run = await app.storage.getRun(context.runId);
      if (!run || run.conversationId !== conversationId || run.actorId !== context.actorId) throw new Error('不能读取其他会话的附件。');
      context.signal.throwIfAborted();
      if (args.action === 'list') {
        const keys = await app.storage.listRecords('bot-documents', conversationId);
        return { success: true, documents: await Promise.all(keys.map(async key => currentDocument(app, conversationId,
          await app.storage.getRecord('bot-documents', key) as BotDocument))) };
      }
      if (typeof args.id !== 'string') throw new Error('请使用消息中提供的附件 ID。');
      const saved = await app.storage.getRecord('bot-documents', recordKey(conversationId, args.id)) as BotDocument | null;
      if (!saved) throw new Error('当前会话中没有这个附件。');
      const document = currentDocument(app, conversationId, saved);
      const info = await stat(document.path);
      if (args.action === 'stat') return { success: true, ...document, sizeBytes: info.size };
      const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 4000);
      const decoder = new TextDecoder(document.encoding);
      let skipped = 0, text = '';
      const accept = (chunk: string) => {
        const skip = Math.min(chunk.length, Math.max(0, offset - skipped)); skipped += skip;
        text += chunk.slice(skip, skip + limit + 1 - text.length);
      };
      // 流式解码保证 UTF-8/UTF-16/GB18030 跨块字符完整，任何一次输出都受限。
      for await (const chunk of createReadStream(document.path)) {
        context.signal.throwIfAborted();
        accept(decoder.decode(chunk as Buffer, { stream: true }));
        if (text.length > limit) break;
      }
      if (text.length <= limit) accept(decoder.decode());
      const truncated = text.length > limit;
      return { success: true, id: document.id, name: document.name, path: document.path, sizeBytes: info.size,
        offset, text: text.slice(0, limit), truncated, ...(truncated ? { nextOffset: offset + limit } : {}) };
    },
  }, {
    declaration: { name: 'bot_send_attachment', description: 'Send an image or document from an authorized local path to the Bot conversation that started this task. The destination is fixed to that conversation. Images are displayed as images; other files are sent as documents. Inspect the returned delivery status: queued or unknown delivery must be handled through the outbox, not by calling this tool again.',
      parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false } },
    effects: () => ['workspace_read', 'external_send'],
    execute: async (args, context) => {
      const run = await app.storage.getRun(context.runId);
      if (!run || run.actorId !== context.actorId || !context.toolCallId) throw new Error('文件发送缺少当前 Bot 任务或工具调用标识。');
      const route = await app.discord.sessions.routeForRun('discord', run) ?? await app.onebot.sessions.routeForRun('onebot', run);
      if (!route) throw new Error('当前任务没有 Bot 回复位置。');
      const platform = route.platform ?? 'discord', service = app[platform];
      if (!await service.sessions.admitted(route)) throw new Error('当前 Bot 会话的发送权限已关闭。');
      const absolute = await new FileReadAccess(app, context).resolve(String(args.path));
      const info = await stat(absolute);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Bot 附件需要是 32 MiB 以内的普通文件。');
      const data = await readFile(absolute, { signal: context.signal });
      context.signal.throwIfAborted();
      const name = path.basename(absolute);
      const id = `attachment-${context.runId}-${context.iteration ?? 0}-${context.toolCallId}`;
      await service.outbox.put(id, route, [{ files: [{ name, data }] }]);
      const delivered = await app.storage.getRecord(`${platform}-delivered`, id);
      const waiting = delivered ? null : await app.storage.getRecord(`${platform}-outbox`, id) as { phase: string; error?: string } | null;
      return { success: true, deliveryId: id, name, delivered: !!delivered,
        status: delivered ? 'sent' : waiting?.phase ?? 'suppressed', ...(waiting?.error ? { message: waiting.error } : {}) };
    },
  }];
}
