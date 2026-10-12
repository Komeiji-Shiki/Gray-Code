import type { ScreenSenseRecord, ScreenSenseUsage } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { reportedScreenUsage } from './screenRecognition';

export const screenRecords = 'screen-sense-send';
const emptyUsage = (): ScreenSenseUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, unknownRequests: 0,
});

/** 新记录分别展示识图与主对话的用量，旧记录继续按原来的主对话单价解释。 */
export async function screenSenseHistory(app: PlatformApplication) {
  const ids = (await app.storage.listRecords(screenRecords)).sort().slice(-20).reverse();
  const records = (await Promise.all(ids.map(id => app.storage.getRecord(screenRecords, id)))).filter(Boolean) as ScreenSenseRecord[];
  const conversations = new Map<string, Awaited<ReturnType<typeof app.storage.readUsageState>>['messages']>();
  await Promise.all([...new Set(records.map(record => record.conversationId))].map(async id => {
    if (await app.storage.getConversation(id)) conversations.set(id, (await app.storage.readUsageState(id)).messages);
  }));
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
