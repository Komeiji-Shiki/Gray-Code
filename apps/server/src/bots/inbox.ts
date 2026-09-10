import type { PlatformMessage, RecordMutation } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotInbound } from './gateway';
import { botKey, type BotContext, type BotSessions } from './sessions';
import { BOT_MESSAGE_MERGE_GAP_MS } from '../../../../shared/botConversation';
import { branchMutation, groupMessages, readBranches } from '../conversations/branches';
import { rebaseActivePathFromHistory } from '../../../../backend/modules/conversation/branch/BranchGraph';
import type { Content } from '../../../../backend/modules/conversation/types';

export interface BotInboxItem {
  id: string; conversationId: string; context: BotContext; sequence: number; receivedAt: number;
  trigger: boolean; mergeable: boolean; message: PlatformMessage;
}
export interface BotInboxState { sequence: number; context: BotContext; lastActivityAt: number; summaryAttemptAt?: number; summarySequence?: number; summaryError?: string; summarySignature?: string }
export const botInboxStateNamespace = 'bot-inbox-state';
const pendingNamespace = 'bot-inbox-pending';
const archiveNamespace = 'bot-inbound-archive';

/** 先持久保存每条原消息；只在会话空闲时按到达顺序交付，运行中不会改写历史。 */
export class BotInbox {
  constructor(private readonly app: PlatformApplication, private readonly sessions: BotSessions) {}
  consumed(item: BotInboxItem): RecordMutation[] { return [{ namespace: pendingNamespace, id: item.id, delete: true }]; }
  async activity(conversationId: string, context: BotContext): Promise<RecordMutation> {
    const saved = await this.app.storage.getVersionedRecord(botInboxStateNamespace, conversationId);
    const value = saved.value as BotInboxState | null;
    return { namespace: botInboxStateNamespace, id: conversationId, expectedRevision: saved.revision,
      value: { ...value, context, sequence: (value?.sequence ?? 0) + 1, lastActivityAt: Date.now() } satisfies BotInboxState };
  }
  async receive(context: BotContext, inbound: BotInbound, parts: PlatformMessage['parts'], trigger: boolean, mergeable: boolean) {
    return this.sessions.serial(context, async () => {
      if (!this.sessions.canRecord(context)) return;
      const id = botKey(context.platform, context.botId, context.id);
      if (await this.app.storage.getRecord(archiveNamespace, id)) return;
      const { conversation } = await this.sessions.recordingConversation(context);
      const saved = await this.app.storage.getVersionedRecord(botInboxStateNamespace, conversation.id);
      const prior = saved.value as BotInboxState | null;
      const receivedAt = Date.now();
      const timestamp = inbound.timestamp ?? receivedAt;
      const item: BotInboxItem = { id, context, conversationId: conversation.id, sequence: (prior?.sequence ?? 0) + 1, receivedAt, trigger, mergeable,
        message: { id: `bot-message-${id}`, role: 'user', timestamp, parts, botPassive: !trigger,
          botLastTimestamp: timestamp, botAuthorId: context.authorId,
          source: { platform: context.platform, messageId: context.id, channelId: context.channelId, platformUserId: context.authorId,
            displayName: context.authorName, timestamp }, botMessageIds: [context.id] } };
      const value: BotInboxState = { ...prior, context, sequence: item.sequence, lastActivityAt: receivedAt };
      await this.app.storage.commitRecords([{ namespace: pendingNamespace, id, ownerId: conversation.id, expectedRevision: null, value: item },
        { namespace: archiveNamespace, id, ownerId: conversation.id, expectedRevision: null, value: item },
        { namespace: botInboxStateNamespace, id: conversation.id, expectedRevision: saved.revision, value }]);
      await this.drain(conversation.id);
    });
  }
  async resume(platform: BotContext['platform']) {
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
      const messages = structuredClone(state.history.messages);
      for (const item of batch) {
        const last = messages.at(-1);
        const delta = Number(item.message.timestamp) - Number(last?.botLastTimestamp);
        if (item.mergeable && last?.botPassive === true && last.botMergeable === true && last.botAuthorId === item.context.authorId
          && delta >= 0 && delta <= BOT_MESSAGE_MERGE_GAP_MS && !last.isSummarized) {
          last.parts.push(...item.message.parts);
          last.botMessageIds = [...last.botMessageIds as string[], item.context.id];
          last.botLastTimestamp = item.message.timestamp;
        } else messages.push({ ...item.message, botPassive: true, botMergeable: item.mergeable });
      }
      messages.forEach((message, index) => { message.index = index; message.parentId = messages[index - 1]?.id ?? null; });
      const branches = readBranches(state);
      branches.graph = rebaseActivePathFromHistory(branches.graph, messages as Content[], { allowRootChange: true });
      Object.assign(branches.groups, groupMessages(messages));
      await this.app.conversations.commit({ state, commit: { messages,
        records: [...batch.flatMap(item => this.consumed(item)), branchMutation(state, branches)] } });
    }
    const next = items[count];
    if (next) {
      const text = next.message.parts.map(part => typeof part.text === 'string' ? part.text : '').join('\n');
      await this.sessions.execute(next.context, { kind: 'message', text, input: next });
    }
  }
}
