import type { PlatformApplication } from '../application';
import { DEFAULT_BOT_AUTO_SUMMARY } from '../../../../shared/botConversation';
import { botInboxStateNamespace, type BotInboxState } from './inbox';
import type { BotPlatform, BotSessions } from './sessions';

/** 定时只检查已保存状态；未开启、没有新消息或任务未完成时，不发起模型请求。 */
export class BotSummaries {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private enabled = false;
  private conversationId?: string;
  constructor(private readonly app: PlatformApplication, private readonly platform: BotPlatform, private readonly sessions: BotSessions) {}
  start() {
    this.enabled = true;
    if (!this.timer) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30000); this.timer.unref(); }
  }
  tick(now = Date.now()): Promise<void> {
    return this.running ??= this.check(now).finally(() => { this.running = undefined; });
  }
  private async check(now: number) {
    if (!this.enabled) return;
    const ids = await this.app.storage.listRecords(botInboxStateNamespace);
    for (const id of ids) {
      if (!this.enabled) return;
      const record = await this.app.storage.getVersionedRecord(botInboxStateNamespace, id);
      const value = record.value as BotInboxState | null;
      if (!value || value.context.platform !== this.platform || !this.sessions.canRecord(value.context)) continue;
      const loaded = await this.sessions.load(value.context, true);
      if (loaded.value.conversationId !== id) continue;
      const settings = loaded.profile.autoSummary ?? DEFAULT_BOT_AUTO_SUMMARY;
      if (!settings.enabled || settings.method && settings.method !== 'time' || this.app.context.isSummarizing(id)) continue;
      const agent = this.app.settings.snapshot().settings.agents.find(item => item.id === loaded.profile.agentId);
      const providerId = loaded.profile.providerId ?? agent?.providerId;
      const model = loaded.profile.modelId ?? agent?.modelId;
      const signature = JSON.stringify([settings, providerId, model]);
      if (value.summarySequence === value.sequence && value.summarySignature === signature) continue;
      const conversation = await this.app.storage.getConversation(id); if (!conversation) continue;
      const baseline = settings.trigger === 'idle' ? value.lastActivityAt : value.summaryAttemptAt ?? conversation.createdAt;
      if (now - baseline < settings.minutes * 60000 || (await this.app.storage.listRuns({ conversationId: id, activeOnly: true })).length) continue;
      if ((await this.app.storage.listRecords('bot-inbox-pending', id)).length) { await this.sessions.inbox.flush(id, value.context); continue; }
      // 先记录本次尝试，重启后不会对同一批空闲历史反复收费。
      await this.app.storage.commitRecords([{ namespace: botInboxStateNamespace, id, expectedRevision: record.revision,
        value: { ...value, summaryAttemptAt: now, summarySequence: value.sequence, summarySignature: signature, summaryError: undefined } }]);
      this.conversationId = id;
      let error: string | undefined;
      try {
        if (!providerId) throw new Error('Bot 没有可用的总结模型渠道。');
        const result = await this.app.context.summarizeManually(this.sessions.owner().id, id, providerId, model, settings);
        if (!result.success) error = result.error?.message;
      } catch (cause) { error = (cause as Error).message; }
      finally { this.conversationId = undefined; }
      await this.sessions.serial(value.context, async () => {
        const latest = await this.app.storage.getVersionedRecord(botInboxStateNamespace, id);
        if (latest.value) await this.app.storage.commitRecords([{ namespace: botInboxStateNamespace, id, expectedRevision: latest.revision,
          value: { ...latest.value as BotInboxState, summaryError: error } }]);
      });
      this.app.publish({ type: 'bot.summary.finished', platform: this.platform, conversationId: id, ...(error ? { error } : {}) });
      if (this.enabled) await this.sessions.inbox.flush(id, value.context);
    }
  }
  async stop() {
    this.enabled = false; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.conversationId) await this.app.context.cancelSummary(this.sessions.owner().id, this.conversationId);
    await this.running;
  }
}
