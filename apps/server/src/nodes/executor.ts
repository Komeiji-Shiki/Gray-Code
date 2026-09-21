import { AsyncLocalStorage } from 'node:async_hooks';
import { validateRpcParams } from '@graycode/contracts';
import type { NodeCapabilities, NodeGrant, NodeTaskInput, NodeTaskDiff, RunRecord, ToolEffect, ComputerAction } from '@graycode/contracts';
import { authorizeEffects } from '@graycode/core';
import type { PlatformApplication } from '../application';
import { nodeHash, nodeText } from './identity';
import type { NodePeer, NodeRegistry } from './registry';
import type { NodeWire } from './wire';
import type { WorkspaceDiff } from '../workspace/diffs';

interface NodeRequestRecord { fingerprint: string; conversationId: string; createdAt: number }
export class NodeExecutor {
  private readonly origin = new AsyncLocalStorage<RunRecord['nodeOrigin']>();
  private readonly starts = new Map<string, Promise<RunRecord>>();
  constructor(private readonly app: PlatformApplication, private readonly registry: NodeRegistry, private readonly online: (id: string) => boolean) {}
  currentOrigin() { return this.origin.getStore(); }
  runInScope<T>(run: RunRecord, action: () => T) { return this.origin.run(run.nodeOrigin, action); }
  validateGrant(grant: NodeGrant) {
    if (!grant || typeof grant.tasks !== 'boolean' || typeof grant.computer !== 'boolean' || !Array.isArray(grant.workspaceIds) || grant.workspaceIds.length > 100 || !grant.tasks && !grant.computer) throw new Error('请选择任务或电脑操作权限，以及对应的账号和项目。');
    const actor = this.app.actor(grant.actorId); if (!actor) throw new Error('配对使用的账号已不可用。');
    if (grant.tasks && !grant.workspaceIds.length) throw new Error('允许执行任务时，至少选择一个项目。');
    for (const id of grant.workspaceIds) this.app.workspace(grant.actorId, id, []);
    if (grant.computer) { const error = authorizeEffects(actor, ['desktop_control']); if (error) throw new Error(error); }
  }
  private authorized(peer: NodePeer) {
    const current = this.registry.peers.get(peer.id);
    if (!current || current.revokedAt || current.direction !== 'incoming') throw new Error('设备配对已撤销。');
    this.validateGrant(current.grant); return current;
  }
  capabilities(peer: NodePeer): NodeCapabilities {
    peer = this.authorized(peer); const actor = this.app.actor(peer.grant.actorId)!;
    const computer = peer.grant.computer ? this.app.computer.status(actor.id) : undefined;
    return { nodeId: this.registry.identity.id, name: this.registry.identity.settings.name, protocol: 1, platform: process.platform,
      account: { id: actor.id, displayName: actor.displayName, role: actor.role },
      workspaces: peer.grant.workspaceIds.map(id => { const value = this.app.workspace(actor.id, id, []); return { id, name: value.name, directory: value.directory }; }),
      agents: this.app.settings.snapshot().settings.agents.map(agent => ({ id: agent.id, name: agent.name })),
      tasks: peer.grant.tasks, computer: !!computer?.available, screenshot: !!computer?.screenshotAvailable };
  }
  async checkRun(run: RunRecord, effects: ToolEffect[] = []) {
    if (!run.nodeOrigin) return;
    const peer = this.registry.peers.get(run.nodeOrigin.peerId);
    if (!peer) throw new Error('发起任务的设备配对不存在。');
    this.authorized(peer);
    if (!peer.grant.tasks || run.actorId !== peer.grant.actorId || !run.workspaceId || !peer.grant.workspaceIds.includes(run.workspaceId)) throw new Error('设备任务的账号或项目授权已改变。');
    if (effects.includes('desktop_control') && (!peer.grant.computer || !this.online(peer.id))) throw new Error('发起设备没有电脑操作权限，或连接已经断开。');
  }
  private async ownRun(peer: NodePeer, id: string) {
    const run = await this.app.storage.getRun(nodeText(id, '任务标识'));
    if (!run || run.nodeOrigin?.peerId !== peer.id || run.nodeOrigin.controllerNodeId !== peer.nodeId || run.actorId !== peer.grant.actorId) throw new Error('此任务不属于当前配对设备。');
    return run;
  }
  start(peer: NodePeer, input: NodeTaskInput) {
    const key = nodeHash(`${peer.id}:${nodeText(input.requestKey, '任务请求标识')}`);
    const pending = this.starts.get(key);
    // 相同标识但参数不同的并发请求也必须进入持久记录校验。
    const next = (pending ? pending.catch(() => {}).then(() => this.startOnce(peer, input, key)) : this.startOnce(peer, input, key));
    this.starts.set(key, next); void next.finally(() => { if (this.starts.get(key) === next) this.starts.delete(key); }).catch(() => {}); return next;
  }
  private async startOnce(peer: NodePeer, input: NodeTaskInput, key: string): Promise<RunRecord> {
    peer = this.authorized(peer);
    if (!peer.grant.tasks || !peer.grant.workspaceIds.includes(input.workspaceId)) throw new Error('配对设备没有所选项目的任务权限。');
    this.app.workspace(peer.grant.actorId, input.workspaceId, []);
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 200_000) throw new Error('请输入有效任务内容，最多 200000 字符。');
    const agentId = nodeText(input.agentId, '智能体');
    const normalized = { workspaceId: input.workspaceId, agentId, text: input.text, conversationId: input.conversationId ?? null };
    const fingerprint = nodeHash(JSON.stringify(normalized));
    let record = await this.app.storage.getRecord('node-task-requests', key) as NodeRequestRecord | null;
    if (record && record.fingerprint !== fingerprint) throw new Error('此任务请求标识已用于其他内容，请检查原请求。');
    if (!record) {
      let conversationId = input.conversationId;
      if (conversationId) {
        const conversation = await this.app.conversation(peer.grant.actorId, conversationId);
        const origin = await this.app.storage.getRecord('node-conversations', conversationId) as RunRecord['nodeOrigin'];
        if (origin?.peerId !== peer.id || conversation.workspaceId !== input.workspaceId) throw new Error('只能继续当前设备在原项目中创建的对话。');
      } else conversationId = `node-${key}`;
      record = { fingerprint, conversationId, createdAt: Date.now() };
      await this.app.storage.commitRecords([{ namespace: 'node-task-requests', id: key, ownerId: peer.id, value: record, expectedRevision: null }]);
    }
    const requestKey = `node-${key}`, existing = await this.app.storage.getRunByRequestKey(requestKey);
    if (existing) return this.ownRun(peer, existing.id);
    if (!await this.app.storage.getConversation(record.conversationId)) await this.app.createConversation(peer.grant.actorId, input.text.slice(0, 80), input.workspaceId,
      { nodeOrigin: { peerId: peer.id, controllerNodeId: peer.nodeId }, executionNodeId: this.registry.identity.id }, undefined,
      { id: record.conversationId, records: [{ namespace: 'node-conversations', id: record.conversationId, ownerId: peer.id, value: { peerId: peer.id, controllerNodeId: peer.nodeId }, expectedRevision: null }] });
    this.authorized(peer);
    return this.app.runtime.start({ actorId: peer.grant.actorId, requestKey, conversationId: record.conversationId, workspaceId: input.workspaceId, agentId,
      message: { role: 'user', parts: [{ text: input.text }] } }, undefined, { nodeOrigin: { peerId: peer.id, controllerNodeId: peer.nodeId } });
  }
  async request(peer: NodePeer, wire: NodeWire, method: string, params: Record<string, any>, connectionId: string) {
    peer = this.authorized(peer); wire.signal.throwIfAborted();
    if (method === 'capabilities') return this.capabilities(peer);
    if (method === 'tasks.start') return this.start(peer, params as NodeTaskInput);
    if (method === 'tasks.list') {
      const ids = await this.app.storage.listRecords('node-task-requests', peer.id), runs: RunRecord[] = [];
      for (const id of ids) { const run = await this.app.storage.getRunByRequestKey(`node-${id}`); if (run) runs.push(run); }
      return runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    }
    if (method.startsWith('tasks.')) {
      const run = await this.ownRun(peer, params.id);
      if (method === 'tasks.get') return { run, history: await this.app.storage.readHistory(run.conversationId, { limit: 200 }),
        approvals: this.app.runtime.pendingApprovals().filter(value => value.runId === run.id), questions: this.app.runtime.pendingQuestions().filter(value => value.runId === run.id),
        diffs: await this.pendingDiffs(run) };
      if (method === 'tasks.events') return this.app.storage.readRunEvents(run.id, params.afterSequence ?? 0, 500);
      if (method === 'tasks.cancel') { await this.app.runtime.cancel(run.id, peer.grant.actorId); return { success: true }; }
      if (method === 'tasks.approve') {
        if (!this.app.runtime.pendingApprovals().some(value => value.runId === run.id && value.id === params.approvalId)) throw new Error('审批不属于所选任务，或已处理。');
        await this.app.runtime.resolveApproval(params.approvalId, peer.grant.actorId, params.accepted === true, params.choiceId); return { success: true };
      }
      if (method === 'tasks.answer') {
        if (!this.app.runtime.pendingQuestions().some(value => value.runId === run.id && value.id === params.questionId)) throw new Error('问题不属于所选任务，或已结束。');
        if (!Array.isArray(params.answers) || params.answers.some((value: unknown) => typeof value !== 'string')) throw new Error('回答格式无效。');
        await this.app.runtime.answerQuestion(params.questionId, peer.grant.actorId, params.answers); return { success: true };
      }
      if (method === 'tasks.diff' || method === 'tasks.resolveDiff') {
        const value = await this.app.storage.getRecord('workspace-diffs', nodeText(params.diffId, '文件修改标识')) as WorkspaceDiff | null;
        if (!value || value.runId !== run.id || value.conversationId !== run.conversationId || value.workspaceId !== run.workspaceId) throw new Error('文件修改不属于此远端任务。');
        if (method === 'tasks.diff') return this.app.diffs.content(peer.grant.actorId, value.id);
        await this.checkRun(run, ['workspace_write']);
        await this.app.diffs.resolve(peer.grant.actorId, value.id, params.accepted === true); return { success: true };
      }
    }
    if (method.startsWith('computer.')) {
      if (!peer.grant.computer) throw new Error('此配对未允许电脑操作，请在执行设备上重新授权。');
      validateRpcParams(method, params);
      const viewId = nodeText(params.viewId, '控制客户端标识', 100);
      const identity = { actorId: peer.grant.actorId, clientId: `node:${peer.id}:${viewId}`, signal: wire.signal };
      // 远程图像上的动作必须使用原观察；本地面板的自动聚焦会更换观察，不能用于远程输入。
      if (method === 'computer.action') return this.app.computer.action(identity, params as ComputerAction, params.operationId, false, 10_000);
      if (method === 'computer.observe') return this.app.computer.observe(identity, params as any);
      if (method === 'computer.display') return this.app.computer.display(identity, params as any);
      if (method === 'computer.windows') return this.app.computer.windows(identity);
      if (method === 'computer.acquire') { await this.app.computer.acquire(identity, params.windowIds ?? []); return this.computerStatus(peer); }
      if (method === 'computer.release') { await this.app.computer.stop(identity.actorId, 'released', identity); return this.computerStatus(peer); }
      if (method === 'computer.stop') { await this.app.computer.stop(identity.actorId, 'remote_stop'); return this.computerStatus(peer); }
      if (method === 'computer.status') return this.computerStatus(peer);
      if (method === 'computer.allowRun') { await this.ownRun(peer, params.runId); return this.app.computer.call(identity, method, params); }
    }
    throw new Error('执行节点不支持此操作。');
  }
  async disconnected(peerId: string, reason = 'node_disconnected') {
    const runs = (await this.app.storage.listRuns({ activeOnly: true, limit: 1000 })).filter(run => run.nodeOrigin?.peerId === peerId);
    await this.app.computer.nodeDisconnected(peerId, runs.map(run => run.id), reason);
  }
  private async computerStatus(peer: NodePeer) {
    const status = this.app.computer.status(peer.grant.actorId);
    if (status.pausedRunId) {
      const run = await this.app.storage.getRun(status.pausedRunId);
      if (run?.nodeOrigin?.peerId !== peer.id || run.actorId !== peer.grant.actorId) delete status.pausedRunId;
    }
    return status;
  }
  private async pendingDiffs(run: RunRecord) {
    const result: NodeTaskDiff[] = [];
    for (const id of await this.app.storage.listRecords('workspace-diffs', run.conversationId)) {
      const value = await this.app.storage.getRecord('workspace-diffs', id) as WorkspaceDiff;
      if (value.status === 'pending' && value.runId === run.id) result.push({ id, path: value.path, status: value.status, warning: value.diffGuardWarning });
    }
    return result;
  }
  async revoked(peerId: string, reason = 'pair_revoked') {
    for (const run of await this.app.storage.listRuns({ activeOnly: true, limit: 1000 })) if (run.nodeOrigin?.peerId === peerId) this.app.runtime.interrupt(run.id, new Error('发起设备的配对或权限已撤销。'));
    await this.disconnected(peerId, reason);
  }
}
