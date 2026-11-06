import type { PlatformStorage } from '@graycode/core';

const checkpointsNamespace = 'workspace-checkpoints';
const contentsNamespace = 'workspace-checkpoint-content';

export interface CheckpointCompactionReport {
  checkpoints: number;
  /** contentIds 被改写的检查点数。 */
  rewritten: number;
  /** 合并后仍被引用的内容记录数。 */
  retained: number;
  /** 删除（演练时为将要删除）的内容记录数。 */
  removed: number;
}

/**
 * 早期检查点不复用上一份内容，同一对话里同一份文件被每个检查点各登记一条内容记录；正文按内容去重，
 * 多出来的只是记录行和索引。这里在对话内把指向同一正文的记录合并为一条并改写检查点的 contentIds，
 * 再删除不再被任何检查点引用的内容记录。删除检查点时按对话内引用计数回收内容，合并不跨对话，回收语义不变。
 * 只能在应用关闭时运行：运行期间新建的检查点会先写内容再发布清单，未发布的内容会被当作无引用删除。
 */
export async function compactCheckpointContent(storage: PlatformStorage, options: {
  dryRun?: boolean; onProgress?: (done: number, total: number) => void;
} = {}): Promise<CheckpointCompactionReport> {
  const ids = await storage.listRecords(checkpointsNamespace);
  const retained = new Set<string>();
  const canonical = new Map<string, Map<string, string>>();
  let rewritten = 0;
  for (const [index, id] of ids.entries()) {
    const record = await storage.getVersionedRecord(checkpointsNamespace, id);
    const checkpoint = record.value as { conversationId: string; contentIds: Record<string, string> } | null;
    if (checkpoint) {
      const entries = Object.entries(checkpoint.contentIds);
      const hashes = await storage.recordValueHashes(contentsNamespace, entries.map(([, contentId]) => contentId));
      const byHash = canonical.get(checkpoint.conversationId) ?? new Map<string, string>();
      canonical.set(checkpoint.conversationId, byHash);
      let changed = false;
      const contentIds = Object.fromEntries(entries.map(([file, contentId], position) => {
        const hash = hashes[position];
        // 内容记录缺失时保留原引用，恢复时照常报告缺失，不在这里改变结果。
        const target = hash === null ? contentId : byHash.get(hash) ?? (byHash.set(hash, contentId), contentId);
        changed ||= target !== contentId;
        retained.add(target);
        return [file, target];
      }));
      if (changed) {
        rewritten++;
        if (!options.dryRun) await storage.commitRecords([{ namespace: checkpointsNamespace, id, ownerId: checkpoint.conversationId,
          value: { ...checkpoint, contentIds }, expectedRevision: record.revision }]);
      }
    }
    options.onProgress?.(index + 1, ids.length);
  }
  const { removed } = await storage.retainRecords(contentsNamespace, [...retained], { dryRun: options.dryRun });
  return { checkpoints: ids.length, rewritten, retained: retained.size, removed };
}
