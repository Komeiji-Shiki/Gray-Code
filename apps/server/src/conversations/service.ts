import { buildBranchTitle, buildBranchCustomMetadata, getTextPreviewFromContent } from '../../../../backend/modules/conversation/manager/metadataUtils';
import { randomUUID } from 'node:crypto';
import type { ConversationState, ConversationUiMetadata, ConversationUiSummary, PageOptions, PlatformConversation, PlatformMessage } from '@graycode/contracts';
import { PlatformStorageError, type PreparedConversationChange } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { CharacterTurn } from '../characters/pipeline';
import type { Content } from '../../../../backend/modules/conversation/types';
import { deleteLogicalMessage, truncateFrom, restoreSummarizedRange } from '../../../../backend/modules/conversation/TranscriptMutation';
import { activePath, switchActivePath, softDeleteNode, restoreNode, renameBranchLabel,
  rebaseActivePathFromHistory, createEmptyBranchGraph, importLinearHistory, removeSubtree } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { assertBranchCapacity, branchMutation, branchNamespace, branchView, groupMessages, materializeBranch, readBranches,
  readBranchPreview, type BranchPreviewState, type BranchState } from './branches';
import { BRANCH_MESSAGE_PROJECTION, BRANCH_RECORD_PROJECTION } from './branchPreview';
import { findMessagePosition, readDisplayMessagesPaged, readMessageMarkers, readRepairedHistory } from './historyView';

