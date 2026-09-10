import { randomUUID } from 'node:crypto';
import type { CheckpointOperationProgress } from '../../../../backend/modules/checkpoint/types';

export interface CheckpointOperationControl {
  signal: AbortSignal;
  update(phase: string, processed?: number, total?: number): void;
  commit(): void;
}
/** 进度属于发起客户端，提交阶段不再接受取消，避免把已生效操作标记为取消。 */
export class CheckpointOperations {
  private readonly entries = new Map<string, { clientId: string; progress: CheckpointOperationProgress; controller: AbortController; cancellable: boolean }>();
  get(clientId: string, id?: string) {
    const values = [...this.entries.values()].filter(value => value.clientId === clientId);
    const value = id ? values.find(value => value.progress.operationId === id) : values.reverse().find(value => !['complete', 'failed', 'cancelled'].includes(value.progress.phase));
    return { progress: value ? { ...value.progress } : null };
  }
  cancel(clientId: string, id: string) {
    const value = this.entries.get(id);
    if (!value || value.clientId !== clientId || !value.cancellable) return { cancelled: false };
    value.controller.abort(new Error('CHECKPOINT_CANCELLED'));
    return { cancelled: true };
  }
  async run<T>(clientId: string, kind: CheckpointOperationProgress['kind'], conversationId: string | undefined,
    checkpointId: string | undefined, action: (control: CheckpointOperationControl) => Promise<T>): Promise<T> {
    for (const [id, value] of this.entries) if (!value.cancellable && ['complete', 'failed', 'cancelled'].includes(value.progress.phase) && Date.now() - value.progress.updatedAt > 600_000) this.entries.delete(id);
    const startedAt = Date.now();
    const entry = { clientId, controller: new AbortController(), cancellable: true,
      progress: { operationId: randomUUID(), kind, conversationId, checkpointId, phase: 'preparing', processed: 0, total: 0,
        cancelled: false, startedAt, updatedAt: startedAt } as CheckpointOperationProgress };
    this.entries.set(entry.progress.operationId, entry);
    const update = (phase: string, processed = entry.progress.processed, total = entry.progress.total) => {
      Object.assign(entry.progress, { phase, processed, total, updatedAt: Date.now() });
    };
    try {
      const result = await action({ signal: entry.controller.signal, update,
        commit: () => { entry.controller.signal.throwIfAborted(); entry.cancellable = false; update('committing'); } });
      update('complete'); return result;
    } catch (error) {
      entry.progress.cancelled = entry.controller.signal.aborted;
      entry.progress.message = error instanceof Error ? error.message : String(error);
      update(entry.progress.cancelled ? 'cancelled' : 'failed'); throw error;
    } finally { entry.cancellable = false; }
  }
}
