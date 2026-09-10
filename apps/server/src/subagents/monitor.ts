import { randomUUID } from 'node:crypto';
import { readLegacySubagent, legacySubagentSnapshot } from './legacySource';
import type { PlatformApplication } from '../application';
import type { SubAgentRunPersistedRecord, SubAgentRunContentWindowOptions } from '../../../../backend/tools/subagents/eventBus/types';
import type { SubAgentTranscriptData } from '../../../../backend/modules/conversation/storageTypes';
import { createRunContentWindow } from '../../../../backend/tools/subagents/eventBus/contentWindow';
import { toManifest } from '../../../../backend/tools/subagents/eventBus/protocol';
import { deleteLogicalMessage } from '../../../../backend/modules/conversation/TranscriptMutation';

/** 监视器按运行读取历史，复用原正文、分页和消息配对规则。 */
export class SubAgentMonitorService {
  constructor(private readonly app: PlatformApplication) {}
  async focus(actorId: string, runId?: string, conversationId?: string, toolId?: string): Promise<string> {
    if (runId) {
      if (await this.app.subagents.get(actorId, runId)) return runId;
      await readLegacySubagent(this.app, actorId, runId, conversationId); return runId;
    }
    const native = (await this.app.subagents.manifests(actorId, conversationId)).find(item => item.sourceToolCallId === toolId);
    if (native) return native.runId;
    if (conversationId && toolId) {
      const metadata = await this.app.conversation(actorId, conversationId);
      const records = (metadata.custom as { subAgentRuns?: SubAgentRunPersistedRecord[] } | undefined)?.subAgentRuns ?? [];
      const candidate = `subagent_run_${toolId.trim().replace(/[^A-Za-z0-9_-]/g, '_')}`;
      if (records.some(record => record.runId === candidate)) return candidate;
    }
    throw new Error('子代理尚未建立运行记录，请稍后从工具调用中打开。');
  }
  async retry(actorId: string, runId: string, conversationId: string | undefined, index: number, messageId?: string, revision?: number) {
    if (await this.app.subagents.get(actorId, runId)) return this.app.subagents.mutate(actorId, runId, index, messageId, revision, true);
    return this.app.subagents.legacy.retry(actorId, runId, conversationId, index, messageId, revision);
  }
  async ready(actorId: string, conversationId?: string, focusRunId?: string) {
    this.app.requireOwner(actorId);
    const parents = new Set<string>();
    if (conversationId) parents.add(conversationId);
    else for (const key of await this.app.storage.listRecords('subagent-transcript')) {
      try { const ids = JSON.parse(key); if (Array.isArray(ids) && typeof ids[0] === 'string') parents.add(ids[0]); } catch { /* 忽略不属于 transcript 的键。 */ }
    }
    const manifests: Record<string, any>[] = await this.app.subagents.manifests(actorId, conversationId);
    for (const id of parents) {
      const metadata = await this.app.conversation(actorId, id);
      const runs = (metadata.custom as { subAgentRuns?: SubAgentRunPersistedRecord[] } | undefined)?.subAgentRuns ?? [];
      for (const record of runs) {
        const manifest = toManifest(legacySubagentSnapshot(record, id));
        manifest.contentCount = record.contentCount ?? record.contents?.length ?? 0;
        manifest.preview = record.preview; manifest.lastMessageRole = record.lastMessageRole;
        manifests.push({ ...manifest, canRetry: true, legacy: true });
      }
    }
    return { manifests: manifests.sort((a, b) => b.createdAt - a.createdAt), focusRunId, activeRunIds: this.app.subagents.activeIds(), capabilities: { retry: true } };
  }
  async window(actorId: string, runId: string, conversationId?: string, options: SubAgentRunContentWindowOptions = {}) {
    const live = await this.app.subagents.window(actorId, runId, options);
    if (live) return live;
    const target = await readLegacySubagent(this.app, actorId, runId, conversationId);
    const transcript = target.transcript;
    const snapshot = legacySubagentSnapshot(target.run, target.conversationId, transcript ?? undefined);
    return { manifest: { ...toManifest(snapshot), canRetry: true, legacy: true }, window: createRunContentWindow(snapshot, { ...options, limit: Math.min(200, options.limit ?? 20) }), activeRunIds: this.app.subagents.activeIds() };
  }
  async deleteMessage(actorId: string, runId: string, conversationId: string | undefined, contentIndex: number, messageId?: string, expectedRevision?: number) {
    if (await this.app.subagents.get(actorId, runId)) return this.app.subagents.mutate(actorId, runId, contentIndex, messageId, expectedRevision, false);
    const target = await readLegacySubagent(this.app, actorId, runId, conversationId);
    return this.app.subagents.legacy.serialize(target.conversationId, runId,
      () => this.deleteLegacyMessage(actorId, runId, target.conversationId, contentIndex, messageId, expectedRevision));
  }
  private async deleteLegacyMessage(actorId: string, runId: string, conversationId: string, contentIndex: number, messageId?: string, expectedRevision?: number) {
    const target = await readLegacySubagent(this.app, actorId, runId, conversationId);
    const key = JSON.stringify([target.conversationId, runId]);
    const record = await this.app.storage.getVersionedRecord('subagent-transcript', key);
    const original = record.value as SubAgentTranscriptData | null;
    const snapshot = legacySubagentSnapshot(target.run, target.conversationId, original ?? undefined);
    if (!Number.isSafeInteger(contentIndex) || !snapshot.contents[contentIndex]) throw new Error('该子代理消息不存在。');
    if (messageId && (snapshot.contents[contentIndex].id ?? `${runId}_${contentIndex}`) !== messageId || expectedRevision !== undefined && snapshot.contentRevision !== expectedRevision)
      throw new Error('子代理消息已变化，请刷新后重试。');
    snapshot.contents = deleteLogicalMessage(snapshot.contents, contentIndex);
    snapshot.contentRevision++; snapshot.eventSequence++;
    const manifest = toManifest(snapshot);
    const nextRun = { ...target.run, ...manifest }; delete nextRun.contents; delete nextRun.lastSentHistory;
    await this.app.storage.commitConversation({ conversationId: target.conversationId, expectedRevision: target.state.history.revision,
      expectedMetadataToken: target.state.metadataToken,
      metadata: { ...target.state.metadata, custom: { ...target.state.metadata.custom as Record<string, unknown>,
        subAgentRuns: target.runs.map(run => run.runId === runId ? nextRun : run) } },
      records: [
        { namespace: 'subagent-transcript-history', id: randomUUID(), ownerId: target.conversationId, value: { run: target.run, transcript: original, timestamp: Date.now() } },
        { namespace: 'subagent-transcript', id: key, ownerId: target.conversationId, expectedRevision: record.revision,
          value: { contents: snapshot.contents, contextCompactions: snapshot.contextCompactions } },
      ] });
    this.app.productUi.conversations.clearMetadataCache();
    this.app.publish({ type: 'ui.message', message: { type: 'subagentMonitor.event', data: { manifest, activeRunIds: this.app.subagents.activeIds(),
      event: { runId, type: 'content_snapshot', timestamp: Date.now(), contentRevision: snapshot.contentRevision, eventSequence: snapshot.eventSequence } } } });
    return { manifest, window: createRunContentWindow(snapshot), activeRunIds: this.app.subagents.activeIds() };
  }
}
