import type { PlatformApplication } from '../application';
import { DEFAULT_BOT_AUTO_SUMMARY } from '../../../../shared/botConversation';
import { botInboxStateNamespace, type BotInboxState } from './inbox';
import type { BotContext, BotPlatform, BotSessions } from './sessions';
import type { BotAutoSummarySettings } from '@graycode/contracts';
import { publicBotError } from './errorSummary';

function summarySignature(settings: BotAutoSummarySettings, providerId?: string | null, model?: string | null) {
  const normalized = { ...settings, method: settings.method ?? 'time' };
  return JSON.stringify([Object.fromEntries(Object.keys(normalized).sort().map(key => [key, normalized[key]])), providerId ?? null, model ?? null]);
}
function matchesSummarySignature(saved: string | undefined, expected: string) {
  if (!saved) return false;
  try { const [settings, providerId, model] = JSON.parse(saved); return summarySignature(settings, providerId, model) === expected; }
  catch { return false; }
}

/** 手动总结与定时总结共用认领和状态回写；区别只在手动请求不看定时开关、间隔与设置签名。 */
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
    let afterId: string | undefined;
    for (;;) {
      // 定时检查只需摘要状态，批量投影避免逐条往返存储，也不还原频道的其他统计数据。
      const page = await this.app.storage.readRecordPage(botInboxStateNamespace, undefined, { afterId, limit: 200,
        projection: { fields: ['sequence', 'context', 'lastActivityAt', 'summaryAttemptAt', 'summarySequence',
          'summaryError', 'summarySignature', 'summaryRetryAt'] } });
      for (const record of page) {
        if (!this.enabled) return;
        try { await this.checkConversation(record.id, now, record.value as BotInboxState); }
        catch (error) {
          // 一个频道的配置、存储或投递失败，不阻止其他频道维护上下文。
          this.app.publish({ type: 'bot.summary.finished', platform: this.platform, conversationId: record.id, error: String((error as Error).message ?? error) });
        }
      }
      if (page.length < 200 || !this.enabled) return;
      afterId = page.at(-1)!.id;
    }
  }
  private async checkConversation(id: string, now: number, value: BotInboxState) {
    if (!value || value.context.platform !== this.platform || !this.sessions.canRecord(value.context)) return;
    const loaded = await this.sessions.load(value.context, true);
    if (loaded.value.conversationId !== id) return;
    const settings = loaded.profile.autoSummary ?? DEFAULT_BOT_AUTO_SUMMARY;
    const legacyTime = !settings.method || settings.method === 'time';
    if (!settings.enabled || (!legacyTime && settings.timedEnabled !== true) || this.app.context.isSummarizing(id)) return;
    const agent = this.app.settings.find('agents', loaded.profile.agentId);
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
    const outcome = await this.run(value.context, id, now, { settings, providerId, model, signature, delay, expectedSequence: value.sequence, expectedAttemptAt: value.summaryAttemptAt });
    if (outcome && this.enabled) await this.sessions.inbox.flush(id, value.context);
  }
  /** 手动总结不看定时开关与间隔；任务运行中或已有总结进行时，返回可以直接展示给用户的固定文案。 */
  async manual(context: BotContext, now = Date.now()): Promise<string> {
    const loaded = await this.sessions.load(context, true);
    const id = loaded.value.conversationId;
    if (!id) throw new Error('这个频道还没有对话，先用 /gray 发一条消息再总结。');
    if (this.app.context.isSummarizing(id) || this.conversationId === id) throw new Error('当前对话已经在总结，请等这一次完成。');
    if ((await this.app.storage.listRuns({ conversationId: id, activeOnly: true })).length) throw new Error('请等待当前任务完成后再总结。');
    // 排队中的消息还没写进历史，先交给收件箱按原顺序补齐，避免总结看不到最新发言。
    if ((await this.app.storage.listRecords('bot-inbox-pending', id)).length) return '还有排队中的消息，请等它们进入对话后再总结。';
    const settings = loaded.profile.autoSummary ?? DEFAULT_BOT_AUTO_SUMMARY;
    const agent = this.app.settings.find('agents', loaded.profile.agentId);
    const providerId = loaded.profile.providerId ?? agent?.providerId;
    // 指令本身已经在频道事务里执行，这里再排队会等自己，所以直接复用外层事务。
    const outcome = await this.run(context, id, now, { settings, providerId, model: loaded.profile.modelId ?? agent?.modelId, exclusive: false });
    if (!outcome) throw new Error('这个频道还没有可总结的对话内容，先发一条消息再总结。');
    if (outcome.error) throw new Error(publicBotError(outcome.error) ?? `总结没有完成：${outcome.error}`);
    return `已总结 ${outcome.summarizedMessageCount ?? 0} 条历史，原文仍保留在对话里，可以随时恢复。`;
  }
  /** 认领发生在频道事务里；模型调用耗时较长，必须放在事务之外，结束后再按最新版本回写状态。 */
  private async run(context: BotContext, id: string, now: number, input: { settings: BotAutoSummarySettings; providerId?: string;
    model?: string; signature?: string; delay?: number; expectedSequence?: number; expectedAttemptAt?: number; exclusive?: boolean }) {
    const delay = input.delay ?? input.settings.minutes * 60000;
    const locked = <T>(operation: () => Promise<T>) => input.exclusive === false ? operation() : this.sessions.serial(context, operation);
    const claimed = await locked(async () => {
      const latest = await this.app.storage.getVersionedRecord(botInboxStateNamespace, id);
      const current = latest.value as BotInboxState | null;
      if (!current) return undefined;
      // 定时路径比较发现时的版本；手动路径只要求没有别的总结正在写状态。
      if (input.expectedSequence !== undefined && (current.sequence !== input.expectedSequence || current.summaryAttemptAt !== input.expectedAttemptAt)) return undefined;
      await this.app.storage.commitRecords([{ namespace: botInboxStateNamespace, id, expectedRevision: latest.revision,
        value: { ...current, summaryAttemptAt: now, summarySequence: undefined, ...(input.signature ? { summarySignature: input.signature } : {}),
          summaryRetryAt: now + delay } }]);
      return current.sequence;
    });
    if (claimed === undefined) return undefined;
    this.conversationId = id;
    let error: string | undefined; let summarizedMessageCount: number | undefined;
    try {
      if (!input.providerId) throw new Error('Bot 没有可用的总结模型渠道。');
      const result = await this.app.context.summarizeManually(this.sessions.owner().id, id, input.providerId, input.model, input.settings);
      if ('summarizedMessageCount' in result) summarizedMessageCount = result.summarizedMessageCount;
      else error = result.error?.message || '上下文总结未完成。';
    } catch (cause) { error = (cause as Error).message; }
    finally { this.conversationId = undefined; }
    await locked(async () => {
      const latest = await this.app.storage.getVersionedRecord(botInboxStateNamespace, id);
      if (!latest.value) return;
      await this.app.storage.commitRecords([{ namespace: botInboxStateNamespace, id, expectedRevision: latest.revision,
        value: { ...latest.value as BotInboxState, summaryError: error, ...(input.signature ? { summarySignature: input.signature } : {}),
          summarySequence: error ? undefined : claimed, summaryRetryAt: error ? now + delay : undefined } }]);
    });
    const retryAt = now + delay;
    this.app.publish({ type: 'bot.summary.finished', platform: this.platform, conversationId: id, ...(error ? { error, retryAt } : {}) });
    return { error, summarizedMessageCount };
  }
  async stop() {
    this.enabled = false; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.conversationId) await this.app.context.cancelSummary(this.sessions.owner().id, this.conversationId);
    await this.running;
  }
}
