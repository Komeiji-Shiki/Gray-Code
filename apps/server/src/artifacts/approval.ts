import type { PlatformMessage } from '@graycode/contracts';
import type { PreparedConversationChange } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { Content } from '../../../../backend/modules/conversation/types';
import { getPlanSourceStatusFromContent, type PlanSourceStatusResult } from '../../../../backend/tools/plan/sourceArtifactSectionRuntime';
import { extractPlanTodoListFromContent } from '../../../../backend/tools/plan/todoListSection';
import { normalizePendingApprovalGate, getPendingApprovalGateMismatchReason } from '../../../../backend/modules/conversation/pendingApprovalGate';
import { getHiddenContinuationApprovalRequirement } from '../../../../backend/modules/api/chat/services/approvalGateRules';
import { rebaseActivePathFromHistory } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { readBranches, branchMutation, groupMessages } from '../conversations/branches';

export function buildPlanGenerationPrompt(artifactType: 'design' | 'review', modified: boolean): string {
  const artifactLabel = artifactType === 'design' ? 'design' : 'review';
  const sourceInstruction = modified
    ? `The user modified the ${artifactLabel} and confirmed the latest version. Use the latest version above as the source of truth.`
    : `Use the confirmed ${artifactLabel} content above as the source of truth.`;

  return [
    `User confirmed the ${artifactLabel} and asked you to generate the implementation plan now.`,
    '',
    sourceInstruction,
    'You are no longer reviewing whether this document is ready.',
    'Do not ask for another confirmation.',
    `Do not restate that the ${artifactLabel} is ready for review.`,
    `When you call create_plan, include sourceArtifact that points to the confirmed ${artifactLabel} document.`,
    'Create the implementation plan immediately by using create_plan.'
  ].join('\n');
}

export function buildPlanExecutionPrompt(modified: boolean): string {
  return [
    'User confirmed the plan and asked you to begin implementation now.',
    '',
    modified ? 'The user modified the plan and confirmed the latest version. Use the latest version above as the source of truth.' : 'Use the confirmed plan content above as the source of truth.',
    'You are no longer drafting or reviewing the plan.',
    'Do not say that the plan is ready for review.',
    'Do not create another plan unless the user explicitly asks to revise it.',
    'Start implementation immediately.',
    'Use todo_update to track progress as you work.',
    'Use update_progress and record_progress_milestone to keep .graycode/progress.md current at the project level when progress changes in a meaningful way.',
    "When TODO status changes in a meaningful way, call update_plan with updateMode: 'progress_sync' to sync the latest TODO snapshot back to the plan document.",
    "When calling update_plan with updateMode: 'progress_sync', never pass sourceArtifact. Only send path, todos, updateMode, and optional changeSummary."
  ].join('\n');
}

export function buildPlanSourceBlockedError(sourceStatus: PlanSourceStatusResult): string {
  if (sourceStatus.sourceStatus === 'mismatched') {
    const label = sourceStatus.sourceArtifactType || 'source';
    const suffix = sourceStatus.sourcePath ? `: ${sourceStatus.sourcePath}` : '';
    return `The ${label} artifact changed. Please regenerate or revise the plan before execution${suffix}`;
  }

  if (sourceStatus.sourceStatus === 'missing_source') {
    const label = sourceStatus.sourceArtifactType || 'source';
    const suffix = sourceStatus.sourcePath ? `: ${sourceStatus.sourcePath}` : '';
    return `The ${label} artifact is missing or unreadable. Please revise the plan before execution${suffix}`;
  }

  return 'The plan source artifact is not executable in its current state.';
}

