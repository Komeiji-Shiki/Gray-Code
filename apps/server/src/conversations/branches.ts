import type { ConversationState, PlatformMessage, RecordMutation } from '@graycode/contracts';
import type { Content } from '../../../../backend/modules/conversation/types';
import type { ConversationBranchGraph } from '../../../../backend/modules/conversation/branch/types';
import { activePath, childrenIndex, createEmptyBranchGraph, importLinearHistory, isFunctionResponseMessage,
  rebaseActivePathFromHistory, validate } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { MAX_CANDIDATES_PER_PARENT } from '../../../../backend/modules/conversation/branch/branchServiceTypes';
import { isRealUserMessage } from '../../../../backend/modules/conversation/helpers';

export const branchNamespace = 'conversation-branches';
export interface BranchState {
  version: 1;
  graph: ConversationBranchGraph;
  /** Preserve complete messages, including individual tool-result IDs, signatures and turn snapshots. */
  groups: Record<string, PlatformMessage[]>;
  pendingKind?: { parentId: string; kind: 'edit' | 'reroll'; requestKey: string; messageId?: string };
}
export function assertBranchCapacity(branch: BranchState, parentId: string): void {
  const candidates = (childrenIndex(branch.graph).get(parentId) ?? []).filter(id => !branch.graph.nodes[id].deleted);
  if (candidates.length >= MAX_CANDIDATES_PER_PARENT) throw new Error(`同一位置最多保留 ${MAX_CANDIDATES_PER_PARENT} 个候选，请先清理不需要的分支。`);
}

export function groupMessages(messages: PlatformMessage[]): Record<string, PlatformMessage[]> {
  const result: Record<string, PlatformMessage[]> = {};
  let owner: string | undefined;
  for (const message of messages) {
    if (!message.id) throw new Error('分支消息缺少稳定 ID。');
    if (isFunctionResponseMessage(message as Content)) {
      if (!owner || result[owner][0].role !== 'model') throw new Error('工具结果没有所属模型消息。');
      result[owner].push(structuredClone(message));
    } else { owner = message.id; result[owner] = [structuredClone(message)]; }
  }
  return result;
}

/** The committed active history is authoritative; branches retain inactive alternatives. */
export function readBranches(state: ConversationState): BranchState {
  const stored = state.records.find(record => record.namespace === branchNamespace)?.record.value as BranchState | null;
  if (stored && stored.version !== 1) throw new Error('不支持的分支存储版本。');
  const value: BranchState = stored ? structuredClone(stored) : { version: 1, graph: createEmptyBranchGraph(), groups: {} };
  if (value.graph.rootNodeId !== null && !validate(value.graph).valid) throw new Error('分支图损坏，未修改历史。');
  const current = groupMessages(state.history.messages);
  value.groups = { ...value.groups, ...current };
  if (state.history.messages.length) value.graph = value.graph.rootNodeId === null
    ? importLinearHistory(state.history.messages as Content[])
    : rebaseActivePathFromHistory(value.graph, state.history.messages as Content[], { allowRootChange: true });
  else value.graph = createEmptyBranchGraph();
  const pending = value.pendingKind;
  if (pending) {
    const nextId = pending.messageId ?? value.graph.nodes[pending.parentId]?.activeChildId;
    const node = nextId ? value.graph.nodes[nextId] : undefined;
    if (node && (pending.messageId || node.parentId === pending.parentId)) {
      if (value.groups[node.id]?.[0].requestKey === pending.requestKey) node.kind = pending.kind;
      delete value.pendingKind;
    }
  }
  return value;
}

/** Persist topology and messages separately inside the compressed record; no duplicated bodies in graph nodes. */
export function branchMutation(state: ConversationState, branch: BranchState): RecordMutation {
  const value = structuredClone(branch);
  for (const node of Object.values(value.graph.nodes)) { node.parts = []; delete node.contentMetadata; delete node.usageMetadata; }
  for (const id of Object.keys(value.groups)) if (!value.graph.nodes[id]) delete value.groups[id];
  return { namespace: branchNamespace, id: state.metadata.id, ownerId: state.metadata.id, value,
    expectedRevision: state.records.find(record => record.namespace === branchNamespace)?.record.revision ?? null };
}

export function materializeBranch(branch: BranchState): PlatformMessage[] {
  const messages: PlatformMessage[] = [];
  for (const id of activePath(branch.graph)) {
    const group = branch.groups[id];
    if (!group?.length) throw new Error(`分支节点 ${id} 的消息正文不可用。`);
    messages.push(...structuredClone(group));
  }
  for (let index = 0; index < messages.length; index++) {
    messages[index].index = index; messages[index].parentId = messages[index - 1]?.id ?? null;
    delete messages[index].isSummarized;
  }
  // Coverage belongs to the summaries on this path. Switching to a path before a summary
  // must not retain flags written by that other path and hide its original messages.
  const byId = new Map(messages.map(message => [message.id, message]));
  const firstUser = messages.findIndex(message => isRealUserMessage(message as Content));
  let previousSummary = -1;
  for (let index = 0; index < messages.length; index++) if (messages[index].isSummary) {
    const ids = messages[index].summarizedMessageIds;
    const covered = Array.isArray(ids) ? ids.map(id => byId.get(id)) : messages.slice(Math.max(previousSummary + 1, firstUser + 1), index);
    for (const message of covered) if (message && (!message.isSummary || messages[index].contextMethod) && message !== messages[firstUser]) message.isSummarized = true;
    previousSummary = index;
  }
  return messages;
}

export function branchView(branch: BranchState, writeTools: ReadonlySet<string> = new Set()): ConversationBranchGraph {
  const graph = structuredClone(branch.graph);
  const children = childrenIndex(graph);
  const pending: Array<{ id: string; wrote: boolean }> = graph.rootNodeId ? [{ id: graph.rootNodeId, wrote: false }] : [];
  while (pending.length) {
    const { id, wrote } = pending.pop()!;
    const node = graph.nodes[id];
    const ownWrite = (branch.groups[id] ?? []).some(message => message.parts.some(part => {
      const call = part.functionCall as { name: string; args?: Record<string, unknown> } | undefined;
      if (!call) return false;
      if (call.name === 'workspace_files') return ['write', 'delete'].includes(String(call.args?.action));
      return call.name === 'run_command' || writeTools.has(call.name);
    }));
    Object.assign(node, { hasWorkspaceState: !!node.workspaceCheckpointId, wroteToWorkspace: wrote || ownWrite });
    for (const child of children.get(id) ?? []) pending.push({ id: child, wrote: wrote || ownWrite });
  }
  for (const node of Object.values(graph.nodes)) {
    // The tree is a preview. Full attachments and signatures are read from the selected history.
    node.parts = (branch.groups[node.id]?.[0].parts ?? []).flatMap(part => typeof part.text === 'string'
      ? [{ text: part.text.slice(0, 180) }]
      : part.functionCall ? [{ text: `[tool: ${(part.functionCall as { name: string }).name}]` }] : []);
  }
  return graph;
}
