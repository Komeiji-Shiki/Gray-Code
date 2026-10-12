import { createHash, randomUUID } from 'node:crypto';
import { authorizeEffects, type RuntimeTool } from '@graycode/core';
import {
  PET_APPLY_TIMEOUT_MS, PET_CHANNELS, PET_DEFAULT_DURATION_MS, PET_HEARTBEAT_INTERVAL_MS, PET_HEARTBEAT_TIMEOUT_MS,
  type PetAnimation, type PetChannel, type PetCommand, type PetCommandInput, type PetConfiguration,
  type PetModelCatalog, type PetRenderState, type PetRendererIdentity, type PetRpcMethods, type PetRpcRequest, type PetRuntime,
  type PetSnapshot, type RunEvent, type ToolOutcome,
} from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { PetResources } from './resources';
import { petAnimations } from '../../../../shared/petFormat';
import { petInteraction } from './interactions';
import { petCommandChannels, petControlBusy, type PetIdentity } from './controls';
import { petTools } from './tool';

const empty = (): PetConfiguration => ({
  visible: false, surface: 'app', scale: 1, reducedMotion: false, stopped: false, taskAnimations: true, mappings: {},
  soundEnabled: false, speechEnabled: false, followPointer: true,
});
interface PendingCommand { command: PetCommand; resolve(value: ToolOutcome): void; timer: NodeJS.Timeout }

/** 显示端共用设备控制状态；资源预览不取得当前桌宠的控制权。 */
export class PetService {
  readonly resources: PetResources;
  private configuration = empty();
  private revision: number | null = null;
  private state: PetRenderState = { generation: randomUUID(), phase: 'unloaded', parameters: [], channels: {} };
  private renderer?: { id: string; clientId: string; lastSeen: number };
  private runtime?: PetRuntime;
  private pending = new Map<string, PendingCommand>();
  private mutation: Promise<unknown> = Promise.resolve();
  private expirations = new Map<PetChannel, NodeJS.Timeout>();
  private taskEpoch = 0;
  private closed = false;
  private heartbeat: NodeJS.Timeout;
  private unsubscribe: () => void;
  private host?: { changed(): void; floatingAvailable: boolean };