export class ArtifactApproval {
  constructor(private readonly app: PlatformApplication) {}
  private async read(actorId: string, conversationId: string, file: string): Promise<string | null> {
    const conversation = await this.app.conversation(actorId, conversationId);
    if (typeof conversation.workspaceId !== 'string') return null;
    const workspace = this.app.workspace(actorId, conversation.workspaceId, ['workspace_read']);
    try { const value = await this.app.files.read(workspace, file); return value.hash === null ? null : value.text; }
    catch { return null; }
  }
  async confirm(actorId: string, type: string, data: Record<string, any>) {
    const conversation = await this.app.conversation(actorId, data.conversationId);
    const artifact = type.startsWith('design.') ? 'design' : type.startsWith('review.') ? 'review' : 'plan';
    const sourcePath = typeof data.path === 'string' ? data.path.trim() : '';
    const original = typeof data.originalContent === 'string' ? data.originalContent : '';
    const content = sourcePath ? await this.read(actorId, conversation.id, sourcePath) ?? original : original;
    const status = artifact === 'plan' ? await getPlanSourceStatusFromContent(content, file => this.read(actorId, conversation.id, file)) : undefined;
    const blocked = status?.sourceStatus === 'mismatched' || status?.sourceStatus === 'missing_source';
    const sourceResult = { ...status, blocked, blockReason: blocked ? status?.sourceStatus === 'mismatched' ? 'source_mismatched' : 'source_missing' : undefined,
      error: blocked ? buildPlanSourceBlockedError(status!) : undefined };
    if (type === 'plan.getSourceStatus') return { success: true, planPath: sourcePath, ...sourceResult };
    if (blocked) return { success: false, ...sourceResult };
    const gate = normalizePendingApprovalGate((conversation.custom as Record<string, unknown> | undefined)?.pendingApprovalGate);
    if (!gate || typeof data.toolId !== 'string' || !data.toolId.trim()) return { success: false, error: '当前对话没有对应的文档确认请求。' };
    const mismatch = getPendingApprovalGateMismatchReason(gate, { sourceToolCallId: data.toolId, sourceArtifactType: artifact,
      sourcePath: sourcePath || undefined, kind: artifact === 'plan' ? 'execute_plan' : 'generate_plan',
      continuationIntent: artifact === 'plan' ? 'implement_now' : 'generate_plan_now' });
    if (mismatch) return { success: false, error: mismatch };
    const modified = content.trim() !== original.trim();
    return { success: true, approvalId: gate.id, prompt: artifact === 'plan' ? buildPlanExecutionPrompt(modified) : buildPlanGenerationPrompt(artifact, modified),
      [`${artifact}Content`]: content, [`${artifact}Path`]: sourcePath,
      ...(artifact === 'plan' ? { ...sourceResult, todos: extractPlanTodoListFromContent(content) } : {}) };
  }
  async prepare(actorId: string, conversationId: string, hidden: Record<string, any>): Promise<PreparedConversationChange> {
    const state = await this.app.conversations.read(actorId, conversationId);
    const gate = normalizePendingApprovalGate((state.metadata.custom as Record<string, unknown> | undefined)?.pendingApprovalGate);
    const requirement = getHiddenContinuationApprovalRequirement(hidden as any);
    if (!gate || !requirement || gate.id !== requirement.approvalId || gate.sourceToolCallId !== hidden.id || gate.sourceToolName !== hidden.name || gate.continuationIntent !== requirement.intent)
      throw new Error('文档确认已失效，请重新打开当前请求。');
    if ((await this.app.storage.listRuns({ conversationId, activeOnly: true, limit: 1 })).length) throw new Error('请等待当前任务完成后确认文档。');
    const messages: PlatformMessage[] = structuredClone(state.history.messages);
    let matched = false;
    for (const message of messages) for (const part of message.parts) {
      const response = part.functionResponse as { id?: string; name?: string; response?: Record<string, unknown> } | undefined;
      if (response?.id === gate.sourceToolCallId && response.name === gate.sourceToolName) {
        response.response = { ...response.response, ...structuredClone(hidden.response) }; matched = true;
      }
    }
    if (!matched) throw new Error('确认请求对应的工具结果已不在当前分支。');
    const metadata = structuredClone(state.metadata);
    metadata.custom = { ...metadata.custom as Record<string, unknown>, pendingApprovalGate: null,
      ...(gate.sourceArtifactType === 'plan' && typeof hidden.response.planContent === 'string'
        ? { todoList: extractPlanTodoListFromContent(hidden.response.planContent) } : {}) };
    const branches = readBranches(state);
    branches.graph = rebaseActivePathFromHistory(branches.graph, messages as Content[]);
    Object.assign(branches.groups, groupMessages(messages));
    return { state, commit: { messages, metadata, records: [branchMutation(state, branches)] } };
  }
}
