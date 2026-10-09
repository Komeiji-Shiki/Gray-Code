import type { PlatformMessage, RecordMutation, BotMessageStage } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotInbound } from './gateway';
import { botKey, type BotContext, type BotSessions } from './sessions';
import { BOT_MESSAGE_MERGE_GAP_MS } from '../../../../shared/botConversation';
import { branchMutation, groupMessages, readBranches } from '../conversations/branches';
import { rebaseActivePathFromHistory } from '../../../../backend/modules/conversation/branch/BranchGraph';
import type { Content } from '../../../../backend/modules/conversation/types';
import { botMessagePolicy } from './config';

export interface BotInboxItem {
  id: string; conversationId: string; context: BotContext; sequence: number; receivedAt: number;
  trigger: boolean; mergeable: boolean; message: PlatformMessage;
  readyAt?: number; control?: boolean; limited?: boolean;
  consumedIds?: string[]; stateMutation?: RecordMutation;
}
export interface BotInboxState { sequence: number; context: BotContext; lastActivityAt: number; pendingTriggers?: number; lastStarts?: Record<string, number>; summaryAttemptAt?: number; summarySequence?: number; summaryError?: string; summarySignature?: string; summaryRetryAt?: number }
export const botInboxStateNamespace = 'bot-inbox-state';
const pendingNamespace = 'bot-inbox-pending';
const archiveNamespace = 'bot-inbound-archive';

