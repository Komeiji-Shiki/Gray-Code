import type { PlatformApplication } from '../application';
import { DEFAULT_BOT_AUTO_SUMMARY } from '../../../../shared/botConversation';
import { botInboxStateNamespace, type BotInboxState } from './inbox';
import type { BotPlatform, BotSessions } from './sessions';
import type { BotAutoSummarySettings } from '@graycode/contracts';

function summarySignature(settings: BotAutoSummarySettings, providerId?: string | null, model?: string | null) {
  const normalized = { ...settings, method: settings.method ?? 'time' };
  return JSON.stringify([Object.fromEntries(Object.keys(normalized).sort().map(key => [key, normalized[key]])), providerId ?? null, model ?? null]);
}
function matchesSummarySignature(saved: string | undefined, expected: string) {
  if (!saved) return false;
  try { const [settings, providerId, model] = JSON.parse(saved); return summarySignature(settings, providerId, model) === expected; }
  catch { return false; }
}

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
      try { await this.checkConversation(id, now); }
      catch (error) {
        // 一个频道的配置、存储或投递失败，不阻止其他频道维护上下文。
        this.app.publish({ type: 'bot.summary.finished', platform: this.platform, conversationId: id, error: String((error as Error).message ?? error) });
      }
    }
  }
  private async checkConversation(id: string, now: number) {
    const record = await this.app.storage.getVersionedRecord(botInboxStateNamespace, id);
    const value = record.value as BotInboxState | null;
    if (!value || value.context.platform !== this.platform || !this.sessions.canRecord(value.context)) return;
    const loaded = await this.sessions.load(value.context, true);
    if (loaded.value.conversationId !== id) return;
    const settings = loaded.profile.autoSummary ?? DEFAULT_BOT_AUTO_SUMMARY;
    const legacyTime = !settings.method || settings.method === 'time';
    if (!settings.enabled || (!legacyTime && settings.timedEnabled !== true) || this.app.context.isSummarizing(id)) return;
    const agent = this.app.settings.snapshot().settings.agents.find(item => item.id === loaded.profile.agentId);
    const providerId = loaded.profile.providerId ?? agent?.providerId;
    const model = loaded.profile.modelId ?? agent?.modelId;
    // MessagePack 读取后字段顺序可能变化，比较配置含义，不能把重启当作设置变更。
    const signature = summarySignature(settings, providerId, model);
    const sameSettings = matchesSummarySignature(value.summarySignature, signature);
    if (value.summarySequence === value.sequence && sameSettings && !value.summaryError) return;
    const delay = settings.minutes * 60000;
    const retryAt = value.summaryRetryAt ?? (value.summaryError && value.summaryAttemptAt ? value.summaryAttemptAt + delay : 0);
    if (sameSettings && now < retryAt) return;
    const conversation = await this.app.storage.getConversation(id); if (!conversation) return;
    const baseline = settings.trigger === 'idle' ? value.lastActivityAt : value.summaryAttemptAt ?? conversation.createdAt;
    if (now - baseline < delay || (await this.app.storage.listRuns({ conversationId: id, activeOnly: true })).length) return;
    if ((await this.app.storage.listRecords('bot-inbox-pending', id)).length) { await this.sessions.inbox.flush(id, value.context); return; }
    const claimed = await this.sessions.serial(value.context, async () => {
      const latest = await this.app.storage.getVersionedRecord(botInboxStateNamespace, id);
      const current = latest.value as BotInboxState | null;
      if (!current || current.sequence !== value.sequence || current.summaryAttemptAt !== value.summaryAttemptAt) return false;
      // 尝试和完成分别记录；意外退出或临时失败后，同一批历史仍可按原间隔重试。
      await this.app.storage.commitRecords([{ namespace: botInboxStateNamespace, id, expectedRevision: latest.revision,
        value: { ...current, summaryAttemptAt: now, summarySequence: undefined, summarySignature: signature, summaryRetryAt: now + delay } }]);
      return true;
    });
    if (!claimed || !this.enabled) return;
    this.conversationId = id;
    let error: string | undefined;
    try {
      if (!providerId) throw new Error('Bot 没有可用的总结模型渠道。');
      const result = await this.app.context.summarizeManually(this.sessions.owner().id, id, providerId, model, settings);
      if (!result.success) error = result.error?.message || '上下文总结未完成。';
    } catch (cause) { error = (cause as Error).message; }
    finally { this.conversationId = undefined; }
    await this.sessions.serial(value.context, async () => {
      const latest = await this.app.storage.getVersionedRecord(botInboxStateNamespace, id);
      if (latest.value) await this.app.storage.commitRecords([{ namespace: botInboxStateNamespace, id, expectedRevision: latest.revision,
        value: { ...latest.value as BotInboxState, summaryError: error, summarySignature: signature,
          summarySequence: error ? undefined : value.sequence, summaryRetryAt: error ? now + delay : undefined } }]);
    });
    this.app.publish({ type: 'bot.summary.finished', platform: this.platform, conversationId: id, ...(error ? { error, retryAt: now + delay } : {}) });
    if (this.enabled) await this.sessions.inbox.flush(id, value.context);
  }
  async stop() {
    this.enabled = false; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.conversationId) await this.app.context.cancelSummary(this.sessions.owner().id, this.conversationId);
    await this.running;
  }
}
