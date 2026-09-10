import { resolveWorkspacePath, workspaceFilePath, workspaceRootFor, workspaceRoots } from '../workspace/paths';
import { createCreateDesignTool } from '../../../../backend/tools/design/create_designRuntime';
import { createUpdateDesignTool } from '../../../../backend/tools/design/update_designRuntime';
import { createCreatePlanTool } from '../../../../backend/tools/plan/create_planRuntime';
import { createUpdatePlanTool } from '../../../../backend/tools/plan/update_planRuntime';
import { createCompareReviewDocumentsTool } from '../../../../backend/tools/review/compare_review_documentsRuntime';
import { createCreateReviewTool } from '../../../../backend/tools/review/create_reviewRuntime';
import { createFinalizeReviewTool } from '../../../../backend/tools/review/finalize_reviewRuntime';
import { createRecordReviewMilestoneTool } from '../../../../backend/tools/review/record_review_milestoneRuntime';
import { createReopenReviewTool } from '../../../../backend/tools/review/reopen_reviewRuntime';
import { createValidateReviewDocumentTool } from '../../../../backend/tools/review/validate_review_documentRuntime';
import { createCreateProgressTool } from '../../../../backend/tools/progress/create_progressRuntime';
import { createRecordProgressMilestoneTool } from '../../../../backend/tools/progress/record_progress_milestoneRuntime';
import { createUpdateProgressTool } from '../../../../backend/tools/progress/update_progressRuntime';
import { createValidateProgressDocumentTool } from '../../../../backend/tools/progress/validate_progress_documentRuntime';
import { randomUUID } from 'node:crypto';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { ToolContext as LegacyToolContext } from '../../../../backend/tools/types';
import { withArtifactHost, type ArtifactDocumentHost } from '../../../../backend/tools/shared/artifactHost';
import { classifyApprovalGateForToolResult } from '../../../../backend/modules/api/chat/services/approvalGateRules';
import { normalizePendingApprovalGate } from '../../../../backend/modules/conversation/pendingApprovalGate';
import type { PlatformApplication } from '../application';
import { fileHash, type FileChange } from '../workspace/fileTransaction';

