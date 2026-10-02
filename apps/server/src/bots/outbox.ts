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
/** 待发送条目的内存索引：只含排序和跳过判断所需的字段，正文仍在锁内从存储读取。 */
interface PendingDelivery { createdAt: number; phase: Delivery['phase']; error?: string; route: BotRoute }
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
  /**
   * 本实例是该命名空间唯一的写入方，启动后首次投递时从存储载入一次，之后随每次保存和删除更新，
   * 流式更新不再列举并读取整个队列。载入期间发生的修改先记入 loadingChanges，载入完成后覆盖快照中的旧值。
   */
  private pending?: Map<string, PendingDelivery>;
  private loading?: Promise<Map<string, PendingDelivery>>;
  private loadingChanges?: Map<string, PendingDelivery | null>;
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
  private track(id: string, value: Delivery | null): void {
    const entry = value && { createdAt: value.createdAt, phase: value.phase, error: value.error, route: value.route };
    this.loadingChanges?.set(id, entry);
    if (!this.pending) return;
    if (entry) this.pending.set(id, entry); else this.pending.delete(id);
  }
  private index(): Promise<Map<string, PendingDelivery>> {
    if (this.pending) return Promise.resolve(this.pending);
    return this.loading ??= (async () => {
      const changes = this.loadingChanges = new Map();
      try {
        const pending = new Map<string, PendingDelivery>();
        for (const { id, value } of await Promise.all((await this.app.storage.listRecords(this.namespace)).map(async id => ({ id, value: await this.read(id) }))))
          if (value) pending.set(id, { createdAt: value.createdAt, phase: value.phase, error: value.error, route: value.route });
        for (const [id, entry] of changes) if (entry) pending.set(id, entry); else pending.delete(id);
        return this.pending = pending;
      } finally { this.loadingChanges = undefined; this.loading = undefined; }
    })();
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
    await this.app.storage.putRecord({ namespace: this.namespace, id, value }); this.track(id, value);
    });
    await this.flush();
  }
  flush(): Promise<void> {
    this.flushRequested = true;
    return this.flushing ??= (async () => {
      while (this.flushRequested) { this.flushRequested = false; await this.deliver(); }
    })().finally(() => { this.flushing = undefined; });
  }
  private async save(id: string, value: Delivery) { await this.app.storage.putRecord({ namespace: this.namespace, id, value }); this.track(id, value); }
  private async deliver(): Promise<void> {
    const pending = await this.index();
    const order = [...pending].sort(([a, left], [b, right]) => left.createdAt - right.createdAt || a.localeCompare(b, undefined, { numeric: true })).map(([id]) => id);
    this.pendingCount = 0; this.lastError = undefined;
    for (const id of order) await this.locked(id, async () => {
      // 等待锁期间条目可能已发送完或被改写，先以索引里的最新状态判断。
      const summary = pending.get(id);
      if (!summary) return;
      // 结果未确认或当前无法发送的条目只计数，不读取正文；中断的发送仍要先落盘为未确认。
      if (summary.phase === 'unknown') { this.pendingCount++; this.lastError = summary.error; return; }
      const connected = this.gateway();
      if (summary.phase !== 'sending' && (!connected || connected.botId !== summary.route.botId || !await this.admitted(summary.route))) { this.pendingCount++; return; }
      // 锁内只读一次；发送前的逐条权限复查仍在下方循环中进行。
      const value = await this.read(id);
      if (!value) { this.track(id, null); return; }
      if (value.phase === 'sending') { value.phase = 'unknown'; value.error = '上次新消息发送中断，尚未确认是否送达。'; await this.save(id, value); }
      if (value.phase === 'unknown') { this.pendingCount++; this.lastError = value.error; return; }
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
              const reply = value.route.replyToMessageId ? { ...message, replyToMessageId: value.route.replyToMessageId } : message;
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
      if (!failed && value.final && value.next >= value.messages.length) {
        await this.app.storage.commitRecords([
          { namespace: this.namespace, id, delete: true }, { namespace: `${this.platform}-delivered`, id, value: { deliveredAt: Date.now(), messageIds: value.messageIds } },
        ]);
        this.track(id, null);
      } else if (failed) this.pendingCount++;
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
      this.track(id, null);
    });
  }
  async close() { await this.flushing; }
}