  constructor(private readonly app: PlatformApplication) {
    this.resources = new PetResources(app.storage);
    this.unsubscribe = app.subscribe(notification => {
      if (notification.type === 'event') {
        const event = notification.event as RunEvent;
        if (['run.cancelled', 'run.failed', 'run.interrupted'].includes(event.type)) {
          this.release(command => command.runId === event.runId, '发起任务已经停止。');
        }
        if (/^(run\.|approval\.|question\.)/.test(event.type)) void this.taskState();
      }
      if (notification.type === 'settings.changed') {
        this.release(command => {
          try { this.authorize(command.actorId); return false; } catch { return true; }
        }, '账号权限已经变化。');
      }
    });
    this.heartbeat = setInterval(() => {
      if (this.renderer && Date.now() - this.renderer.lastSeen > PET_HEARTBEAT_TIMEOUT_MS) this.reset('播放器连接已断开。');
    }, PET_HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  async initialize() {
    const record = await this.app.storage.getVersionedRecord('pet-configuration', 'local');
    if (record.value) this.configuration = { ...empty(), ...record.value as PetConfiguration };
    this.revision = record.revision;
    const position = await this.app.storage.getRecord('pet-position', this.configuration.surface) as PetConfiguration['position'] | null;
    if (position) this.configuration.position = position;
    this.runtime = (await this.app.storage.getRecord('pet-runtime', 'info') as PetRuntime | null) ?? undefined;
  }

  attachHost(host: NonNullable<PetService['host']>) { this.host = host; host.changed(); }
  get hasHost() { return this.host !== undefined; }
  get keepsAlive() { return this.configuration.visible && this.configuration.surface === 'floating'; }

  async snapshot(): Promise<PetSnapshot> {
    const resource = this.configuration.resourceId ? await this.resources.get(this.configuration.resourceId) : undefined;
    return {
      configuration: this.configuration, revision: this.revision, state: this.state,
      resource, runtime: this.runtime, floatingAvailable: this.host?.floatingAvailable === true,
    };
  }

  async modelCatalog(resourceId = this.configuration.resourceId): Promise<PetModelCatalog> {
    const resource = resourceId ? await this.resources.get(resourceId) : undefined;
    const channels: PetModelCatalog['state']['channels'] = {};
    for (const channel of PET_CHANNELS) {
      const command = this.state.channels?.[channel];
      if (!command || command.expiresAt <= Date.now()) continue;
      channels[channel] = {
        requestId: command.requestId,
        ...(command.id ? { id: command.id } : {}),
        ...(command.angle !== undefined ? { angle: command.angle } : {}),
        ...(command.parameters ? { parameters: { ...command.parameters } } : {}),
        source: command.source, expiresAt: command.expiresAt,
      };
    }
    return {
      ...(resource ? { resource: {
        id: resource.id, kind: resource.kind, name: resource.name, description: resource.description,
        actions: resource.actions.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })),
        expressions: resource.expressions.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })),
      } } : {}),
      parameters: resourceId === this.state.resourceId ? this.state.parameters : [],
      state: { phase: this.state.phase, stopped: this.configuration.stopped, channels,
        ...(this.state.applied ? { applied: { ...this.state.applied } } : {}) },
    };
  }

  async query(actorId: string, signal: AbortSignal): Promise<ToolOutcome> {
    this.authorize(actorId);
    signal.throwIfAborted();
    return { success: true, data: await this.modelCatalog() };
  }

  speak(text: string, identity: { actorId: string; runId?: string }): void {
    if (this.closed || !this.configuration.speechEnabled || !this.configuration.visible || this.configuration.stopped || !text.trim()) return;
    this.authorize(identity.actorId);
    this.app.publish({ type: 'pets.speech', generation: this.state.generation, requestId: randomUUID(), text, runId: identity.runId });
  }

  private publish() {
    this.app.publish({ type: 'pets.changed', configuration: this.configuration, revision: this.revision, state: this.state });
    this.host?.changed();
  }

  private authorize(actorId: string) {
    const actor = this.app.actor(actorId);
    const error = actor ? authorizeEffects(actor, ['desktop_control']) : '账号不可用。';
    if (error) throw new Error(error);
  }

  private complete(requestId: string, value: ToolOutcome) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({ ...value, requestId });
  }

  private release(matches: (command: PetCommand) => boolean, reason: string) {
    let changed = false;
    for (const channel of PET_CHANNELS) {
      const command = this.state.channels?.[channel];
      if (!command || !matches(command)) continue;
      clearTimeout(this.expirations.get(channel));
      this.expirations.delete(channel);
      delete this.state.channels![channel];
      this.complete(command.requestId, { success: false, accepted: true, applied: false, error: reason });
      changed = true;
    }
    if (this.state.current && matches(this.state.current)) { this.state.current = undefined; changed = true; }
    if (changed) this.publish();
  }

  private clearCommands(reason: string) {
    for (const timer of this.expirations.values()) clearTimeout(timer);
    this.expirations.clear();
    for (const id of this.pending.keys()) this.complete(id, { success: false, accepted: true, applied: false, error: reason });
    this.state.channels = {};
    this.state.current = undefined;
    this.publish();
  }

  private reset(reason: string) {
    this.taskEpoch++;
    this.clearCommands(reason);
    this.renderer = undefined;
    this.state = {
      generation: randomUUID(), resourceId: this.configuration.resourceId, phase: 'unloaded', parameters: [], channels: {},
    };
    this.publish();
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(action);
    this.mutation = next.catch(() => {});
    return next;
  }

  private async save(input: PetConfiguration, revision: number | null) {
    for (const field of ['visible', 'reducedMotion', 'stopped', 'taskAnimations'] as const) {
      if (typeof input?.[field] !== 'boolean') throw new Error('桌宠显示设置无效。');
    }
    for (const field of ['soundEnabled', 'speechEnabled', 'followPointer'] as const) {
      if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new Error('桌宠互动设置无效。');
    }
    if (!['app', 'floating'].includes(input.surface) || !Number.isFinite(input.scale) || input.scale < 0.4 || input.scale > 3) {
      throw new Error('请选择显示位置和 0.4 至 3 倍缩放。');
    }
    if (input.surface === 'floating' && !this.host?.floatingAvailable) throw new Error('此执行设备没有桌面悬浮宿主。');
    const resource = input.resourceId ? await this.resources.get(input.resourceId) : undefined;
    if (input.visible && !resource) throw new Error('请先选择桌宠资源。');
    if (!input.mappings || typeof input.mappings !== 'object' || Array.isArray(input.mappings)) throw new Error('任务动画映射无效。');
    const mappings: PetConfiguration['mappings'] = {};
    for (const [key, id] of Object.entries(input.mappings)) {
      if (!petAnimations.some(item => item.id === key) || !resource?.actions.some(action => action.id === id)) {
        throw new Error('任务动画引用了当前模型没有的动作。');
      }
      mappings[key as PetAnimation] = id;
    }
    if (resource && resource.id !== this.configuration.resourceId && resource.kind === 'live2d' && !mappings.idle) {
      const idle = resource.actions.find(action => action.group?.toLowerCase() === 'idle');
      if (idle) mappings.idle = idle.id;
    }
    if (input.position && (!Number.isFinite(input.position.x) || !Number.isFinite(input.position.y))) throw new Error('桌宠位置无效。');
    const position = await this.app.storage.getRecord('pet-position', input.surface) as PetConfiguration['position'] | null;
    const value: PetConfiguration = {
      visible: input.visible, surface: input.surface, scale: input.scale, reducedMotion: input.reducedMotion,
      stopped: input.stopped, taskAnimations: input.taskAnimations, mappings,
      ...(resource ? { resourceId: resource.id } : {}), ...(position ? { position } : {}),
      ...(input.soundEnabled !== undefined ? { soundEnabled: input.soundEnabled } : {}),
      ...(input.speechEnabled !== undefined ? { speechEnabled: input.speechEnabled } : {}),
      ...(input.followPointer !== undefined ? { followPointer: input.followPointer } : {}),
    };
    const saved = await this.app.storage.commitRecords([{ namespace: 'pet-configuration', id: 'local', expectedRevision: revision, value }]);
    const previous = this.configuration;
    this.configuration = value;
    this.revision = saved[0]!.revision;
    if (previous.resourceId !== value.resourceId || previous.surface !== value.surface || previous.visible !== value.visible) {
      this.reset('桌宠或显示位置已经切换。');
    } else if (value.stopped) this.clearCommands('用户停止了动作。');
    else if (previous.taskAnimations && !value.taskAnimations) this.release(command => command.source === 'task', '已关闭任务动画。');
    this.publish();
    if (!value.stopped) void this.taskState();
    return this.snapshot();
  }

  private verifyRenderer(client: ClientSession, input: PetRendererIdentity) {
    if (!this.renderer || this.renderer.id !== input.rendererId || this.renderer.clientId !== client.clientId ||
      this.state.generation !== input.generation) throw new Error('播放器已经切换，请重新加载状态。');
    this.renderer.lastSeen = Date.now();
  }

  call<M extends keyof PetRpcMethods>(client: ClientSession, method: M,
    input: PetRpcMethods[M]['params']): Promise<PetRpcMethods[M]['result']>;
  call(client: ClientSession, method: string, input: unknown): Promise<unknown>;
  async call(client: ClientSession, method: string, input: unknown = {}): Promise<unknown> {
    this.app.requireOwner(client.actorId);
    if (method === 'pets.inbox' || method.startsWith('pets.chat.')) {
      return petInteraction(this.app, client, method, input as Record<string, unknown>);
    }
    // RPC 边界已按方法校验字段，判别联合让内部调用保留各方法自己的类型。
    const request = { method, input } as PetRpcRequest;
    switch (request.method) {
      case 'pets.position': return this.serialize(async () => {
        const { position } = request.input;
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('桌宠位置无效。');
        await this.app.storage.putRecord({ namespace: 'pet-position', id: this.configuration.surface, value: position });
        this.configuration.position = { ...position };
        this.publish();
        return { success: true };
      });
      case 'pets.list': return this.resources.list();
      case 'pets.status': return this.snapshot();
      case 'pets.import': return this.serialize(async () => {
        const resource = await this.resources.import(request.input);
        this.publish();
        return resource;
      });
      case 'pets.bundle': return this.resources.bundle(request.input.id);
      case 'pets.resource.annotate': return this.serialize(async () => {
        const resource = await this.resources.annotate(request.input);
        this.app.publish({ type: 'pets.resources.changed', resourceId: resource.id });
        this.publish();
        return resource;
      });
      case 'pets.remove': return this.serialize(async () => {
        if (this.configuration.resourceId === request.input.id) {
          await this.save({ ...this.configuration, resourceId: undefined, visible: false, mappings: {} }, request.input.revision);
        }
        await this.resources.remove(request.input.id);
        this.publish();
        return { success: true };
      });
      case 'pets.configure': return this.serialize(() => this.save(request.input.configuration, request.input.revision));
      case 'pets.runtime.import': return this.serialize(async () => {
        const { data, name } = request.input;
        if (data.length > 14 * 1024 * 1024 || !/^live2dcubismcore(?:\.min)?\.js$/i.test(name)) {
          throw new Error('请选择官方 Cubism SDK Core 中的 live2dcubismcore.min.js。');
        }
        const bytes = Buffer.from(data, 'base64');
        if (!bytes.toString('utf8').includes('Live2DCubismCore')) throw new Error('所选文件没有 Cubism Core 定义。');
        const info = { name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
        await this.app.storage.commitRecords([
          { namespace: 'pet-runtime', id: 'info', value: info },
          { namespace: 'pet-runtime', id: 'core', value: { bytes: new Uint8Array(bytes) } },
        ]);
        this.runtime = info;
        this.reset('本地运行库已经更换。');
        return this.snapshot();
      });
      case 'pets.runtime.get': {
        const record = await this.app.storage.getRecord('pet-runtime', 'core') as { bytes: Uint8Array } | null;
        return record ? { ...this.runtime!, data: Buffer.from(record.bytes).toString('base64') } : null;
      }
      case 'pets.runtime.remove': return this.serialize(async () => {
        await this.app.storage.commitRecords([
          { namespace: 'pet-runtime', id: 'info', delete: true }, { namespace: 'pet-runtime', id: 'core', delete: true },
        ]);
        this.runtime = undefined;
        this.reset('本地运行库已经移除。');
        return this.snapshot();
      });
      case 'pets.renderer.claim': {
        const input = request.input;
        if (!this.configuration.visible || input.surface !== this.configuration.surface || input.generation !== this.state.generation) {
          throw new Error('当前显示端未启用或状态已经变化。');
        }
        if (this.renderer && this.renderer.id !== input.rendererId && Date.now() - this.renderer.lastSeen < PET_HEARTBEAT_TIMEOUT_MS) {
          throw new Error('已有播放器正在显示此桌宠。');
        }
        if (input.rendererId.length > 100) throw new Error('播放器标识无效。');
        this.renderer = { id: input.rendererId, clientId: client.clientId, lastSeen: Date.now() };
        this.state.phase = 'loading';
        this.state.rendererId = input.rendererId;
        this.state.resourceId = this.configuration.resourceId;
        this.publish();
        return this.snapshot();
      }
      case 'pets.renderer.ready': {
        const input = request.input;
        this.verifyRenderer(client, input);
        if (input.parameters.length > 4096 || input.parameters.some(value =>
          !value || typeof value.id !== 'string' || ![value.min, value.max, value.default].every(Number.isFinite) ||
          value.min > value.max || value.default < value.min || value.default > value.max)) throw new Error('模型返回的参数定义无效。');
        this.state.parameters = input.parameters;
        this.state.phase = 'ready';
        this.state.error = undefined;
        this.publish();
        void this.taskState();
        return { success: true };
      }
      case 'pets.renderer.heartbeat': this.verifyRenderer(client, request.input); return { success: true };
      case 'pets.renderer.closed': this.verifyRenderer(client, request.input); this.reset('播放器已关闭。'); return { success: true };
      case 'pets.renderer.failed': {
        this.verifyRenderer(client, request.input);
        this.clearCommands('播放器加载或执行失败。');
        this.state.phase = 'failed';
        this.state.error = request.input.error.slice(0, 2000);
        this.publish();
        return { success: true };
      }
      case 'pets.renderer.applied': {
        this.verifyRenderer(client, request.input);
        const command = this.pending.get(request.input.requestId)?.command ??
          Object.values(this.state.channels ?? {}).find(command => command.requestId === request.input.requestId) ??
          (this.state.current?.requestId === request.input.requestId ? this.state.current : undefined);
        if (!command) return { success: false, stale: true };
        if (request.input.success) {
          this.state.applied = {
            requestId: command.requestId, action: command.action, ...(command.id ? { id: command.id } : {}), at: Date.now(),
          };
          this.complete(command.requestId, {
            success: true, accepted: true, applied: true, resourceId: command.resourceId, command: this.state.applied,
          });
        } else {
          this.complete(command.requestId, {
            success: false, accepted: true, applied: false, error: request.input.error || '播放器无法应用该操作。',
          });
          this.release(active => active.requestId === command.requestId, '播放器无法应用该操作。');
        }
        if (command.action === 'cancel' || command.action === 'resume') {
          if (this.state.current?.requestId === command.requestId) this.state.current = undefined;
          void this.taskState();
        }
        this.publish();
        return { success: true };
      }
      case 'pets.command': return this.command(request.input.command, { source: 'manual', actorId: client.actorId });
      default: throw new Error('未知桌宠操作。');
    }
  }

  async command(input: PetCommandInput, identity: PetIdentity, signal?: AbortSignal, expectedTaskEpoch?: number): Promise<ToolOutcome> {
    if (this.closed) return { success: false, accepted: false, error: '桌宠服务已关闭。' };
    this.authorize(identity.actorId);
    signal?.throwIfAborted();
    const generation = this.state.generation;
    const snapshot = await this.snapshot();
    signal?.throwIfAborted();
    this.authorize(identity.actorId);
    if (this.closed || identity.source === 'task' && (!this.configuration.taskAnimations ||
      expectedTaskEpoch !== undefined && expectedTaskEpoch !== this.taskEpoch)) {
      return { success: false, accepted: false, error: '任务动画状态已经变化。' };
    }
    if (generation !== this.state.generation || !snapshot.resource || !this.configuration.visible ||
      !this.renderer || this.state.phase !== 'ready') return { success: false, accepted: false, error: '当前桌宠尚未加载显示。' };
    if (this.configuration.stopped) {
      if (input.action !== 'resume' || identity.source !== 'manual') {
        return { success: false, accepted: false, error: '用户已停止桌宠，请由用户恢复。' };
      }
      await this.serialize(() => this.save({ ...this.configuration, stopped: false }, this.revision));
    }
    const drafts = petCommandChannels(input, snapshot.resource, this.state.parameters);
    const releasing = input.action === 'cancel' || input.action === 'resume';
    const channels = releasing ? PET_CHANNELS : Object.keys(drafts) as PetChannel[];
    for (const channel of channels) {
      const active = this.state.channels?.[channel];
      if (active && petControlBusy(active, identity)) {
        if (releasing) continue;
        return { success: false, accepted: false, error: '其他任务或用户正在控制桌宠的 ' + channel + ' 通道。' };
      }
    }
    const durationMs = releasing ? 0 : input.durationMs ?? (
      drafts.motion ? snapshot.resource.actions.find(action => action.id === drafts.motion!.id)?.durationMs ?? PET_DEFAULT_DURATION_MS :
        PET_DEFAULT_DURATION_MS
    );
    if (!releasing && (!Number.isFinite(durationMs) || durationMs < 100 || durationMs > 120_000)) {
      throw new Error('动作持续时间需要在 100 至 120000 毫秒之间。');
    }
    const now = Date.now();
    const command: PetCommand = {
      ...input, ...identity, requestId: randomUUID(), resourceId: snapshot.resource.id, generation, createdAt: now, expiresAt: now + durationMs,
    };
    this.state.channels ??= {};
    if (releasing) this.release(active => !petControlBusy(active, identity), '指令已撤销，控制权已释放。');
    else for (const channel of channels) {
      const previous = this.state.channels[channel];
      if (previous) this.complete(previous.requestId, { success: false, accepted: true, applied: false, error: '该通道已被新指令替换。' });
      clearTimeout(this.expirations.get(channel));
      this.state.channels[channel] = { ...command, ...drafts[channel] };
      const timer = setTimeout(() => {
        if (this.state.channels?.[channel]?.requestId !== command.requestId) return;
        delete this.state.channels[channel];
        this.expirations.delete(channel);
        if (this.state.current?.requestId === command.requestId &&
          !Object.values(this.state.channels).some(active => active.requestId === command.requestId)) this.state.current = undefined;
        this.publish();
        if (channel === 'motion') void this.taskState();
      }, durationMs);
      timer.unref();
      this.expirations.set(channel, timer);
    }
    this.state.current = command;
    const result = new Promise<ToolOutcome>(resolve => {
      const timer = setTimeout(() => {
        this.complete(command.requestId, { success: false, accepted: true, applied: false, error: '播放器未及时确认，实际结果未知，请查询状态。' });
        if (releasing) void this.taskState();
      }, PET_APPLY_TIMEOUT_MS);
      timer.unref();
      this.pending.set(command.requestId, { command, resolve, timer });
    });
    const abort = () => {
      this.release(active => active.requestId === command.requestId, '发起任务已取消。');
      this.complete(command.requestId, { success: false, accepted: true, applied: false, error: '发起任务已取消。' });
      void this.taskState();
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.publish();
    try { return await result; } finally { signal?.removeEventListener('abort', abort); }
  }

  private async taskState() {
    try {
      const request = ++this.taskEpoch;
      const generation = this.state.generation;
      const revision = this.revision;
      const available = () => !this.closed && this.configuration.visible && !this.configuration.stopped &&
        this.configuration.taskAnimations && this.state.phase === 'ready' &&
        !['manual', 'model'].includes(this.state.channels?.motion?.source ?? '');
      if (!available()) return;
      const runs = await this.app.storage.listRuns({ activeOnly: true, limit: 100 });
      const latest = !runs.length ? (await this.app.storage.listRuns({ limit: 1 }))[0] : undefined;
      const state: PetAnimation = runs.some(run => run.status === 'awaiting_approval') ? 'review' :
        runs.some(run => run.status === 'awaiting_input') ? 'waiting' : runs.length ? 'running' : latest?.status === 'failed' ? 'failed' : 'idle';
      const resource = this.configuration.resourceId && await this.resources.get(this.configuration.resourceId);
      if (request !== this.taskEpoch || generation !== this.state.generation || revision !== this.revision || !available()) return;
      const id = resource && (resource.kind === 'sprite' ? state : this.configuration.mappings[state]);
      if (!id || this.state.channels?.motion?.id === id) return;
      await this.command({ action: 'play', id, durationMs: 120_000 }, { source: 'task', actorId: 'owner' }, undefined, request);
    } catch (error) {
      // 所有后台触发入口共用这里，状态查询和实际播放的异常都需要留下原因。
      console.error('[桌宠] 任务动画更新失败：', error);
    }
  }

  tools(): RuntimeTool[] { return petTools(this); }
  close() {
    this.closed = true;
    this.taskEpoch++;
    this.unsubscribe();
    clearInterval(this.heartbeat);
    this.host = undefined;
    this.clearCommands('应用正在关闭。');
  }
}
