import type { ScreenSenseRecord, ScreenSenseUsage } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { extractMessageTokens } from '../../../../backend/modules/conversation/usageStats';
import type { Content } from '../../../../backend/modules/conversation/types';
export const screenRecords = 'screen-sense-send';
/** 从真实任务消息计算完整交流用量，截图和上下文不重复计入两个类别。 */
export async function screenSenseHistory(app: PlatformApplication) {
  const ids = (await app.storage.listRecords(screenRecords)).sort().slice(-20).reverse();
  const records = (await Promise.all(ids.map(id => app.storage.getRecord(screenRecords, id)))).filter(Boolean) as ScreenSenseRecord[];
  const conversations = new Map<string, Awaited<ReturnType<typeof app.storage.readUsageState>>['messages']>();
  await Promise.all([...new Set(records.map(record => record.conversationId))].map(async id => {
    if (await app.storage.getConversation(id)) conversations.set(id, (await app.storage.readUsageState(id)).messages);
  }));
  return Promise.all(records.map(async record => {
    const run = record.runId ? await app.storage.getRun(record.runId) : await app.storage.getRunByRequestKey(`desktop:screen-sense:${record.id}`);
    const messages = run ? (conversations.get(record.conversationId) ?? []).filter(message => message.runId === run.id) : [];
    const usage: ScreenSenseUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, unknownRequests: 0 };
    for (const message of messages) {
      usage.requests++;
      const raw = message.usageMetadata as Content['usageMetadata'];
      // 缺失和中断的用量保持未知，不把字符估计冒充渠道实际报告。
      if (message.usageMetadataPartial || !Number.isFinite(raw?.promptTokenCount) || !Number.isFinite(raw?.candidatesTokenCount ?? message.candidatesTokenCount)) { usage.unknownRequests++; continue; }
      const tokens = extractMessageTokens(message as Content);
      if (tokens) { usage.inputTokens += tokens.prompt; usage.outputTokens += tokens.candidates + tokens.thoughts; usage.cacheReadTokens += tokens.cacheRead; usage.cacheWriteTokens += tokens.cacheCreation; }
    }
    if (run && ['failed', 'completed', 'interrupted'].includes(run.status) && !messages.length) usage.unknownRequests++;
    if (record.prices) {
      const price = record.prices;
      usage.estimatedCost = (Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens) * price.input
        + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite + usage.outputTokens * price.output) / 1e6;
    }
    return { ...record, runId: run?.id ?? record.runId, status: run?.status, usage };
  }));
}
