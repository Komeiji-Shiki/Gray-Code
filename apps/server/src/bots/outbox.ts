import { createHash } from 'node:crypto';
import type { BotDeliverySummary } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotGateway, BotReply } from './gateway';
import type { BotPlatform, BotRoute } from './sessions';
import { botRenderedMessageKey, stripDiscordPresentation } from './presentation';

interface Delivery {
  version: 2; route: BotRoute; messages: BotReply[]; next: number; messageIds: Array<string | null>; sentHashes: string[];
  phase: 'queued' | 'sending' | 'editing' | 'unknown'; final: boolean; createdAt: number; error?: string;
  reconcileReceipt?: boolean;
}
const fingerprint = (message: BotReply) => {
  const hash = createHash('sha256').update(message.content ?? '');
  for (const file of message.files ?? []) hash.update(file.name).update(file.data);
  return hash.digest('hex');
};

/** 已知消息可幂等编辑；新消息发送结果不确定时保留记录，由主人决定是否重试。 */
export class BotOutbox {
  private flushing?: Promise<void>;
  private flushRequested = false;
  private readonly locks = new Map<string, Promise<unknown>>();
  private pendingCount = 0;
  private lastError?: string;
  constructor(private readonly app: PlatformApplication, private readonly platform: BotPlatform,
    private readonly gateway: () => { gateway: BotGateway; botId: string } | undefined,
    private readonly admitted: (route: BotRoute) => Promise<boolean>) {}
  private get namespace() { return `${this.platform}-outbox`; }
  status() { return { pendingMessages: this.pendingCount, deliveryError: this.lastError }; }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(id, operation);
    try { return await operation; } finally { if (this.locks.get(id) === operation) this.locks.delete(id); }
  }
  private async read(id: string): Promise<Delivery | null> {
    const value = await this.app.storage.getRecord(this.namespace, id) as Delivery | { route: BotRoute; parts: string[]; next: number } | null;
    if (!value) return null;
    if ('version' in value) return value;
    // 旧记录没有发送中的标记，不能从缺少回执推断消息一定未送达。
    return { version: 2, route: value.route, messages: value.parts.map(content => ({ content })), next: value.next,
      messageIds: Array(value.next).fill(null), sentHashes: value.parts.slice(0, value.next).map(content => fingerprint({ content })),
      phase: 'unknown', final: true, createdAt: 0, error: '旧版待发送消息没有完整回执，请确认后重试。' };
  }
  async put(id: string, route: BotRoute, messages: BotReply[], final = true): Promise<void> {
    await this.locked(id, async () => {
    if (await this.app.storage.getRecord(`${this.platform}-delivered`, id) || await this.app.storage.getRecord(`${this.platform}-suppressed`, id)) return;
    const previous = await this.read(id);
    const value: Delivery = previous ? { ...previous, messages, final } : {
      version: 2, route, messages, next: 0, messageIds: [], sentHashes: [], phase: 'queued', final, createdAt: Date.now(),
    };
    await this.app.storage.putRecord({ namespace: this.namespace, id, value });
    });
    await this.flush();
  }
  flush(): Promise<void> {
    this.flushRequested = true;
    return this.flushing ??= (async () => {
      while (this.flushRequested) { this.flushRequested = false; await this.deliver(); }
    })().finally(() => { this.flushing = undefined; });
  }
  private async save(id: string, value: Delivery) { await this.app.storage.putRecord({ namespace: this.namespace, id, value }); }
  private async deliver(): Promise<void> {
    const records = await Promise.all((await this.app.storage.listRecords(this.namespace)).map(async id => ({ id, value: await this.read(id) })));
    records.sort((a, b) => (a.value?.createdAt ?? 0) - (b.value?.createdAt ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    this.pendingCount = 0; this.lastError = undefined;
    for (const { id } of records) await this.locked(id, async () => {
      const value = await this.read(id);
      if (!value) return;
      if (value.phase === 'sending') { value.phase = 'unknown'; value.error = '上次新消息发送中断，尚未确认是否送达。'; await this.save(id, value); }
      if (value.phase === 'unknown') { this.pendingCount++; this.lastError = value.error; return; }
      const connected = this.gateway();
      if (!connected || connected.botId !== value.route.botId || !await this.admitted(value.route)) { this.pendingCount++; return; }
      let failed = false;
      for (let index = 0; index < value.messages.length; index++) {
        const current = this.gateway();
        if (!current || current.botId !== value.route.botId || !await this.admitted(value.route)) { failed = true; break; }
        const message = value.messages[index]; const hash = fingerprint(message);
        if (index < value.next && value.sentHashes[index] === hash) continue;
        const messageId = value.messageIds[index];
        // 旧版已经发出的分段没有消息 ID，保留原分段，不伪造可编辑的回执。
        if (index < value.next && !messageId) continue;
        try {
          if (messageId) {
            if (!current.gateway.editReply) throw new Error('当前消息平台不支持编辑回复。');
            value.phase = 'editing'; await this.save(id, value);
            await current.gateway.editReply(value.route.channelId, messageId, message);
          } else {
            value.phase = 'sending'; await this.save(id, value);
            const nonce = createHash('sha256').update(`${id}:${index}`).digest('hex').slice(0, 24);
            if (current.gateway.sendReply) {
              const reply = this.platform === 'discord' && value.route.replyToMessageId ? { ...message, replyToMessageId: value.route.replyToMessageId } : message;
              const receipt = await current.gateway.sendReply(value.route.channelId, reply, nonce);
              value.messageIds[index] = receipt.id;
              value.next = index + 1;
              // nonce 可能返回先前已存在的流式消息，确认其内容也更新为当前最终回复。
              if (value.reconcileReceipt && current.gateway.editReply) await current.gateway.editReply(value.route.channelId, receipt.id, message);
            } else {
              if (message.files?.length) throw new Error('当前消息平台不支持这个附件输出方式。');
              await current.gateway.send(value.route.channelId, message.content ?? '');
              value.messageIds[index] = null;
            }
            value.next = index + 1;
          }
          const receiptId = value.messageIds[index];
          if (this.platform === 'discord' && receiptId && message.content && stripDiscordPresentation(message.content) !== message.content) {
            await this.app.storage.putRecord({ namespace: 'bot-rendered-messages',
              id: botRenderedMessageKey(value.route.botId, value.route.channelId, receiptId), ownerId: value.route.conversationId,
              value: { renderer: 'discord-rounds' } });
          }
          value.sentHashes[index] = hash; value.phase = 'queued'; delete value.error;
          await this.save(id, value);
        } catch {
          value.phase = value.messageIds[index] ? 'queued' : 'unknown';
          value.error = value.messageIds[index] ? '回复更新失败，重新连接后可继续更新同一条消息。' : '新消息的发送结果未确认，请在桌面待发送列表检查后重试。';
          await this.save(id, value); this.lastError = value.error; failed = true; break;
        }
      }
      if (!failed && value.messageIds.length > value.messages.length) {
        try {
          const current = this.gateway();
          while (value.messageIds.length > value.messages.length) {
            const messageId = value.messageIds.at(-1);
            if (messageId) {
              if (!current?.gateway.deleteReply) throw new Error('消息平台不支持移除多余的流式消息。');
              await current.gateway.deleteReply(value.route.channelId, messageId);
            }
            value.messageIds.pop(); value.sentHashes.pop(); value.next = Math.min(value.next, value.messages.length);
            await this.save(id, value);
          }
        } catch {
          value.phase = 'queued'; value.error = '流式回复已更新，但多余的旧分段尚未移除，重新连接后可继续处理。';
          await this.save(id, value); this.lastError = value.error; failed = true;
        }
      }
      if (!failed && value.final && value.next >= value.messages.length) await this.app.storage.commitRecords([
        { namespace: this.namespace, id, delete: true }, { namespace: `${this.platform}-delivered`, id, value: { deliveredAt: Date.now(), messageIds: value.messageIds } },
      ]);
      else if (failed) this.pendingCount++;
    });
  }
  async list(): Promise<BotDeliverySummary[]> {
    const values = await Promise.all((await this.app.storage.listRecords(this.namespace)).map(async id => {
      const value = await this.read(id);
      return value ? { id, phase: value.phase, channelId: value.route.channelId, conversationId: value.route.conversationId,
        createdAt: value.createdAt, error: value.error, preview: value.messages.map(item => item.content ?? item.files?.map(file => file.name).join(', ')).join('\n').slice(0, 1000),
        completedParts: value.next, totalParts: value.messages.length } : null;
    }));
    return values.filter(value => value !== null);
  }
  async retry(id: string, acknowledgeDuplicateRisk = false) {
    await this.flushing;
    await this.locked(id, async () => {
    const value = await this.read(id); if (!value) return { success: true };
    if ((value.phase === 'unknown' || value.phase === 'sending') && !acknowledgeDuplicateRisk) throw new Error('发送结果尚未确认，重试可能重复。请明确确认后再重试。');
    value.reconcileReceipt = value.phase === 'unknown' || value.phase === 'sending';
    value.phase = 'queued'; delete value.error; await this.save(id, value);
    });
    await this.flush();
    return { success: true };
  }
  async suppress(id: string, reason: string) {
    await this.locked(id, async () => {
      const value = await this.read(id); if (!value) return;
      await this.app.storage.commitRecords([
        { namespace: this.namespace, id, delete: true },
        { namespace: `${this.platform}-suppressed`, id, value: { reason, suppressedAt: Date.now(), messageIds: value.messageIds } },
      ]);
    });
  }
  async close() { await this.flushing; }
}
