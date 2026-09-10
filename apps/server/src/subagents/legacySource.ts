import type { PlatformApplication } from '../application';
import type { SubAgentRunPersistedRecord, SubAgentRunSnapshot } from '../../../../backend/tools/subagents/eventBus/types';
import type { SubAgentTranscriptData } from '../../../../backend/modules/conversation/storageTypes';

/** 旧运行仅从已经迁入的记录读取，不扫描或修改原来的用户目录。 */
export async function readLegacySubagent(app: PlatformApplication, actorId: string, runId: string, conversationId?: string) {
  app.requireOwner(actorId);
  if (!conversationId) {
    const matches: string[] = [];
    for (const key of await app.storage.listRecords('subagent-transcript')) {
      try { const ids = JSON.parse(key); if (Array.isArray(ids) && ids[1] === runId && typeof ids[0] === 'string') matches.push(ids[0]); } catch { /* 只读取合法运行引用。 */ }
    }
    if (matches.length !== 1) throw new Error('请从所属对话打开此子代理运行。');
    conversationId = matches[0];
  }
  await app.conversation(actorId, conversationId);
  const state = await app.storage.readConversationState(conversationId);
  const runs = (state.metadata.custom as { subAgentRuns?: SubAgentRunPersistedRecord[] } | undefined)?.subAgentRuns ?? [];
  const run = runs.find(run => run.runId === runId);
  if (!run) throw new Error('没有找到此子代理运行的元数据。');
  const key = JSON.stringify([conversationId, runId]);
  const transcriptRecord = await app.storage.getVersionedRecord('subagent-transcript', key);
  const transcript = transcriptRecord.value as SubAgentTranscriptData | null;
  if (!transcript && !Array.isArray(run.contents)) throw new Error('子代理正文尚未迁入，原始记录仍需导入。');
  return { state, runs, run, conversationId, key, transcriptRecord, transcript };
}

export function legacySubagentSnapshot(record: SubAgentRunPersistedRecord, conversationId: string, transcript?: SubAgentTranscriptData | null): SubAgentRunSnapshot {
  const contents = transcript?.contents ?? record.contents ?? [];
  const status = ['queued', 'running', 'paused', 'awaiting_monitor_action'].includes(record.status) ? 'interrupted' : record.status;
  return { ...record, conversationId, status, contents, events: [], contentRevision: record.contentRevision ?? 0,
    eventSequence: record.eventSequence ?? 0, contextCompactions: transcript?.contextCompactions ?? record.contextCompactions ?? [], transcriptLoaded: true };
}
