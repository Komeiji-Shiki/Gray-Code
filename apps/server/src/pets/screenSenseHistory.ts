import type { PlatformMessage, ScreenSenseRecord, ScreenSenseUsage } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
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
interface ScreenHistoryCache {
  conversations: Map<string, ConversationUsageCache>;
  activeIds: Set<string>;
  requestSequence: number;
  viewSequence: number;
}
const screenHistoryCaches = new WeakMap<PlatformApplication, ScreenHistoryCache>();

function historyCache(app: PlatformApplication): ScreenHistoryCache {
  let cached = screenHistoryCaches.get(app);
  if (!cached) {
    cached = { conversations: new Map(), activeIds: new Set(), requestSequence: 0, viewSequence: 0 };
    screenHistoryCaches.set(app, cached);
  }
  return cached;
}

async function conversationUsage(app: PlatformApplication, cache: ScreenHistoryCache, id: string): Promise<PlatformMessage[]> {
  const current = cache.conversations.get(id) ?? { messages: [] } as ConversationUsageCache;
  if (cache.activeIds.has(id)) cache.conversations.set(id, current);
  // 同一会话串行推进令牌，后来的读取使用前次确认的前缀，避免并发全量读取或旧结果覆盖新结果。
  const pending = (current.pending ?? Promise.resolve()).catch(() => undefined).then(async () => {
    try {
      let state = await app.storage.readUsageState(id, [], current.token);
      if (state.keep > current.messages.length) state = await app.storage.readUsageState(id);
      const messages = state.keep === current.messages.length && !state.messages.length ? current.messages
        : [...current.messages.slice(0, state.keep), ...state.messages];
      if (cache.conversations.get(id) === current) {
        current.messages = messages;
        current.token = state.token;
      }
      return messages;
    } catch (error) {
      // 记录可能仍在最近列表中，但其对话已删除；不保留旧用量，也不吞掉其他存储错误。
      if ((error as { code?: string }).code !== 'NOT_FOUND') throw error;
      if (cache.conversations.get(id) === current) cache.conversations.delete(id);
      return [];
    }
  });
  current.pending = pending;
  try { return await pending; }
  finally { if (current.pending === pending) current.pending = undefined; }
}

/** 新记录分别展示识图与主对话的用量，旧记录继续按原来的主对话单价解释。 */
export async function screenSenseHistory(app: PlatformApplication) {
  const cache = historyCache(app);
  const sequence = ++cache.requestSequence;
  const page = await app.storage.readRecordPage(screenRecords, undefined, { limit: 20, order: 'desc' });
  const records = page.map(entry => entry.value).filter(Boolean) as ScreenSenseRecord[];
  const ids = new Set(records.map(record => record.conversationId));
  if (sequence >= cache.viewSequence) {
    cache.viewSequence = sequence;
    cache.activeIds = ids;
    for (const id of cache.conversations.keys()) if (!ids.has(id)) cache.conversations.delete(id);
  }
  const conversations = new Map<string, Awaited<ReturnType<typeof app.storage.readUsageState>>['messages']>();
  await Promise.all([...ids].map(async id => conversations.set(id, await conversationUsage(app, cache, id))));
  return Promise.all(records.map(async record => {
    const run = record.runId ? await app.storage.getRun(record.runId)
      : await app.storage.getRunByRequestKey(`desktop:screen-sense:${record.id}`);
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
