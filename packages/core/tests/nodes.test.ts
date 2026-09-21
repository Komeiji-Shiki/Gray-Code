import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionNodeStatus, ModelInput, NodeGrant, PlatformMessage, RunRecord } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { nodeHash, parseInvitation } from '../../../apps/server/src/nodes/identity';
import { openNodeSocket, postPair } from '../../../apps/server/src/nodes/transport';
import type { ComputerNativePort, NativeComputerStatus } from '../../../apps/server/src/computer/port';
import { ApplicationBackups } from '../../../apps/server/src/backups/service';
import { preserveNodeRevocations } from '../../../apps/server/src/backups/nodeRevocations';
import { fixture } from './fixtures';

// 使用真实 TLS/WebSocket、独立数据库和运行器；模型只生成受控工具调用，不访问外部服务。
const encryption = () => {
  const key = randomBytes(32);
  return {
    encrypt: async (text: string) => { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, cipher.update(text), cipher.final(), cipher.getAuthTag()]); },
    decrypt: async (value: Uint8Array) => { const data = Buffer.from(value), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString(); },
  };
};
const until = async (predicate: () => unknown | Promise<unknown>) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('执行节点未达到预期状态。');
};
class NodeNativeFixture implements ComputerNativePort {
  available = true;
  state: NativeComputerStatus = { active: false, reason: 'idle', generation: 0 };
  listeners = new Set<(value: NativeComputerStatus) => void>();
  actions: Record<string, any>[] = []; holdAction?: () => Promise<void>;
  window = { id: '98', title: '节点验收窗口', className: 'NodeFixture', processId: 4567, processStartedAt: '2026-09-13T00:00:00Z', executable: 'node-fixture',
    monitorId: 'display', dpi: 96, minimized: false, foreground: true, bounds: { x: 100, y: 50, width: 800, height: 600 }, captureBounds: { x: 100, y: 50, width: 800, height: 600 } };
  subscribe(listener: (value: NativeComputerStatus) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(this.state); }
  async request<T>(method: string, args: Record<string, any> = {}): Promise<T> {
    if (method === 'windows') return { windows: [this.window], displays: [], capturedAt: Date.now() } as T;
    if (method === 'acquire') { this.state = { active: true, leaseId: randomUUID(), owner: args.owner, generation: this.state.generation + 1, reason: 'acquired' }; this.emit(); return this.state as T; }
    if (method === 'observe') return { id: randomUUID(), capturedAt: Date.now(), window: this.window, elements: [], truncated: false } as T;
    if (method === 'capture') return { capturedAt: Date.now(), width: 400, height: 300, windowId: '98', monitorId: 'display', dpi: 96, bounds: this.window.captureBounds, mimeType: 'image/png', data: 'fixture' } as T;
    if (method === 'validate') return { valid: true } as T;
    if (method === 'action') { this.actions.push(args); await this.holdAction?.(); return { performed: true, action: args.action } as T; }
    throw new Error('Unexpected native request: ' + method);
  }
  async stop(reason: string) { this.state = { active: false, reason, generation: this.state.generation + 1 }; this.emit(); }
  async close() { await this.stop('host_closed'); }
}

