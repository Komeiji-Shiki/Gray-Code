import { buildBranchTitle, buildBranchCustomMetadata, getTextPreviewFromContent } from '../../../../backend/modules/conversation/manager/metadataUtils';
import { randomUUID } from 'node:crypto';
import type { ConversationState, PlatformMessage } from '@graycode/contracts';
import type { PreparedConversationChange } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { CharacterTurn } from '../characters/pipeline';
import type { Content } from '../../../../backend/modules/conversation/types';
import { deleteLogicalMessage, truncateFrom, restoreSummarizedRange } from '../../../../backend/modules/conversation/TranscriptMutation';
import { activePath, switchActivePath, softDeleteNode, restoreNode, renameBranchLabel,
  rebaseActivePathFromHistory, createEmptyBranchGraph, importLinearHistory, removeSubtree } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { assertBranchCapacity, branchMutation, branchNamespace, branchView, groupMessages, materializeBranch, readBranches, type BranchState } from './branches';

export class ConversationService {
  constructor(private readonly app: PlatformApplication) {}
  async read(actorId: string, id: string): Promise<ConversationState> {
    await this.app.conversation(actorId, id);
    return this.app.storage.readConversationState(id, [{ namespace: branchNamespace, id }]);
  }
  private target(state: ConversationState, index: number, messageId: string): void {
    if (!Number.isSafeInteger(index) || index < 0 || !messageId || state.history.messages[index]?.id !== messageId)
      throw new Error('MESSAGE_CHANGED: 消息已变化，请刷新后重试。');
  }
  async idle(actorId: string, id: string, target?: { index: number; messageId: string }): Promise<ConversationState> {
    await this.app.manageConversation(actorId, id);
    let state = await this.read(actorId, id);
    if (target) this.target(state, target.index, target.messageId);
    const runs = await this.app.storage.listRuns({ conversationId: id, activeOnly: true });
    for (const run of runs) { await this.app.runtime.cancel(run.id, actorId); await this.app.runtime.wait(run.id); }
    if (runs.length) state = await this.read(actorId, id);
    if (target) this.target(state, target.index, target.messageId);
    return state;
  }
  private changed(state: ConversationState, messages: PlatformMessage[], reason: string, branch: BranchState): PreparedConversationChange {
    const metadata = structuredClone(state.metadata);
    metadata.custom = { ...(metadata.custom as Record<string, unknown> ?? {}), trimState: null, messageCount: messages.length };
    return { state, commit: { messages, metadata,
      snapshot: { id: randomUUID(), conversationId: state.metadata.id, timestamp: Date.now(), name: reason,
        kind: 'history-mutation', sourceRevision: state.history.revision, conversationMetadata: state.metadata },
      records: [branchMutation(state, branch)] } };
  }
  async commit(change: PreparedConversationChange, preserveWindow = false) {
    const result = await this.app.storage.commitConversation({ conversationId: change.state.metadata.id,
      expectedRevision: change.state.history.revision, expectedMetadataToken: change.state.metadataToken, ...change.commit });
    this.app.productUi.conversations.clearMetadataCache();
    this.app.publish({ type: 'conversation.changed', conversationId: change.state.metadata.id, revision: result.revision, ...(preserveWindow ? { preserveWindow: true } : {}) });
    return { success: true, revision: result.revision, historyLength: result.total, snapshotId: change.commit.snapshot?.id };
  }
  /** 旧子代理明确重试时使用新格式历史，先保留当前运行的快照与分支。 */
  async replaceImportedSubagentHistory(actorId: string, id: string, messages: PlatformMessage[]) {
    const state = await this.read(actorId, id);
    if (!(state.metadata.custom as Record<string, unknown> | undefined)?.platformSubagentId) throw new Error('目标不是独立子代理会话。');
    const branches = readBranches(state);
    branches.graph = messages.length ? rebaseActivePathFromHistory(branches.graph, messages as Content[], { allowRootChange: true }) : createEmptyBranchGraph();
    Object.assign(branches.groups, groupMessages(messages));
    return this.commit(this.changed(state, messages, '从旧子代理记录重试前', branches));
  }
  async remove(actorId: string, id: string, index: number, messageId: string, single: boolean) {
    const state = await this.idle(actorId, id, { index, messageId });
    let history = state.history.messages as Content[];
    for (let cursor = single ? index : history.length - 1; cursor >= index; cursor--) {
      if (history[cursor]?.isSummary) history = restoreSummarizedRange(history, cursor).contents;
    }
    const messages = (single ? deleteLogicalMessage(history, index) : truncateFrom(history, index)) as PlatformMessage[];
    const branches = readBranches(state);
    branches.graph = messages.length ? rebaseActivePathFromHistory(branches.graph, messages as Content[], { allowRootChange: true }) : createEmptyBranchGraph();
    Object.assign(branches.groups, groupMessages(messages));
    // Retained inactive candidates cannot silently restore a deleted summary or response set.
    const retainedIds = new Set(messages.map(message => message.id));
    for (const node of Object.values(branches.graph.nodes)) if (!retainedIds.has(node.id) && state.history.messages.some(message => message.id === node.id)) {
      node.deleted = true; node.deletedAt = Date.now();
    }
    return this.commit(this.changed(state, messages, single ? '删除消息前' : '截断历史前', branches));
  }
  async fork(actorId: string, id: string, index: number, options: { title?: string; conversationId?: string } = {}) {
    const state = await this.read(actorId, id);
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.history.messages.length) throw new Error('分支位置无效。');
    // 模型工具调用与后续结果组成同一组，复制边界不能拆散已经保存的配对。
    let end = index + 1;
    while (state.history.messages[end]?.isFunctionResponse) end++;
    const history = state.history.messages.slice(0, end);
    const pending = new Set<string>();
    for (const message of history) for (const part of message.parts) {
      if (part.functionCall) pending.add((part.functionCall as { id: string }).id);
      if (part.functionResponse) pending.delete((part.functionResponse as { id: string }).id);
    }
    if (pending.size) throw new Error('所选位置仍有未完成的工具调用，请等待结束后复制。');
    const sourceNodeId = history.at(-1)!.isFunctionResponse
      ? [...history].reverse().find(message => message.role === 'model')!.id! : history.at(-1)!.id!;
    const targetId = options.conversationId ?? randomUUID(); const now = Date.now();
    const sourceCustom = state.metadata.custom as Record<string, unknown> | undefined;
    const preview = getTextPreviewFromContent([...history].reverse().find(message => message.role === 'user' && !message.isFunctionResponse) as Content | undefined);
    const title = options.title?.trim() || buildBranchTitle(state.metadata.title, index);
    const custom: Record<string, unknown> = { ...buildBranchCustomMetadata(sourceCustom, id, index, history.length, preview, now, sourceNodeId),
      ...(sourceCustom?.platformMode ? { platformMode: sourceCustom.platformMode } : {}),
      ...(sourceCustom?.characterConfig ? { characterConfig: structuredClone(sourceCustom.characterConfig) } : {}) };
    const branches = readBranches(state);
    branches.graph.exportedRefs = [...(branches.graph.exportedRefs ?? []), { targetConversationId: targetId, nodeId: sourceNodeId, exportedAt: now }];
    const graph = importLinearHistory(history as Content[]); graph.exportedFrom = { conversationId: id, nodeId: sourceNodeId };
    const targetBranch: BranchState = { version: 1, graph, groups: groupMessages(history) };
    for (const node of Object.values(graph.nodes)) { node.parts = []; delete node.contentMetadata; delete node.usageMetadata; }
    const metadata = { id: targetId, title, actorId, createdAt: now, updatedAt: now, workspaceId: state.metadata.workspaceId, workspaceUri: state.metadata.workspaceUri, custom };
    await this.app.storage.forkConversation(id, metadata, { beforeIndex: end, expectedRevision: state.history.revision,
      records: [branchMutation(state, branches), { namespace: branchNamespace, id: targetId, ownerId: targetId, expectedRevision: null, value: targetBranch }] });
    this.app.productUi.conversations.clearMetadataCache(); this.app.publish({ type: 'conversation.changed', conversationId: targetId });
    return { success: true, conversationId: targetId, title, createdAt: now, updatedAt: now, messageCount: history.length, preview, workspaceUri: metadata.workspaceUri, branch: custom.branch };
  }
  async settleCancelled(actorId: string, id: string, index: number, toolCallIds: string[]) {
    const state = await this.idle(actorId, id);
    const model = state.history.messages[index];
    if (!model || model.role !== 'model') return { success: true };
    const paired = new Set(state.history.messages.flatMap(message => message.parts.flatMap(part => part.functionResponse ? [(part.functionResponse as { id: string }).id] : [])));
    const selected = new Set(toolCallIds);
    const calls = model.parts.flatMap(part => part.functionCall ? [part.functionCall as { id: string; name: string }] : []).filter(call => selected.has(call.id) && !paired.has(call.id));
    if (!calls.length) return { success: true };
    const messages = structuredClone(state.history.messages);
    const responses: PlatformMessage[] = calls.map(call => ({ id: randomUUID(), role: 'user', isFunctionResponse: true, timestamp: Date.now(),
      parts: [{ functionResponse: { id: call.id, name: call.name, response: { success: false, code: 'CANCELLED', error: '用户取消了尚未完成的工具调用。' } } }] }));
    let insert = index + 1; while (messages[insert]?.isFunctionResponse) insert++;
    messages.splice(insert, 0, ...responses);
    for (let cursor = 0; cursor < messages.length; cursor++) { messages[cursor].index = cursor; messages[cursor].parentId = messages[cursor - 1]?.id ?? null; }
    const branches = readBranches(state); branches.graph = rebaseActivePathFromHistory(branches.graph, messages as Content[]); Object.assign(branches.groups, groupMessages(messages));
    return this.commit(this.changed(state, messages, '结算已取消工具前', branches));
  }
  async graph(actorId: string, id: string) {
    const config = this.app.product.runtimeSettings().getCheckpointConfig();
    const branches = await this.withCheckpoints(actorId, id, readBranches(await this.read(actorId, id)));
    return { graph: branchView(branches, new Set([...config.beforeTools, ...config.afterTools])) };
  }
  private async withCheckpoints(actorId: string, id: string, branches: BranchState) {
    // 较早独立版的检查点已保存消息归属，按该归属补齐尚未记录的分支绑定。
    for (const checkpoint of (await this.app.checkpoints.list(actorId, id)).reverse()) {
      const node = branches.graph.nodes[checkpoint.messageNodeId ?? ''];
      if (node && !node.workspaceCheckpointId) { node.workspaceCheckpointId = checkpoint.id; node.workspaceState = 'checkpointed'; }
    }
    return branches;
  }
  async switch(actorId: string, id: string, nodeId: string, mode: string, options: { confirmedDiscardDirty?: boolean; confirmedDirtyFiles?: string[] } = {}) {
    await this.app.manageConversation(actorId, id);
    if (!['chat-only', 'chat-and-workspace'].includes(mode)) throw new Error('未知的分支切换模式。');
    const state = await this.read(actorId, id);
    const branches = readBranches(state);
    branches.graph = switchActivePath(branches.graph, nodeId);
    const messages = materializeBranch(branches);
    const change = this.changed(state, messages, '切换分支前', branches);
    if (mode === 'chat-and-workspace') {
      // 原分支绑定哪个存档就恢复哪个，不能把其他节点的最新存档当成目标状态。
      const checkpointId = branches.graph.nodes[nodeId]?.workspaceCheckpointId;
      if (!checkpointId) throw new Error('目标分支没有绑定工作区存档，可选择只切换聊天。');
      return this.app.checkpoints.restore(actorId, id, checkpointId, options, change);
    }
    return this.commit(change);
  }
  async changeCandidate(actorId: string, id: string, nodeId: string, action: 'delete' | 'restore' | 'rename', label?: string) {
    await this.app.manageConversation(actorId, id);
    const state = await this.read(actorId, id);
    const branches = readBranches(state);
    if (action === 'delete') {
      if (activePath(branches.graph).includes(nodeId)) throw new Error('不能删除当前活跃分支，请先切换到其他候选。');
      branches.graph = softDeleteNode(branches.graph, nodeId, { deletedAt: Date.now() });
    } else if (action === 'restore') branches.graph = restoreNode(branches.graph, nodeId);
    else {
      const normalized = label?.trim() ?? '';
      if (!normalized || normalized.length > 200) throw new Error('分支名称需要 1 至 200 个字符。');
      branches.graph = renameBranchLabel(branches.graph, nodeId, normalized);
    }
    const result = await this.app.storage.commitConversation({ conversationId: id, expectedRevision: state.history.revision,
      expectedMetadataToken: state.metadataToken, records: [branchMutation(state, branches)] });
    this.app.publish({ type: 'conversation.changed', conversationId: id });
    return { success: true, revision: result.revision };
  }
  async reroll(actorId: string, id: string, targetId: string | undefined, requestKey: string): Promise<PreparedConversationChange> {
    const initial = await this.read(actorId, id);
    const target = targetId ?? [...initial.history.messages].reverse().find(message => message.role === 'model')?.id;
    const index = initial.history.messages.findIndex(message => message.id === target);
    if (index < 1 || initial.history.messages[index].role !== 'model') throw new Error('重试目标不是当前历史中的模型消息。');
    const state = await this.idle(actorId, id, { index, messageId: initial.history.messages[index].id! });
    const branches = readBranches(state);
    assertBranchCapacity(branches, branches.graph.nodes[state.history.messages[index].id!].parentId!);
    const messages = truncateFrom(state.history.messages as Content[], index) as PlatformMessage[];
    branches.graph = rebaseActivePathFromHistory(branches.graph, messages as Content[]);
    branches.pendingKind = { parentId: branches.graph.activeTailNodeId!, kind: 'reroll', requestKey };
    return this.changed(state, messages, '重新生成前', branches);
  }
  async edit(actorId: string, id: string, targetId: string, parts: PlatformMessage['parts'], requestKey: string, mode: 'keep' | 'branch',
    options: { preserveAttachments?: boolean; deepSeekVisionTileSplit?: boolean } = {}) {
    const initial = await this.read(actorId, id);
    const index = initial.history.messages.findIndex(message => message.id === targetId);
    if (index < 0 || initial.history.messages[index].role !== 'user' || initial.history.messages[index].isFunctionResponse) throw new Error('编辑目标不是用户消息。');
    const state = await this.idle(actorId, id, { index, messageId: targetId });
    const branches = readBranches(state);
    const messages = structuredClone(state.history.messages);
    const original = messages[index];
    const nextParts = structuredClone(options.preserveAttachments ? [...original.parts.filter(part => part.inlineData), ...parts] : parts);
    if (!nextParts.length) throw new Error('请输入消息或保留附件。');
    const visionMode = options.deepSeekVisionTileSplit ?? original.deepSeekVisionTileSplit;
    const edited = { ...original, parts: nextParts, tokenCountByChannel: {},
      ...(typeof visionMode === 'boolean' ? { deepSeekVisionTileSplit: visionMode } : {}) };
    if (mode === 'keep') {
      const turn = original.characterTurn as CharacterTurn | undefined;
      if (turn) {
        const source = await this.app.characterPipeline.transformParts(nextParts, turn, 1, 'source', undefined, true);
        const display = await this.app.characterPipeline.transformParts(source.parts, turn, 1, 'display', undefined, true);
        Object.assign(edited, { parts: source.parts, characterOriginalParts: nextParts, characterDisplayParts: display.parts,
          characterStages: source.stages, characterDisplayStages: display.stages });
      }
      messages[index] = edited;
      branches.groups[targetId] = [edited];
      return { change: this.changed(state, messages, '编辑消息前', branches), message: undefined };
    }
    const prefix = truncateFrom(messages as Content[], index) as PlatformMessage[];
    assertBranchCapacity(branches, branches.graph.nodes[targetId].parentId ?? targetId);
    // Original root editing keeps the root ID; other edits create a sibling user candidate.
    const message = { role: 'user', id: index === 0 ? targetId : randomUUID(), parts: nextParts,
      ...(typeof visionMode === 'boolean' ? { deepSeekVisionTileSplit: visionMode } : {}) };
    if (prefix.length) branches.graph = rebaseActivePathFromHistory(branches.graph, prefix as Content[]);
    branches.pendingKind = index === 0
      ? { parentId: targetId, kind: 'reroll', requestKey }
      : { parentId: branches.graph.activeTailNodeId ?? '', kind: 'edit', requestKey, messageId: message.id };
    return { change: this.changed(state, prefix, '编辑并重新生成前', branches), message };
  }
  async purgeCandidate(actorId: string, id: string, nodeId: string) {
    await this.app.manageConversation(actorId, id);
    const state = await this.read(actorId, id);
    const branches = await this.withCheckpoints(actorId, id, readBranches(state));
    const node = branches.graph.nodes[nodeId];
    if (!node) return { success: true, nodeId, purged: false, prunedNodeCount: 0 };
    if (!node.deleted) throw new Error('请先软删除这个候选，再选择彻底删除。');
    const removed = removeSubtree(branches.graph, nodeId);
    const checkpoints = new Set(removed.prunedNodeIds.map(id => branches.graph.nodes[id]?.workspaceCheckpointId).filter(Boolean));
    branches.graph = removed.graph;
    await this.app.storage.commitConversation({ conversationId: id, expectedRevision: state.history.revision,
      expectedMetadataToken: state.metadataToken, records: [branchMutation(state, branches)] });
    this.app.publish({ type: 'conversation.changed', conversationId: id });
    for (const checkpoint of await this.app.checkpoints.list(actorId, id)) {
      if (!checkpoints.has(checkpoint.id) && !removed.prunedNodeIds.includes(checkpoint.messageNodeId ?? '')) continue;
      try { await this.app.checkpoints.delete(actorId, id, checkpoint.id); }
      catch (error) { this.app.publish({ type: 'workspace.checkpoint.warning', conversationId: id, error: String(error) }); }
    }
    return { success: true, nodeId, purged: true, prunedNodeCount: removed.prunedNodeIds.length };
  }
  async restoreSnapshot(actorId: string, id: string, snapshotId: string, expectedRevision: number) {
    await this.app.manageConversation(actorId, id);
    const state = await this.read(actorId, id);
    if (state.history.revision !== expectedRevision) throw new Error('历史已变化，请刷新后再恢复快照。');
    const snapshot = await this.app.storage.getSnapshot(snapshotId);
    if (!snapshot || snapshot.conversationId !== id) throw new Error('快照不属于当前对话。');
    const branches = readBranches(state);
    branches.graph = snapshot.history.length ? rebaseActivePathFromHistory(branches.graph, snapshot.history as Content[], { allowRootChange: true }) : createEmptyBranchGraph();
    Object.assign(branches.groups, groupMessages(snapshot.history));
    return this.commit(this.changed(state, snapshot.history, '恢复快照前', branches));
  }
}
