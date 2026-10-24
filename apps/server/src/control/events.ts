import type { RunEvent, RunRecord } from '@graycode/contracts';

const finishedTypes = new Set<RunEvent['type']>(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

export interface ControlEvent {
  type: string;
  conversationId?: string;
  [key: string]: unknown;
}

/**
 * 外部事件流的稳定形态：只投影契约里的任务事件（RunEvent）与会话变化，补上会话 ID 并展平。
 * 流式增量、界面消息等内部事件只在 raw=1 时原样提供，内部重构不会破坏外部订阅方。
 */
export class ControlEventProjector {
  /** 任务事件本身不带会话 ID；监听前已在运行的任务由启动时登记，之后随 run.created 登记。 */
  private readonly conversations = new Map<string, string>();

  track(runs: Pick<RunRecord, 'id' | 'conversationId'>[]): void {
    for (const run of runs) this.conversations.set(run.id, run.conversationId);
  }

  project(event: Record<string, any>): ControlEvent | undefined {
    if (event.type === 'run.created') {
      const run = event.run as RunRecord;
      this.conversations.set(run.id, run.conversationId);
      return { type: 'run.created', runId: run.id, conversationId: run.conversationId, status: run.status };
    }
    if (event.type === 'event') {
      const runEvent = event.event as RunEvent;
      const conversationId = this.conversations.get(runEvent.runId);
      if (finishedTypes.has(runEvent.type)) this.conversations.delete(runEvent.runId);
      return { type: runEvent.type, runId: runEvent.runId, ...(conversationId ? { conversationId } : {}),
        sequence: runEvent.sequence, timestamp: runEvent.timestamp, ...(event.status ? { status: event.status } : {}), payload: runEvent.payload };
    }
    if (event.type === 'conversation.changed')
      return { type: 'conversation.changed', conversationId: event.conversationId, ...(event.deleted ? { deleted: true } : {}) };
    return undefined;
  }
}
