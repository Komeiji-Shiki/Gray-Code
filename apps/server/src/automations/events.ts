import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AutomationEventConfiguration, AutomationEventOccurrence, AutomationRecord, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

export const automationEventReceipts = 'automation-event-receipts';
export const automationEventCauses = 'automation-event-causes';
export type EventSourceChange = { previous?: string; next: string };
interface FileListener { watcher: FSWatcher; signature: string; timer?: ReturnType<typeof setTimeout>; causes: Set<string> }

/** 原生通知只唤醒校验；内容指纹和事务中的来源状态决定是否产生新事件。 */
export class AutomationEventSources {
  private readonly files = new Map<string, FileListener>();
  private queue: Promise<unknown> = Promise.resolve();
  private poll?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly app: PlatformApplication, private readonly host: {
    records(): AutomationRecord[];
    receive(id: string, event: AutomationEventOccurrence, change?: EventSourceChange): Promise<void>;
    baseline(id: string, next: string): Promise<void>;
    fail(id: string, error: unknown): Promise<void>;
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
      if (!this.app.nodes.status(actorId).peers.some(peer => peer.id === trigger.peerId && !peer.revokedAt)) throw new Error('请选择尚未撤销的已配对设备。');
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
    if (event.trigger.type === 'node_online') return this.app.nodes.status(actorId).peers.find(peer => peer.id === (event.trigger as { peerId: string }).peerId)?.state ?? 'missing';
    const file = await this.file(actorId, event);
    try {
      if (!(await stat(file)).isFile()) throw new Error('请选择文件，文件夹不能作为单文件监控来源。');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
      return hash.digest('hex');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
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
      if (record?.event?.trigger.type === 'file_changed' && entry.signature === JSON.stringify(record.event.trigger)) continue;
      entry.watcher.close(); clearTimeout(entry.timer); this.files.delete(id);
    }
    for (const record of active) {
      if (record.event!.trigger.type !== 'file_changed' || this.files.has(record.id)) continue;
      try {
        const file = await this.file(record.actorId, record.event!);
        if (this.closed) return;
        const trigger = record.event!.trigger;
        const listener: FileListener = { watcher: undefined!, signature: JSON.stringify(trigger), causes: new Set() };
        listener.watcher = watch(path.dirname(file), { persistent: false }, (_kind, name) => {
          if (this.closed) return;
          if (name && path.basename(String(name)).toLocaleLowerCase() !== path.basename(file).toLocaleLowerCase()) return;
          for (const id of this.causes()) listener.causes.add(id);
          clearTimeout(listener.timer);
          listener.timer = setTimeout(() => { listener.timer = undefined; void this.scan(record.id).catch(error => this.host.fail(record.id, error)); }, trigger.debounceMs);
          listener.timer.unref();
        });
        listener.watcher.on('error', error => { if (!this.closed) void this.host.fail(record.id, error); });
        this.files.set(record.id, listener);
        await this.scanNow(record.id);
      } catch (error) { await this.host.fail(record.id, error); }
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
      summary: `${record.event.trigger.path}：${next === 'missing' ? '文件已删除' : record.eventSourceState === 'missing' ? '文件已创建' : '内容已改变'}` }, { previous: record.eventSourceState, next });
  }
  scan(id: string) { return this.enqueue(() => this.scanNow(id)); }
  async reconcile() {
    for (const record of this.records()) {
      if (record.event?.trigger.type === 'file_changed') await this.scan(record.id).catch(error => this.host.fail(record.id, error));
    }
    await this.nodesChanged();
    await this.replayCompleted();
  }
  nodesChanged() { return this.enqueue(async () => {
    for (const record of this.records()) {
      if (record.event?.trigger.type !== 'node_online') continue;
      const next = await this.sourceState(record.actorId, record.event);
      if (next === record.eventSourceState) continue;
      if (next === 'missing' || next === 'revoked') { await this.host.fail(record.id, new Error('来源设备已经移除或撤销，请重新选择事件来源。')); continue; }
      if (next !== 'online') { await this.host.baseline(record.id, next); continue; }
      const peer = this.app.nodes.status(record.actorId).peers.find(row => row.id === (record.event!.trigger as { peerId: string }).peerId);
      await this.host.receive(record.id, { key: `node:${randomUUID()}`, type: 'node_online', observedAt: Date.now(), status: 'pending', ancestry: [],
        summary: `${peer?.name ?? '所选设备'}已上线或恢复连接` }, { previous: record.eventSourceState, next });
    }
  }); }
  completed(runId: string) { return this.enqueue(() => this.completedNow(runId)); }
  private async completedNow(runId: string, onlyId?: string) {
    const run = await this.app.storage.getRun(runId); if (!run || run.status !== 'completed') return;
    const cause = await this.app.storage.getRecord(automationEventCauses, run.requestKey) as { ancestry: string[] } | null;
    const ancestry = [...new Set([...cause?.ancestry ?? [], ...run.automationId ? [run.automationId] : []])];
    for (const record of this.records()) if ((!onlyId || record.id === onlyId) && record.event?.trigger.type === 'run_completed' && record.event.trigger.conversationId === run.conversationId && run.actorId === record.actorId
      && run.updatedAt >= Number(record.eventSourceState ?? record.createdAt)) {
      await this.host.receive(record.id, { key: `run:${run.id}`, type: 'run_completed', observedAt: Date.now(), summary: `来源对话的一次任务已完成（${run.id}）`,
        sourceRunId: run.id, ancestry, status: 'pending' });
    }
  }
  replayCompleted() { return this.enqueue(async () => {
    for (const record of this.records()) if (record.event?.trigger.type === 'run_completed') {
      let cursor = { timestamp: Number(record.eventSourceState ?? record.createdAt), runId: '' };
      for (;;) {
        const runs = await this.app.storage.listRuns({ actorId: record.actorId, conversationId: record.event.trigger.conversationId, completedAfter: cursor, limit: 100 });
        for (const run of runs) await this.completedNow(run.id, record.id);
        if (runs.length) await this.host.baseline(record.id, String(runs.at(-1)!.updatedAt));
        if (runs.length < 100) break;
        const last = runs.at(-1)!; cursor = { timestamp: last.updatedAt, runId: last.id };
      }
    }
  }); }
  async settleFiles(run: RunRecord) {
    if (!run.automationId) return;
    for (const record of this.records()) if (record.event?.trigger.type === 'file_changed')
      await this.scan(record.id).catch(error => this.host.fail(record.id, error));
  }
  async close() {
    this.closed = true; clearInterval(this.poll);
    // 关闭期间已开始的路径解析可能尚未返回，须等待它结束再释放全部监听。
    await this.queue; clearInterval(this.poll);
    for (const item of this.files.values()) { clearTimeout(item.timer); item.watcher.close(); } this.files.clear();
  }
}
