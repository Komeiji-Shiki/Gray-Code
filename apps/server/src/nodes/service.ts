import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { ExecutionNodeStatus, NodeGrant, NodeListenerSettings, NodePeerSummary, NodeTaskInput, RunRecord, ToolEffect } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import type { SecretCodec } from '../settings/service';
import { NodeIdentity, nodeAddress, nodeCertificate, nodeHash, nodeText, parseInvitation } from './identity';
import { NodeRegistry, type NodePeer } from './registry';
import { NodeExecutor } from './executor';
import { NodeClients } from './client';
import { NodeListener, postPair } from './transport';
import { NodeConnectionError, NodeWire } from './wire';

interface IncomingConnection { wire: NodeWire; releasing?: Promise<void> }
export class ExecutionNodes {
  readonly identity: NodeIdentity;
  private readonly registry: NodeRegistry;
  private readonly executor: NodeExecutor;
  private readonly clients: NodeClients;
  private readonly incoming = new Map<string, IncomingConnection>();
  private readonly views = new Map<string, Set<string>>();
  private readonly listener = new NodeListener();
  private listenerState: ExecutionNodeStatus['listener'] = { state: 'disabled' };
  private active = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private forwarding: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;
  constructor(private readonly app: PlatformApplication, codec?: SecretCodec) {
    this.identity = new NodeIdentity(app.storage, codec); this.registry = new NodeRegistry(app.storage, this.identity);
    this.executor = new NodeExecutor(app, this.registry, id => !!this.incoming.get(id)?.wire.online);
    this.clients = new NodeClients(app, this.registry, () => this.changed());
    this.unsubscribe = app.subscribe(notification => {
      if (notification.type === 'settings.changed') void this.permissionsChanged().catch(error => app.publish({ type: 'notification', message: String(error) }));
      if (notification.type === 'computer.changed') for (const connection of this.incoming.values()) connection.wire.event(notification);
      if (notification.type === 'workspace.diff.changed') for (const [id, connection] of this.incoming) {
        if (this.registry.peers.get(id)?.grant.workspaceIds.includes(String(notification.workspaceId))) connection.wire.event({ type: 'tasks.changed' });
      }
      const runId = notification.runId ?? (notification.event as { runId?: string } | undefined)?.runId;
      if (typeof runId === 'string' && ['event', 'run.created', 'message.persisted', 'model.delta', 'tool.progress'].includes(String(notification.type))) {
        const next = this.forwarding.then(async () => {
          const run = (notification.run as RunRecord | undefined) ?? await app.storage.getRun(runId);
          if (run?.nodeOrigin) this.incoming.get(run.nodeOrigin.peerId)?.wire.event(notification);
        }); this.forwarding = next.catch(() => {});
      }
    });
  }
  private changed() { if (!this.closed) this.app.publish({ type: 'nodes.changed' }); }
  private serialized<T>(action: () => Promise<T>) {
    const next = this.queue.then(action); this.queue = next.catch(() => {}); return next;
  }
  async initialize() { await this.identity.initialize(); await this.registry.initialize(); }
  async activate() {
    if (this.active) return; this.active = true;
    if (this.identity.settings.enabled) await this.startListener();
    await this.clients.activate();
  }
  get keepsAlive() { return this.listenerState.state === 'listening' || [...this.registry.peers.values()].some(peer => peer.direction === 'outgoing' && !peer.revokedAt && !peer.paused); }
  currentOrigin() { return this.executor.currentOrigin(); }
  runInScope<T>(run: RunRecord, action: () => T) { return this.executor.runInScope(run, action); }
  checkRun(run: RunRecord, effects?: ToolEffect[]) { return this.executor.checkRun(run, effects); }
  private interfaces() {
    return Object.entries(networkInterfaces()).flatMap(([name, values]) => (values ?? []).filter(value => value.family === 'IPv4').map(value => ({ name, address: value.address, internal: value.internal })));
  }
  status(actorId: string): ExecutionNodeStatus {
    this.app.requireOwner(actorId);
    const peers: NodePeerSummary[] = [...this.registry.peers.values()].map(peer => ({ id: peer.id, nodeId: peer.nodeId, name: peer.name, direction: peer.direction,
      createdAt: peer.createdAt, revokedAt: peer.revokedAt, address: peer.address, grant: structuredClone(peer.grant),
      state: peer.revokedAt ? 'revoked' : this.incoming.get(peer.id)?.wire.online ? 'online' : 'offline',
      ...(peer.direction === 'outgoing' ? this.clients.summaries(peer) : {}) }));
    return { nodeId: this.identity.id, settings: this.identity.settings, secureStorage: this.identity.secureStorage,
      listener: structuredClone(this.listenerState), interfaces: this.interfaces(), peers };
  }
  private async startListener() {
    await this.stopListener(); const settings = this.identity.settings;
    if (!settings.enabled) return;
    try {
      const credentials = await this.identity.credentials();
      const port = await this.listener.start({ ...settings, ...credentials,
        pair: async input => {
          const { peer, token } = await this.registry.accept(input, grant => this.executor.validateGrant(grant)); this.changed();
          return { nodeId: this.identity.id, peerId: peer.id, token, grant: peer.grant };
        },
        authenticate: request => {
          const id = request.headers['x-graycode-peer']; const nodeId = request.headers['x-graycode-node'];
          const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
          const peer = typeof id === 'string' ? this.registry.peers.get(id) : undefined;
          if (peer?.direction === 'incoming' && peer.nodeId === nodeId && peer.revokedAt) throw new NodeConnectionError('NODE_REVOKED', '设备配对已撤销。');
          if (!peer || peer.revokedAt || peer.direction !== 'incoming' || peer.nodeId !== nodeId || !peer.tokenHash
            || !timingSafeEqual(Buffer.from(nodeHash(token), 'hex'), Buffer.from(peer.tokenHash, 'hex'))) throw new Error('设备凭据已失效。');
          this.executor.validateGrant(peer.grant);
          if (this.incoming.has(peer.id)) throw new Error('同一设备已经连接，请先关闭旧连接，检查是否复制了设备数据。');
          return peer.id;
        },
        connected: (id, socket) => {
          const peer = this.registry.peers.get(id)!; const connectionId = randomUUID();
          const wire = new NodeWire(socket, {
            request: async (method, params) => {
              if (method === 'pair.revoke') {
                await this.registry.revoke(peer); await this.executor.revoked(peer.id); this.changed();
                // 先返回撤销结果，再结束此连接；重试时仍以服务端撤销记录为准。
                setTimeout(() => wire.close('设备配对已撤销。'), 50).unref(); return { revoked: true, peerId: peer.id };
              }
              return this.executor.request(peer, wire, method, params, connectionId);
            },
            close: () => {
              const connection = this.incoming.get(id); if (!connection || connection.wire !== wire) return;
              connection.releasing = this.executor.disconnected(id).catch(error => this.app.publish({ type: 'notification', message: String(error) })).finally(() => {
                if (this.incoming.get(id) === connection) this.incoming.delete(id); this.changed();
              }); this.changed();
            },
          });
          this.incoming.set(id, { wire }); this.changed();
        },
      });
      if (settings.port !== port) await this.identity.configure({ ...settings, port });
      this.listenerState = { state: 'listening', address: `https://${settings.host}:${port}`, fingerprint: nodeCertificate(credentials.certificate, this.identity.id).fingerprint };
    } catch (error) { this.listenerState = { state: 'error', error: (error as Error).message }; }
    this.changed();
  }
  private async stopListener() {
    for (const connection of this.incoming.values()) connection.wire.close('执行设备入口已经关闭。');
    await this.listener.close(); await Promise.allSettled([...this.incoming.values()].map(value => value.releasing));
    this.listenerState = { state: 'disabled' }; this.changed();
  }
  private async configure(params: NodeListenerSettings) {
    const settings: NodeListenerSettings = { enabled: params.enabled, name: nodeText(params.name, '设备名称'), host: nodeText(params.host, '监听地址'), port: params.port };
    if (typeof settings.enabled !== 'boolean' || isIP(settings.host) !== 4 || !this.interfaces().some(value => value.address === settings.host)
      || !Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) throw new Error('请选择当前设备的 IPv4 地址，端口应为 0 至 65535；0 表示首次自动分配。');
    if (settings.enabled) await this.identity.credentials();
    await this.identity.configure(settings); this.active = true; await this.startListener(); await this.clients.activate();
    return this.status('owner');
  }
  private async invitation(grant: NodeGrant) {
    this.executor.validateGrant(grant);
    if (this.listenerState.state !== 'listening') throw new Error('请先启用本机执行入口。');
    const credentials = await this.identity.credentials(), invite = await this.registry.invitation(grant);
    const value = { version: 1, nodeId: this.identity.id, name: this.identity.settings.name, address: this.listenerState.address!, certificate: credentials.certificate, ...invite };
    return { code: `graycode-node.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`, expiresAt: invite.expiresAt, grant };
  }
  private async pair(code: unknown) {
    const invitation = parseInvitation(code);
    if (invitation.nodeId === this.identity.id) throw new Error('不能与当前执行节点自身配对。');
    if (invitation.expiresAt < Date.now()) throw new Error('配对码已过期。');
    await this.identity.seal('');
    const requestKey = await this.registry.pairingRequest(invitation);
    const response = await postPair(invitation, { nodeId: this.identity.id, name: this.identity.settings.name, secret: invitation.secret, requestKey });
    const peer = await this.registry.connectedPair(invitation, response);
    this.active = true; await this.clients.activate(); await this.clients.connect(peer.id).catch(() => {}); this.changed();
    return { peerId: peer.id, status: this.status('owner') };
  }
  private async revoke(id: string, localOnly: boolean) {
    const peer = this.registry.peers.get(nodeText(id, '配对标识')); if (!peer) throw new Error('设备配对不存在。');
    if (peer.revokedAt) return { revoked: true, direction: peer.direction };
    if (peer.direction === 'outgoing') {
      if (!localOnly) {
        const result = await this.clients.request(peer.id, 'pair.revoke');
        if (result?.revoked !== true) throw new Error('执行设备没有确认撤销。');
      }
      await this.clients.disconnect(peer.id, true); await this.registry.revoke(peer); this.changed();
      return { revoked: true, remoteConfirmed: !localOnly };
    }
    await this.registry.revoke(peer); this.incoming.get(peer.id)?.wire.close('本机已撤销设备配对。'); await this.executor.revoked(peer.id); this.changed();
    return { revoked: true, remoteConfirmed: true };
  }
  private async permissionsChanged() {
    for (const peer of this.registry.peers.values()) if (peer.direction === 'incoming' && !peer.revokedAt) {
      try { this.executor.validateGrant(peer.grant); this.incoming.get(peer.id)?.wire.event({ type: 'capabilities.changed' }); }
      catch { this.incoming.get(peer.id)?.wire.close('执行账号或项目权限已改变。'); await this.executor.revoked(peer.id, 'permission_revoked'); }
    }
    this.changed();
  }
  async clientClosed(clientId: string) {
    const peers = this.views.get(clientId); this.views.delete(clientId);
    await Promise.allSettled([...(peers ?? [])].map(id => this.clients.request(id, 'computer.release', { viewId: nodeHash(clientId) })));
  }
  async call(session: ClientSession, method: string, params: Record<string, any>) {
    this.app.requireOwner(session.actorId);
    switch (method) {
      case 'nodes.status': return this.status(session.actorId);
      case 'nodes.options': return {
        accounts: this.app.settings.snapshot().settings.accounts.filter(value => !value.revoked).map(value => ({ id: value.id, displayName: value.displayName, role: value.role, workspaceIds: value.workspaceIds, computer: value.role === 'owner' || value.effects.includes('desktop_control') })),
        workspaces: this.app.settings.snapshot().settings.workspaces.filter(value => !value.managedConversationId).map(value => ({ id: value.id, name: value.name, directory: value.directory })),
      };
      case 'nodes.configure': return this.serialized(() => this.configure(params as NodeListenerSettings));
      case 'nodes.invitation': return this.serialized(() => this.invitation(params as NodeGrant));
      case 'nodes.pair': return this.serialized(() => this.pair(params.code));
      case 'nodes.revoke': return this.serialized(() => this.revoke(params.id, params.localOnly === true));
      case 'nodes.disconnect': await this.clients.disconnect(params.id, true); return { success: true };
      case 'nodes.connect': {
        const peer = this.registry.peers.get(params.id);
        if (!peer || peer.direction !== 'outgoing' || peer.revokedAt) throw new Error('执行设备配对不可用。');
        if (params.address !== undefined) { await this.clients.disconnect(peer.id); peer.address = nodeAddress(params.address); }
        await this.registry.save({ ...peer, paused: false }); await this.clients.connect(peer.id); return this.status(session.actorId);
      }
      case 'nodes.tasks.start': return this.clients.dispatch(params.peerId, params as NodeTaskInput);
      case 'nodes.tasks.retry': return this.clients.retry(params.peerId, params.id);
      case 'nodes.dispatches': return this.clients.list(params.peerId);
      case 'nodes.request': {
        if (typeof params.method !== 'string' || !['capabilities', 'tasks.list', 'tasks.get', 'tasks.events', 'tasks.cancel', 'tasks.approve', 'tasks.answer', 'tasks.diff', 'tasks.resolveDiff',
          'computer.status', 'computer.windows', 'computer.observe', 'computer.display', 'computer.acquire', 'computer.action', 'computer.release', 'computer.stop', 'computer.allowRun'].includes(params.method)) throw new Error('未知执行设备操作。');
        const request = { ...params.params };
        if (params.method.startsWith('computer.')) {
          request.viewId = nodeHash(session.clientId);
          const peers = this.views.get(session.clientId) ?? new Set<string>(); peers.add(params.peerId); this.views.set(session.clientId, peers);
        }
        return this.clients.request(params.peerId, params.method, request);
      }
      default: throw new Error('未知执行节点操作。');
    }
  }
  async close() {
    this.closed = true; this.unsubscribe(); await this.queue; await this.clients.close(); await this.stopListener(); await this.forwarding;
  }
}
