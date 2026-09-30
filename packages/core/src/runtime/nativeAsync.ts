import type { ModelToolCall, PlatformMessage, RunRecord, ToolDeclaration, ToolOutcome } from '@graycode/contracts';
import type { PlatformStorage } from '../storage/client';

export const NATIVE_ASYNC_NAMESPACE = 'native-tool-calls';
export const WAIT_FOR_TASKS = 'wait_for_tasks';
export interface NativeToolRecord {
  run: RunRecord;
  call: ModelToolCall;
  handle: string;
  detached: boolean;
  published?: boolean;
  outcome?: ToolOutcome;
}
interface PendingTool {
  record: NativeToolRecord;
  started: Promise<void>;
  done: Promise<void>;
  resolve: () => void;
  published: boolean;
  delivered: boolean;
  delivering?: Promise<void>;
  executing: boolean;
  cancelled?: boolean;
}

export function nativeToolDeclaration(tool: ToolDeclaration, description?: string, parameterDescriptions: Record<string, string> = {}): ToolDeclaration {
  const properties = Object.fromEntries(Object.entries(tool.parameters.properties as Record<string, object> ?? {})
    .map(([name, schema]) => [name, parameterDescriptions[name] ? { ...schema, description: parameterDescriptions[name] } : schema]));
  return { ...tool, async: true,
    // 通用等待规则由 wait_for_tasks 统一说明；工具自身只补宿主特有边界，减少稳定前缀中的重复文本。
    description: `${tool.description}${description ? `\n${description}` : ''}`,
    parameters: { ...tool.parameters, properties: { ...properties,
      task_handle: { type: 'string', minLength: 1, maxLength: 120, description: 'Unique handle for this call, including earlier completed tasks. Use it with wait_for_tasks.' } },
      required: [...new Set([...(tool.parameters.required as string[] ?? []), 'task_handle'])] } };
}
export const waitForTasksDeclaration: ToolDeclaration = {
  name: WAIT_FOR_TASKS, description: 'Wait only for the specified native async task_handles. Their results are delivered on the original calls before this wait returns. Continue independent work instead of waiting for results you do not need.',
  parameters: { type: 'object', additionalProperties: false, required: ['task_handles'], properties: {
    task_handles: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 120 } },
  } },
};

/** 调用身份和结果沿用正式记录与历史；此处只管理执行中的 Promise，不另建任务宿主。 */
export class NativeAsyncTools {
  private readonly calls = new Map<string, PendingTool>();
  private readonly lanes = new Map<string, { promises: Promise<void>[]; next: number }>();
  constructor(private readonly storage: PlatformStorage,
    private readonly deliver: (record: NativeToolRecord, detached: boolean) => Promise<void>,
    private readonly lifecycle: (runId: string) => 'active' | 'settling' | 'finished') {}

  private key(runId: string, callId: string) { return `${runId}:${callId}`; }
  has(runId: string, callId: string) { return this.calls.has(this.key(runId, callId)); }
  pending(conversationId: string): PendingTool[] {
    return [...this.calls.values()].filter(value => value.record.run.conversationId === conversationId && value.published && !value.delivered);
  }
  pendingIds(conversationId: string) { return this.pending(conversationId).map(value => value.record.call.id); }

  launch(run: RunRecord, call: ModelToolCall, history: PlatformMessage[], execute: () => Promise<ToolOutcome>): boolean {
    if (this.has(run.id, call.id)) return false;
    const handle = call.args.task_handle;
    const reused = typeof handle === 'string' && (history.some(message => message.parts.some(part =>
      (part.functionCall as ModelToolCall | undefined)?.args?.task_handle === handle)) || [...this.calls.values()].some(value =>
      value.record.run.conversationId === run.conversationId && value.record.handle === handle));
    let resolve!: () => void;
    const done = new Promise<void>(complete => { resolve = complete; });
    const value: PendingTool = { record: { run: structuredClone(run), call: structuredClone(call), handle: String(handle ?? ''), detached: false },
      started: Promise.resolve(), done, resolve, published: false, delivered: false, executing: false };
    this.calls.set(this.key(run.id, call.id), value);
    let lanes = this.lanes.get(run.id);
    if (!lanes) { lanes = { promises: Array.from({ length: 4 }, () => Promise.resolve()), next: 0 }; this.lanes.set(run.id, lanes); }
    const lane = lanes.next++ % lanes.promises.length;
    value.started = lanes.promises[lane].then(async () => {
      if (value.cancelled) return;
      value.executing = true;
      await this.persist(value);
      if (typeof handle !== 'string' || !handle.trim() || handle.length > 120 || reused) {
        await this.complete(run.id, call.id, { success: false, code: 'INVALID_TASK_HANDLE', error: 'task_handle 必须非空，并且在当前会话中从未使用。' });
        return;
      }
      const outcome = await execute();
      if (outcome.deferred === true) {
        value.record.detached = true;
        // 命令可能在启动回执到达前退出，已经保存的终态不能被启动状态覆盖。
        if (!value.record.outcome) await this.persist(value);
      } else await this.complete(run.id, call.id, outcome);
    }).catch(async error => {
      if (!value.record.outcome) await this.complete(run.id, call.id, { success: false, code: 'TOOL_FAILED', error: String(error) });
      else { value.resolve(); throw error; }
    });
    lanes.promises[lane] = value.started.then(() => value.done).catch(() => {});
    return true;
  }

