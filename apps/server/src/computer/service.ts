import { createHash } from 'node:crypto';
import { authorizeEffects, type ToolContext } from '@graycode/core';
import type { ComputerAction, ComputerCapture, ComputerDisplayCapture, ComputerObservation, ComputerOperation, ComputerStatus, ComputerController, ComputerWindows, ToolOutcome } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { WindowsComputerNative } from './native';
import { ComputerError, type ComputerNativePort, type ComputerScreenPort, type NativeComputerStatus } from './port';

type Identity = { actorId: string; runId?: string; clientId?: string; signal?: AbortSignal };
type SavedOperation = ComputerOperation & { fingerprint: string };
const namespace = 'computer-actions';
const keyOf = (identity: Identity) => JSON.stringify([identity.actorId, identity.runId ? 'run' : 'client', identity.runId ?? identity.clientId]);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export class ComputerService {
  private readonly native: ComputerNativePort;
  private state: NativeComputerStatus = { active: false, reason: 'idle', generation: 0 };
  private controller?: ComputerController;
  private controllerKey?: string;
  private pausedRunId?: string;
  private readonly paused = new Set<string>();
  private readonly observations = new Map<string, { key: string; value: ComputerObservation }>();
  private readonly recent: ComputerOperation[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private stopEpoch = 0;
  private abortCleanup?: () => void;
  private readonly unsubscribe: () => void;
  constructor(private readonly app: PlatformApplication, private readonly screen?: ComputerScreenPort, native?: ComputerNativePort) {
    this.native = native ?? new WindowsComputerNative();
    this.unsubscribe = this.native.subscribe(status => {
      this.state = status;
      if (!status.active) {
        if (this.controller?.runId && !['released', 'run_finished', 'host_closed'].includes(status.reason)) {
          this.paused.add(this.controllerKey!); this.pausedRunId = this.controller.runId;
        }
        this.clearControl();
      }
      this.changed();
    });
  }
  private changed() { this.app.publish({ type: 'computer.changed' }); }
  private clearControl() {
    this.controller = undefined; this.controllerKey = undefined; this.abortCleanup?.(); this.abortCleanup = undefined;
    this.observations.clear(); this.stopEpoch++;
  }
  private authorize(actorId: string) {
    const actor = this.app.actor(actorId); const error = actor ? authorizeEffects(actor, ['desktop_control']) : '账号不可用。';
    if (error) throw new ComputerError('COMPUTER_FORBIDDEN', error);
  }
  status(actorId: string): ComputerStatus {
    this.authorize(actorId);
    return { available: this.native.available, screenshotAvailable: !!this.screen || this.native.available, platform: process.platform,
      active: this.state.active && !!this.controller, reason: this.state.reason, stopShortcut: 'Ctrl+Alt+Esc', stopShortcutRegistered: this.state.stopShortcutRegistered,
      controller: this.controller && structuredClone(this.controller), pausedRunId: this.pausedRunId, host: this.native.identity,
      ...(!this.native.available ? { error: '当前设备未安装 Windows 电脑操作宿主。' } : {}) };
  }
  private serialized<T>(identity: Identity, action: () => Promise<T>): Promise<T> {
    const epoch = this.stopEpoch;
    const next = this.queue.then(async () => {
      this.authorize(identity.actorId); identity.signal?.throwIfAborted();
      if (identity.runId && this.paused.has(keyOf(identity))) throw new ComputerError('USER_TAKEOVER', '用户已经接管电脑操作。只有主人在控制面板允许继续后，本任务才能重新取得控制权。');
      if (epoch !== this.stopEpoch) throw new ComputerError('CONTROL_CHANGED', '控制状态已经变化，请重新发起操作。');
      return action();
    });
    this.queue = next.catch(() => {}); return next;
  }
  async windows(identity: Identity) { return this.serialized(identity, () => this.native.request<ComputerWindows>('windows', {}, identity.signal)); }
  private remembered(identity: Identity, id: string) {
    const saved = this.observations.get(id);
    if (!saved || saved.key !== keyOf(identity) || Date.now() - saved.value.capturedAt > 120_000)
      throw new ComputerError('OBSERVATION_STALE', '观察记录不属于当前任务或已过期，请重新观察。');
    return saved.value;
  }
  async observe(identity: Identity, params: { windowId: string; screenshot?: boolean; maxElements?: number; maxDepth?: number; width?: number; height?: number; frameOnly?: boolean; windowOnly?: boolean; expectedProcess?: { processId: number; processStartedAt?: string | null; className: string }; format?: 'png' | 'jpeg'; quality?: number }) {
    return this.serialized(identity, async () => {
      const epoch = this.stopEpoch;
      const value = await this.native.request<ComputerObservation>('observe', { windowId: params.windowId, maxElements: params.frameOnly ? 1 : params.maxElements ?? 250,
        maxDepth: params.frameOnly ? 1 : params.maxDepth ?? 14, includeCommandLine: !params.frameOnly }, identity.signal);
      if (params.expectedProcess && (value.window.processId !== params.expectedProcess.processId || value.window.processStartedAt !== params.expectedProcess.processStartedAt || value.window.className !== params.expectedProcess.className)) throw new ComputerError('WINDOW_CHANGED', '所选窗口已不属于原进程，请重新选择。');
      if (params.screenshot) {
        const size = { width: Math.max(320, Math.min(2560, params.width ?? 1600)), height: Math.max(240, Math.min(2160, params.height ?? 1200)), format: params.format, quality: params.quality };
        try {
          // 前台区域可直接采集，文件对话框也可用；后台窗口才需要系统窗口共享目录。
          if (!this.screen || !params.windowOnly && value.window.foreground) throw new ComputerError('CAPTURE_UNAVAILABLE', '使用本机可见窗口采集。');
          value.screenshot = await this.screen.capture(value, size);
        } catch (error) {
          if (params.windowOnly || (error as ComputerError).code !== 'CAPTURE_UNAVAILABLE') throw error;
          value.screenshot = await this.native.request<ComputerCapture>('capture', { observationId: value.id, ...size }, identity.signal);
        }
        await this.native.request('validate', { observationId: value.id }, identity.signal);
      }
      identity.signal?.throwIfAborted();
      if (epoch !== this.stopEpoch) throw new ComputerError('CONTROL_CHANGED', '观察期间控制状态已变化，请重新读取。');
      this.observations.set(value.id, { key: keyOf(identity), value });
      while (this.observations.size > 32) this.observations.delete(this.observations.keys().next().value!);
      return value;
    });
  }
  async acquire(identity: Identity, windowIds: string[]) {
    return this.serialized(identity, async () => {
      const key = keyOf(identity), epoch = this.stopEpoch;
      if (!windowIds.length || windowIds.length > 16 || windowIds.some(id => !/^\d+$/.test(id))) throw new ComputerError('TARGET_REQUIRED', '请选择 1 至 16 个实际窗口。');
      if (this.controllerKey && this.controllerKey !== key) throw new ComputerError('CONTROL_BUSY', '另一任务正在控制电脑，请先停止或接管。');
      if (this.controller) {
        if (JSON.stringify([...windowIds].sort()) !== JSON.stringify([...this.controller.windowIds].sort())) throw new ComputerError('TARGET_CHANGED', '修改控制窗口范围前，请先释放当前控制权。');
        return this.status(identity.actorId);
      }
      this.controller = { actorId: identity.actorId, runId: identity.runId, clientId: identity.clientId, windowIds: [...windowIds], acquiredAt: Date.now() };
      this.controllerKey = key;
      try {
        const result = await this.native.request<NativeComputerStatus>('acquire', { owner: key, windowIds }, identity.signal);
        if (!result.active || epoch !== this.stopEpoch || identity.signal?.aborted) {
          await this.native.stop('control_changed'); throw new ComputerError('CONTROL_CHANGED', '取得控制权期间已经停止，请重新确认当前状态。');
        }
        this.state = result;
        const abort = () => {
          // 已取得控制权的归属由本服务核实；账号撤销后仍必须能释放输入。
          if (this.controllerKey === key) void this.stopOwned('run_cancelled').catch(error => this.app.publish({ type: 'notification', message: String(error) }));
        };
        identity.signal?.addEventListener('abort', abort, { once: true }); this.abortCleanup = () => identity.signal?.removeEventListener('abort', abort);
        this.changed(); return this.status(identity.actorId);
      } catch (error) { if (this.controllerKey === key) this.clearControl(); throw error; }
    });
  }
  async display(identity: Identity, params: { monitorId: string; width?: number; height?: number; format?: 'png' | 'jpeg'; quality?: number }) {
    return this.serialized(identity, () => this.native.request<ComputerDisplayCapture>('displayCapture', params, identity.signal));
  }
  async stop(actorId: string, reason = 'requested', expected?: Identity) {
    this.authorize(actorId);
    if (expected && this.controllerKey !== keyOf(expected)) return this.status(actorId);
    if (this.controller && this.controller.actorId !== actorId) this.app.requireOwner(actorId);
    await this.stopOwned(reason); return this.status(actorId);
  }
  private async stopOwned(reason: string) {
    if (this.controller?.runId && !['released', 'run_finished', 'host_closed'].includes(reason)) { this.paused.add(this.controllerKey!); this.pausedRunId = this.controller.runId; }
    this.state = { ...this.state, active: false, reason };
    this.clearControl(); this.changed(); await this.native.stop(reason);
  }
  async permissionsChanged() {
    if (!this.controller) return;
    try { this.authorize(this.controller.actorId); } catch { await this.stopOwned('permission_revoked'); }
  }
  async finishRun(runId: string) {
    if (this.controller?.runId === runId) await this.stopOwned('run_finished');
    for (const key of this.paused) if ((JSON.parse(key) as string[])[2] === runId) this.paused.delete(key);
    if (this.pausedRunId === runId) { this.pausedRunId = undefined; this.changed(); }
  }
  async clientClosed(clientId: string) {
    if (this.controller?.clientId === clientId) await this.stopOwned('client_disconnected');
  }
  /** 执行节点断线只中止其电脑控制，普通任务仍由运行器持有。 */
  async nodeDisconnected(peerId: string, runIds: string[], reason = 'node_disconnected') {
    const affected = (key: string) => { const parts = JSON.parse(key) as string[]; return parts[1] === 'run' ? runIds.includes(parts[2]) : parts[2]?.startsWith(`node:${peerId}:`); };
    for (const [id, value] of this.observations) if (affected(value.key)) this.observations.delete(id);
    if (this.controllerKey && affected(this.controllerKey)) await this.stopOwned(reason);
  }
  private mapped(args: ComputerAction, observation: ComputerObservation): Record<string, unknown> {
    const mapped: Record<string, unknown> = { ...args };
    if (['click', 'scroll', 'drag'].includes(args.action) && (!args.elementId || args.action === 'drag') && !args.coordinateSpace)
      throw new ComputerError('COORDINATES_REQUIRED', '请明确坐标来自图像像素还是屏幕物理像素。');
    if (args.coordinateSpace === 'image' && ['click', 'scroll', 'drag'].includes(args.action)) {
      const image = observation.screenshot; if (!image) throw new ComputerError('CAPTURE_REQUIRED', '此观察没有截图，不能使用图像坐标。');
      const point = (x: number | undefined, y: number | undefined) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || x! < 0 || y! < 0 || x! >= image.width || y! >= image.height) throw new ComputerError('POINT_OUTSIDE_IMAGE', '坐标超出了当前截图。');
        return { x: image.bounds.x + Math.floor(x! * image.bounds.width / image.width), y: image.bounds.y + Math.floor(y! * image.bounds.height / image.height) };
      };
      if (!args.elementId) Object.assign(mapped, point(args.x, args.y));
      if (args.action === 'drag') { const end = point(args.toX, args.toY); mapped.toX = end.x; mapped.toY = end.y; }
    }
    return mapped;
  }
  private async prepareManual(identity: Identity, observation: ComputerObservation, args: ComputerAction, mapped: Record<string, unknown>, leaseId: string) {
    if (args.action === 'focusWindow') return mapped;
    const originalElement = args.elementId ? observation.elements.find(value => value.id === args.elementId) : undefined;
    if (args.elementId && !originalElement) throw new ComputerError('ELEMENT_NOT_FOUND', '控件不属于当前观察。');
    await this.native.request('action', { observationId: observation.id, action: 'focusWindow', leaseId }, identity.signal);
    let current = await this.native.request<ComputerObservation>('observe', { windowId: observation.window.id, maxElements: 1000 }, identity.signal);
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    if (!same(current.window.bounds, observation.window.bounds) || current.window.dpi !== observation.window.dpi || current.window.processStartedAt !== observation.window.processStartedAt)
      throw new ComputerError('OBSERVATION_STALE', '切换后窗口位置或进程已经变化，请重新观察。');
    const resolveElement = () => {
      const result = originalElement && current.elements.find(value => value.runtimeId === originalElement.runtimeId);
      if (originalElement && (!result || result.name !== originalElement.name || !same(result.bounds, originalElement.bounds)))
        throw new ComputerError('OBSERVATION_STALE', '切换后控件已经变化，请重新观察。');
      return result;
    };
    let selected = resolveElement();
    if (selected && ['type', 'key'].includes(args.action) && !selected.focused) {
      await this.native.request('action', { observationId: current.id, action: 'focusElement', elementId: selected.id, leaseId }, identity.signal);
      current = await this.native.request<ComputerObservation>('observe', { windowId: current.window.id, maxElements: 1000 }, identity.signal); selected = resolveElement();
    }
    return { ...mapped, observationId: current.id, ...(selected ? { elementId: selected.id } : {}) };
  }
  async action(identity: Identity, args: ComputerAction, operationId: string, manual = false, maximumFrameAge = 120_000) {
    return this.serialized(identity, async () => {
      if (!operationId || operationId.length > 240) throw new ComputerError('OPERATION_ID_REQUIRED', '操作需要唯一的请求标识。');
      const id = hash(keyOf(identity) + '\n' + operationId), fingerprint = hash(JSON.stringify(args));
      const previous = await this.app.storage.getRecord(namespace, id) as SavedOperation | null;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ComputerError('OPERATION_CONFLICT', '同一个请求标识不能用于不同的操作。');
        if (previous.status === 'completed') return { ...previous.result, repeated: true };
        throw new ComputerError(previous.code ?? 'OPERATION_UNKNOWN', previous.error ?? '这次操作已派发但没有确定结果，请重新观察，不能重复执行。');
      }
      const observation = this.remembered(identity, args.observationId);
      if (Date.now() - (observation.screenshot?.capturedAt ?? observation.capturedAt) > maximumFrameAge)
        throw new ComputerError('OBSERVATION_STALE', '画面已过期，请重新采集后操作。');
      if (!this.state.active || !this.state.leaseId || this.controllerKey !== keyOf(identity)) throw new ComputerError('CONTROL_REQUIRED', '请先为当前任务取得所选窗口的控制权。');
      const mapped = this.mapped(args, observation), leaseId = this.state.leaseId, epoch = this.stopEpoch;
      const operation: SavedOperation = { id, fingerprint, actorId: identity.actorId, runId: identity.runId, clientId: identity.clientId,
        requestedAt: Date.now(), action: args.action, window: observation.window, observationId: observation.id, status: 'dispatching',
        input: { textLength: args.text?.length, elementId: args.elementId, key: args.key, x: mapped.x as number, y: mapped.y as number, toX: mapped.toX as number, toY: mapped.toY as number } };
      // 先记录派发状态；断线或重启后同一标识只报告未知结果，不自动重复输入。
      await this.app.storage.commitRecords([{ namespace, id, ownerId: identity.actorId, value: operation, expectedRevision: null }]);
      this.observations.delete(observation.id);
      try {
        identity.signal?.throwIfAborted();
        if (epoch !== this.stopEpoch) throw new ComputerError('CONTROL_CHANGED', '派发前已停止电脑操作。');
        const prepared = manual ? await this.prepareManual(identity, observation, args, mapped, leaseId) : mapped;
        operation.result = await this.native.request('action', { ...prepared, leaseId }, identity.signal);
        operation.status = 'completed'; return operation.result;
      } catch (error) {
        operation.code = (error as ComputerError).code ?? 'OPERATION_FAILED'; operation.error = (error as Error).message;
        operation.status = ['OPERATION_UNKNOWN', 'HOST_DISCONNECTED'].includes(operation.code) ? 'unknown' : 'failed'; throw error;
      } finally {
        operation.finishedAt = Date.now(); await this.app.storage.putRecord({ namespace, id, ownerId: identity.actorId, value: operation });
        const { fingerprint: _, ...display } = operation; this.recent.unshift(display); this.recent.length = Math.min(50, this.recent.length); this.changed();
      }
    });
  }
  async tool(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolOutcome> {
    const identity = { actorId: context.actorId, runId: context.runId, signal: context.signal };
    try {
      if (name === 'computer_windows') return { success: true, data: await this.windows(identity) };
      if (name === 'computer_observe') {
        const value = await this.observe(identity, args as any); const { screenshot, ...observation } = value;
        return { success: true, data: { ...observation, ...(screenshot ? { screenshot: { ...screenshot, data: undefined } } : {}) },
          ...(screenshot ? { attachments: [{ mimeType: screenshot.mimeType, data: screenshot.data, name: '窗口截图.png' }] } : {}) };
      }
      if (name === 'computer_control') return { success: true, data: args.action === 'acquire' ? await this.acquire(identity, args.windowIds ?? [])
        : args.action === 'status' ? this.status(identity.actorId) : await this.stop(identity.actorId, 'released', identity) };
      return { success: true, data: await this.action(identity, args as ComputerAction, `${context.iteration}:${context.toolCallId}`) };
    } catch (error) { return { success: false, code: (error as ComputerError).code ?? 'COMPUTER_FAILED', error: (error as Error).message }; }
  }
  async call(client: ClientSession, method: string, params: Record<string, any>) {
    this.authorize(client.actorId);
    switch (method) {
      case 'computer.status': return this.status(client.actorId);
      case 'computer.windows': return this.windows(client);
      case 'computer.observe': return this.observe(client, params as any);
      case 'computer.acquire': return this.acquire(client, params.windowIds ?? []);
      case 'computer.action': return this.action(client, params as ComputerAction, params.operationId, true);
      case 'computer.stop': return this.stop(client.actorId);
      case 'computer.release': return this.stop(client.actorId, 'released', client);
      case 'computer.recent': return this.recent.filter(value => value.actorId === client.actorId);
      case 'computer.allowRun':
        this.app.requireOwner(client.actorId);
        for (const key of this.paused) if ((JSON.parse(key) as string[])[2] === params.runId) this.paused.delete(key);
        if (this.pausedRunId === params.runId) this.pausedRunId = undefined; this.changed(); return { success: true };
      default: throw new ComputerError('METHOD_UNSUPPORTED', '未知电脑操作请求。');
    }
  }
  async close() {
    this.stopEpoch++; this.abortCleanup?.(); this.unsubscribe(); await this.native.close(); await this.queue;
    this.observations.clear(); this.paused.clear();
  }
}
