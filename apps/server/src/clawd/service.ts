import { createHash, randomUUID } from 'node:crypto';
import type { ClawdSettings, ClawdStatus, RunEvent, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { ClawdTransport, type ClawdEvent } from './transport';

interface TrackedRun { run: RunRecord; event: ClawdEvent }
interface SessionState { event: ClawdEvent; active: boolean; dirty: boolean; lastSentAt: number }
const priority: Record<ClawdEvent['state'], number> = { idle: 0, attention: 1, thinking: 2, working: 3, error: 4, notification: 5 };
const observedEvents = new Set<RunEvent['type']>(['run.created', 'run.started', 'model.preparing', 'model.started',
  'tool.started', 'tool.completed', 'approval.requested', 'approval.resolved', 'question.asked', 'question.answered',
  'question.expired', 'run.waiting_input', 'run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

/** 联动只订阅运行状态，网络发送与模型、工具和审批流程分别推进。 */
export class ClawdService {
  private readonly runs = new Map<string, TrackedRun>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly prefix: string;
  private readonly unsubscribe: () => void;
  private configuration?: ClawdSettings;
  private current: ClawdStatus = { state: 'disabled' };
  private processing: Promise<void> = Promise.resolve();
  private sending?: Promise<void>;
  private controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private retryAt = 0;
  private ready = false;
  private closed = false;

  constructor(private readonly app: PlatformApplication, private readonly transport = new ClawdTransport()) {
    this.prefix = `graycode-${createHash('sha256').update(app.storage.directory).digest('hex').slice(0, 12)}-`;
    this.unsubscribe = app.subscribe(notification => {
      if (!this.ready || this.closed) return;
      if (notification.type === 'settings.changed') this.enqueue(() => this.configure());
      if (this.configuration?.enabled && notification.type === 'event' && observedEvents.has((notification.event as RunEvent).type)) {
        const event = notification.event as RunEvent;
        this.enqueue(() => this.receive(event));
      }
    });
  }

  status(): ClawdStatus { return { ...this.current }; }

  async initialize(): Promise<void> { this.ready = true; await this.configure(); }

  private enqueue(operation: () => Promise<void>) {
    this.processing = this.processing.then(async () => { if (!this.closed) await operation(); })
      .catch(() => { if (!this.closed) this.current = { state: 'error' }; });
  }

  private async configure() {
    const next = this.app.settings.read('clawd').clawd;
    if (this.configuration?.enabled === next?.enabled && this.configuration?.agentId === next?.agentId) return;
    const previous = this.configuration;
    this.controller.abort(); await this.sending;
    this.controller = new AbortController();
    if (previous?.enabled) await this.endSessions(previous.agentId);
    this.configuration = next; this.runs.clear(); this.sessions.clear(); this.retryAt = 0;
    clearInterval(this.timer); this.timer = undefined;
    this.current = { state: next?.enabled ? 'waiting' : 'disabled' };
    if (!next?.enabled || this.closed) return;
    const activeRuns = await this.app.storage.listRuns({ activeOnly: true, limit: 1000 });
    if (this.closed) return;
    for (const run of activeRuns) {
      const event = this.base(run, run.status === 'awaiting_approval' || run.status === 'awaiting_input' ? 'notification' : 'thinking', 'SessionStart');
      this.runs.set(run.id, { run, event }); this.updateSession(run.conversationId, event);
    }
    this.timer = setInterval(() => {
      // 重启后即使端口未变化，也重新报告仍在运行的会话；不重放旧的完成通知。
      for (const session of this.sessions.values()) if (session.active && !session.dirty && Date.now() - session.lastSentAt >= 15_000) {
        session.event = { ...session.event, event: 'Heartbeat' }; session.dirty = true;
      }
      this.flush();
    }, 5000); this.timer.unref(); this.flush();
  }

  private base(run: RunRecord, state: ClawdEvent['state'], event: string): ClawdEvent {
    const workspace = this.app.settings.find('workspaces', run.workspaceId);
    return { session_id: this.prefix + run.conversationId, state, event,
      ...(workspace ? { cwd: workspace.directory.slice(0, 2048) } : {}) };
  }

  private async receive(event: RunEvent) {
    if (!this.configuration?.enabled) return;
    let tracked = this.runs.get(event.runId);
    if (!tracked) {
      const run = await this.app.storage.getRun(event.runId); if (!run) return;
      tracked = { run, event: this.base(run, 'idle', 'SessionStart') };
      this.runs.set(event.runId, tracked);
    }
    let state: ClawdEvent['state'] = 'thinking', name = 'ModelStart';
    switch (event.type) {
      case 'run.created': state = 'idle'; name = 'SessionStart'; break;
      case 'run.started': name = 'UserPromptSubmit'; break;
      case 'tool.started': state = 'working'; name = 'PreToolUse'; break;
      case 'tool.completed': state = event.payload.success === false ? 'error' : 'working'; name = event.payload.success === false ? 'PostToolUseFailure' : 'PostToolUse'; break;
      case 'approval.requested': case 'question.asked': case 'run.waiting_input': state = 'notification'; name = 'Notification'; break;
      case 'run.completed': state = 'attention'; name = 'Stop'; this.runs.delete(event.runId); break;
      case 'run.failed': state = 'error'; name = 'PostToolUseFailure'; this.runs.delete(event.runId); break;
      case 'run.cancelled': case 'run.interrupted': state = 'idle'; name = 'SessionEnd'; this.runs.delete(event.runId); break;
    }
    if (this.runs.has(event.runId) && (this.app.runtime.pendingApprovals().some(item => item.runId === event.runId)
      || this.app.runtime.pendingQuestions().some(item => item.runId === event.runId))) { state = 'notification'; name = 'Notification'; }
    tracked.event = { ...this.base(tracked.run, state, name),
      ...(typeof event.payload.toolName === 'string' ? { tool_name: event.payload.toolName.slice(0, 256) } : {}),
      ...(typeof event.payload.toolCallId === 'string' ? { tool_use_id: event.payload.toolCallId.slice(0, 256) } : {}) };
    this.updateSession(tracked.run.conversationId, tracked.event);
  }

  private updateSession(conversationId: string, fallback: ClawdEvent) {
    const active = [...this.runs.values()].filter(item => item.run.conversationId === conversationId);
    // 同一对话中的并行工作尚未结束时，单个运行结束不能使桌宠提前显示完成。
    const selected = active.reduce<ClawdEvent | undefined>((best, item) => !best || priority[item.event.state] >= priority[best.state] ? item.event : best, undefined) ?? fallback;
    const previous = this.sessions.get(selected.session_id);
    if (previous && previous.active === !!active.length && JSON.stringify(previous.event) === JSON.stringify(selected)) return;
    this.sessions.set(selected.session_id, { event: selected, active: !!active.length, dirty: true, lastSentAt: previous?.lastSentAt ?? 0 });
    this.flush();
  }

  private flush() {
    if (this.sending || this.closed || !this.configuration?.enabled || Date.now() < this.retryAt) return;
    const agentId = this.configuration.agentId, signal = this.controller.signal;
    this.sending = (async () => {
      while (!signal.aborted) {
        const session = [...this.sessions.values()].find(item => item.dirty); if (!session) return;
        session.dirty = false;
        const result = await this.transport.send(agentId, session.event, signal);
        if (signal.aborted) return;
        this.current = result;
        if (result.state !== 'connected') { session.dirty = true; this.retryAt = Date.now() + 5000; return; }
        session.lastSentAt = result.lastSentAt!;
        if (session.event.event === 'SessionEnd' && this.sessions.get(session.event.session_id) === session) this.sessions.delete(session.event.session_id);
      }
    })().finally(() => {
      this.sending = undefined;
      if (!signal.aborted && [...this.sessions.values()].some(item => item.dirty)) this.flush();
    });
  }

  async check(): Promise<ClawdStatus> {
    await this.processing;
    if (this.closed || !this.configuration?.enabled) return this.status();
    const agentId = this.configuration.agentId, signal = this.controller.signal;
    const probe: ClawdEvent = { session_id: this.prefix + 'check-' + randomUUID(), state: 'idle', event: 'SessionStart' };
    const result = await this.transport.send(agentId, probe, signal);
    if (result.state === 'connected') await this.transport.send(agentId, { ...probe, event: 'SessionEnd' }, signal);
    if (!signal.aborted) this.current = result;
    return this.status();
  }

  private async endSessions(agentId: string) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(1500)]);
    for (const session of this.sessions.values()) {
      if (signal.aborted) break;
      const result = await this.transport.send(agentId, { session_id: session.event.session_id, state: 'idle', event: 'SessionEnd' }, signal);
      if (result.state !== 'connected') break;
    }
  }

  async close(): Promise<void> {
    this.closed = true; this.unsubscribe(); clearInterval(this.timer); this.controller.abort();
    await this.processing; await this.sending;
    this.controller = new AbortController();
    if (this.configuration?.enabled) await this.endSessions(this.configuration.agentId);
    this.controller.abort(); this.runs.clear(); this.sessions.clear();
  }
}