  async complete(runId: string, callId: string, outcome: ToolOutcome): Promise<boolean> {
    const value = this.calls.get(this.key(runId, callId));
    if (!value || value.record.outcome) return false;
    const { deferred: _deferred, ...result } = outcome;
    value.record.outcome = result;
    if (value.delivered) { value.resolve(); return true; }
    await this.persist(value);
    value.resolve();
    if (value.published && value.record.detached && this.lifecycle(runId) !== 'active') await this.deliverOne(value, true);
    return true;
  }

  async publish(runId: string, calls: ModelToolCall[]): Promise<void> {
    for (const call of calls) {
      const value = this.calls.get(this.key(runId, call.id));
      if (value) { value.published = true; value.record.published = true; await this.persist(value); }
    }
  }
  async flush(conversationId: string): Promise<boolean> {
    let delivered = false;
    for (const value of this.pending(conversationId)) if (value.record.outcome) {
      await this.deliverOne(value, false); delivered = true;
    }
    return delivered;
  }
  private async deliverOne(value: PendingTool, detached: boolean): Promise<void> {
    if (value.delivered) return;
    value.delivering ??= this.deliver(structuredClone(value.record), detached).then(async () => {
      value.delivered = true;
      await this.storage.deleteRecord(NATIVE_ASYNC_NAMESPACE, this.key(value.record.run.id, value.record.call.id));
      // 取消仍在清理时保留交付身份，防止已排队的终态被中断占位结果重复结算。
      if (detached && this.lifecycle(value.record.run.id) === 'finished') this.calls.delete(this.key(value.record.run.id, value.record.call.id));
    });
    await value.delivering;
  }
  private persist(value: PendingTool) {
    return this.storage.putRecord({ namespace: NATIVE_ASYNC_NAMESPACE, id: this.key(value.record.run.id, value.record.call.id),
      ownerId: value.record.run.conversationId, value: structuredClone(value.record) });
  }
  async reconcile(conversationId: string, history: PlatformMessage[]) {
    const calls = new Set(history.flatMap(message => message.parts.flatMap(part => part.functionCall
      ? [(part.functionCall as ModelToolCall).id] : [])));
    const results = new Set(history.flatMap(message => message.parts.flatMap(part => part.functionResponse
      ? [(part.functionResponse as { id: string }).id] : [])));
    for (const value of this.pending(conversationId)) if (!calls.has(value.record.call.id) || results.has(value.record.call.id)) {
      value.delivered = true;
      await this.storage.deleteRecord(NATIVE_ASYNC_NAMESPACE, this.key(value.record.run.id, value.record.call.id));
    }
  }

  async wait(conversationId: string, handles: unknown, signal: AbortSignal): Promise<ToolOutcome> {
    if (!Array.isArray(handles) || !handles.length || handles.some(handle => typeof handle !== 'string') || new Set(handles).size !== handles.length)
      return { success: false, code: 'INVALID_ARGUMENTS', error: '请提供非空且不重复的 task_handles。' };
    const selected = handles.map(handle => [...this.calls.values()].find(value =>
      value.record.run.conversationId === conversationId && value.record.handle === handle));
    if (selected.some(value => !value)) {
      const history = (await this.storage.readFullHistory(conversationId)).messages;
      const responded = new Set(history.flatMap(message => message.parts.flatMap(part => part.functionResponse
        ? [(part.functionResponse as { id?: string }).id] : [])));
      if (handles.some((handle, index) => !selected[index] && !history.some(message => message.parts.some(part => {
        const call = part.functionCall as ModelToolCall | undefined;
        return call?.async === true && call.args.task_handle === handle && responded.has(call.id);
      })))) return { success: false, code: 'UNKNOWN_TASK_HANDLE', error: '指定的异步任务不存在。' };
    }
    await this.abortable(Promise.all(selected.flatMap(value => value ? [value.done] : [])), signal);
    await this.flush(conversationId);
    return { success: true, data: { status: 'completed', completed_task_handles: handles } };
  }
  async waitAny(conversationId: string, signal: AbortSignal) {
    const pending = this.pending(conversationId);
    if (pending.length) await this.abortable(Promise.race(pending.map(value => value.done)), signal);
  }
  private async abortable(work: Promise<unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason ?? new Error('任务已取消。')); });
    signal.addEventListener('abort', abort, { once: true });
    try { await Promise.race([work, cancelled]); signal.throwIfAborted(); }
    finally { signal.removeEventListener('abort', abort); }
  }

  async interrupt(runId: string): Promise<string[]> {
    const values = [...this.calls.values()].filter(value => value.record.run.id === runId);
    for (const value of values) if (!value.executing) { value.cancelled = true; value.resolve(); }
    await Promise.allSettled(values.filter(value => value.executing).map(value => value.started));
    for (const value of values) if (!value.record.detached) {
      this.calls.delete(this.key(runId, value.record.call.id)); value.resolve();
      await this.storage.deleteRecord(NATIVE_ASYNC_NAMESPACE, this.key(runId, value.record.call.id));
    }
    return values.filter(value => value.record.detached).map(value => value.record.call.id);
  }
  async release(runId: string) {
    this.lanes.delete(runId);
    for (const value of [...this.calls.values()].filter(value => value.record.run.id === runId)) {
      if (value.record.outcome && !value.delivered && value.published) await this.deliverOne(value, true);
      if (value.delivered) this.calls.delete(this.key(runId, value.record.call.id));
    }
  }
}
