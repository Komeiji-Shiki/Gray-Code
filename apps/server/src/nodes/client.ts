import type { NodeCapabilities, NodePeerSummary, NodeTaskDispatch, NodeTaskInput, RunEvent, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { nodeHash, nodeText } from './identity';
import type { NodePeer, NodeRegistry } from './registry';
import { openNodeSocket } from './transport';
import { NodeConnectionError, NodeWire } from './wire';

interface PeerConnection {
  state: NodePeerSummary['state']; wire?: NodeWire; connecting?: Promise<void>; capabilities?: NodeCapabilities;
  error?: string; lastSeenAt?: number; attempts: number; retry?: ReturnType<typeof setTimeout>; generation: number;
  connectController?: AbortController;
}
interface SavedDispatch extends NodeTaskDispatch { input: NodeTaskInput; fingerprint: string }
/** 控制端保留派发记录与事件游标。连接恢复只查询原任务，派发重试由用户使用原标识触发。 */
export class NodeClients {
  private readonly connections = new Map<string, PeerConnection>();
  private readonly cursors = new Map<string, number>();
  private readonly dispatching = new Map<string, Promise<RunRecord>>();
  private readonly recovering = new Map<string, Promise<void>>();
  private eventQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly app: PlatformApplication, private readonly registry: NodeRegistry, private readonly changed: () => void) {}
  private state(id: string) {
    let state = this.connections.get(id);
    if (!state) { state = { state: 'offline', attempts: 0, generation: 0 }; this.connections.set(id, state); } return state;
  }
  summaries(peer: NodePeer): Partial<NodePeerSummary> {
    const value = this.state(peer.id);
    return { state: peer.revokedAt ? 'revoked' : value.state, error: value.error, lastSeenAt: value.lastSeenAt, capabilities: value.capabilities };
  }
  private peer(id: string) {
    const peer = this.registry.peers.get(nodeText(id, '设备标识'));
    if (!peer || peer.direction !== 'outgoing' || peer.revokedAt) throw new Error('所选执行设备尚未配对，或已撤销。'); return peer;
  }
  private schedule(id: string) {
    const peer = this.registry.peers.get(id), state = this.state(id);
    if (this.closed || !peer || peer.paused || peer.revokedAt || state.retry) return;
    const delay = [1000, 2000, 5000, 10_000, 30_000][Math.min(state.attempts++, 4)];
    state.retry = setTimeout(() => { state.retry = undefined; void this.connect(id).catch(() => {}); }, delay); state.retry.unref();
  }
  connect(id: string): Promise<void> {
    const peer = this.peer(id), state = this.state(id);
    if (state.wire?.online) return Promise.resolve();
    if (state.connecting) return state.connecting;
    const generation = state.generation;
    state.state = 'connecting'; state.error = undefined; clearTimeout(state.retry); state.retry = undefined; this.changed();
    const next = (async () => {
      const controller = new AbortController(); state.connectController = controller;
      const token = await this.registry.identity.credential(peer.credentialRef);
      const socket = await openNodeSocket({ nodeId: peer.nodeId, address: peer.address!, certificate: peer.certificate! }, peer.id, this.registry.identity.id, token, controller.signal);
      if (this.closed || state.generation !== generation || this.registry.peers.get(id)?.revokedAt) { socket.terminate(); return; }
      const wire = new NodeWire(socket, {
        event: event => this.receive(peer, event),
        close: reason => { if (state.wire !== wire) return; state.wire = undefined; state.state = 'offline'; state.error = reason; this.changed(); this.schedule(id); },
      });
      state.wire = wire;
      const capabilities = await wire.request<NodeCapabilities>('capabilities');
      if (capabilities.nodeId !== peer.nodeId || capabilities.protocol !== 1) { wire.close('设备身份或协议不匹配。'); throw new Error('设备身份或协议不匹配。'); }
      state.capabilities = capabilities; state.state = 'online'; state.error = undefined; state.attempts = 0; state.lastSeenAt = Date.now(); this.changed();
      await this.recover(peer);
    })().catch(async error => {
      if (state.generation !== generation || this.closed) return;
      state.wire?.close((error as Error).message); state.wire = undefined;
      if ((error as NodeConnectionError).code === 'NODE_REVOKED') await this.registry.revoke(peer);
      state.state = this.registry.peers.get(id)?.revokedAt ? 'revoked' : 'offline'; state.error = (error as Error).message; this.changed(); this.schedule(id); throw error;
    }).finally(() => { if (state.connecting === next) { state.connecting = undefined; state.connectController = undefined; } });
    state.connecting = next; return next;
  }
  async request<T = any>(id: string, method: string, params: Record<string, any> = {}): Promise<T> {
    this.peer(id); const wire = this.state(id).wire;
    if (!wire?.online) throw new NodeConnectionError('NODE_OFFLINE', '所选执行设备已离线，请恢复连接后继续。');
    return wire.request<T>(method, params);
  }
  async activate() {
    this.closed = false;
    for (const peer of this.registry.peers.values()) if (peer.direction === 'outgoing' && !peer.revokedAt && !peer.paused) void this.connect(peer.id).catch(() => {});
  }
  private receive(peer: NodePeer, value: Record<string, any>) {
    const state = this.state(peer.id); state.lastSeenAt = Date.now();
    if (value.type === 'capabilities.changed') {
      void this.request<NodeCapabilities>(peer.id, 'capabilities').then(capabilities => {
        if (capabilities.nodeId !== peer.nodeId || capabilities.protocol !== 1) throw new Error('执行设备身份或协议发生变化，请重新配对。');
        state.capabilities = capabilities; this.changed();
      }).catch(error => { state.error = error.message; this.changed(); }); return;
    }
    if (value.type === 'event') {
      const event = value.event as RunEvent;
      if (!event || typeof event.runId !== 'string' || !Number.isSafeInteger(event.sequence)) return;
      const next = this.eventQueue.then(() => this.acceptEvent(peer, event)); this.eventQueue = next.catch(() => {});
      void next.catch(error => { state.error = (error as Error).message; this.changed(); });
    } else if (['model.delta', 'message.persisted', 'run.created', 'tool.progress', 'computer.changed', 'tasks.changed'].includes(value.type)) {
      this.app.publish({ type: 'nodes.event', peerId: peer.id, nodeId: peer.nodeId, notification: value });
    }
  }
  private async cursor(peer: NodePeer, runId: string) {
    const id = nodeHash(`${peer.id}:${runId}`);
    if (!this.cursors.has(id)) {
      const saved = await this.app.storage.getRecord('node-event-cursors', id) as { sequence: number } | null;
      this.cursors.set(id, saved?.sequence ?? 0);
    }
    return { id, sequence: this.cursors.get(id)! };
  }
  private async acceptEvent(peer: NodePeer, event: RunEvent, filling = false) {
    const cursor = await this.cursor(peer, event.runId);
    if (event.sequence <= cursor.sequence) return;
    if (event.sequence !== cursor.sequence + 1 && !filling) { await this.events(peer, event.runId); return; }
    if (event.sequence !== this.cursors.get(cursor.id)! + 1) throw new Error('设备事件顺序不连续，请重新连接并补取。');
    await this.app.storage.putRecord({ namespace: 'node-event-cursors', id: cursor.id, ownerId: peer.id, value: { runId: event.runId, sequence: event.sequence } });
    this.cursors.set(cursor.id, event.sequence);
    this.app.publish({ type: 'nodes.event', peerId: peer.id, nodeId: peer.nodeId, notification: { type: 'event', event } });
  }
  private async events(peer: NodePeer, runId: string) {
    for (;;) {
      const cursor = await this.cursor(peer, runId);
      const events = await this.request<RunEvent[]>(peer.id, 'tasks.events', { id: runId, afterSequence: cursor.sequence });
      for (const event of events) await this.acceptEvent(peer, event, true);
      if (events.length < 500) return;
    }
  }
  private recover(peer: NodePeer) {
    const pending = this.recovering.get(peer.id); if (pending) return pending;
    const next = (async () => {
      const runs = await this.request<RunRecord[]>(peer.id, 'tasks.list');
      // 与实时事件共用队列，补取期间到达的新事件不会覆盖较新的游标。
      const recovery = this.eventQueue.then(async () => { for (const run of runs) await this.events(peer, run.id); });
      this.eventQueue = recovery.catch(() => {}); await recovery;
      for (const dispatch of await this.list(peer.id)) {
        const run = runs.find(value => value.requestKey === `node-${nodeHash(`${peer.id}:${dispatch.requestKey}`)}`);
        if (run) await this.app.storage.putRecord({ namespace: 'node-dispatches', id: dispatch.id, ownerId: peer.id, value: { ...dispatch, state: 'accepted', run, error: undefined } });
      }
      this.changed();
    })().finally(() => this.recovering.delete(peer.id)); this.recovering.set(peer.id, next); return next;
  }
  dispatch(peerId: string, input: NodeTaskInput) {
    const peer = this.peer(peerId), key = nodeHash(`${peerId}:${nodeText(input.requestKey, '任务请求标识')}`);
    const previous = this.dispatching.get(key);
    const next = (previous ? previous.catch(() => {}).then(() => this.dispatchOnce(peer, key, input)) : this.dispatchOnce(peer, key, input));
    this.dispatching.set(key, next); void next.finally(() => { if (this.dispatching.get(key) === next) this.dispatching.delete(key); }).catch(() => {}); return next;
  }
  private async dispatchOnce(peer: NodePeer, id: string, input: NodeTaskInput): Promise<RunRecord> {
    const normalized: NodeTaskInput = { requestKey: input.requestKey, workspaceId: input.workspaceId, agentId: input.agentId, text: input.text,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}) };
    const fingerprint = nodeHash(JSON.stringify(normalized));
    const saved = await this.app.storage.getRecord('node-dispatches', id) as SavedDispatch | null;
    if (saved && saved.fingerprint !== fingerprint) throw new Error('任务请求标识已经用于其他内容。');
    if (saved?.run) return saved.run;
    const record: SavedDispatch = saved ?? { id, peerId: peer.id, nodeId: peer.nodeId, requestKey: input.requestKey, workspaceId: input.workspaceId,
      agentId: input.agentId, input: normalized, fingerprint, state: 'pending', createdAt: Date.now() };
    await this.app.storage.putRecord({ namespace: 'node-dispatches', id, ownerId: peer.id, value: record }); this.changed();
    try {
      const run = await this.request<RunRecord>(peer.id, 'tasks.start', normalized);
      if (run.executionNodeId !== peer.nodeId || run.nodeOrigin?.controllerNodeId !== this.registry.identity.id || run.workspaceId !== input.workspaceId) throw new Error('远端返回的任务归属与所选设备或项目不一致。');
      record.run = run; record.state = 'accepted'; record.error = undefined; return run;
    } catch (error) { record.error = (error as Error).message; throw error; }
    finally { await this.app.storage.putRecord({ namespace: 'node-dispatches', id, ownerId: peer.id, value: record }); this.changed(); }
  }
  async list(peerId: string) {
    this.peer(peerId); const ids = await this.app.storage.listRecords('node-dispatches', peerId);
    const values = await Promise.all(ids.map(id => this.app.storage.getRecord('node-dispatches', id) as Promise<SavedDispatch>));
    return values.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }
  async retry(peerId: string, id: string) {
    const value = await this.app.storage.getRecord('node-dispatches', id) as SavedDispatch | null;
    if (!value || value.peerId !== peerId) throw new Error('原任务派发记录不存在。'); return this.dispatch(peerId, value.input);
  }
  async disconnect(id: string, pause = false) {
    const peer = this.peer(id), state = this.state(id); state.generation++; state.connectController?.abort(); clearTimeout(state.retry); state.retry = undefined;
    if (pause) await this.registry.save({ ...peer, paused: true });
    const wire = state.wire; state.wire = undefined; wire?.close('本机已断开设备连接。'); state.state = 'offline'; this.changed();
    await state.connecting?.catch(() => {});
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.connections.keys()].map(async id => {
      const state = this.state(id); state.generation++; state.connectController?.abort(); clearTimeout(state.retry); state.retry = undefined; state.wire?.close('应用正在退出。');
      await state.connecting?.catch(() => {});
    }));
    await Promise.allSettled([...this.dispatching.values(), ...this.recovering.values(), this.eventQueue]);
  }
}
