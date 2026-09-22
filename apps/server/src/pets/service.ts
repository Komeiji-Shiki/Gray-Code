import { createHash, randomUUID } from 'node:crypto';
import { authorizeEffects, type RuntimeTool } from '@graycode/core';
import type { PetAnimation, PetCommand, PetCommandInput, PetConfiguration, PetParameter, PetRenderState, PetSnapshot, ToolOutcome } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { PetResources } from './resources';
import { petAnimations } from '../../../../shared/petFormat';
import { petInteraction } from './interactions';

const empty = (): PetConfiguration => ({ visible: false, surface: 'app', scale: 1, reducedMotion: false, stopped: false, taskAnimations: true, mappings: {} });
const priorities = { task: 0, model: 1, manual: 2 };
/** 显示端共用设备控制状态；资源预览不取得当前桌宠的控制权。 */
export class PetService {
  readonly resources: PetResources;
  private configuration = empty(); private revision: number | null = null;
  private state: PetRenderState = { generation: randomUUID(), phase: 'unloaded', parameters: [] };
  private renderer?: { id: string; clientId: string; lastSeen: number };
  private runtime?: { name: string; sha256: string; bytes: number };
  private pending = new Map<string, { resolve(value: ToolOutcome): void; timer: NodeJS.Timeout }>();
  private mutation: Promise<unknown> = Promise.resolve();
  private animationTimer?: NodeJS.Timeout;
  private taskEpoch = 0;
  private closed = false;
  private heartbeat: NodeJS.Timeout;
  private unsubscribe: () => void;
  private host?: { changed(): void; floatingAvailable: boolean };
  constructor(private readonly app: PlatformApplication) {
    this.resources = new PetResources(app.storage);
    this.unsubscribe = app.subscribe(event => {
      if (event.type === 'event' && ['run.cancelled', 'run.failed', 'run.interrupted'].includes((event.event as any)?.type) && this.state.current?.runId === (event.event as any).runId) this.clearCommand('发起任务已经停止。');
      if (event.type === 'event' && /^(run\.|approval\.|question\.)/.test((event.event as any)?.type ?? '')) void this.taskState().catch(() => {});
      if (event.type === 'settings.changed' && this.state.current) {
        try { this.authorize(this.state.current.actorId); } catch { this.clearCommand('账号权限已经变化。'); }
      }
    });
    this.heartbeat = setInterval(() => { if (this.renderer && Date.now() - this.renderer.lastSeen > 20_000) this.reset('播放器连接已断开。'); }, 5000); this.heartbeat.unref();
  }
  async initialize() {
    const record = await this.app.storage.getVersionedRecord('pet-configuration', 'local');
    if (record.value) this.configuration = { ...empty(), ...record.value as PetConfiguration };
    this.revision = record.revision;
    const position = await this.app.storage.getRecord('pet-position', this.configuration.surface) as { x: number; y: number } | null;
    if (position) this.configuration.position = position;
    this.runtime = (await this.app.storage.getRecord('pet-runtime', 'info') as typeof this.runtime) ?? undefined;
  }
  attachHost(host: NonNullable<PetService['host']>) { this.host = host; host.changed(); }
  get keepsAlive() { return this.configuration.visible && this.configuration.surface === 'floating'; }
  async snapshot(): Promise<PetSnapshot> {
    const resource = this.configuration.resourceId ? await this.resources.get(this.configuration.resourceId) : undefined;
    return { configuration: structuredClone(this.configuration), revision: this.revision, state: structuredClone(this.state), resource,
      runtime: this.runtime, floatingAvailable: this.host?.floatingAvailable === true };
  }
  private publish() { this.app.publish({ type: 'pets.changed', configuration: this.configuration, revision: this.revision, state: this.state }); this.host?.changed(); }
  private authorize(actorId: string) {
    const actor = this.app.actor(actorId); const error = actor ? authorizeEffects(actor, ['desktop_control']) : '账号不可用。';
    if (error) throw new Error(error);
  }
  private complete(requestId: string, value: ToolOutcome) {
    const pending = this.pending.get(requestId); if (!pending) return;
    this.pending.delete(requestId); clearTimeout(pending.timer); pending.resolve(value);
  }
  private clearCommand(reason: string) {
    clearTimeout(this.animationTimer);
    for (const id of this.pending.keys()) this.complete(id, { success: false, accepted: true, applied: false, error: reason });
    this.state.current = undefined; this.publish();
  }
  private reset(reason: string) {
    this.taskEpoch++;
    this.clearCommand(reason); this.renderer = undefined;
    this.state = { generation: randomUUID(), resourceId: this.configuration.resourceId, phase: 'unloaded', parameters: [] }; this.publish();
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(action); this.mutation = next.catch(() => {}); return next;
  }
  private async save(input: PetConfiguration, revision: number | null) {
    for (const field of ['visible', 'reducedMotion', 'stopped', 'taskAnimations'] as const) if (typeof input?.[field] !== 'boolean') throw new Error('桌宠显示设置无效。');
    if (!['app', 'floating'].includes(input.surface) || !Number.isFinite(input.scale) || input.scale < 0.4 || input.scale > 3) throw new Error('请选择显示位置和 0.4 至 3 倍缩放。');
    if (input.surface === 'floating' && !this.host?.floatingAvailable) throw new Error('此执行设备没有桌面悬浮宿主。');
    const resource = input.resourceId ? await this.resources.get(input.resourceId) : undefined;
    if (input.visible && !resource) throw new Error('请先选择桌宠资源。');
    if (!input.mappings || typeof input.mappings !== 'object' || Array.isArray(input.mappings)) throw new Error('任务动画映射无效。');
    const mappings: PetConfiguration['mappings'] = {};
    for (const [key, id] of Object.entries(input.mappings)) {
      if (!petAnimations.some(item => item.id === key) || !resource?.actions.some(action => action.id === id)) throw new Error('任务动画引用了当前模型没有的动作。');
      mappings[key as PetAnimation] = id;
    }
    if (input.position && (!Number.isFinite(input.position.x) || !Number.isFinite(input.position.y))) throw new Error('桌宠位置无效。');
    const position = await this.app.storage.getRecord('pet-position', input.surface) as { x: number; y: number } | null;
    const value: PetConfiguration = { visible: input.visible, surface: input.surface, scale: input.scale, reducedMotion: input.reducedMotion,
      stopped: input.stopped, taskAnimations: input.taskAnimations, mappings,
      ...(resource ? { resourceId: resource.id } : {}), ...(position ? { position } : {}) };
    const saved = await this.app.storage.commitRecords([{ namespace: 'pet-configuration', id: 'local', expectedRevision: revision, value }]);
    const previous = this.configuration; this.configuration = value; this.revision = saved[0]!.revision;
    if (previous.resourceId !== value.resourceId || previous.surface !== value.surface || previous.visible !== value.visible) this.reset('桌宠或显示位置已经切换。');
    else if (value.stopped || value.reducedMotion !== previous.reducedMotion) this.clearCommand('用户停止了动作或调整了动态效果。');
    else if (previous.taskAnimations && !value.taskAnimations && this.state.current?.source === 'task') this.clearCommand('已关闭任务动画。');
    this.publish(); if (!value.stopped) void this.taskState(); return this.snapshot();
  }
  private verifyRenderer(client: ClientSession, input: Record<string, any>) {
    if (!this.renderer || this.renderer.id !== input.rendererId || this.renderer.clientId !== client.clientId || this.state.generation !== input.generation) throw new Error('播放器已经切换，请重新加载状态。');
    this.renderer.lastSeen = Date.now();
  }
  async call(client: ClientSession, method: string, input: Record<string, any>) {
    this.app.requireOwner(client.actorId);
    if (method === 'pets.inbox' || method.startsWith('pets.chat.')) return petInteraction(this.app, client, method, input);
    switch (method) {
      case 'pets.position': return this.serialize(async () => {
        if (!input.position || !Number.isFinite(input.position.x) || !Number.isFinite(input.position.y)) throw new Error('桌宠位置无效。');
        const position = { x: input.position.x, y: input.position.y };
        await this.app.storage.putRecord({ namespace: 'pet-position', id: this.configuration.surface, value: position });
        this.configuration.position = position; this.publish(); return { success: true };
      });
      case 'pets.list': return this.resources.list();
      case 'pets.status': return this.snapshot();
      case 'pets.import': return this.serialize(async () => { const resource = await this.resources.import(input as any); this.publish(); return resource; });
      case 'pets.bundle': return this.resources.bundle(input.id);
      case 'pets.remove': return this.serialize(async () => {
        if (this.configuration.resourceId === input.id) await this.save({ ...this.configuration, resourceId: undefined, visible: false, mappings: {} }, input.revision);
        await this.resources.remove(input.id); this.publish(); return { success: true };
      });
      case 'pets.configure': return this.serialize(() => this.save(input.configuration, input.revision));
      case 'pets.runtime.import': return this.serialize(async () => {
        if (typeof input.data !== 'string' || input.data.length > 14 * 1024 * 1024 || typeof input.name !== 'string' || !/^live2dcubismcore(?:\.min)?\.js$/i.test(input.name)) throw new Error('请选择官方 Cubism SDK Core 中的 live2dcubismcore.min.js。');
        const bytes = Buffer.from(input.data, 'base64');
        if (!bytes.toString('utf8').includes('Live2DCubismCore')) throw new Error('所选文件没有 Cubism Core 定义。');
        const info = { name: input.name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
        await this.app.storage.commitRecords([{ namespace: 'pet-runtime', id: 'info', value: info }, { namespace: 'pet-runtime', id: 'core', value: { bytes: new Uint8Array(bytes) } }]);
        this.runtime = info; this.reset('本地运行库已经更换。'); return this.snapshot();
      });
      case 'pets.runtime.get': {
        const record = await this.app.storage.getRecord('pet-runtime', 'core') as { bytes: Uint8Array } | null;
        return record ? { ...this.runtime, data: Buffer.from(record.bytes).toString('base64') } : null;
      }
      case 'pets.runtime.remove': return this.serialize(async () => {
        await this.app.storage.commitRecords([{ namespace: 'pet-runtime', id: 'info', delete: true }, { namespace: 'pet-runtime', id: 'core', delete: true }]);
        this.runtime = undefined; this.reset('本地运行库已经移除。'); return this.snapshot();
      });
      case 'pets.renderer.claim': {
        if (!this.configuration.visible || input.surface !== this.configuration.surface || input.generation !== this.state.generation) throw new Error('当前显示端未启用或状态已经变化。');
        if (this.renderer && this.renderer.id !== input.rendererId && Date.now() - this.renderer.lastSeen < 20_000) throw new Error('已有播放器正在显示此桌宠。');
        if (typeof input.rendererId !== 'string' || input.rendererId.length > 100) throw new Error('播放器标识无效。');
        this.renderer = { id: input.rendererId, clientId: client.clientId, lastSeen: Date.now() };
        this.state.phase = 'loading'; this.state.rendererId = input.rendererId; this.state.resourceId = this.configuration.resourceId; this.publish(); return this.snapshot();
      }
      case 'pets.renderer.ready': {
        this.verifyRenderer(client, input);
        if (!Array.isArray(input.parameters) || input.parameters.length > 4096 || input.parameters.some((value: PetParameter) => !value || typeof value.id !== 'string' || ![value.min, value.max, value.default].every(Number.isFinite) || value.min > value.max || value.default < value.min || value.default > value.max)) throw new Error('模型返回的参数定义无效。');
        this.state.parameters = input.parameters; this.state.phase = 'ready'; this.state.error = undefined; this.publish(); void this.taskState(); return { success: true };
      }
      case 'pets.renderer.heartbeat': this.verifyRenderer(client, input); return { success: true };
      case 'pets.renderer.closed': this.verifyRenderer(client, input); this.reset('播放器已关闭。'); return { success: true };
      case 'pets.renderer.failed': this.verifyRenderer(client, input); this.clearCommand('播放器加载或执行失败。'); this.state.phase = 'failed'; this.state.error = String(input.error).slice(0, 2000); this.publish(); return { success: true };
      case 'pets.renderer.applied': {
        this.verifyRenderer(client, input); const command = this.state.current;
        if (!command || command.requestId !== input.requestId) return { success: false, stale: true };
        if (input.success === true) {
          this.state.applied = { requestId: command.requestId, action: command.action, ...(command.id ? { id: command.id } : {}), at: Date.now() };
          this.complete(command.requestId, { success: true, accepted: true, applied: true, resourceId: command.resourceId, command: this.state.applied, state: structuredClone(this.state) });
        } else {
          this.complete(command.requestId, { success: false, accepted: true, applied: false, error: String(input.error || '播放器无法应用该操作。') }); this.state.current = undefined;
        }
        this.publish(); return { success: true };
      }
      case 'pets.command': return this.command(input.command, { source: 'manual', actorId: client.actorId });
      default: throw new Error('未知桌宠操作。');
    }
  }
  async command(input: PetCommandInput, identity: { source: PetCommand['source']; actorId: string; runId?: string }, signal?: AbortSignal, expectedTaskEpoch?: number): Promise<ToolOutcome> {
    if(this.closed)return {success:false,accepted:false,error:'桌宠服务已关闭。'};
    this.authorize(identity.actorId); signal?.throwIfAborted();
    const generation = this.state.generation; const snapshot = await this.snapshot(); signal?.throwIfAborted();
    this.authorize(identity.actorId);
    if(this.closed||identity.source==='task'&&(!this.configuration.taskAnimations||expectedTaskEpoch!==undefined&&expectedTaskEpoch!==this.taskEpoch))return {success:false,accepted:false,error:'任务动画状态已经变化。'};
    if (generation !== this.state.generation || !snapshot.resource || !this.configuration.visible || !this.renderer || this.state.phase !== 'ready') return { success: false, accepted: false, error: '当前桌宠尚未加载显示。' };
    if (this.configuration.stopped) return { success: false, accepted: false, error: '用户已停止桌宠，请由用户恢复。' };
    if (!input || !['play', 'expression', 'look', 'parameters', 'cancel', 'resume'].includes(input.action)) throw new Error('桌宠动作类型无效。');
    const active = this.state.current;
    if (active && active.expiresAt > Date.now() && (priorities[active.source] > priorities[identity.source] || active.source === 'model' && identity.source === 'model' && active.runId !== identity.runId)) return { success: false, accepted: false, error: '其他任务或用户正在控制桌宠。', current: active };
    if (input.action === 'play' && !snapshot.resource.actions.some(action => action.id === input.id)) throw new Error('当前桌宠没有这个动作，请先查询实际动作列表。');
    if (input.action === 'expression' && !snapshot.resource.expressions.some(expression => expression.id === input.id)) throw new Error('当前模型没有这个表情。');
    if (input.action === 'look' && input.angle !== null && (!Number.isFinite(input.angle) || input.angle! < 0 || input.angle! >= 360)) throw new Error('视线方向需要 0 至 360 度以内的角度，或 null 恢复正面。');
    if (input.action === 'look' && snapshot.resource.sprite?.version === 1 && input.angle !== null) throw new Error('版本 1 图集没有观察方向。');
    if (input.action === 'parameters') {
      if (!input.parameters || typeof input.parameters !== 'object' || !Object.keys(input.parameters).length) throw new Error('请提供模型参数。');
      for (const [id, value] of Object.entries(input.parameters)) {
        const parameter = this.state.parameters.find(item => item.id === id);
        if (!parameter || !Number.isFinite(value) || value < parameter.min || value > parameter.max) throw new Error(`参数 ${id} 不存在或超出模型范围。`);
      }
    }
    const durationMs = input.durationMs ?? (input.action === 'play' ? snapshot.resource.actions.find(action => action.id === input.id)?.durationMs ?? 6000 : 6000);
    if (!Number.isFinite(durationMs) || durationMs < 100 || durationMs > 120_000) throw new Error('动作持续时间需要在 100 至 120000 毫秒之间。');
    this.clearCommand('动作被同一任务的新请求或用户操作替换。');
    const command: PetCommand = { ...input, ...identity, requestId: randomUUID(), resourceId: snapshot.resource.id, generation, createdAt: Date.now(), expiresAt: Date.now() + durationMs };
    this.state.current = command;
    const result = new Promise<ToolOutcome>(resolve => {
      const timer = setTimeout(() => this.complete(command.requestId, { success: false, accepted: true, applied: false, error: '播放器未及时确认，实际结果未知，请查询状态。' }), 5000); timer.unref();
      this.pending.set(command.requestId, { resolve, timer });
    });
    this.animationTimer = setTimeout(() => { if (this.state.current?.requestId === command.requestId) { this.state.current = undefined; this.publish(); void this.taskState(); } }, durationMs); this.animationTimer.unref();
    const abort = () => { if (this.state.current?.requestId === command.requestId) this.clearCommand('发起任务已取消。'); };
    signal?.addEventListener('abort', abort, { once: true }); this.publish();
    try { return await result; } finally { signal?.removeEventListener('abort', abort); }
  }
  private async taskState() {
    const request=++this.taskEpoch,generation=this.state.generation,revision=this.revision;
    const available=()=>!this.closed&&this.configuration.visible&&!this.configuration.stopped&&this.configuration.taskAnimations&&this.state.phase==='ready'&&this.state.current?.source!=='manual'&&this.state.current?.source!=='model';
    if (!available()) return;
    const runs = await this.app.storage.listRuns({ activeOnly: true, limit: 100 });
    const latest = !runs.length ? (await this.app.storage.listRuns({ limit: 1 }))[0] : undefined;
    const state: PetAnimation = runs.some(run => run.status === 'awaiting_approval') ? 'review' : runs.some(run => run.status === 'awaiting_input') ? 'waiting' : runs.length ? 'running' : latest?.status === 'failed' ? 'failed' : 'idle';
    const resource = this.configuration.resourceId && await this.resources.get(this.configuration.resourceId);
    if(request!==this.taskEpoch||generation!==this.state.generation||revision!==this.revision||!available())return;
    const id = resource && (resource.kind === 'sprite' ? state : this.configuration.mappings[state]);
    if (!id || this.state.current?.id === id) return;
    void this.command({ action: 'play', id, durationMs: 120_000 }, { source: 'task', actorId: 'owner' },undefined,request).catch(() => {});
  }
  tools(): RuntimeTool[] {
    return [{ declaration: { name: 'pet_control', description: '控制本执行设备上用户已选择并显示的桌宠。先用 query 读取实际动作、表情和参数范围；play、expression、look、parameters、cancel、resume 只作用于这个模型。不会开启截图。用户停止具有优先权；其他任务控制中返回忙碌。结果区分已接受和播放器实际应用，切换模型后重新查询。', parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['query', 'play', 'expression', 'look', 'parameters', 'cancel', 'resume'] }, id: { type: 'string' }, angle: { type: ['number', 'null'], minimum: 0, exclusiveMaximum: 360 }, parameters: { type: 'object', additionalProperties: { type: 'number' } }, durationMs: { type: 'integer', minimum: 100, maximum: 120000 },
    }, required: ['action'], additionalProperties: false } }, effects: () => ['desktop_control'], execute: async (input, context) => {
      try { this.authorize(context.actorId); context.signal.throwIfAborted(); return input.action === 'query' ? { success: true, data: await this.snapshot() } : await this.command(input as unknown as PetCommandInput, { source: 'model', actorId: context.actorId, runId: context.runId }, context.signal); }
      catch (error) { return { success: false, error: (error as Error).message }; }
    } }];
  }
  close() { this.closed=true;this.taskEpoch++;this.unsubscribe(); clearInterval(this.heartbeat); this.host = undefined; this.clearCommand('应用正在关闭。'); }
}
