import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AutomationEventConfiguration, AutomationEventOccurrence, AutomationRecord, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

export const automationEventReceipts = 'automation-event-receipts';
export const automationEventCauses = 'automation-event-causes';
export type EventSourceChange = { trigger: AutomationEventConfiguration['trigger']; previous?: string; next?: string };
/** 来源身份只取契约字段，不受字段顺序及跨线程对象原型影响。 */
export function eventSourceKey(trigger: AutomationEventConfiguration['trigger']): string {
  switch (trigger.type) {
    case 'run_completed': return JSON.stringify([trigger.type, trigger.conversationId]);
    case 'file_changed': return JSON.stringify([trigger.type, trigger.workspaceId, trigger.path, trigger.debounceMs]);
    case 'node_online': return JSON.stringify([trigger.type, trigger.peerId]);
  }
}
interface FileListener { watcher: FSWatcher; signature: string; timer?: ReturnType<typeof setTimeout>; causes: Set<string> }

/** 原生通知只唤醒校验；内容指纹和事务中的来源状态决定是否产生新事件。 */
export class AutomationEventSources {
  private readonly files = new Map<string, FileListener>();
  private readonly lifetime = new AbortController();
  private readonly reads = new Set<Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private reconciling?: Promise<void>;
  private poll?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly app: PlatformApplication, private readonly host: {
    records(): AutomationRecord[];
    receive(id: string, event: AutomationEventOccurrence, change: EventSourceChange): Promise<void>;
    baseline(id: string, change: EventSourceChange & { next: string }): Promise<void>;
    fail(id: string, error: unknown, trigger: AutomationEventConfiguration['trigger']): Promise<void>;
  }) {}
  async validate(actorId: string, value: AutomationEventConfiguration | undefined) {
    if (!value || !['skip', 'latest'].includes(value.busyPolicy) || !['pause', 'resume'].includes(value.restartPolicy))
      throw new Error('请选择事件忙碌处理方式及重启后的监听方式。');
    const trigger = value.trigger;
    if (trigger?.type === 'run_completed') {
      const conversation = await this.app.conversation(actorId, trigger.conversationId);
      if (conversation.actorId !== actorId || this.app.subagents.childConversationIds().has(conversation.id)) throw new Error('请选择自己的主对话作为事件来源。');
      return { trigger: { type: trigger.type, conversationId: conversation.id }, busyPolicy: value.busyPolicy, restartPolicy: value.restartPolicy } as AutomationEventConfiguration;
    }
    if (trigger?.type === 'node_online') {
      const peer = this.app.nodes.peer(actorId, trigger.peerId);
      if (!peer || peer.revokedAt) throw new Error('请选择尚未撤销的已配对设备。');
      return { trigger: { type: trigger.type, peerId: trigger.peerId }, busyPolicy: value.busyPolicy, restartPolicy: value.restartPolicy } as AutomationEventConfiguration;
    }
    if (trigger?.type !== 'file_changed' || typeof trigger.path !== 'string' || !trigger.path.trim()
      || !Number.isInteger(trigger.debounceMs) || trigger.debounceMs < 100 || trigger.debounceMs > 60_000) throw new Error('请填写监控文件，以及 100 至 60000 毫秒的合并等待时间。');
    const result: AutomationEventConfiguration = { trigger: { ...trigger, path: trigger.path.trim() }, busyPolicy: value.busyPolicy, restartPolicy: value.restartPolicy };
    await this.sourceState(actorId, result); return result;
  }
  private async file(actorId: string, event: AutomationEventConfiguration) {
    if (event.trigger.type !== 'file_changed') throw new Error('事件来源不是文件。');
    const workspace = this.app.workspace(actorId, event.trigger.workspaceId, []);
    const file = await this.app.files.resolveGranted(workspace, event.trigger.path);
    if (!(await stat(path.dirname(file))).isDirectory()) throw new Error('监控文件的父目录不存在。');
    return file;
  }
  async sourceState(actorId: string, event: AutomationEventConfiguration): Promise<string> {
    if (event.trigger.type === 'run_completed') return String(Date.now());
    if (event.trigger.type === 'node_online') return this.app.nodes.peer(actorId, event.trigger.peerId)?.state ?? 'missing';
    this.lifetime.signal.throwIfAborted();
    // 配置校验也可能正在读文件；它不在监听队列中，但同样需要在关闭时结束。
    const reading = this.fileState(actorId, event); this.reads.add(reading);
    try { return await reading; } finally { this.reads.delete(reading); }
  }
  private async fileState(actorId: string, event: AutomationEventConfiguration): Promise<string> {
    const file = await this.file(actorId, event);
    try {
      if (!(await stat(file)).isFile()) throw new Error('请选择文件，文件夹不能作为单文件监控来源。');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(file, { signal: this.lifetime.signal })) hash.update(chunk);
      this.lifetime.signal.throwIfAborted();
      return hash.digest('hex');
    } catch (error) { this.lifetime.signal.throwIfAborted(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  }
  private async reportFailure(id: string, error: unknown, trigger: AutomationEventConfiguration['trigger']) {
    // 正常退出中止校验时保持任务状态，下一次启动仍按用户配置恢复监听。
    if (!this.closed) await this.host.fail(id, error, trigger);
  }
  private enqueue(operation: () => Promise<void>) {
    const next = this.queue.then(() => this.closed ? undefined : operation()); this.queue = next.catch(() => {}); return next;
  }
  private records() { return this.host.records().filter(record => record.kind === 'event' && record.event && record.status === 'active'); }
  private causes() {
    // 文件系统通知不提供写入进程；关联当前运行的任务，避免跨工作区写入形成循环。
    return [...new Set(this.host.records().filter(record => record.currentRequestKey || record.awaitingBackground)
      .flatMap(record => [...record.currentEvent?.ancestry ?? [], record.id]))];
  }
  sync() { return this.enqueue(async () => {
    const active = this.records();
    for (const [id, entry] of this.files) {
      const record = active.find(row => row.id === id);
      if (record?.event?.trigger.type === 'file_changed' && entry.signature === eventSourceKey(record.event.trigger)) continue;
      entry.watcher.close(); clearTimeout(entry.timer); this.files.delete(id);
    }
    for (const record of active) {
      if (record.event!.trigger.type !== 'file_changed' || this.files.has(record.id)) continue;
      try {
        const file = await this.file(record.actorId, record.event!);
        if (this.closed) return;
        const trigger = record.event!.trigger;
        const listener: FileListener = { watcher: undefined!, signature: eventSourceKey(trigger), causes: new Set() };
        listener.watcher = watch(path.dirname(file), { persistent: false }, (_kind, name) => {
          if (this.closed) return;
          if (name && path.basename(String(name)).toLocaleLowerCase() !== path.basename(file).toLocaleLowerCase()) return;
          for (const id of this.causes()) listener.causes.add(id);
          clearTimeout(listener.timer);
          listener.timer = setTimeout(() => { listener.timer = undefined; void this.scan(record.id).catch(error => this.reportFailure(record.id, error, trigger)); }, trigger.debounceMs);
          listener.timer.unref();
        });
        listener.watcher.on('error', error => { void this.reportFailure(record.id, error, trigger); });
        this.files.set(record.id, listener);
        await this.scanNow(record.id);
      } catch (error) { await this.reportFailure(record.id, error, record.event!.trigger); }
    }
    if (active.length && !this.poll) { this.poll = setInterval(() => { void this.reconcile().catch(error => this.app.publish({ type: 'notification', severity: 'error', message: `事件恢复失败：${String(error)}` })); }, 30_000); this.poll.unref(); }
    if (!active.length && this.poll) { clearInterval(this.poll); this.poll = undefined; }
  }); }
  private async scanNow(id: string) {
    const record = this.records().find(row => row.id === id), listener = this.files.get(id);
    if (!record?.event || record.event.trigger.type !== 'file_changed' || !listener) return;
    const causes = new Set([...listener.causes, ...this.causes()]); listener.causes.clear();
    const next = await this.sourceState(record.actorId, record.event);
    if (next === record.eventSourceState) return;
    await this.host.receive(id, { key: `file:${randomUUID()}`, type: 'file_changed', observedAt: Date.now(), status: 'pending', ancestry: [...causes],
      summary: `${record.event.trigger.path}：${next === 'missing' ? '文件已删除' : record.eventSourceState === 'missing' ? '文件已创建' : '内容已改变'}` }, { trigger: record.event.trigger, previous: record.eventSourceState, next });
  }
  scan(id: string) { return this.enqueue(() => this.scanNow(id)); }
  reconcile(): Promise<void> {
    // 慢文件校验期间复用正在执行的定期检查，避免每次计时器唤醒再排一整轮读取。
    return this.reconciling ??= (async () => {
      for (const record of this.records()) {
        if (record.event?.trigger.type === 'file_changed') await this.scan(record.id).catch(error => this.reportFailure(record.id, error, record.event!.trigger));
      }
      await this.nodesChanged();
      await this.replayCompleted();
    })().finally(() => { this.reconciling = undefined; });
  }
  nodesChanged() { return this.enqueue(async () => {
    for (const record of this.records()) {
      if (record.event?.trigger.type !== 'node_online') continue;
      const peer = this.app.nodes.peer(record.actorId, record.event.trigger.peerId);
      const next = peer?.state ?? 'missing';
      if (next === record.eventSourceState) continue;
      if (next === 'missing' || next === 'revoked') { await this.reportFailure(record.id, new Error('来源设备已经移除或撤销，请重新选择事件来源。'), record.event.trigger); continue; }
      if (next !== 'online') { await this.host.baseline(record.id, { trigger: record.event.trigger, previous: record.eventSourceState, next }); continue; }
      await this.host.receive(record.id, { key: `node:${randomUUID()}`, type: 'node_online', observedAt: Date.now(), status: 'pending', ancestry: [],
        summary: `${peer?.name ?? '所选设备'}已上线或恢复连接` }, { trigger: record.event.trigger, previous: record.eventSourceState, next });
    }
  }); }
  completed(runId: string) { return this.enqueue(async () => {
    if (!this.records().some(record => record.event?.trigger.type === 'run_completed')) return;
    const run = await this.app.storage.getRun(runId); if (run) await this.deliverCompleted(run);
  }); }
  private async deliverCompleted(run: RunRecord, onlyId?: string) {
    if (run.status !== 'completed') return;
    const recipients = this.records().filter(record => (!onlyId || record.id === onlyId) && record.event?.trigger.type === 'run_completed'
      && record.event.trigger.conversationId === run.conversationId && run.actorId === record.actorId
      && run.updatedAt >= Number(record.eventSourceState ?? record.createdAt));
    if (!recipients.length) return;
    const cause = await this.app.storage.getRecord(automationEventCauses, run.requestKey) as { ancestry: string[] } | null;
    const ancestry = [...new Set([...cause?.ancestry ?? [], ...run.automationId ? [run.automationId] : []])];
    for (const record of recipients) {
      await this.host.receive(record.id, { key: `run:${run.id}`, type: 'run_completed', observedAt: Date.now(), summary: `来源对话的一次任务已完成（${run.id}）`,
        sourceRunId: run.id, ancestry, status: 'pending' }, { trigger: record.event!.trigger, previous: record.eventSourceState });
    }
  }
  replayCompleted() { return this.enqueue(async () => {
    for (const record of this.records()) if (record.event?.trigger.type === 'run_completed') {
      const trigger = record.event.trigger;
      let sourceState = record.eventSourceState;
      let cursor = { timestamp: Number(record.eventSourceState ?? record.createdAt), runId: '' };
      for (;;) {
        const current = this.records().find(row => row.id === record.id);
        if (this.closed || !current?.event || current.eventSourceState !== sourceState || eventSourceKey(current.event.trigger) !== eventSourceKey(trigger)) break;
        const runs = await this.app.storage.listRuns({ actorId: record.actorId, conversationId: trigger.conversationId, completedAfter: cursor, limit: 100 });
        for (const run of runs) await this.deliverCompleted(run, record.id);
        if (runs.length) {
          const next = String(runs.at(-1)!.updatedAt);
          // 同毫秒仍需重读以接收后来完成的任务，收据负责去重；游标不变时无需再写入。
          if (next !== sourceState) await this.host.baseline(record.id, { trigger, previous: sourceState, next });
          sourceState = next;
        }
        if (runs.length < 100) break;
        const last = runs.at(-1)!; cursor = { timestamp: last.updatedAt, runId: last.id };
      }
    }
  }); }
  async settleFiles(run: RunRecord) {
    if (!run.automationId) return;
    for (const record of this.records()) if (record.event?.trigger.type === 'file_changed')
      await this.scan(record.id).catch(error => this.reportFailure(record.id, error, record.event!.trigger));
  }
  async close() {
    this.closed = true; clearInterval(this.poll);
    this.lifetime.abort();
    // 关闭期间已开始的路径解析可能尚未返回，须等待它结束再释放全部监听。
    await this.queue; await Promise.allSettled([...this.reads, ...(this.reconciling ? [this.reconciling] : [])]); clearInterval(this.poll);
    for (const item of this.files.values()) { clearTimeout(item.timer); item.watcher.close(); } this.files.clear();
  }
}
