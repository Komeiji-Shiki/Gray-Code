import type { PlatformApplication } from '../application';
import { activePath, collectDeletedNodes, pruneDeletedNodes, validate } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { DEFAULT_BRANCH_RETENTION_DAYS } from '../../../../backend/modules/conversation/branch/types';
import { branchMutation, branchNamespace, readBranches, type BranchState } from './branches';

export function branchRetentionDays(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('分支保留天数必须为非负整数，0 表示不自动清理。');
  return value as number;
}
export { DEFAULT_BRANCH_RETENTION_DAYS };

/** 复用原图清理算法；独立存储使用会话事务保护正文、图和当前任务。 */
export class BranchRetention {
  constructor(private readonly app: PlatformApplication) {}
  private async ids(actorId: string, conversationId?: string) {
    this.app.requireOwner(actorId);
    if (conversationId) { await this.app.conversation(actorId, conversationId); return [conversationId]; }
    return this.app.storage.listRecords(branchNamespace);
  }
  async count(actorId: string, conversationId?: string) {
    let conversationCount = 0; let deletedNodeCount = 0;
    for (const id of await this.ids(actorId, conversationId)) {
      if (!await this.app.storage.getConversation(id)) continue;
      conversationCount++;
      const stored = await this.app.storage.getVersionedRecord(branchNamespace, id, { fields: ['graph'], omitBinary: true });
      const branch = stored?.value as Pick<BranchState, 'graph'> | undefined;
      if (branch?.graph && validate(branch.graph).valid) deletedNodeCount += collectDeletedNodes(branch.graph).length;
    }
    return { conversationCount, deletedNodeCount };
  }
  async prune(actorId: string, conversationId?: string) {
    const ids = await this.ids(actorId, conversationId);
    const retentionDays = this.app.product.branchRetentionDays;
    const result = { conversationsScanned: ids.length, conversationsChanged: 0, prunedNodeCount: 0,
      corruptConversations: [] as string[], skippedConversations: [] as string[] };
    for (const id of ids) {
      if (!await this.app.storage.getConversation(id) || (await this.app.storage.listRuns({ conversationId: id, activeOnly: true })).length) {
        result.skippedConversations.push(id); continue;
      }
      let state; let branch;
      try {
        state = await this.app.conversations.read(actorId, id);
        branch = readBranches(state); activePath(branch.graph);
      } catch { result.corruptConversations.push(id); continue; }
      const pruned = pruneDeletedNodes(branch.graph, { retentionDays });
      if (!pruned.prunedNodeIds.length) continue;
      branch.graph = pruned.graph;
      if (!validate(branch.graph).valid) { result.corruptConversations.push(id); continue; }
      try {
        await this.app.storage.commitConversation({ conversationId: id, expectedRevision: state.history.revision,
          expectedMetadataToken: state.metadataToken, records: [branchMutation(state, branch)] });
      } catch { result.skippedConversations.push(id); continue; }
      result.conversationsChanged++; result.prunedNodeCount += pruned.prunedNodeIds.length;
      this.app.publish({ type: 'conversation.changed', conversationId: id });
      // 只清理本次移除节点的存档；仍被其他候选引用的存档由检查点服务拒绝删除。
      for (const checkpoint of await this.app.checkpoints.list(actorId, id)) {
        if (checkpoint.messageNodeId && pruned.prunedNodeIds.includes(checkpoint.messageNodeId)) {
          try { await this.app.checkpoints.delete(actorId, id, checkpoint.id); }
          catch (error) { console.warn('[分支清理] 检查点保留：', checkpoint.id, String(error)); }
        }
      }
    }
    return result;
  }
}
