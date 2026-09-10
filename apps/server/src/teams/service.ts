import { randomUUID } from 'node:crypto';
import type { RecordMutation, TeamEvent, TeamTask, TeamWaitResult } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { PendingFeedback } from '../subagents/feedback';
import { assertOwner, assertRevision, blockedBy, dependenciesFor, readyTasks, type TeamBoard, type TeamScope } from './board';

interface Waiter {
  scope: TeamScope;
  after: number;
  signal: AbortSignal;
  resolve: (result: TeamWaitResult) => void;
  reject: (error: unknown) => void;
  abort: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const eventKey = (rootId: string, sequence: number) => JSON.stringify([rootId, String(sequence).padStart(16, '0')]);
const taskKey = (rootId: string, id: string) => JSON.stringify([rootId, id]);
const boundedText = (value: unknown, limit: number, name: string, optional = false): string => {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > limit) throw new Error(`${name}必须是${optional ? '' : '非空'}文字，最多 ${limit} 字符。`);
  return value.trim();
};

/** 团队事务只串行读取、校验和提交；模型执行与事件等待都在事务队列之外。 */
export class TeamService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly boards = new Map<string, TeamBoard>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly memberStates = new Map<string, string>();
  private readonly notifications = new Set<Promise<unknown>>();
  private readonly unsubscribe: () => void;
  private closing = false;
  constructor(private readonly app: PlatformApplication) {
    this.unsubscribe = app.subscribe(notification => {
      const event = notification.event as { type?: string; runId?: string } | undefined;
      if (notification.type !== 'event' || !event?.runId || !(event.type?.startsWith('run.') || event.type?.startsWith('approval.'))) return;
      const update = app.storage.getRun(event.runId).then(async run => {
        if (!run) return;
        const child = app.subagents.recordForRun(run);
        if (child && !(event.type?.startsWith('approval.') || event.type === 'run.waiting_input' || event.type === 'run.started')) return;
        await this.memberChanged(run.conversationId, child?.id ?? 'main', `${child?.taskId ?? run.id}:${run.status}`, run.status);
      }).catch(error => this.report(error));
      this.notifications.add(update);
      void update.finally(() => this.notifications.delete(update));
    });
  }
  private report(error: unknown) { this.app.publish({ type: 'notification', severity: 'error', message: `团队事件处理失败：${String(error)}` }); }
  private serial<T>(rootId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(rootId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(rootId, next);
    void next.finally(() => { if (this.queues.get(rootId) === next) this.queues.delete(rootId); }).catch(() => {});
    return next;
  }
  private async board(rootId: string): Promise<TeamBoard> {
    const cached = this.boards.get(rootId); if (cached) return cached;
    const state = await this.app.storage.getVersionedRecord('team-state', rootId);
    const tasks = new Map<string, TeamTask>();
    let afterId: string | undefined;
    for (;;) {
      const records = await this.app.storage.readRecordPage('team-tasks', rootId, { afterId, limit: 200 });
      for (const record of records) { const task = record.value as TeamTask; tasks.set(task.id, task); }
      if (records.length < 200) break;
      afterId = records.at(-1)!.id;
    }
    const board = { sequence: (state.value as { sequence: number } | null)?.sequence ?? 0, revision: state.revision, tasks };
    this.boards.set(rootId, board); return board;
  }
  async scope(context: ToolContext): Promise<TeamScope> {
    context.signal.throwIfAborted();
    if (this.closing) throw new Error('团队服务正在关闭。');
    const run = await this.app.storage.getRun(context.runId);
    if (!run || run.actorId !== context.actorId || run.conversationId !== context.conversationId || !['running', 'queued'].includes(run.status)) throw new Error('团队工具需要当前已授权的执行身份。');
    await this.app.conversation(context.actorId, run.conversationId);
    const child = this.app.subagents.recordForRun(run);
    if (!child && this.app.subagents.isChildConversation(run.conversationId)) throw new Error('当前执行不属于此子代理。');
    const rootId = this.app.subagents.rootConversationId(run.conversationId);
    await this.app.conversation(context.actorId, rootId);
    return { rootId, conversationId: run.conversationId, memberId: child?.id ?? 'main', runId: run.id, actorId: run.actorId };
  }
  private async commit(rootId: string, board: TeamBoard, events: TeamEvent[], records: RecordMutation[], tasks: TeamTask[] = []): Promise<void> {
    const sequence = events.at(-1)!.sequence;
    const result = await this.app.storage.commitRecords([
      { namespace: 'team-state', id: rootId, ownerId: rootId, expectedRevision: board.revision, value: { sequence } },
      ...records,
      ...events.map(event => ({ namespace: 'team-events', id: eventKey(rootId, event.sequence), ownerId: rootId, expectedRevision: null, value: event })),
    ]);
    board.sequence = sequence; board.revision = result[0].revision;
    for (const task of tasks) board.tasks.set(task.id, task);
    await this.wake(rootId, board).catch(error => this.report(error));
  }
  async tasks(scope: TeamScope, args: Record<string, unknown>, signal: AbortSignal) {
    return this.serial(scope.rootId, async () => {
      const board = await this.board(scope.rootId);
      signal.throwIfAborted();
      const ready = () => readyTasks(board).map(task => task.id);
      const snapshot = (task: TeamTask | null) => ({ task: task ? structuredClone(task) : null, sequence: board.sequence, readyTaskIds: ready(), memberId: scope.memberId });
      if (args.action === 'list') {
        const limit = Number(args.limit ?? 50), after = Number(args.afterCreatedSequence ?? 0);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < 0) throw new Error('任务分页参数无效。');
        const tasks = [...board.tasks.values()].filter(task => task.createdSequence > after && (!args.status || task.status === args.status)).sort((a, b) => a.createdSequence - b.createdSequence);
        const selected = tasks.slice(0, limit);
        return { memberId: scope.memberId, sequence: board.sequence, total: tasks.length, hasMore: tasks.length > limit,
          nextAfterCreatedSequence: selected.at(-1)?.createdSequence, readyTaskIds: ready(),
          tasks: selected.map(({ description: _description, result: _result, ...task }) => ({ ...task, dependencies: [...task.dependencies], blockedBy: blockedBy(board, task) })) };
      }
      let task: TeamTask;
      let eventType: TeamEvent['type'];
      let previous: TeamTask | undefined;
      if (args.action === 'create') {
        const id = randomUUID();
        task = { id, title: boundedText(args.title, 240, '任务标题'), description: boundedText(args.description, 16000, '任务说明', true),
          dependencies: dependenciesFor(board, id, args.dependencies ?? []), status: 'pending', creator: scope.memberId,
          revision: 1, createdSequence: board.sequence + 1, updatedSequence: board.sequence + 1 };
        eventType = 'task.created';
      } else {
        previous = args.action === 'claim_ready' ? readyTasks(board)[0] : board.tasks.get(String(args.taskId ?? ''));
        if (!previous) { if (args.action === 'claim_ready') return snapshot(null); throw new Error('当前团队中没有这个任务。'); }
        if (args.action === 'get') return snapshot(previous);
        if (args.action !== 'claim_ready') assertRevision(previous, args.expectedRevision);
        task = structuredClone(previous);
        switch (args.action) {
          case 'claim': case 'claim_ready':
            if (task.status !== 'pending' || task.owner || blockedBy(board, task).length) throw new Error('任务已被领取、已完成或依赖尚未完成。');
            task.status = 'in_progress'; task.owner = scope.memberId; task.ownerRunId = scope.runId; eventType = 'task.claimed'; break;
          case 'complete':
            assertOwner(task, scope);
            if (task.status !== 'in_progress') throw new Error('只有正在执行的任务可以完成。');
            task.result = boundedText(args.result, 16000, '任务结果', true); task.status = 'completed'; eventType = 'task.completed'; break;
          case 'release':
            if (scope.memberId !== 'main') assertOwner(task, scope);
            if (task.status !== 'in_progress') throw new Error('只有已领取的任务可以释放。');
            task.status = 'pending'; delete task.owner; delete task.ownerRunId; delete task.result; eventType = 'task.released'; break;
          case 'set_dependencies':
            if (task.status !== 'pending') throw new Error('开始执行后不能修改依赖，请先明确释放任务。');
            if (scope.memberId !== 'main' && task.creator !== scope.memberId) throw new Error('只有创建者或主代理可以修改任务依赖。');
            task.dependencies = dependenciesFor(board, task.id, args.dependencies); eventType = 'task.dependencies_changed'; break;
          default: throw new Error('未知的团队任务操作。');
        }
        task.revision++; task.updatedSequence = board.sequence + 1;
      }
      signal.throwIfAborted();
      await this.commit(scope.rootId, board, [{ sequence: task.updatedSequence, type: eventType, memberId: scope.memberId, taskId: task.id, taskRevision: task.revision }],
        [{ namespace: 'team-tasks', id: taskKey(scope.rootId, task.id), ownerId: scope.rootId, expectedRevision: previous?.revision ?? null, value: task }], [task]);
      return snapshot(task);
    });
  }
  /** 接收顺序、待投递消息、发送回执和事件一起提交；重启后继续递增。 */
  async enqueueFeedback(pending: PendingFeedback[], records: RecordMutation[]): Promise<void> {
    if (!pending.length) { await this.app.storage.commitRecords(records); return; }
    const rootId = this.app.subagents.rootConversationId(pending[0].conversationId);
    if (pending.some(item => this.app.subagents.rootConversationId(item.conversationId) !== rootId)) throw new Error('不能把不同团队的消息混在同一事务中。');
    await this.serial(rootId, async () => {
      const board = await this.board(rootId); const events: TeamEvent[] = []; const writes: RecordMutation[] = [...records];
      for (const value of pending) {
        // 重复接收保留第一次成功提交的序号，已投递的消息不重新入队。
        if (await this.app.storage.getRecord('subagent-deliveries', value.id)) continue;
        const previous = await this.app.storage.getVersionedRecord('subagent-feedback', value.id);
        if (previous.value) continue;
        const sequence = board.sequence + events.length + 1;
        writes.push({ namespace: 'subagent-feedback', id: value.id, ownerId: value.conversationId, expectedRevision: null,
          value: { ...value, sequence, message: { ...value.message, deliverySequence: sequence } } });
        events.push({ sequence, type: 'message.queued', memberId: String((value.message.agentMessage as { fromRunId?: string } | undefined)?.fromRunId ?? 'main'),
          messageId: value.id, conversationId: value.conversationId });
      }
      if (events.length) await this.commit(rootId, board, events, writes);
      else if (writes.length) await this.app.storage.commitRecords(writes);
    });
  }
  async memberChanged(conversationId: string, memberId: string, identity: string, status: string): Promise<void> {
    if (this.closing) return;
    const rootId = this.app.subagents.rootConversationId(conversationId), key = JSON.stringify([rootId, memberId]);
    await this.serial(rootId, async () => {
      if (this.closing || this.memberStates.get(key) === identity) return;
      const board = await this.board(rootId);
      await this.commit(rootId, board, [{ sequence: board.sequence + 1, type: 'member.changed', memberId, conversationId, status }], []);
      this.memberStates.set(key, identity);
    });
  }
  private async result(board: TeamBoard, scope: TeamScope, after: number, timedOut = false): Promise<TeamWaitResult | null> {
    if (!Number.isSafeInteger(after) || after < 0 || after > board.sequence) throw new Error(`事件游标无效，当前序号为 ${board.sequence}。`);
    const readyTaskIds = readyTasks(board).map(task => task.id);
    const productive = await this.app.subagents.hasTeamProgress(scope.actorId, scope.rootId, scope.runId);
    const noProgress = !readyTaskIds.length && !productive;
    if (after < board.sequence) {
      const records = await this.app.storage.readRecordPage('team-events', scope.rootId, { afterId: eventKey(scope.rootId, after), limit: 50 });
      const events = records.map(record => record.value as TeamEvent), sequence = events.at(-1)?.sequence ?? after;
      return { reason: 'events', sequence, latestSequence: board.sequence, hasMore: sequence < board.sequence, events, readyTaskIds, noProgress };
    }
    const reason = readyTaskIds.length ? 'ready_work' : noProgress ? 'no_progress' : timedOut ? 'timeout' : undefined;
    return reason ? { reason, sequence: board.sequence, latestSequence: board.sequence, hasMore: false, events: [], readyTaskIds, noProgress } : null;
  }
  private finish(waiter: Waiter, result?: TeamWaitResult, error?: unknown) {
    clearTimeout(waiter.timer); waiter.signal.removeEventListener('abort', waiter.abort);
    const waiters = this.waiters.get(waiter.scope.rootId); waiters?.delete(waiter);
    if (!waiters?.size) this.waiters.delete(waiter.scope.rootId);
    if (error !== undefined) waiter.reject(error); else waiter.resolve(result!);
  }
  private async wake(rootId: string, board: TeamBoard): Promise<void> {
    for (const waiter of [...this.waiters.get(rootId) ?? []]) {
      const result = await this.result(board, waiter.scope, waiter.after);
      if (result) this.finish(waiter, result);
    }
  }
  async wait(scope: TeamScope, after: number, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new Error('等待时间必须在 0 至 60000 毫秒之间。');
    return this.app.subagents.withReleasedSlotWhileWaiting(scope.runId, signal, async () => {
      // 返回包裹的 Promise，防止队列等待事件时挡住产生事件的事务。
      const registered = await this.serial(scope.rootId, async () => {
        signal.throwIfAborted();
        if (this.closing) throw new Error('团队服务正在关闭。');
        const board = await this.board(scope.rootId);
        const immediate = await this.result(board, scope, after, timeoutMs === 0);
        if (immediate) return { immediate };
        signal.throwIfAborted();
        let resolve!: Waiter['resolve'], reject!: Waiter['reject'];
        const pending = new Promise<TeamWaitResult>((done, fail) => { resolve = done; reject = fail; });
        void pending.catch(() => {});
        const waiter = { scope, after, signal, resolve, reject } as Waiter;
        waiter.abort = () => this.finish(waiter, undefined, signal.reason ?? new Error('事件等待已取消。'));
        waiter.timer = setTimeout(() => {
          void this.serial(scope.rootId, async () => {
            if (!this.waiters.get(scope.rootId)?.has(waiter)) return;
            this.finish(waiter, (await this.result(await this.board(scope.rootId), scope, after, true))!);
          }).catch(error => this.finish(waiter, undefined, error));
        }, timeoutMs);
        signal.addEventListener('abort', waiter.abort, { once: true });
        const waiters = this.waiters.get(scope.rootId) ?? new Set<Waiter>(); waiters.add(waiter); this.waiters.set(scope.rootId, waiters);
        return { pending };
      });
      return registered.immediate ?? await registered.pending!;
    });
  }
  async close(): Promise<void> {
    this.closing = true; this.unsubscribe();
    for (const waiters of this.waiters.values()) for (const waiter of [...waiters]) this.finish(waiter, undefined, new Error('宿主正在关闭。'));
    await Promise.allSettled([...this.notifications, ...this.queues.values()]);
  }
}