/** 先持久保存每条原消息；只在会话空闲时按到达顺序交付，运行中不会改写历史。 */
export class BotInbox {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private paused = false;
  observe?: (context: BotContext, stage: BotMessageStage, reason?: string, conversationId?: string, runId?: string) => void;
  constructor(private readonly app: PlatformApplication, private readonly sessions: BotSessions) {}
  consumed(item: BotInboxItem): RecordMutation[] {
    return [...(item.consumedIds ?? [item.id]).map<RecordMutation>(id => ({ namespace: pendingNamespace, id, delete: true })), ...(item.stateMutation ? [item.stateMutation] : [])];
  }
  async contains(context: BotContext): Promise<boolean> {
    const id = botKey(context.platform, context.botId, context.id);
    return !!(await this.app.storage.getRecord(archiveNamespace, id) || await this.app.storage.getRecord('bot-receipts', id));
  }
  async activity(conversationId: string, context: BotContext): Promise<RecordMutation> {
    const saved = await this.app.storage.getVersionedRecord(botInboxStateNamespace, conversationId);
    const value = saved.value as BotInboxState | null;
    return { namespace: botInboxStateNamespace, id: conversationId, expectedRevision: saved.revision,
      value: { ...value, context, sequence: (value?.sequence ?? 0) + 1, lastActivityAt: Date.now() } satisfies BotInboxState };
  }
  async receive(context: BotContext, inbound: BotInbound, parts: PlatformMessage['parts'], trigger: boolean, mergeable: boolean, receivedAt = Date.now(), control = false) {
    return this.sessions.serial(context, async () => {
      if (!this.sessions.canRecord(context)) return;
      const id = botKey(context.platform, context.botId, context.id);
      if (await this.app.storage.getRecord(archiveNamespace, id)) return;
      const { conversation } = await this.sessions.recordingConversation(context);
      const saved = await this.app.storage.getVersionedRecord(botInboxStateNamespace, conversation.id);
      const prior = saved.value as BotInboxState | null;
      const policy = botMessagePolicy(this.app.settings.read(context.platform)[context.platform]!, context.channelId, context.direct);
      let pendingTriggers = prior?.pendingTriggers;
      if (pendingTriggers === undefined) {
        // 旧记录首次使用时补齐计数，以后与入队、消费一起提交，不为限流反复恢复附件正文。
        const pending = await this.app.storage.listRecords(pendingNamespace, conversation.id);
        const values = await Promise.all(pending.map(id => this.app.storage.getRecord(pendingNamespace, id) as Promise<BotInboxItem | null>));
        pendingTriggers = values.filter(item => item?.trigger).length;
      }
      const limited = trigger && policy.maxPending > 0 && pendingTriggers >= policy.maxPending;
      if (limited) { trigger = false; mergeable = false; }
      const timestamp = inbound.timestamp ?? receivedAt;
      const item: BotInboxItem = { id, context, conversationId: conversation.id, sequence: (prior?.sequence ?? 0) + 1, receivedAt, readyAt: Date.now(), trigger, mergeable, control, limited,
        message: { id: `bot-message-${id}`, role: 'user', timestamp, parts, botPassive: !trigger,
          botLastTimestamp: timestamp, botAuthorId: context.authorId,
          source: { platform: context.platform, messageId: context.id, channelId: context.channelId, platformUserId: context.authorId,
            displayName: context.authorName, timestamp, ...(inbound.references?.length ? { references: inbound.references } : {}) }, botMessageIds: [context.id] } };
      const value: BotInboxState = { ...prior, context, sequence: item.sequence, lastActivityAt: receivedAt, pendingTriggers: pendingTriggers + Number(trigger) };
      await this.app.storage.commitRecords([{ namespace: pendingNamespace, id, ownerId: conversation.id, expectedRevision: null, value: item },
        { namespace: archiveNamespace, id, ownerId: conversation.id, expectedRevision: null, value: item },
        { namespace: botInboxStateNamespace, id: conversation.id, expectedRevision: saved.revision, value }]);
      if (!control) this.observe?.(context, limited ? 'limited' : trigger ? 'queued' : 'ignored',
        limited ? '排队已满，消息保留为背景，不单独安排回复。' : trigger ? '已进入当前会话的回复队列。' : '未触发回复，消息保留为背景。', conversation.id);
      await this.drain(conversation.id);
    });
  }
  async resume(platform: BotContext['platform']) {
    this.paused = false;
    const ids = await this.app.storage.listRecords(botInboxStateNamespace);
    for (const id of ids) {
      const value = await this.app.storage.getRecord(botInboxStateNamespace, id) as BotInboxState | null;
      if (value?.context.platform === platform) await this.flush(id, value.context);
    }
  }
  async flush(conversationId: string, context?: BotContext) {
    const saved = context ?? (await this.app.storage.getRecord(botInboxStateNamespace, conversationId) as BotInboxState | null)?.context;
    if (saved) await this.sessions.serial(saved, () => this.drain(conversationId));
  }
  private async drain(conversationId: string) {
    if (this.paused) return;
    if (this.app.context.isSummarizing(conversationId)) return;
    if ((await this.app.storage.listRuns({ conversationId, activeOnly: true })).length) return;
    const ids = await this.app.storage.listRecords(pendingNamespace, conversationId);
    const items = (await Promise.all(ids.map(id => this.app.storage.getRecord(pendingNamespace, id) as Promise<BotInboxItem | null>)))
      .filter((item): item is BotInboxItem => !!item).sort((a, b) => a.sequence - b.sequence);
    if (!items.length || !this.sessions.canRecord(items[0].context)) return;
    let count = 0;
    // 授权撤销后的排队消息仍保留原话，但不能继续用旧权限启动模型或工具。
    for (const item of items) {
      if (item.trigger) { try { this.sessions.authorize(item.context); break; } catch { item.trigger = false; item.mergeable = false; } }
      count++;
    }
    if (count) {
      const batch = items.slice(0, count);
      const state = await this.app.conversations.read(this.sessions.owner().id, conversationId);
      const messages = state.history.messages.map(message => ({ ...message }));
      let mergedTail: PlatformMessage | undefined;
      for (const item of batch) {
        const last = messages.at(-1);
        const delta = Number(item.message.timestamp) - Number(last?.botLastTimestamp);
        if (item.mergeable && last?.botPassive === true && last.botMergeable === true && last.botAuthorId === item.context.authorId
          && delta >= 0 && delta <= BOT_MESSAGE_MERGE_GAP_MS && !last.isSummarized) {
          // 只为本批实际合并的尾部取得可写数组，旧正文和附件继续按只读数据复用。
          if (last !== mergedTail) {
            last.parts = [...last.parts]; last.botMessageIds = [...last.botMessageIds as string[]]; mergedTail = last;
          }
          last.parts.push(...item.message.parts);
          (last.botMessageIds as string[]).push(item.context.id);
          last.botLastTimestamp = item.message.timestamp;
        } else messages.push({ ...item.message, botPassive: true, botMergeable: item.mergeable });
      }
      messages.forEach((message, index) => { message.index = index; message.parentId = messages[index - 1]?.id ?? null; });
      const branches = readBranches(state);
      branches.graph = rebaseActivePathFromHistory(branches.graph, messages as Content[], { allowRootChange: true });
      Object.assign(branches.groups, groupMessages(messages));
      const inboxState = await this.app.storage.getVersionedRecord(botInboxStateNamespace, conversationId);
      await this.app.conversations.commit({ state, commit: { messages,
        records: [...batch.flatMap(item => this.consumed(item)), branchMutation(state, branches, messages), {
          namespace: botInboxStateNamespace, id: conversationId, expectedRevision: inboxState.revision,
          value: { ...inboxState.value as BotInboxState, pendingTriggers: items.slice(count).filter(item => item.trigger).length } }] } });
    }
    const next = items[count];
    if (next) {
      const policy = botMessagePolicy(this.app.settings.read(next.context.platform)[next.context.platform]!, next.context.channelId, next.context.direct);
      const saved = await this.app.storage.getVersionedRecord(botInboxStateNamespace, conversationId);
      const state = saved.value as BotInboxState;
      const due = Math.max((next.readyAt ?? next.receivedAt) + policy.mergeWindowMs, (state.lastStarts?.[next.context.authorId] ?? 0) + policy.cooldownMs);
      if (due > Date.now()) {
        if (this.timers.has(conversationId)) clearTimeout(this.timers.get(conversationId));
        const timer = setTimeout(() => {
          this.timers.delete(conversationId);
          void this.flush(conversationId, next.context).catch(error => this.observe?.(next.context, 'failed', (error as Error).message, conversationId));
        }, due - Date.now());
        timer.unref(); this.timers.set(conversationId, timer);
        this.observe?.(next.context, 'queued', '正在等待消息合并窗口或回复冷却结束。', conversationId);
        return;
      }
      const batch = [next];
      if (policy.mergeWindowMs > 0) for (const item of items.slice(count + 1)) {
        if (item.control || item.limited || item.context.authorId !== next.context.authorId || item.receivedAt - next.receivedAt > policy.mergeWindowMs) break;
        batch.push(item);
      }
      const message = { ...next.message, parts: batch.flatMap(item => item.message.parts),
        botMessageIds: batch.flatMap(item => item.message.botMessageIds as string[]), botLastTimestamp: batch.at(-1)!.message.timestamp };
      const now = Date.now();
      const lastStarts = Object.fromEntries(Object.entries(state.lastStarts ?? {}).filter(([, time]) => now - time < policy.cooldownMs));
      if (policy.cooldownMs) lastStarts[next.context.authorId] = now;
      const input: BotInboxItem = { ...next, message, consumedIds: batch.map(item => item.id), stateMutation: {
        namespace: botInboxStateNamespace, id: conversationId, expectedRevision: saved.revision,
        value: { ...state, lastStarts, pendingTriggers: items.slice(count + batch.length).filter(item => item.trigger).length } } };
      const text = message.parts.map(part => typeof part.text === 'string' ? part.text : '').join('\n');
      const result = await this.sessions.execute(next.context, { kind: 'message', text, input });
      this.observe?.(next.context, 'running', batch.length > 1 ? `已合并 ${batch.length} 条连续消息。` : undefined, conversationId, result.run?.id);
      for (const item of batch.slice(1)) this.observe?.(item.context, 'merged', '已并入同一发言人的上一条请求。', conversationId, result.run?.id);
    }
  }
  pause() { this.paused = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}
