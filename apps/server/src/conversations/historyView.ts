import type { PageOptions, PlatformMessage } from '@graycode/contracts';
import { PlatformStorage, PlatformStorageError } from '@graycode/core';
import { t } from '../../../../backend/i18n';
import type { Content, ContentPart, ConversationHistory } from '../../../../backend/modules/conversation/types';
import type { HistoryOutlineEntry } from '../../../../backend/modules/conversation/storageTypes';
import { toDisplayMessages } from '../../../../backend/modules/conversation/manager/historyFormatting';
import { isPlaceholderToolResponse, repairDuplicateFunctionResponses } from '../../../../backend/modules/conversation/manager/historyRepair';
import { buildMigratedHistory, ensureNodeId, needsNodeIdMigration } from '../../../../backend/modules/conversation/manager/nodeId';
import { findFunctionResponseInsertIndex, messageRunId } from '../../../../backend/modules/conversation/manager/utils';

export interface OutlineScanResult {
  outline: HistoryOutlineEntry[];
  hasUnresolvedCalls: boolean;
  hasResponseAnomalies: boolean;
  needsNodeIdMigration: boolean;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof PlatformStorageError && error.code === 'NOT_FOUND';
}

function toPlatform(content: Content): PlatformMessage {
  return { ...content, parts: (content.parts ?? []).map(part => ({ ...part })) };
}

/**
 * 轻量扫描存储摘要，判断历史是否需要配对自愈或旧节点 ID 迁移。
 * 对话不存在时返回 null。
 */
export async function scanConversationOutline(storage: PlatformStorage, conversationId: string): Promise<OutlineScanResult | null> {
  let entries: HistoryOutlineEntry[];
  try {
    entries = (await storage.readHistoryOutline(conversationId)).entries;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const activeRuns = await storage.listRuns({ conversationId, activeOnly: true });
  const activeRunIds = new Set(activeRuns.map(run => run.id));
  const respondedIds = new Set<string>();
  const seenResponseIds = new Set<string>();
  const resolvedResponseIds = new Set<string>();
  let hasResponseAnomalies = false;
  let needsMigration = false;
  for (const entry of entries) {
    if (!entry.id || !entry.hasParentId) needsMigration = true;
    for (const response of entry.responses ?? []) {
      respondedIds.add(response.id);
      if (seenResponseIds.has(response.id)) hasResponseAnomalies = true;
      else seenResponseIds.add(response.id);
      if (!isPlaceholderToolResponse(response)) resolvedResponseIds.add(response.id);
    }
  }
  let hasUnresolvedCalls = false;
  for (const entry of entries) {
    const activeRunCall = !!(entry.runId && activeRunIds.has(entry.runId));
    for (const call of entry.calls ?? []) {
      if (call.rejected && resolvedResponseIds.has(call.id)) {
        hasResponseAnomalies = true;
        continue;
      }
      if (!activeRunCall && !respondedIds.has(call.id) && !call.rejected) {
        hasUnresolvedCalls = true;
        break;
      }
    }
  }
  return {
    outline: entries,
    hasUnresolvedCalls,
    hasResponseAnomalies,
    needsNodeIdMigration: needsMigration,
  };
}

/**
 * 在存储版本保护下一次性修复重复工具响应、悬空工具调用与缺失节点 ID。
 * 绝大多数干净历史仅经过轻量摘要扫描即可直接返回，不读取完整消息正文。
 */
export async function ensureCleanHistory(
  storage: PlatformStorage,
  conversationId: string,
): Promise<{ exists: boolean; outline?: HistoryOutlineEntry[]; messages?: ConversationHistory }> {
  const scan = await scanConversationOutline(storage, conversationId);
  if (!scan) return { exists: false };
  if (!scan.hasUnresolvedCalls && !scan.hasResponseAnomalies && !scan.needsNodeIdMigration) {
    return { exists: true, outline: scan.outline };
  }
  let page: { revision: number; messages: PlatformMessage[] };
  try {
    page = await storage.readFullHistory(conversationId);
  } catch (error) {
    if (isNotFoundError(error)) return { exists: false };
    throw error;
  }
  const activeRunIds = new Set((await storage.listRuns({ conversationId, activeOnly: true })).map(run => run.id));
  const history = page.messages as ConversationHistory;
  const repaired = repairDuplicateFunctionResponses(history);
  let current: ConversationHistory = repaired.changed ? repaired.history.slice() : history.slice();
  let changed = repaired.changed;

  const respondedToolCallIds = new Set<string>();
  for (const message of current) {
    for (const part of message.parts ?? []) {
      if (part.functionResponse?.id) respondedToolCallIds.add(part.functionResponse.id);
    }
  }

  const unresolvedByIndex = new Map<number, Array<{ id: string; name: string }>>();
  for (let i = 0; i < current.length; i++) {
    const original = current[i];
    if (!original.parts) continue;
    const runId = messageRunId(original);
    if (runId && activeRunIds.has(runId)) continue;
    let working = original;
    for (const part of original.parts) {
      const callId = part.functionCall?.id;
      if (callId && !respondedToolCallIds.has(callId) && !part.functionCall?.rejected) {
        if (working === original) {
          working = structuredClone(original);
          current[i] = working;
        }
        const target = working.parts!.find(item => item.functionCall?.id === callId);
        if (target?.functionCall) target.functionCall.rejected = true;
        const list = unresolvedByIndex.get(i) ?? [];
        list.push({ id: callId, name: part.functionCall?.name || 'unknown' });
        unresolvedByIndex.set(i, list);
      }
    }
  }

  if (unresolvedByIndex.size > 0) {
    changed = true;
    const sortedIndices = [...unresolvedByIndex.keys()].sort((a, b) => b - a);
    for (const messageIndex of sortedIndices) {
      const calls = unresolvedByIndex.get(messageIndex)!;
      const rejectedResponseParts: ContentPart[] = calls.map(call => ({
        functionResponse: {
          name: call.name,
          id: call.id,
          response: {
            success: false,
            error: t('modules.api.chat.errors.userRejectedTool'),
            rejected: true,
          },
        },
      }));
      const insertAt = findFunctionResponseInsertIndex(current, messageIndex);
      const parent = insertAt > 0 ? current[insertAt - 1] : null;
      current.splice(insertAt, 0, ensureNodeId({
        role: 'user',
        parts: rejectedResponseParts,
        isFunctionResponse: true,
      }, parent));
    }
  }

  if (needsNodeIdMigration(current)) {
    current = buildMigratedHistory(conversationId, current);
    changed = true;
  }

  if (changed) {
    try {
      await storage.commitConversation({
        conversationId,
        expectedRevision: page.revision,
        messages: current.map(toPlatform),
      });
    } catch (error) {
      if (!(error instanceof PlatformStorageError) || !['STORAGE_BUSY', 'REVISION_CONFLICT'].includes(error.code)) throw error;
      current = (await storage.readFullHistory(conversationId)).messages as ConversationHistory;
    }
  }
  return { exists: true, messages: current };
}

export async function readDisplayMessagesPaged(
  storage: PlatformStorage,
  conversationId: string,
  options: PageOptions = {},
): Promise<{ total: number; messages: Content[] }> {
  const isInitialPage = options.beforeIndex === undefined && options.offset === undefined;
  if (isInitialPage) {
    const ensured = await ensureCleanHistory(storage, conversationId);
    if (!ensured.exists) return { total: 0, messages: [] };
  }
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 120), 1000));
  const beforeIndex = Number.isFinite(options.beforeIndex) ? Math.max(0, Math.floor(options.beforeIndex!)) : undefined;
  const offset = beforeIndex === undefined && Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : undefined;
  try {
    const page = await storage.readHistory(conversationId, { limit, beforeIndex, offset });
    return { total: page.total, messages: toDisplayMessages(page.messages as Content[], page.startIndex) };
  } catch (error) {
    if (isNotFoundError(error)) return { total: 0, messages: [] };
    throw error;
  }
}

