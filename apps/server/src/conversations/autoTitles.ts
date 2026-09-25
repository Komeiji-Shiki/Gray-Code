/**
 * 对话标题维护（独立宿主）。
 *
 * 独立宿主新建对话先以占位标题落库（ui.mode.new / conversation.createConversation），
 * 修复前的版本没有「首条消息命名」的时机，既有数据会一直停在「新对话」。本模块提供：
 * - deriveConversationTitle：发送路径与补齐共用的命名规则（与旧 RPC runs.start 一致）；
 * - backfillPlaceholderTitles：启动后台补齐，把已有真实用户消息的占位标题改为消息摘要。
 */

import type { PlatformApplication } from '../application';

/** 新建对话的占位标题（各新建入口均写中文字面量）。 */
export const PLACEHOLDER_CONVERSATION_TITLES = new Set(['新对话', '新角色对话']);

/** 由消息文本推导标题：压缩空白并限制长度（与旧 RPC runs.start 的命名规则一致）。 */
export function deriveConversationTitle(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const title = text.trim().replace(/\s+/g, ' ').slice(0, 48);
  return title || undefined;
}

const MAINTENANCE_NAMESPACE = 'maintenance';
const MAINTENANCE_ID = 'conversation-placeholder-titles';

/** 读取对话开头的消息，返回首条真实用户文本（跳过工具响应、总结、后台回执与内部反馈）。 */
async function firstUserMessageTitle(app: PlatformApplication, conversationId: string): Promise<string | undefined> {
  const page = await app.storage.readHistory(conversationId, { offset: 0, limit: 12 });
  for (const message of page.messages) {
    if (message.role !== 'user') continue;
    if (message.isFunctionResponse || message.isSummary || message.userFeedback || message.contextControl) continue;
    if (message.source === 'background_task') continue;
    for (const part of message.parts) {
      const title = deriveConversationTitle((part as { text?: unknown }).text);
      if (title) return title;
    }
  }
  return undefined;
}

/**
 * 启动后台补齐：把仍是占位标题、但已有真实用户消息的对话按首条用户消息命名。
 * 完成后写入一次性标记，后续启动直接跳过；单个对话失败只提示，不影响本轮其余补齐。
 */
export async function backfillPlaceholderTitles(app: PlatformApplication): Promise<number> {
  if (await app.storage.getRecord(MAINTENANCE_NAMESPACE, MAINTENANCE_ID)) return 0;
  const placeholders: string[] = [];
  let cursor: { updatedAt: number; id: string } | undefined;
  do {
    const page = await app.storage.listConversations({ limit: 200, cursor });
    for (const item of page.items) {
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (PLACEHOLDER_CONVERSATION_TITLES.has(title)) placeholders.push(item.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  let updated = 0;
  for (const id of placeholders) {
    try {
      const title = await firstUserMessageTitle(app, id);
      if (!title) continue;
      const conversation = await app.storage.getConversation(id);
      const current = typeof conversation?.title === 'string' ? conversation.title.trim() : '';
      // 期间可能被用户改名：只回填仍是占位（或空）标题的对话。
      if (!conversation || (current && !PLACEHOLDER_CONVERSATION_TITLES.has(current))) continue;
      await app.storage.saveMetadata({ ...conversation, title, updatedAt: Date.now() });
      app.publish({ type: 'conversation.changed', conversationId: id, metadataOnly: true });
      updated++;
    } catch (error) {
      console.warn('[autoTitles] Failed to backfill conversation title:', id, error);
    }
  }
  if (updated) app.productUi.conversations.clearMetadataCache();
  await app.storage.putRecord({ namespace: MAINTENANCE_NAMESPACE, id: MAINTENANCE_ID, ownerId: MAINTENANCE_ID,
    value: { updated, at: Date.now() } });
  return updated;
}
