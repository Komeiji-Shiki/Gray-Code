import type { SubAgentContextCompactionRecord } from '../../../../shared/subAgentContextCompaction';
import { cloneContentsForWindow } from './transcript';
import { ensureSnapshotProtocolFields } from './protocol';
import { DEFAULT_CONTENT_WINDOW_LIMIT, type SubAgentRunSnapshot, type SubAgentRunContentWindow, type SubAgentRunContentWindowOptions } from './types';

/** 内存 transcript 与数据库分页共用同一组窗口边界。 */
export function getRunContentRange(totalCount: number, options: SubAgentRunContentWindowOptions = {}) {
  const rawLimit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit!)) : DEFAULT_CONTENT_WINDOW_LIMIT;
  const limit = rawLimit > 0 ? rawLimit : DEFAULT_CONTENT_WINDOW_LIMIT;
  let startIndex: number;
  let endIndex: number;
  if (typeof options.startIndex === 'number' || typeof options.endIndex === 'number') {
    if (typeof options.startIndex === 'number' && typeof options.endIndex === 'number') {
      startIndex = Math.max(0, Math.min(totalCount, Math.floor(options.startIndex)));
      endIndex = Math.max(startIndex, Math.min(totalCount, Math.floor(options.endIndex)));
      if (endIndex - startIndex > limit) endIndex = startIndex + limit;
    } else if (typeof options.endIndex === 'number') {
      endIndex = Math.max(0, Math.min(totalCount, Math.floor(options.endIndex)));
      startIndex = Math.max(0, endIndex - limit);
    } else {
      startIndex = Math.max(0, Math.min(totalCount, Math.floor(options.startIndex!)));
      endIndex = Math.min(totalCount, startIndex + limit);
    }
  } else if (options.fromTail !== false) {
    endIndex = totalCount; startIndex = Math.max(0, endIndex - limit);
  } else { startIndex = 0; endIndex = Math.min(totalCount, limit); }
  return { startIndex, endIndex };
}

export function createRunContentWindow(snapshot: SubAgentRunSnapshot, options: SubAgentRunContentWindowOptions = {}): SubAgentRunContentWindow | undefined {
  if (!snapshot || snapshot.transcriptLoaded === false) return undefined;
  const contents = snapshot.contents || [];
  const totalCount = contents.length;
  const { startIndex, endIndex } = getRunContentRange(totalCount, options);
  ensureSnapshotProtocolFields(snapshot);
  return { runId: snapshot.runId, contents: cloneContentsForWindow(contents.slice(startIndex, endIndex)), startIndex, endIndex, totalCount,
    contentRevision: snapshot.contentRevision, eventSequence: snapshot.eventSequence,
    contextCompactions: JSON.parse(JSON.stringify(snapshot.contextCompactions || [])) as SubAgentContextCompactionRecord[],
    hasMoreBefore: startIndex > 0, hasMoreAfter: endIndex < totalCount };
}