export class PlatformArtifacts {
  constructor(private readonly app: PlatformApplication) {}
  tools(): RuntimeTool[] {
    const factories = [createCreateDesignTool, createUpdateDesignTool, createCreatePlanTool, createUpdatePlanTool, createCompareReviewDocumentsTool, createCreateReviewTool, createFinalizeReviewTool, createRecordReviewMilestoneTool, createReopenReviewTool, createValidateReviewDocumentTool, createCreateProgressTool, createRecordProgressMilestoneTool, createUpdateProgressTool, createValidateProgressDocumentTool];
    return factories.map(factory => {
      const tool = factory();
      const readOnly = ['validate_review_document', 'compare_review_documents', 'validate_progress_document'].includes(tool.declaration.name);
      return { declaration: { name: tool.declaration.name, description: tool.declaration.description, parameters: tool.declaration.parameters },
        effects: () => readOnly ? ['workspace_read'] : ['workspace_read', 'workspace_write'],
        execute: (args, context) => this.execute(tool, args, context, readOnly) } as RuntimeTool;
    });
  }
  private async execute(tool: ReturnType<typeof createCreatePlanTool>, args: Record<string, unknown>, context: ToolContext, readOnly: boolean) {
    if (!context.workspace || !context.conversationId) throw new Error('文档工具需要对话绑定工作区。');
    this.app.workspace(context.actorId, context.workspace.id, readOnly ? ['workspace_read'] : ['workspace_write']);
    const workspace = context.workspace;
    await this.app.conversation(context.actorId, context.conversationId);
    return this.app.files.transaction(workspace, async transaction => {
      const state = await this.app.storage.readConversationState(context.conversationId!);
      const staged = new Map<string, FileChange>();
      let metadataChanged = false;
      const relative = (absolute: string) => {
        if (!workspaceRootFor(workspace, absolute)) throw new Error('文档不属于当前工作区。');
        return workspaceFilePath(workspace, absolute);
      };
      const missing = () => Object.assign(new Error('File not found'), { code: 'FileNotFound' });
      const host: ArtifactDocumentHost = {
        workspaces: () => workspaceRoots(workspace).map(root => ({ name: root.name })),
        resolve: input => {
          try { const absolute = resolveWorkspacePath(workspace, input); relative(absolute); return { uri: { fsPath: absolute } }; }
          catch (error) { return { error: String(error) }; }
        },
        read: async target => {
          context.signal.throwIfAborted();
          const key = relative(target.fsPath);
          const bytes = staged.get(key)?.after.bytes ?? (await transaction.capture(key)).bytes;
          if (bytes === null) throw missing();
          return bytes;
        },
        stat: async target => {
          const key = relative(target.fsPath);
          const bytes = staged.get(key)?.after.bytes ?? (await transaction.capture(key)).bytes;
          if (bytes === null) throw missing();
          return { size: bytes.byteLength };
        },
        write: async (target, bytes) => {
          if (readOnly) throw new Error('只读文档工具不能写入文件。');
          context.signal.throwIfAborted();
          const key = relative(target.fsPath);
          const before = staged.get(key)?.before ?? await transaction.capture(key);
          staged.set(key, { path: key, before, after: { bytes: new Uint8Array(bytes), hash: fileHash(bytes), mode: before.mode } });
        },
        // 父目录随文件事务一同创建；这里仅检查路径，失败时不遗留空目录。
        prepareParent: async absolute => { await this.app.files.resolve(workspace, relative(absolute)); },
      };
      const requireConversation = (id: string) => { if (id !== state.metadata.id) throw new Error('不能访问其他对话。'); context.signal.throwIfAborted(); };
      const conversationStore: NonNullable<LegacyToolContext['conversationStore']> = {
        getHistory: async id => { requireConversation(id); return structuredClone(state.history.messages); },
        getCustomMetadata: async (id, key) => { requireConversation(id); return structuredClone((state.metadata.custom as Record<string, unknown> | undefined)?.[key]); },
        setCustomMetadata: async (id, key, value) => {
          requireConversation(id); state.metadata.custom = { ...state.metadata.custom as Record<string, unknown>, [key]: structuredClone(value) }; metadataChanged = true;
        },
      };
      const { multimodal, ...result } = await withArtifactHost(host, () => tool.handler(args, {
        conversationId: context.conversationId, toolId: context.toolCallId, abortSignal: context.signal, conversationStore,
      }));
      context.signal.throwIfAborted();
      if (!result.success) return { ...result, attachments: multimodal };
      const seed = classifyApprovalGateForToolResult({ id: context.toolCallId!, name: tool.declaration.name, args }, result);
      if (seed) {
        state.metadata.custom = { ...state.metadata.custom as Record<string, unknown>, pendingApprovalGate: { ...seed, id: randomUUID(), createdAt: Date.now() } };
        metadataChanged = true;
      }
      if (staged.size) await this.app.changes.perform(transaction, workspace, state, [...staged.values()],
        metadataChanged ? { metadata: state.metadata } : {}, { runId: context.runId, toolCallId: context.toolCallId });
      else if (metadataChanged) await this.app.storage.commitConversation({ conversationId: state.metadata.id,
        expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken, activeRunId: context.runId, metadata: state.metadata });
      if (metadataChanged) this.app.productUi.conversations.clearMetadataCache();
      return { ...result, attachments: multimodal };
    });
  }
  async beforeRun(run: import('@graycode/contracts').RunRecord) {
    const state = await this.app.storage.readConversationState(run.conversationId);
    if (!normalizePendingApprovalGate((state.metadata.custom as Record<string, unknown> | undefined)?.pendingApprovalGate)) return;
    // 新的用户消息取代旧确认请求；隐藏确认通过准备事务明确消费对应请求。
    if (!state.history.messages.some(message => message.runId === run.id && message.isUserInput)) return;
    const metadata = { ...state.metadata, custom: { ...state.metadata.custom as Record<string, unknown>, pendingApprovalGate: null } };
    await this.app.storage.commitConversation({ conversationId: run.conversationId, expectedRevision: state.history.revision,
      expectedMetadataToken: state.metadataToken, activeRunId: run.id, metadata });
    this.app.productUi.conversations.clearMetadataCache();
  }
  async shouldStop(conversationId: string, toolCallIds: string[]) {
    const conversation = await this.app.storage.getConversation(conversationId);
    const gate = normalizePendingApprovalGate((conversation?.custom as Record<string, unknown> | undefined)?.pendingApprovalGate);
    return !!gate && toolCallIds.includes(gate.sourceToolCallId);
  }
}