export class ConversationService {
  constructor(private readonly app: PlatformApplication) {}
  async read(actorId: string, id: string): Promise<ConversationState> {
    await this.app.conversation(actorId, id);
    return this.app.storage.readConversationState(id, [{ namespace: branchNamespace, id }]);
  }
  async listIds(actorId: string): Promise<string[]> {
    this.app.requireOwner(actorId);
    const hidden = this.app.subagents.childConversationIds();
    const ids: string[] = [];
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = await this.app.storage.listConversationIds({ limit: 1000, cursor });
      for (const id of page.ids) if (!hidden.has(id)) ids.push(id);
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  }
  async metadata(actorId: string, id: string): Promise<ConversationUiMetadata | null> {
    if (!this.app.actor(actorId)) throw new Error('Account is unavailable.');
    const info = await this.app.storage.getConversationInfo(id);
    if (!info) return null;
    await this.app.conversation(actorId, id);
    return {
      ...info.metadata,
      custom: { ...info.metadata.custom, messageCount: info.messageCount },
    };
  }
  async customMetadata(actorId: string, id: string, key: string): Promise<unknown> {
    const metadata = await this.metadata(actorId, id);
    return metadata?.custom?.[key];
  }
  async summaries(actorId: string, conversationIds: string[]): Promise<ConversationUiSummary[]> {
    this.app.requireOwner(actorId);
    const all = Array.isArray(conversationIds) ? conversationIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    const truncated = all.length > 200;
    const ids = all.slice(0, 200);
    if (!ids.length) return [];
    const uniqueIds = [...new Set(ids)];
    const page = await this.app.storage.listConversations({ ids: uniqueIds, limit: uniqueIds.length });
    const byId = new Map(page.items.map(item => [item.id, item]));
    const result: ConversationUiSummary[] = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) continue;
      result.push({
        id: item.id,
        title: typeof item.title === 'string' && item.title.trim() ? item.title : `Chat ${item.id.slice(0, 8)}`,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        messageCount: item.messageCount,
        ...(item.preview !== undefined ? { preview: item.preview } : {}),
        ...(item.workspaceUri !== undefined ? { workspaceUri: item.workspaceUri } : {}),
      });
    }
    if (truncated) (result as ConversationUiSummary[] & { truncated?: boolean }).truncated = true;
    return result;
  }
  /**
   * 基于 metadataToken 的 CAS 版本化更新。
   * 并发写入（如自动总结提交或连续设置修改）发生冲突时自动重读最新元数据并重新应用变更。
   */
  async updateMetadata(
    actorId: string,
    id: string,
    mutate: (metadata: PlatformConversation, info: { messageCount: number; historyRevision: number }) => PlatformConversation | null | Promise<PlatformConversation | null>,
  ): Promise<PlatformConversation> {
    await this.app.manageConversation(actorId, id);
    for (let attempt = 0; attempt < 8; attempt++) {
      const info = await this.app.storage.getConversationInfo(id);
      if (!info) throw new Error(`Conversation ${id} has been deleted or does not exist.`);
      const current = structuredClone(info.metadata);
      const next = await mutate(current, { messageCount: info.messageCount, historyRevision: info.historyRevision });
      if (next === null) return info.metadata;
      try {
        await this.app.storage.saveMetadata(next, { expectedMetadataToken: info.metadataToken });
        return next;
      } catch (error) {
        if (!(error instanceof PlatformStorageError) || error.code !== 'REVISION_CONFLICT' || attempt === 7) throw error;
      }
    }
    throw new Error('Conversation metadata changed concurrently.');
  }
  async rename(actorId: string, id: string, title: string) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 300) throw new Error('对话标题需要 1 至 300 个字符。');
    const normalized = title.trim();
    await this.updateMetadata(actorId, id, metadata => {
      if (metadata.title === normalized) return null;
      return { ...metadata, title: normalized, updatedAt: Date.now() };
    });
    this.app.publish({ type: 'conversation.changed', conversationId: id, metadataOnly: true });
    return { success: true };
  }
  async setCustomMetadata(actorId: string, id: string, key: string, value: unknown) {
    await this.updateMetadata(actorId, id, metadata => ({
      ...metadata,
      updatedAt: Date.now(),
      custom: { ...(metadata.custom as Record<string, unknown> ?? {}), [key]: value },
    }));
    return { success: true };
  }
  async updateCustomMetadata<T>(actorId: string, id: string, key: string, updater: (current: unknown) => T | Promise<T>): Promise<T> {
    let resolved!: T;
    await this.updateMetadata(actorId, id, async metadata => {
      const custom = { ...(metadata.custom as Record<string, unknown> ?? {}) };
      const current = custom[key];
      resolved = await updater(current);
      if (resolved === current) return null;
      custom[key] = resolved;
      return { ...metadata, updatedAt: Date.now(), custom };
    });
    return resolved;
  }
  async updateSummary(actorId: string, id: string, summary: { messageCount?: number; preview?: string }) {
    // 列表摘要更新不移动 updatedAt，消息条数以存储已提交的真实计数为准。
    await this.updateMetadata(actorId, id, (metadata, info) => {
      const custom = { ...(metadata.custom as Record<string, unknown> ?? {}) };
      if (summary.messageCount !== undefined) custom.messageCount = info.messageCount;
      if (summary.preview !== undefined) custom.preview = summary.preview;
      return { ...metadata, custom };
    });
    return { success: true };
  }
  async rawHistory(actorId: string, id: string): Promise<Content[]> {
    if (!this.app.actor(actorId)) throw new Error('Account is unavailable.');
    const existing = await this.app.findConversation(actorId, id);
    if (!existing) return [];
    return await readRepairedHistory(this.app.storage, id) ?? [];
  }
  async messagesPaged(actorId: string, id: string, options: PageOptions = {}): Promise<{ total: number; messages: Content[] }> {
    if (!this.app.actor(actorId)) throw new Error('Account is unavailable.');
    const existing = await this.app.findConversation(actorId, id);
    if (!existing) return { total: 0, messages: [] };
    return readDisplayMessagesPaged(this.app.storage, id, options);
  }
  async messageMarkers(actorId: string, id: string) {
    await this.app.conversation(actorId, id);
    return readMessageMarkers(this.app.storage, id);
  }
  async messagePosition(actorId: string, id: string, messageId: string) {
    await this.app.conversation(actorId, id);
    return findMessagePosition(this.app.storage, id, messageId);
  }
  private target(messages: ReadonlyArray<Pick<PlatformMessage, 'id'>>, index: number, messageId: string): void {
    if (!Number.isSafeInteger(index) || index < 0 || !messageId || messages[index]?.id !== messageId)
      throw new Error('MESSAGE_CHANGED: 消息已变化，请刷新后重试。');
  }
  async idle(actorId: string, id: string, target?: { index: number; messageId: string }): Promise<ConversationState> {
    await this.app.manageConversation(actorId, id);
    const runs = await this.app.storage.listRuns({ conversationId: id, activeOnly: true });
    // 取消前只校验目标身份；运行停止后再读取一次完整状态，保留清理期间追加的结果。
    if (runs.length && target) this.target((await this.app.storage.readHistoryOutline(id)).entries, target.index, target.messageId);
    for (const run of runs) { await this.app.runtime.cancel(run.id, actorId); await this.app.runtime.wait(run.id); }
    const state = await this.read(actorId, id);
    if (target) this.target(state.history.messages, target.index, target.messageId);
    return state;
  }
  private changed(state: ConversationState, messages: PlatformMessage[], reason: string, branch: BranchState): PreparedConversationChange {
    const metadata = structuredClone(state.metadata);
    metadata.custom = { ...(metadata.custom as Record<string, unknown> ?? {}), trimState: null, messageCount: messages.length };
    return { state, commit: { messages, metadata,
      snapshot: { id: randomUUID(), conversationId: state.metadata.id, timestamp: Date.now(), name: reason,
        kind: 'history-mutation', sourceRevision: state.history.revision, conversationMetadata: state.metadata },
      records: [branchMutation(state, branch, messages)] } };
  }
  async commit(change: PreparedConversationChange, preserveWindow = false) {
    const result = await this.app.storage.commitConversation({ conversationId: change.state.metadata.id,
      expectedRevision: change.state.history.revision, expectedMetadataToken: change.state.metadataToken, ...change.commit });
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
    const originalIds = new Set(state.history.messages.map(message => message.id));
    for (const node of Object.values(branches.graph.nodes)) if (!retainedIds.has(node.id) && originalIds.has(node.id)) {
      node.deleted = true; node.deletedAt = Date.now();
      // 截断会同时删除相邻节点，保留活动指针会让下次读取把归档候选判为损坏。
      node.activeChildId = null;
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
    // 分支副本的当前正文随共享历史一起提交，无需在图记录中再次保存。
    const targetBranch: BranchState = { version: 1, graph, groups: {} };
    for (const node of Object.values(graph.nodes)) { node.parts = []; delete node.contentMetadata; delete node.usageMetadata; }
    const metadata = { id: targetId, title, actorId, createdAt: now, updatedAt: now, workspaceId: state.metadata.workspaceId, workspaceUri: state.metadata.workspaceUri, custom };
    await this.app.storage.forkConversation(id, metadata, { beforeIndex: end, expectedRevision: state.history.revision,
      records: [branchMutation(state, branches, state.history.messages), { namespace: branchNamespace, id: targetId, ownerId: targetId, expectedRevision: null, value: targetBranch }] });
    this.app.publish({ type: 'conversation.changed', conversationId: targetId });
    return { success: true, conversationId: targetId, title, createdAt: now, updatedAt: now, messageCount: history.length, preview, workspaceUri: metadata.workspaceUri, branch: custom.branch };
  }
  async settleCancelled(actorId: string, id: string, index: number, toolCallIds: string[]) {
    const state = await this.idle(actorId, id);
    const model = state.history.messages[index];
    if (!model || model.role !== 'model') return { success: true };
    const paired = new Set(state.history.messages.flatMap(message => message.parts.flatMap(part => part.functionResponse ? [(part.functionResponse as { id: string }).id] : [])));
    const selected = new Set(toolCallIds);
    const detached = new Set(this.app.runtime.pendingAsyncToolCalls(id));
    // 已进入持久反馈队列的原生结果还未追加历史时，也不能再补取消占位。
    const queued = await Promise.all((await this.app.subagents.feedback.pendingIds(id)).map(key => this.app.storage.getRecord('subagent-feedback', key)));
    for (const record of queued) {
      const message = (record as { message: PlatformMessage } | null)?.message;
      for (const part of message?.parts ?? []) if (part.functionResponse) detached.add((part.functionResponse as { id: string }).id);
    }
    const calls = model.parts.flatMap(part => part.functionCall ? [part.functionCall as { id: string; name: string }] : []).filter(call => selected.has(call.id) && !paired.has(call.id) && !detached.has(call.id));
    if (!calls.length) return { success: true };
    const messages = state.history.messages.map(message => ({ ...message }));
    const responses: PlatformMessage[] = calls.map(call => ({ id: randomUUID(), role: 'user', isFunctionResponse: true, timestamp: Date.now(),
      parts: [{ functionResponse: { id: call.id, name: call.name, response: { success: false, code: 'CANCELLED', error: '用户取消了尚未完成的工具调用。' } } }] }));
    let insert = index + 1; while (messages[insert]?.isFunctionResponse) insert++;
    messages.splice(insert, 0, ...responses);
    for (let cursor = 0; cursor < messages.length; cursor++) { messages[cursor].index = cursor; messages[cursor].parentId = messages[cursor - 1]?.id ?? null; }
    const branches = readBranches(state); branches.graph = rebaseActivePathFromHistory(branches.graph, messages as Content[]); Object.assign(branches.groups, groupMessages(messages));
    return this.commit(this.changed(state, messages, '结算已取消工具前', branches));
  }
  async graph(actorId: string, id: string) {
    await this.app.conversation(actorId, id);
    const config = this.app.product.runtimeSettings().getCheckpointConfig();
    const state = await this.app.storage.readConversationState(id, [{ namespace: branchNamespace, id, projection: BRANCH_RECORD_PROJECTION }], {
      historyProjection: BRANCH_MESSAGE_PROJECTION,
    });
    const branches = await this.withCheckpoints(actorId, id, readBranchPreview(state));
    return { graph: branchView(branches, new Set([...config.beforeTools, ...config.afterTools])) };
  }
  private async withCheckpoints<T extends BranchPreviewState>(actorId: string, id: string, branches: T): Promise<T> {
    // 较早独立版的检查点已保存消息归属，按该归属补齐尚未记录的分支绑定。
    for (const checkpoint of (await this.app.checkpoints.listMetadata(actorId, id)).reverse()) {
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
      expectedMetadataToken: state.metadataToken, records: [branchMutation(state, branches, state.history.messages)] });
    this.app.publish({ type: 'conversation.changed', conversationId: id });
    return { success: true, revision: result.revision };
  }
  async reroll(actorId: string, id: string, targetId: string | undefined, requestKey: string): Promise<PreparedConversationChange> {
    await this.app.conversation(actorId, id);
    const { entries } = await this.app.storage.readHistoryOutline(id);
    let index = targetId !== undefined ? entries.findIndex(message => message.id === targetId) : entries.length - 1;
    if (targetId === undefined) while (index >= 0 && entries[index].role !== 'model') index--;
    if (index < 1 || entries[index].role !== 'model') throw new Error('重试目标不是当前历史中的模型消息。');
    const state = await this.idle(actorId, id, { index, messageId: entries[index].id! });
    const branches = readBranches(state);
    assertBranchCapacity(branches, branches.graph.nodes[state.history.messages[index].id!].parentId!);
    const messages = truncateFrom(state.history.messages as Content[], index) as PlatformMessage[];
    branches.graph = rebaseActivePathFromHistory(branches.graph, messages as Content[]);
    branches.pendingKind = { parentId: branches.graph.activeTailNodeId!, kind: 'reroll', requestKey };
    return this.changed(state, messages, '重新生成前', branches);
  }
  async edit(actorId: string, id: string, targetId: string, parts: PlatformMessage['parts'], requestKey: string, mode: 'keep' | 'branch',
    options: { preserveAttachments?: boolean; deepSeekVisionTileSplit?: boolean } = {}) {
    await this.app.conversation(actorId, id);
    const { entries } = await this.app.storage.readHistoryOutline(id);
    const index = entries.findIndex(message => message.id === targetId);
    if (index < 0 || entries[index].role !== 'user' || entries[index].isFunctionResponse) throw new Error('编辑目标不是用户消息。');
    const state = await this.idle(actorId, id, { index, messageId: targetId });
    const branches = readBranches(state);
    const messages = [...state.history.messages];
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
      expectedMetadataToken: state.metadataToken, records: [branchMutation(state, branches, state.history.messages)] });
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