describe('执行节点配对、运行与恢复', () => {
  let fa: Awaited<ReturnType<typeof fixture>>, fb: Awaited<ReturnType<typeof fixture>>;
  let a: PlatformApplication, b: PlatformApplication, ra: ApplicationRouter, rb: ApplicationRouter;
  let codecA: ReturnType<typeof encryption>, codecB: ReturnType<typeof encryption>;
  let callsA = 0, callsB = 0;
  let nativeB: NodeNativeFixture | undefined;
  const owner = { actorId: 'owner', clientId: 'node-owner' };
  let generateB: (input: ModelInput) => Promise<PlatformMessage>;
  const callA = (method: string, params: Record<string, any> = {}) => ra.call(owner, method, params) as Promise<any>;
  const callB = (method: string, params: Record<string, any> = {}) => rb.call(owner, method, params) as Promise<any>;
  const grant: NodeGrant = { actorId: 'worker', workspaceIds: ['project'], tasks: true, computer: false };
  const configure = async (app: PlatformApplication, directory: string) => {
    app.tools.register({ declaration: { name: 'node_marker', description: '追加验收文字', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      effects: () => ['workspace_write'], execute: async (_args, context) => { await appendFile(path.join(context.workspace!.directory, 'node-result.txt'), '一次\n'); return { success: true }; } });
    const settings = app.settings.snapshot();
    if (!settings.settings.workspaces.length) {
      settings.settings.workspaces.push({ id: 'project', name: '远端项目', directory, deviceId: 'local' });
      settings.settings.accounts.push({ id: 'worker', displayName: '执行成员', role: 'member', effects: ['public_read', 'workspace_read', 'workspace_write'], workspaceIds: ['project'] });
    }
    settings.settings.agents[0].toolNames = ['node_marker']; settings.settings.agents[0].toolApproval = { node_marker: 'auto' }; settings.settings.agents[0].reviewerToolNames = [];
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
  };
  const openA = async () => { a = await PlatformApplication.open({ dataDirectory: fa.data, secretCodec: codecA, models: { generate: async () => { callsA++; return { role: 'model', parts: [{ text: '本机' }] }; } } }); ra = new ApplicationRouter(a); await configure(a, fa.source); };
  const openB = async () => { b = await PlatformApplication.open({ dataDirectory: fb.data, secretCodec: codecB, computerNative: nativeB, models: { generate: input => { callsB++; return generateB(input); } } }); rb = new ApplicationRouter(b); await configure(b, fb.source); };
  const pair = async (permissions = grant) => {
    const status = await callB('nodes.configure', { enabled: true, name: '执行设备 B', host: '127.0.0.1', port: 0 }); expect(status.listener.state).toBe('listening');
    const invite = await callB('nodes.invitation', permissions); const result = await callA('nodes.pair', { code: invite.code });
    expect(result.status.peers.find((peer: any) => peer.id === result.peerId).state).toBe('online'); return { ...invite, peerId: result.peerId };
  };
  beforeEach(async () => {
    fa = await fixture(); fb = await fixture(); await fa.store.close(); await fb.store.close(); codecA = encryption(); codecB = encryption(); callsA = 0; callsB = 0; nativeB = undefined;
    generateB = async input => input.messages.some(message => message.role === 'model') ? { role: 'model', parts: [{ text: '远端已完成。' }] }
      : { role: 'model', parts: [{ functionCall: { id: 'marker', name: 'node_marker', args: {} } }] };
    await openA(); await openB();
  });
  afterEach(async () => { await Promise.allSettled([a?.close(), b?.close()]); await fa.cleanup(); await fb.cleanup(); });

  test('设备上线事件只响应实际重连，重复状态通知不重复执行，撤销后暂停规则', async () => {
    const paired = await pair();
    const draft = await a.product.draft(); const providerId = await draft.configs.createConfig({ name: '设备事件验证', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', enabled: true, timeout: 1000, contextManagementEnabled: false }); await a.product.save(draft);
    await a.createConversation('owner', '设备恢复任务', 'project', { platformMode: 'chat' }, undefined, { id: 'node-event-chat' });
    const rule = await a.automations.create('owner', { kind: 'event', name: '恢复后检查', objective: '报告设备已恢复。', conversationId: 'node-event-chat', agentId: 'default', providerId,
      event: { trigger: { type: 'node_online', peerId: paired.peerId }, busyPolicy: 'skip', restartPolicy: 'resume' } });
    async function until(condition: (record: any) => boolean) { for (let i = 0; i < 150; i++) { const record = (await a.automations.list('owner')).find(row => row.id === rule.id); if (condition(record)) return record!; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('设备事件状态未达到预期'); }
    expect(rule.recentEvents).toEqual([]); expect(callsA).toBe(0);
    await callA('nodes.disconnect', { id: paired.peerId }); await until(row => row.eventSourceState === 'offline');
    await callA('nodes.connect', { id: paired.peerId }); await until(row => !!row.pendingEvent);
    for (let i = 0; i < 5; i++) a.publish({ type: 'nodes.changed' });
    await a.automations.tick(); const done = await until(row => row.completedRuns === 1 && !row.currentRequestKey);
    expect(done.recentEvents).toHaveLength(1); expect(callsA).toBe(1); expect(callsB).toBe(0);
    await callA('nodes.revoke', { id: paired.peerId }); const stopped = await until(row => row.status === 'paused');
    expect(stopped.error).toContain('撤销');
  });

  test('真实 TLS 配对绑定账号和项目，重试与重启不会再次执行副作用', async () => {
    const paired = await pair(), statusA = a.nodes.status('owner'), statusB = b.nodes.status('owner');
    expect(statusA.nodeId).not.toBe(statusB.nodeId);
    await expect(ra.call({ actorId: 'worker', clientId: 'member' }, 'nodes.status')).rejects.toThrow('Owner');
    const args = { peerId: paired.peerId, requestKey: 'first-job', workspaceId: 'project', agentId: 'default', text: '在远端追加一次文字。', actorId: 'forged', executionNodeId: statusA.nodeId };
    const [run, repeated] = await Promise.all([callA('nodes.tasks.start', args), callA('nodes.tasks.start', args)]);
    expect(repeated.id).toBe(run.id); expect(run).toMatchObject({ actorId: 'worker', workspaceId: 'project', executionNodeId: statusB.nodeId, nodeOrigin: { peerId: paired.peerId, controllerNodeId: statusA.nodeId } });
    expect((await b.runtime.wait(run.id))?.status).toBe('completed'); expect(await readFile(path.join(fb.source, 'node-result.txt'), 'utf8')).toBe('一次\n');
    expect(callsA).toBe(0); expect(callsB).toBe(2);
    await expect(readFile(path.join(fa.source, 'node-result.txt'))).rejects.toThrow();
    const result = await callA('nodes.request', { peerId: paired.peerId, method: 'tasks.get', params: { id: run.id } });
    expect(result.history.messages.at(-1).parts).toEqual([{ text: '远端已完成。' }]);
    await expect(callA('nodes.tasks.start', { ...args, text: '不同的副作用' })).rejects.toThrow('标识');
    await expect(callA('nodes.tasks.start', { ...args, requestKey: 'wrong-workspace', workspaceId: 'missing' })).rejects.toThrow('项目');
    const oldPort = statusB.settings.port; await a.close(); await b.close(); await openB(); await openA(); await b.nodes.activate(); await a.nodes.activate();
    await until(() => a.nodes.status('owner').peers.find(peer => peer.id === paired.peerId)?.state === 'online');
    expect(b.nodes.status('owner').settings.port).toBe(oldPort); expect(b.nodes.status('owner').nodeId).toBe(statusB.nodeId);
    const same = await callA('nodes.tasks.start', args); expect(same.id).toBe(run.id); expect(callsB).toBe(2);
    expect(await readFile(path.join(fb.source, 'node-result.txt'), 'utf8')).toBe('一次\n');
    const saved = await b.storage.getRecord('execution-node', 'local') as any;
    const secret = await b.storage.getRecord('platform-secrets', saved.privateKeyRef) as any; expect(Buffer.from(secret.encrypted).toString()).not.toContain('PRIVATE KEY');
  });

  test('断线保留任务和事件，恢复后补取结果；撤销立即停止此设备的新请求', async () => {
    const paired = await pair(); let release: (() => void) | undefined;
    generateB = async input => { await new Promise<void>(resolve => { release = resolve; input.signal.addEventListener('abort', () => resolve(), { once: true }); }); return { role: 'model', parts: [{ text: '断线期间完成' }] }; };
    const run = await callA('nodes.tasks.start', { peerId: paired.peerId, requestKey: 'offline-task', workspaceId: 'project', agentId: 'default', text: '等待后结束' }); await until(() => release);
    await callA('nodes.disconnect', { id: paired.peerId }); expect((await b.storage.getRun(run.id))?.status).toBe('running');
    await expect(callA('nodes.request', { peerId: paired.peerId, method: 'tasks.get', params: { id: run.id } })).rejects.toThrow('离线');
    release!(); expect((await b.runtime.wait(run.id))?.status).toBe('completed');
    const notifications: Record<string, any>[] = []; const off = a.subscribe(event => { if (event.type === 'nodes.event') notifications.push(event); });
    await until(() => b.nodes.status('owner').peers[0].state === 'offline'); await callA('nodes.connect', { id: paired.peerId });
    await until(() => notifications.some(value => value.notification.event?.type === 'run.completed')); off();
    const events = notifications.flatMap(value => value.notification.event ? [value.notification.event] : []);
    expect(new Set(events.map(event => event.sequence)).size).toBe(events.length);
    const outcome = await callA('nodes.revoke', { id: paired.peerId }); expect(outcome.remoteConfirmed).toBe(true);
    expect(b.nodes.status('owner').peers[0].state).toBe('revoked');
    await expect(callA('nodes.connect', { id: paired.peerId })).rejects.toThrow('不可用'); expect(callsA).toBe(0); expect(callsB).toBe(1);
  });

  test('设备类别恢复重新保护凭据并保留配对身份，撤销后恢复同一旧备份也不能重新连接', async () => {
    const paired = await pair(), originalNodeId = a.nodes.status('owner').nodeId;
    const archive = path.join(fa.root, 'node-data.graycode-backup');
    await new ApplicationBackups(a.storage, { appVersion: '2.0.0-pre', secretCodec: codecA, notify() {} }).export(archive, 'fixture-password');
    await a.close(); const restoredCodec = encryption(), targetPath = path.join(fa.root, 'restored-controller');
    const reopen = async () => { a = await PlatformApplication.open({ dataDirectory: targetPath, documentsDirectory: fa.root, secretCodec: restoredCodec,
      models: { generate: async () => { callsA++; return { role: 'model', parts: [{ text: '恢复后的控制端' }] }; } } }); ra = new ApplicationRouter(a); await configure(a, fa.source); };
    const restore = async () => {
      const backups = new ApplicationBackups(a.storage, { appVersion: '2.0.0-pre', secretCodec: restoredCodec, notify() {} });
      const preview = await backups.prepareRestore(archive, 'fixture-password', { previewOnly: true });
      const selected = await backups.selectRestore({ mode: 'selective', categories: [{ id: 'devices', conflict: 'replace' }], expectedPreview: preview.pending.preview!.fingerprint });
      expect(selected.pending.selection?.items?.some(item => item.dependency && item.category === 'settings')).toBe(true);
      await backups.restore.confirm(); await a.close(); const applied = await backups.restore.apply(); expect(applied.pending).toBeUndefined(); await reopen();
    };
    await reopen(); expect(a.nodes.status('owner').nodeId).not.toBe(originalNodeId); await restore();
    expect(a.nodes.status('owner').nodeId).toBe(originalNodeId); expect(a.nodes.status('owner').peers.find(peer => peer.id === paired.peerId)?.state).toBe('offline');
    await callA('nodes.connect', { id: paired.peerId }); expect(a.nodes.status('owner').peers.find(peer => peer.id === paired.peerId)?.state).toBe('online');
    await callA('nodes.revoke', { id: paired.peerId }); await restore();
    expect(a.nodes.status('owner').peers.find(peer => peer.id === paired.peerId)?.state).toBe('revoked');
    await expect(callA('nodes.connect', { id: paired.peerId })).rejects.toThrow('配对不可用'); expect(callsA).toBe(0); expect(callsB).toBe(0);
  });

  test('配对码单次消费、证书与设备身份校验、权限变化和运行归属检查', async () => {
    const paired = await pair(), invitation = parseInvitation(paired.code);
    const renamed = b.settings.snapshot(); renamed.settings.agents[0].name = '更新后的执行智能体';
    await b.settings.save({ settings: renamed.settings, expectedRevision: renamed.revision });
    await until(() => a.nodes.status('owner').peers[0].capabilities?.agents[0].name === '更新后的执行智能体');
    await expect(postPair(invitation, { nodeId: randomUUID(), name: '其他设备', secret: invitation.secret, requestKey: 'another' })).rejects.toThrow('已被使用');
    const certA = await a.nodes.identity.credentials();
    await expect(postPair({ ...invitation, certificate: certA.certificate }, { nodeId: randomUUID(), name: '证书错误', secret: invitation.secret, requestKey: 'wrong-cert' })).rejects.toThrow();
    const stored = await a.storage.getRecord('node-peers', paired.peerId) as any;
    const token = await a.nodes.identity.credential(stored.credentialRef);
    await expect(openNodeSocket(invitation, paired.peerId, a.nodes.identity.id, token)).rejects.toThrow('403');
    await expect(callA('nodes.request', { peerId: paired.peerId, method: 'computer.windows', params: {} })).rejects.toThrow('电脑操作');
    const localConversation = await b.createConversation('owner', '本机私有任务', 'project');
    generateB = async () => ({ role: 'model', parts: [{ text: '本地完成' }] });
    const local = await b.runtime.start({ actorId: 'owner', conversationId: localConversation.id, workspaceId: 'project', agentId: 'default', requestKey: 'local-only', message: { role: 'user', parts: [{ text: '本机' }] } });
    await b.runtime.wait(local.id);
    await expect(callA('nodes.request', { peerId: paired.peerId, method: 'tasks.get', params: { id: local.id } })).rejects.toThrow('不属于');
    const settings = b.settings.snapshot(); settings.settings.accounts.find(value => value.id === 'worker')!.revoked = true; await b.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await until(() => a.nodes.status('owner').peers[0].state === 'offline');
    const tombs = await b.storage.listRecords('node-revocations'); expect(tombs).toHaveLength(0);
    await callB('nodes.revoke', { id: paired.peerId }); expect(await b.storage.getRecord('node-revocations', paired.peerId)).toMatchObject({ nodeId: a.nodes.identity.id, direction: 'incoming' });
    await until(() => a.nodes.status('owner').peers[0].state === 'revoked');
    expect(await a.storage.getRecord('platform-secrets', stored.credentialRef)).toBeNull();
  });

  test('配对回执丢失后沿用原请求恢复，不创建第二份授权', async () => {
    await callB('nodes.configure', { enabled: true, name: '配对回执验收', host: '127.0.0.1', port: 0 });
    const invite = await callB('nodes.invitation', grant), parsed = parseInvitation(invite.code), requestKey = randomUUID();
    await a.storage.putRecord({ namespace: 'node-pairing-pending', id: nodeHash(parsed.secret), value: { requestKey, createdAt: Date.now() } });
    const first = await postPair(parsed, { nodeId: a.nodes.identity.id, name: '本机', requestKey, secret: parsed.secret });
    const recovered = await callA('nodes.pair', { code: invite.code }); expect(recovered.peerId).toBe(first.peerId);
    expect(b.nodes.status('owner').peers).toHaveLength(1);
    expect(await a.nodes.identity.credential((await a.storage.getRecord('node-peers', first.peerId) as any).credentialRef)).toBe(first.token);
  });

  test('恢复配对前备份时保留后来撤销的设备，删除对应旧凭据', async () => {
    const paired = await pair(); const snapshot = await b.storage.backupSnapshot();
    const original = await b.storage.getRecord('node-peers', paired.peerId) as any;
    await callB('nodes.revoke', { id: paired.peerId }); await b.close();
    await preserveNodeRevocations(fb.data, snapshot.directory);
    const restored = await PlatformApplication.open({ dataDirectory: snapshot.directory, secretCodec: codecB });
    try {
      expect(restored.nodes.status('owner').peers[0].state).toBe('revoked');
      expect(await restored.storage.getRecord('platform-secrets', original.credentialRef)).toBeNull();
      expect((await restored.nodes.identity.credentials()).certificate).toContain('BEGIN CERTIFICATE');
    } finally { await restored.close(); }
  });

  test('远端控制随连接释放，输入回执丢失后跨连接重试仍只执行一次', async () => {
    await b.close(); nativeB = new NodeNativeFixture(); await openB();
    const paired = await pair({ actorId: 'owner', workspaceIds: [], tasks: false, computer: true });
    const control = (method: string, params: Record<string, any> = {}) => callA('nodes.request', { peerId: paired.peerId, method, params });
    expect(await control('capabilities')).toMatchObject({ computer: true, screenshot: true,
      visual: { version: 1, coordinateSpace: 'image', actions: expect.arrayContaining(['click', 'drag', 'type', 'key', 'scroll']) } });
    await control('computer.acquire', { windowIds: ['98'] });
    const observation = await control('computer.observe', { windowId: '98', screenshot: true });
    let release!: () => void; nativeB.holdAction = () => new Promise<void>(resolve => { release = resolve; });
    const args = { observationId: observation.id, action: 'click', coordinateSpace: 'image', x: 50, y: 30, operationId: 'input-once' };
    const sending = control('computer.action', args); const outcome = sending.catch(error => error);
    await until(() => nativeB!.actions.length === 1); await callA('nodes.disconnect', { id: paired.peerId }); release();
    expect((await outcome).message).toContain('结果');
    await until(() => !b.computer.status('owner').active && b.nodes.status('owner').peers[0].state === 'offline');
    await callA('nodes.connect', { id: paired.peerId });
    expect(await control('computer.action', args)).toMatchObject({ performed: true, repeated: true }); expect(nativeB.actions).toHaveLength(1);
    expect(nativeB.actions[0]).toMatchObject({ x: 200, y: 110 });
    await expect(control('computer.action', { ...args, operationId: 'new-input-with-old-frame' })).rejects.toThrow('观察');
    await control('computer.acquire', { windowIds: ['98'] });
    await a.nodes.clientClosed(owner.clientId); expect(b.computer.status('owner').active).toBe(false);
    await b.computer.acquire({ actorId: 'owner', clientId: 'local-controller' }, ['98']);
    await callA('nodes.disconnect', { id: paired.peerId });
    await until(() => b.nodes.status('owner').peers[0].state === 'offline');
    expect(b.computer.status('owner').controller?.clientId).toBe('local-controller');
    await callA('nodes.connect', { id: paired.peerId });
    await control('computer.stop'); expect(b.computer.status('owner').active).toBe(false);
  });

  test('远端模型暂停电脑操作后，由绑定的主人恢复授权再继续原任务', async () => {
    await b.close(); nativeB = new NodeNativeFixture(); await openB();
    const settings = b.settings.snapshot(); settings.settings.agents[0].toolNames = ['computer_control']; settings.settings.agents[0].toolApproval = { computer_control: 'auto' };
    await b.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    const paired = await pair({ actorId: 'owner', workspaceIds: ['project'], tasks: true, computer: true });
    let release: (() => void) | undefined;
    generateB = async input => {
      if (!input.messages.some(message => message.role === 'model')) return { role: 'model', parts: [{ functionCall: { id: 'control', name: 'computer_control', args: { action: 'acquire', windowIds: ['98'] } } }] };
      await new Promise<void>(resolve => { release = resolve; input.signal.addEventListener('abort', () => resolve(), { once: true }); }); return { role: 'model', parts: [{ text: '原任务继续完成。' }] };
    };
    const run = await callA('nodes.tasks.start', { peerId: paired.peerId, requestKey: 'resume-computer', workspaceId: 'project', agentId: 'default', text: '取得验收窗口控制权后等待。' });
    await until(() => release && b.computer.status('owner').controller?.runId === run.id);
    await callA('nodes.request', { peerId: paired.peerId, method: 'computer.stop' });
    expect(await callA('nodes.request', { peerId: paired.peerId, method: 'computer.status' })).toMatchObject({ active: false, pausedRunId: run.id });
    expect((await b.storage.getRun(run.id))?.status).toBe('running');
    await callA('nodes.request', { peerId: paired.peerId, method: 'computer.allowRun', params: { runId: run.id } });
    expect((await callA('nodes.request', { peerId: paired.peerId, method: 'computer.status' })).pausedRunId).toBeUndefined();
    release!(); expect((await b.runtime.wait(run.id))?.status).toBe('completed');
  });
});
