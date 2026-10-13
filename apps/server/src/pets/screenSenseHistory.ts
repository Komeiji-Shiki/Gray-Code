import type { PlatformMessage, ScreenSenseRecord, ScreenSenseUsage } from '@graycode/contracts';
import type { PlatformStorage } from '@graycode/core';
import { reportedScreenUsage } from './screenRecognition';

export const screenRecords = 'screen-sense-send';
const emptyUsage = (): ScreenSenseUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, unknownRequests: 0,
});

interface ConversationUsageCache {
  messages: PlatformMessage[];
  token?: string;
  pending?: Promise<PlatformMessage[]>;
}
/** 新记录分别展示识图与主对话的用量，旧记录继续按原来的主对话单价解释。 */
export class ScreenSenseHistory {
  private readonly conversations = new Map<string, ConversationUsageCache>();
  private activeIds = new Set<string>();
  private requestSequence = 0;
  private viewSequence = 0;

  constructor(private readonly storage: Pick<PlatformStorage, 'readRecordPage' | 'readUsageState' | 'getRun' | 'getRunByRequestKey'>) {}

  private async conversationUsage(id: string): Promise<PlatformMessage[]> {
    const current: ConversationUsageCache = this.conversations.get(id) ?? { messages: [] };
    if (this.activeIds.has(id)) this.conversations.set(id, current);
    // 每次快照仍独立报错；前一次失败只解除串行等待，不能让排队的后续读取永久失败。
    const pending = (current.pending ?? Promise.resolve()).catch(() => undefined).then(async () => {
      try {
        const state = await this.storage.readUsageState(id, [], current.token);
        const messages = state.keep === current.messages.length && !state.messages.length ? current.messages
          : [...current.messages.slice(0, state.keep), ...state.messages];
        if (this.conversations.get(id) === current) {
          current.messages = messages;
          current.token = state.token;
        }
        return messages;
      } catch (error) {
        // 感知记录没有对话 owner_id，删除对话后仍保留识图费用；只清掉不存在对话的主用量。
        if ((error as { code?: string }).code !== 'NOT_FOUND') throw error;
        if (this.conversations.get(id) === current) this.conversations.delete(id);
        return [];
      }
    });
    current.pending = pending;
    try {
      return await pending;
    } finally {
      if (current.pending === pending) current.pending = undefined;
    }
  }

  async read() {
    const sequence = ++this.requestSequence;
    const page = await this.storage.readRecordPage(screenRecords, undefined, { limit: 20, order: 'desc' });
    const records = page.map(entry => entry.value as ScreenSenseRecord);
    const ids = new Set(records.map(record => record.conversationId));
    if (sequence >= this.viewSequence) {
      this.viewSequence = sequence;
      this.activeIds = ids;
      for (const id of this.conversations.keys()) {
        if (!ids.has(id)) this.conversations.delete(id);
      }
    }
    const conversations = new Map<string, PlatformMessage[]>();
    await Promise.all([...ids].map(async id => conversations.set(id, await this.conversationUsage(id))));
    return Promise.all(records.map(async record => {
      const run = record.runId ? await this.storage.getRun(record.runId)
        : await this.storage.getRunByRequestKey(`desktop:screen-sense:${record.id}`);
      const messages = run ? (conversations.get(record.conversationId) ?? []).filter(message => message.runId === run.id) : [];
      const mainUsage = emptyUsage();
      for (const message of messages) {
        const usage = reportedScreenUsage(message);
        mainUsage.inputTokens += usage.inputTokens;
        mainUsage.outputTokens += usage.outputTokens;
        mainUsage.cacheReadTokens += usage.cacheReadTokens;
        mainUsage.cacheWriteTokens += usage.cacheWriteTokens;
        mainUsage.requests += usage.requests;
        mainUsage.unknownRequests += usage.unknownRequests;
      }
      if (run && ['failed', 'completed', 'interrupted'].includes(run.status) && !messages.length) mainUsage.unknownRequests++;
      const usage = record.visionUsage ? { ...record.visionUsage } : mainUsage;
      if (record.prices) {
        const price = record.prices;
        usage.estimatedCost = (Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens) * price.input
          + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite + usage.outputTokens * price.output) / 1e6;
      }
      return { ...record, runId: run?.id ?? record.runId, status: run?.status, usage, ...(record.visionUsage ? { mainUsage } : {}) };
    }));
  }
}