export async function readMessageMarkers(
  storage: PlatformStorage,
  conversationId: string,
): Promise<{ total: number; markers: Array<{ index: number; id?: string; preview?: string }>; floorIndices: number[] }> {
  const ensured = await ensureCleanHistory(storage, conversationId);
  if (!ensured.exists) return { total: 0, markers: [], floorIndices: [] };
  const outline = ensured.outline ?? (await storage.readHistoryOutline(conversationId)).entries;
  const markers: Array<{ index: number; id?: string; preview?: string }> = [];
  const floorIndices: number[] = [];
  outline.forEach((entry, index) => {
    if (entry.role === 'model' || (entry.role === 'user' && !entry.isFunctionResponse)) floorIndices.push(index);
    if (entry.role !== 'user' || entry.isFunctionResponse) return;
    markers.push({ index, ...(entry.id ? { id: entry.id } : {}), ...(entry.preview ? { preview: entry.preview } : {}) });
  });
  return { total: outline.length, markers, floorIndices };
}

export async function findMessagePosition(
  storage: PlatformStorage,
  conversationId: string,
  messageId: string,
): Promise<{ index?: number }> {
  if (typeof messageId !== 'string' || !messageId || messageId.length > 512) return {};
  const ensured = await ensureCleanHistory(storage, conversationId);
  if (!ensured.exists) return {};
  const outline = ensured.outline ?? (await storage.readHistoryOutline(conversationId)).entries;
  const index = outline.findIndex(entry => entry.id === messageId);
  return index >= 0 ? { index } : {};
}
