/**
 * LimCode - Chat 流程服务（应用服务层）
 *
 * 负责编排单次 Chat 调用的核心业务逻辑：
 * - 配置校验
 * - 对话存在性检查
 * - 用户消息写入 & checkpoint
 * - 工具调用循环（委托 ToolIterationLoopService / ToolExecutionService）
 */

import { t } from '../../../../i18n';
import { Logger } from '../../../../core/logger';
import type { ConfigManager } from '../../../config/ConfigManager';
import type { ChannelManager } from '../../../channel/ChannelManager';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { SettingsManager } from '../../../settings/SettingsManager';
import type { BaseChannelConfig } from '../../../config/configs/base';
import { ChannelError, ErrorType } from '../../../channel/types';
import type { DynamicContextStrategy, ResolvedPromptModeSnapshot } from '../../../settings/types';
import type { Content, ContentPart } from '../../../conversation/types';
import type { CheckpointRecord } from '../../../checkpoint';

import type {
  ChatRequestData,
  RetryRequestData,
  EditAndRetryRequestData,
  ToolConfirmationResponseData,
  DeleteToMessageRequestData,
  HiddenFunctionResponseData,
  DeleteToMessageSuccessData,
  DeleteToMessageErrorData,
  ChatSuccessData,
  ChatErrorData,
  ChatStreamChunkData,
  ChatStreamCompleteData,
  ChatStreamErrorData,
  ChatStreamToolIterationData,
  ChatStreamCheckpointsData,
  ChatStreamToolConfirmationData,
  ChatStreamToolsExecutingData,
  ChatStreamToolStatusData,
  ChatStreamAutoSummaryData,
  ChatStreamAutoSummaryStatusData,
} from '../types';

import type { MessageBuilderService } from './MessageBuilderService';
import type { TokenEstimationService } from './TokenEstimationService';
import type { ToolIterationLoopService } from './ToolIterationLoopService';
import { MAIN_LOOP_ABORT_DRAIN_GRACE_MS, drainToolExecutionGeneratorAfterAbort } from './ToolIterationLoopService';
import type { CheckpointService } from './CheckpointService';
import type { DiffInterruptService } from './DiffInterruptService';
import type { ToolExecutionService, ToolExecutionFullResult, ToolExecutionProgressEvent } from './ToolExecutionService';
import type { ToolCallParserService } from './ToolCallParserService';
import {
  clearPendingApprovalGate,
  getPendingApprovalGate,
  getPendingApprovalGateKindForContinuationIntent
} from '../../../conversation/pendingApprovalGate';
import { getHiddenContinuationApprovalRequirement } from './approvalGateRules';
import { resolveAndPersistPostToolStopState } from './postToolStopState';
import { MAIN_SESSION_RUN_ID } from '../../../../tools/subagents/agentMailbox';
import {
  BranchError,
  activePath,
  getGlobalBranchService,
  isFunctionResponseMessage,
} from '../../../conversation/branch';
import type { ConversationBranchGraph } from '../../../conversation/branch';

export type ChatStreamOutput =
  | ChatStreamChunkData
  | ChatStreamCompleteData
  | ChatStreamErrorData
  | ChatStreamToolIterationData
  | ChatStreamCheckpointsData
  | ChatStreamToolConfirmationData
  | ChatStreamToolsExecutingData
  | ChatStreamToolStatusData
  | ChatStreamAutoSummaryData
  | ChatStreamAutoSummaryStatusData;

/**
 * reroll（重新生成并保留旧回答）请求数据（TREE-01）。
 * 与 RetryRequestData 的区别：不删除旧回答——后端在 BranchGraph 中把旧助手节点及其子树
 * 保留为候选（进 sidecar），新建候选并切换主历史到新候选路径；失败保留旧候选（决策 10）。
 */
export interface RerollRequestData {
  /** 对话 ID */
  conversationId: string;
  /**
   * 要重新生成的助手节点 ID（须在当前活跃路径上，且父节点为用户消息）；
   * 省略时取活跃路径上最后一条助手消息（前端「重新生成」默认行为）。
   */
  assistantNodeId?: string;
  /** 配置 ID */
  configId: string;
  /** 模型覆盖（可选） */
  modelOverride?: string;
  /** 取消信号 */
  abortSignal?: AbortSignal;
  /** 总结请求专用取消信号 */
  summarizeAbortSignal?: AbortSignal;
  /** Prompt 模式 ID（可选） */
  promptModeId?: string;
}

/**
 * 编辑用户消息分支（TREE-03）请求数据。
 * 与 EditAndRetryRequestData 的区别：不覆盖原消息——后端在 BranchGraph 中把旧用户节点及其子树
 * 保留为候选（进 sidecar），创建编辑候选（新 user 节点，kind='edit'）并切换主历史到编辑后路径；
 * 失败保留旧候选（决策 10 精神）。
 */
export interface EditBranchRequestData {
  /** 对话 ID */
  conversationId: string;
  /**
   * 要编辑的用户节点 ID（须在当前活跃路径上，且 role==='user'，且不是根节点）；
   * 省略时取活跃路径上最后一条可编辑用户消息（前端「编辑最后一条用户消息」默认行为）。
   */
  userNodeId?: string;
  /** 新文本（替换用户消息的文本 parts） */
  newText: string;
  /** 配置 ID */
  configId: string;
  /** 模型覆盖（可选） */
  modelOverride?: string;
  /** 取消信号 */
  abortSignal?: AbortSignal;
  /** 总结请求专用取消信号 */
  summarizeAbortSignal?: AbortSignal;
  /** Prompt 模式 ID（可选） */
  promptModeId?: string;
  /**
   * 编辑模式（可选，默认 'branch'）：
   * - 'branch'：创建编辑候选（新 user 节点）并切换分支，旧节点及其子树保留进 sidecar；
   * - 'keep'：直接改写活跃路径上的原用户消息并截断其后内容（保持当前分支，不产生新候选）。
   */
  mode?: 'branch' | 'keep';
}

/** TREE-03：编辑目标解析结果 */
export interface EditTargetResolution {
  /** 被编辑的旧用户节点 id */
  nodeId: string;
  /** 新编辑候选的父节点 id（旧用户节点的父节点；null 即根节点，不可编辑） */
  parentNodeId: string;
}

/**
 * TREE-03：解析并校验编辑目标（纯函数，可单测）。
 *
 * - 显式 userNodeId：图模式校验「存在 + 在活跃路径 + role==='user' + 非根节点」；
 *   线性模式（graph 为 null）以主历史为活跃路径，父节点取前一个非 functionResponse 消息
 *   （与 importLinearHistory 的线性链接规则一致，决策 8）；
 * - 省略 userNodeId：取活跃路径上最后一条可编辑用户消息；
 * - 错误码：节点缺失 NODE_NOT_FOUND；非 user / 不在活跃路径 / 根节点 → INVALID_BRANCH_RELATION。
 */
export function resolveEditTargetNode(
  graph: ConversationBranchGraph | null,
  history: ReadonlyArray<Content>,
  userNodeId?: string,
): EditTargetResolution {
  if (userNodeId !== undefined && userNodeId.trim() !== '') {
    if (graph) {
      const node = graph.nodes[userNodeId];
      if (!node) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${userNodeId}`);
      }
      if (node.role !== 'user') {
        throw new BranchError(
          'INVALID_BRANCH_RELATION',
          `edit target ${userNodeId} is not a user node`
        );
      }
      const path = activePath(graph);
      if (!path.includes(userNodeId)) {
        throw new BranchError(
          'INVALID_BRANCH_RELATION',
          `node ${userNodeId} is not on the active path; cannot edit it`
        );
      }
      if (node.parentId === null) {
        throw new BranchError(
          'INVALID_BRANCH_RELATION',
          `cannot edit the root node ${userNodeId} (no parent to branch under)`
        );
      }
      return { nodeId: userNodeId, parentNodeId: node.parentId };
    }
    // 线性模式（无分支图）：主历史即活跃路径
    const idx = history.findIndex(message => message.id === userNodeId);
    if (idx < 0) {
      throw new BranchError('NODE_NOT_FOUND', `node not found: ${userNodeId}`);
    }
    if (history[idx].role !== 'user') {
      throw new BranchError(
        'INVALID_BRANCH_RELATION',
        `edit target ${userNodeId} is not a user node`
      );
    }
    const parentId = findLinearParentId(history, idx);
    if (parentId === null) {
      throw new BranchError(
        'INVALID_BRANCH_RELATION',
        `cannot edit the root node ${userNodeId} (no parent to branch under)`
      );
    }
    return { nodeId: userNodeId, parentNodeId: parentId };
  }
  // 缺省：活跃路径上最后一条可编辑用户消息
  if (graph) {
    const path = activePath(graph);
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const node = graph.nodes[path[i]];
      if (node && node.role === 'user' && node.parentId !== null) {
        return { nodeId: node.id, parentNodeId: node.parentId };
      }
    }
  } else {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === 'user' && !isFunctionResponseMessage(history[i])) {
        const parentId = findLinearParentId(history, i);
        if (parentId !== null) {
          return { nodeId: history[i].id!, parentNodeId: parentId };
        }
      }
    }
  }
  throw new BranchError(
    'INVALID_BRANCH_RELATION',
    'no editable user node found on the active path'
  );
}

/** 线性模式父节点解析：向前跳过 functionResponse（决策 8：FR 不独立成节点） */
function findLinearParentId(history: ReadonlyArray<Content>, index: number): string | null {
  for (let j = index - 1; j >= 0; j -= 1) {
    if (!isFunctionResponseMessage(history[j])) {
      return history[j].id ?? null;
    }
  }
  return null;
}

/**
 * 解析 reroll 主历史截断起始索引。
 *
 * reroll 是“单条助手消息重新生成”：显式 assistantNodeId 或最后一条 model 消息就是截断点。
 * 目标之前的所有历史均保留，包括工具调用模型消息与其后的 functionResponse；因此工具续接回答
 * 重新生成时不会退回最近的用户消息，也不会重复执行已经完成的工具。
 *
 * 无法定位目标或目标位于首条消息时返回 -1（startReroll 会负责正式的关系校验；
 * 此函数只用于流启动前清理目标消息及其后续检查点）。
 */
export function resolveRerollTruncateIndex(
  history: ReadonlyArray<Content>,
  assistantNodeId?: string,
): number {
  let targetIndex = -1;
  if (assistantNodeId !== undefined && assistantNodeId.trim() !== '') {
    targetIndex = history.findIndex(message => message.id === assistantNodeId);
  } else {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === 'model' && !isFunctionResponseMessage(history[i])) {
        targetIndex = i;
        break;
      }
    }
  }
  return targetIndex > 0 ? targetIndex : -1;
}

type TodoStatusValue = 'pending' | 'in_progress' | 'completed' | 'cancelled';
type TodoItemValue = { id: string; content: string; status: TodoStatusValue };

const CONVERSATION_PROMPT_MODE_KEY = 'promptModeConfig';

export class ChatFlowService {
  private readonly log = Logger.get('ChatFlow');
  constructor(
    private configManager: ConfigManager,
    private conversationManager: ConversationManager,
    private settingsManager: SettingsManager | undefined,
    private messageBuilderService: MessageBuilderService,
    private tokenEstimationService: TokenEstimationService,
    private toolIterationLoopService: ToolIterationLoopService,
    private checkpointService: CheckpointService,
    private diffInterruptService: DiffInterruptService,
    private toolExecutionService: ToolExecutionService,
    private toolCallParserService: ToolCallParserService,
  ) {}

  /**
   * 获取单回合最大工具调用次数
   */
  private getMaxToolIterations(): number {
    return this.settingsManager?.getMaxToolIterations() ?? 20;
  }

  /**
   * 确保对话存在（不存在则创建）
   */
  private async ensureConversation(conversationId: string): Promise<void> {
    await this.conversationManager.getHistory(conversationId);
  }

  private normalizePromptModeId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized || undefined;
  }

  private async resolvePromptModeSnapshot(
    conversationId: string,
    requestedModeId?: string,
  ): Promise<ResolvedPromptModeSnapshot | undefined> {
    if (!this.settingsManager) return undefined;

    const directModeId = this.normalizePromptModeId(requestedModeId);
    if (directModeId) {
      return this.settingsManager.resolvePromptMode(directModeId);
    }

    const stored = await this.conversationManager.getCustomMetadata(conversationId, CONVERSATION_PROMPT_MODE_KEY);
    return this.settingsManager.resolvePromptMode(this.normalizePromptModeId((stored as any)?.modeId));
  }

  private resolveDynamicContextStrategy(
    promptModeSnapshot?: ResolvedPromptModeSnapshot,
    override?: DynamicContextStrategy
  ): DynamicContextStrategy {
    return this.settingsManager?.resolveDynamicContextStrategy(promptModeSnapshot, override) ?? (override === 'preserve' ? 'preserve' : 'single');
  }

  private mergeResponseWithCleanup(
    existing: Record<string, unknown> | undefined,
    patch: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      ...(existing && typeof existing === 'object' ? existing : {}),
      ...(patch || {})
    };
  }

  private async validateHiddenContinuationApproval(
    conversationId: string,
    hiddenFunctionResponse?: HiddenFunctionResponseData
  ): Promise<ChatErrorData | null> {
    const requirement = getHiddenContinuationApprovalRequirement(hiddenFunctionResponse);
    if (!requirement) {
      return null;
    }

    const gate = await getPendingApprovalGate(this.conversationManager, conversationId);
    if (!gate) {
      this.log.warn('approval_gate.missing', {
        conversationId,
        intent: requirement.intent,
        sourceToolId: hiddenFunctionResponse?.id || null,
        sourceToolName: hiddenFunctionResponse?.name || null
      });
      return {
        success: false,
        error: {
          code: 'APPROVAL_GATE_REQUIRED',
          message: `Missing pending approval gate for continuation intent: ${requirement.intent}.`
        }
      };
    }

    const approvalId = requirement.approvalId;
    if (!approvalId) {
      this.log.warn('approval_gate.approval_id_missing', {
        conversationId,
        intent: requirement.intent,
        gateId: gate.id,
        sourceToolId: hiddenFunctionResponse?.id || null,
        sourceToolName: hiddenFunctionResponse?.name || null
      });
      return {
        success: false,
        error: {
          code: 'APPROVAL_GATE_REQUIRED',
          message: `Missing approvalId for continuation intent: ${requirement.intent}.`
        }
      };
    }

    const expectedKind = getPendingApprovalGateKindForContinuationIntent(requirement.intent);
    const hiddenToolId = typeof hiddenFunctionResponse?.id === 'string' ? hiddenFunctionResponse.id.trim() : '';
    const hiddenToolName = typeof hiddenFunctionResponse?.name === 'string' ? hiddenFunctionResponse.name.trim() : '';

    if (!hiddenToolId || !hiddenToolName) {
      return {
        success: false,
        error: {
          code: 'APPROVAL_GATE_MISMATCH',
          message: 'Hidden continuation payload must include the original tool id and tool name.'
        }
      };
    }

    if (gate.id !== approvalId || gate.kind !== expectedKind || gate.continuationIntent !== requirement.intent || gate.sourceToolCallId !== hiddenToolId || gate.sourceToolName !== hiddenToolName) {
      this.log.warn('approval_gate.mismatch', {
        conversationId,
        intent: requirement.intent,
        approvalId,
        gateId: gate.id,
        gateKind: gate.kind,
        gateIntent: gate.continuationIntent,
        hiddenToolId: hiddenToolId || null,
        hiddenToolName: hiddenToolName || null
      });
      return {
        success: false,
        error: {
          code: 'APPROVAL_GATE_MISMATCH',
          message: `Approval gate mismatch for continuation intent: ${requirement.intent}.`
        }
      };
    }

    await clearPendingApprovalGate(this.conversationManager, conversationId);
    this.log.info('approval_gate.consumed', {
      conversationId,
      intent: requirement.intent,
      gateId: gate.id,
      sourceToolId: gate.sourceToolCallId,
      sourceToolName: gate.sourceToolName
    });
    return null;
  }

  private async clearPendingApprovalGateIfPresent(
    conversationId: string,
    reason: string
  ): Promise<void> {
    const gate = await getPendingApprovalGate(this.conversationManager, conversationId);
    if (!gate) {
      return;
    }

    await clearPendingApprovalGate(this.conversationManager, conversationId);
    this.log.info('approval_gate.cleared', {
      conversationId,
      reason,
      gateId: gate.id,
      gateKind: gate.kind,
      sourceToolId: gate.sourceToolCallId,
      sourceToolName: gate.sourceToolName
    });
  }

  private normalizeTodoStatus(value: unknown): TodoStatusValue {
    if (value === 'in_progress' || value === 'completed' || value === 'cancelled') return value;
    return 'pending';
  }

  private normalizePlanUpdateMode(value: unknown): 'revision' | 'progress_sync' {
    return value === 'progress_sync' ? 'progress_sync' : 'revision';
  }

  private normalizeTodoList(raw: unknown): TodoItemValue[] {
    if (!Array.isArray(raw)) return [];
    const out: TodoItemValue[] = [];

    for (const item of raw) {
      const id = (item as any)?.id;
      const content = (item as any)?.content;
      const status = (item as any)?.status;
      if (typeof id !== 'string' || !id.trim()) continue;
      if (typeof content !== 'string') continue;

      out.push({
        id: id.trim(),
        content,
        status: this.normalizeTodoStatus(status),
      });
    }

    return out;
  }

  private applyTodoUpdateOps(existing: TodoItemValue[], rawOps: unknown): TodoItemValue[] {
    const result: Array<TodoItemValue | null> = existing.map((t) => ({ ...t }));
    const indexById = new Map<string, number>();

    for (let i = 0; i < result.length; i++) {
      const t = result[i];
      if (t) indexById.set(t.id, i);
    }

    const ops = Array.isArray(rawOps) ? rawOps : [];
    for (const opAny of ops) {
      const op = (opAny as any)?.op;
      const idRaw = (opAny as any)?.id;
      const id = typeof idRaw === 'string' ? idRaw.trim() : '';

      if (op === 'add') {
        const content = (opAny as any)?.content;
        if (!id || typeof content !== 'string') continue;
        const status = this.normalizeTodoStatus((opAny as any)?.status);
        const idx = indexById.get(id);

        if (idx === undefined) {
          indexById.set(id, result.length);
          result.push({ id, content, status });
        } else {
          const current = result[idx];
          if (!current) continue;
          current.content = content;
          current.status = status;
        }
        continue;
      }

      if (!id) continue;
      const idx = indexById.get(id);
      if (idx === undefined) continue;
      const current = result[idx];
      if (!current) continue;

      if (op === 'set_status') {
        current.status = this.normalizeTodoStatus((opAny as any)?.status);
        continue;
      }

      if (op === 'set_content') {
        const content = (opAny as any)?.content;
        if (typeof content === 'string') current.content = content;
        continue;
      }

      if (op === 'cancel') {
        current.status = 'cancelled';
        continue;
      }

      if (op === 'remove') {
        result[idx] = null;
        indexById.delete(id);
      }
    }

    return result.filter((t): t is TodoItemValue => !!t);
  }

  private collectRespondedToolCallIds(history: Content[]): Set<string> {
    const responded = new Set<string>();
    for (const msg of history) {
      if (msg.role !== 'user' || !Array.isArray(msg.parts)) continue;
      for (const part of msg.parts) {
        const id = part.functionResponse?.id;
        if (typeof id === 'string' && id.trim()) {
          responded.add(id.trim());
        }
      }
    }
    return responded;
  }

  private isToolCallResponded(callId: string | undefined, responded: Set<string>): boolean {
    if (!callId) return true;
    const normalized = callId.trim();
    if (!normalized) return true;
    return responded.has(normalized);
  }

  private collectFunctionResponseById(history: Content[]): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();

    for (const msg of history) {
      if (msg.role !== 'user' || !Array.isArray(msg.parts)) continue;
      for (const part of msg.parts) {
        const response = part.functionResponse?.response;
        const idRaw = part.functionResponse?.id;
        if (typeof idRaw !== 'string' || !idRaw.trim()) continue;
        if (!response || typeof response !== 'object') continue;

        const id = idRaw.trim();
        const current = response as Record<string, unknown>;
        const prev = out.get(id);
        out.set(id, this.mergeResponseWithCleanup(prev, current));
      }
    }

    return out;
  }

  private replayTodoListFromHistory(history: Content[], respondedToolCallIds?: Set<string>): TodoItemValue[] | null {
    const responded = respondedToolCallIds || this.collectRespondedToolCallIds(history);
    const responseById = this.collectFunctionResponseById(history);

    let touched = false;
    let list: TodoItemValue[] = [];

    for (const msg of history) {
      if (msg.role !== 'model' || !Array.isArray(msg.parts)) continue;

      for (const part of msg.parts) {
        const call = part.functionCall;
        if (!call || call.rejected) continue;

        if (!this.isToolCallResponded(call.id, responded)) continue;

        const mergedResponse = (() => {
          if (typeof call.id !== 'string' || !call.id.trim()) return undefined;
          return responseById.get(call.id.trim());
        })();

        const args = call.args && typeof call.args === 'object' ? call.args as Record<string, unknown> : {};

        if (call.name === 'create_plan') {
          const prompt = (mergedResponse as any)?.planExecutionPrompt;
          if (typeof prompt !== 'string' || !prompt.trim()) continue;

          const todosInput = Array.isArray((mergedResponse as any)?.todos)
            ? (mergedResponse as any)?.todos
            : Array.isArray((mergedResponse as any)?.data?.todos)
              ? (mergedResponse as any)?.data?.todos
              : (args as any).todos;
          if (!Array.isArray(todosInput)) continue;
          list = this.normalizeTodoList(todosInput);
          touched = true;
          continue;
        }

        if (call.name === 'update_plan') {
          const updateMode = this.normalizePlanUpdateMode(
            (mergedResponse as any)?.data?.updateMode
            ?? (mergedResponse as any)?.updateMode
            ?? (args as any)?.updateMode
          );

          const todosInput = Array.isArray((mergedResponse as any)?.todos)
            ? (mergedResponse as any)?.todos
            : Array.isArray((mergedResponse as any)?.data?.todos)
              ? (mergedResponse as any)?.data?.todos
              : (args as any).todos;

          if (updateMode === 'progress_sync') {
            if (!Array.isArray(todosInput)) continue;
            list = this.normalizeTodoList(todosInput);
            touched = true;
            continue;
          }

          const prompt = (mergedResponse as any)?.planExecutionPrompt;
          if (typeof prompt !== 'string' || !prompt.trim()) {
            list = [];
            touched = true;
            continue;
          }

          list = Array.isArray(todosInput) ? this.normalizeTodoList(todosInput) : [];
          touched = true;
          continue;
        }

        if (call.name === 'todo_write') {
          const todosInput = Array.isArray((mergedResponse as any)?.todos)
            ? (mergedResponse as any)?.todos
            : Array.isArray((mergedResponse as any)?.data?.todos)
              ? (mergedResponse as any)?.data?.todos
              : (args as any).todos;
          if (!Array.isArray(todosInput)) continue;
          list = this.normalizeTodoList(todosInput);
          touched = true;
          continue;
        }

        if (call.name === 'todo_update') {
          if (!Array.isArray((args as any).ops)) continue;
          list = this.applyTodoUpdateOps(list, (args as any).ops);
          touched = true;
        }
      }
    }

    return touched ? list : null;
  }

  private async rebuildTodoListMetadataFromHistory(conversationId: string): Promise<void> {
    const history = await this.conversationManager.getHistoryRef(conversationId);
    const replayed = this.replayTodoListFromHistory(history);

    await this.conversationManager.setCustomMetadata(conversationId, 'todoList', replayed || []);

    // 回退/删除后不再从历史“恢复 Build 壳”，避免出现 Recovered Build。
    // activeBuild 仅由真实的计划执行流程维护。
    await this.conversationManager.setCustomMetadata(conversationId, 'activeBuild', null);
  }

  async refreshDerivedMetadataAfterHistoryMutation(conversationId: string): Promise<void> {
    await this.rebuildTodoListMetadataFromHistory(conversationId);
  }

  /**
   * 写入（或替换）一条隐藏 functionResponse。
   *
   * 用途：前端需要“继续对话”但不创建可见 user 文本消息（例如 Plan 执行确认）。
   *
   * 规则：
   * 1) 若提供 id，优先在历史中按 functionResponse.id 精确匹配并替换；
   * 2) 否则（或未匹配到）追加一条 isFunctionResponse 的 user 消息。
   */
  private async upsertHiddenFunctionResponse(
    conversationId: string,
    hidden: NonNullable<ChatRequestData['hiddenFunctionResponse']>,
  ): Promise<void> {
    const targetId = typeof hidden.id === 'string' && hidden.id.trim() ? hidden.id.trim() : undefined;

    if (targetId) {
      const history = await this.conversationManager.getHistoryRef(conversationId);

      for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role !== 'user' || !Array.isArray(msg.parts) || msg.parts.length === 0) continue;

        let matched = false;
        const nextParts: ContentPart[] = msg.parts.map((part) => {
          if (!part.functionResponse) return part;
          if (part.functionResponse.id !== targetId) return part;

          matched = true;
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              id: targetId,
              name: hidden.name,
              response: this.mergeResponseWithCleanup(part.functionResponse.response, hidden.response),
            },
          };
        });

        if (matched) {
          await this.conversationManager.updateMessage(conversationId, i, {
            parts: nextParts,
            isFunctionResponse: true,
          });
          return;
        }
      }
    }

    await this.conversationManager.addContent(conversationId, {
      role: 'user',
      parts: [{
        functionResponse: {
          id: targetId,
          name: hidden.name,
          response: hidden.response,
        },
      }],
      isFunctionResponse: true,
    });
  }

  /**
   * 请求前置清理：中断上一轮未完成的 diff 等待并关闭编辑器，拒绝所有未响应的工具调用。
   *
   * 流式与非流式入口共用（handleChatStream / handleRetryStream / handleChat / handleRetry）：
   * 在写入本轮输入到历史之前统一调用，避免上一轮悬空的 functionCall / pending diff 跨回合残留，
   * 导致下一次请求历史中出现带 functionCall 但没有 functionResponse 的消息而触发 API 400。
   *
   * mark/reset 成对且自带 try/finally：cancelAllPending / rejectAllPendingToolCalls 中任何
   * await 抛错都会复位中断标记，不会让全局 userInterruptFlag 泄漏（对照 handleChatStream 的
   * finally 用法；resetUserInterrupt 幂等，调用方后续 finally 再 reset 一次无副作用）。
   */
  private async prepareConversationForRequest(conversationId: string): Promise<void> {
    // 中断之前未完成的 diff 等待并关闭编辑器
    this.diffInterruptService.markUserInterrupt(conversationId);
    try {
      await this.diffInterruptService.cancelAllPending(conversationId);

      // 拒绝所有未响应的工具调用（在添加用户消息之前）
      // 悬空 functionCall 会被标记 rejected 并补 functionResponse，
      // 确保 functionResponse 插入到工具调用消息之后、用户消息之前
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);
    } finally {
      // 重置中断标记：中途任何 await 抛错都必须清理，
      // 否则全局中断标记残留，无会话 diff 被误取消
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }
  }

  /**
   * 非流式 Chat 流程
   */
  async handleChat(request: ChatRequestData): Promise<ChatSuccessData | ChatErrorData> {
    const { conversationId, configId, message, modelOverride, hiddenFunctionResponse } = request;

    // 1. 确保对话存在（自动创建）
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      return {
        success: false,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
    }

    if (!config.enabled) {
      return {
        success: false,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
    }

    const approvalValidationError = await this.validateHiddenContinuationApproval(conversationId, hiddenFunctionResponse);
    if (approvalValidationError) {
      return approvalValidationError;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot, request.dynamicContextStrategyOverride);

    if (!hiddenFunctionResponse) {
      await this.clearPendingApprovalGateIfPresent(conversationId, 'visible_user_message');
    }

    // 2.5 请求前置清理：中断上一轮未完成的 diff 等待、拒绝所有未响应的工具调用
    //（与流式 handleChatStream 对齐，避免悬空 functionCall/pending diff 跨回合残留）
    await this.prepareConversationForRequest(conversationId);

    // 3. 添加输入到历史
    if (hiddenFunctionResponse) {
      await this.upsertHiddenFunctionResponse(conversationId, hiddenFunctionResponse);
    } else {
      const userParts = this.messageBuilderService.buildUserMessageParts(message, request.attachments);
      await this.conversationManager.addMessage(conversationId, 'user', userParts, {
        isUserInput: request.source !== 'background_task',
        source: request.source
      });
    }

    // 4. 工具调用循环（委托给 ToolIterationLoopService，非流式）
    const maxToolIterations = this.getMaxToolIterations();
    const loopResult = await this.toolIterationLoopService.runNonStreamLoop(
      conversationId,
      configId,
      config,
      maxToolIterations,
      modelOverride,
      promptModeSnapshot,
      dynamicContextStrategy,
      !hiddenFunctionResponse,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        error: {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    return {
      success: true,
      content: loopResult.content!,
    };
  }

  /**
   * 非流式 Retry 流程
   */
  async handleRetry(request: RetryRequestData): Promise<ChatSuccessData | ChatErrorData> {
    const { conversationId, configId, modelOverride } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      return {
        success: false,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
    }

    if (!config.enabled) {
      return {
        success: false,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'retry');

    // 2.5 请求前置清理：中断上一轮未完成的 diff 等待、拒绝所有未响应的工具调用
    //（与流式 handleRetryStream 对齐，避免悬空 functionCall/pending diff 跨回合残留）
    await this.prepareConversationForRequest(conversationId);

    // 3. 工具调用循环（委托给 ToolIterationLoopService，非流式）
    const maxToolIterations = this.getMaxToolIterations();
    const loopResult = await this.toolIterationLoopService.runNonStreamLoop(
      conversationId,
      configId,
      config,
      maxToolIterations,
      modelOverride,
      promptModeSnapshot,
      dynamicContextStrategy,
      false,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        error: {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    return {
      success: true,
      content: loopResult.content!,
    };
  }

  /**
   * 非流式 EditAndRetry 流程
   */
  async handleEditAndRetry(
    request: EditAndRetryRequestData,
  ): Promise<ChatSuccessData | ChatErrorData> {
    const { conversationId, messageIndex, newMessage, configId, modelOverride } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      return {
        success: false,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
    }

    if (!config.enabled) {
      return {
        success: false,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
    }

    // 3. 验证消息索引和角色
    const message = await this.conversationManager.getMessage(conversationId, messageIndex);
    if (!message) {
      return {
        success: false,
        error: {
          code: 'MESSAGE_NOT_FOUND',
          message: t('modules.api.chat.errors.messageNotFound', { messageIndex }),
        },
      };
    }

    if (message.role !== 'user') {
      return {
        success: false,
        error: {
          code: 'INVALID_MESSAGE_ROLE',
          message: t('modules.api.chat.errors.canOnlyEditUserMessage', { role: message.role }),
        },
      };
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'edit_and_retry');

    // 3.5 请求前置清理：中断上一轮未完成的 diff 等待、拒绝所有未响应的工具调用
    //（与 handleChat/handleRetry 一致，避免悬空 functionCall/pending diff 跨回合残留）
    await this.prepareConversationForRequest(conversationId);

    // 4. 更新消息内容，并标记为动态提示词插入点
    await this.conversationManager.updateMessage(conversationId, messageIndex, {
      parts: [{ text: newMessage }],
      isUserInput: true,
      // 清除旧的 token 计数，强制重新计算
      tokenCountByChannel: {}
    });
    
    // 注：编辑后消息的 token 计数将在 getHistoryWithContextTrimInfo 中
    // 与系统提示词、动态上下文一起并行计算

    // 5. 删除后续所有消息（messageIndex+1 及之后）和关联的检查点
    const historyRef = await this.conversationManager.getHistoryRef(conversationId);
    if (messageIndex + 1 < historyRef.length) {
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, messageIndex + 1);
      await this.conversationManager.deleteToMessage(conversationId, messageIndex + 1);
      await this.rebuildTodoListMetadataFromHistory(conversationId);
    }
    
    // 5.5 清除裁剪状态（编辑后应重新计算裁剪）
    await this.toolIterationLoopService.clearTrimState(conversationId);

    // 6. 工具调用循环（委托给 ToolIterationLoopService，非流式）
    const maxToolIterations = this.getMaxToolIterations();
    const loopResult = await this.toolIterationLoopService.runNonStreamLoop(
      conversationId,
      configId,
      config,
      maxToolIterations,
      modelOverride,
      promptModeSnapshot,
      dynamicContextStrategy,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        error: {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    return {
      success: true,
      content: loopResult.content!,
    };
  }

  /**
   * 流式 Chat 流程
   */
  async *handleChatStream(
    request: ChatRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, message, modelOverride, hiddenFunctionResponse } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    if (!config.enabled) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
      return;
    }

    const approvalValidationError = await this.validateHiddenContinuationApproval(conversationId, hiddenFunctionResponse);
    if (approvalValidationError) {
      yield {
        conversationId,
        error: approvalValidationError.error
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot, request.dynamicContextStrategyOverride);

    if (!hiddenFunctionResponse) {
      await this.clearPendingApprovalGateIfPresent(conversationId, 'visible_user_message');
    }


    // 3. 请求前置清理：中断上一轮未完成的 diff 等待并关闭编辑器、
    //    拒绝所有未响应的工具调用（在添加用户消息之前，确保 functionResponse
    //    会被插入到工具调用消息之后、用户消息之前）
    await this.prepareConversationForRequest(conversationId);

    try {
      // 4/5/6. 写入输入到历史：
      // - 普通模式：用户文本消息 + before/after checkpoint
      // - 隐藏模式：写入（或替换）functionResponse，不创建可见 user 文本消息，也不创建用户消息 checkpoint
      if (!hiddenFunctionResponse) {
        // 4. 为用户消息创建存档点（如果配置了执行前）
        const beforeUserCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
          conversationId,
          'before',
        );
        if (beforeUserCheckpoint) {
          // 立即发送用户消息前存档点到前端
          yield {
            conversationId,
            checkpoints: [beforeUserCheckpoint],
            checkpointOnly: true as const,
          } satisfies ChatStreamCheckpointsData;
        }

        // 5. 添加用户消息到历史（包含附件）
        const userParts = this.messageBuilderService.buildUserMessageParts(message, request.attachments);
        await this.conversationManager.addMessage(conversationId, 'user', userParts, {
          isUserInput: request.source !== 'background_task',
          source: request.source
        });

        // 注：用户消息的 token 计数将在 ContextTrimService.getHistoryWithContextTrimInfo 中
        // 与系统提示词、动态上下文一起并行计算，节省时间

        // 6. 为用户消息创建存档点（如果配置了执行后）
        const afterUserCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
          conversationId,
          'after',
        );
        if (afterUserCheckpoint) {
          yield {
            conversationId,
            checkpoints: [afterUserCheckpoint],
            checkpointOnly: true as const,
          } satisfies ChatStreamCheckpointsData;
        }
      } else {
        await this.upsertHiddenFunctionResponse(conversationId, hiddenFunctionResponse);
      }
    } finally {
      // 7. 重置中断标记：中途任何 await 抛错都必须清理，
      // 否则全局中断标记残留，无会话 diff 被误取消（对照 delete 路径的 finally 用法）。
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    // 8. 判断是否是首条消息（需要刷新动态系统提示词）
    const currentHistoryCheck = await this.conversationManager.getHistoryRef(conversationId);
    const isFirstMessage = currentHistoryCheck.length === 1; // 只有刚添加的用户消息

    // 9. 工具调用循环（委托给 ToolIterationLoopService）
    const maxToolIterations = this.getMaxToolIterations();

    for await (const output of this.toolIterationLoopService.runToolLoop({
      conversationId,
      configId,
      config,
      modelOverride,
      abortSignal: request.abortSignal,
      summarizeAbortSignal: request.summarizeAbortSignal,
      isFirstMessage,
      maxIterations: maxToolIterations,
      isNewTurn: !hiddenFunctionResponse,
      promptModeSnapshot,
      dynamicContextStrategy,
    })) {
      yield output as ChatStreamOutput;
    }
  }

  /**
   * 流式 Retry 流程
   */
  async *handleRetryStream(
    request: RetryRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, modelOverride } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    if (!config.enabled) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'retry_stream');

    // 3. 请求前置清理：中断上一轮未完成的 diff 等待并关闭编辑器、
    //    拒绝所有未响应的工具调用（悬空 functionCall 会被标记 rejected 并补 functionResponse，
    //    历史里不会残留带 functionCall 但没有 functionResponse 的消息）
    await this.prepareConversationForRequest(conversationId);

    // 6. 判断是否需要刷新动态系统提示词
    const retryHistoryCheck = await this.conversationManager.getHistoryRef(conversationId);
    const isRetryFirstMessage =
      retryHistoryCheck.length === 1 && retryHistoryCheck[0].role === 'user';

    // 7. 工具调用循环（委托给 ToolIterationLoopService）
    const maxToolIterations = this.getMaxToolIterations();

    for await (const output of this.toolIterationLoopService.runToolLoop({
      conversationId,
      configId,
      config,
      modelOverride,
      abortSignal: request.abortSignal,
      summarizeAbortSignal: request.summarizeAbortSignal,
      isFirstMessage: isRetryFirstMessage,
      maxIterations: maxToolIterations,
      // 重试场景原本没有模型消息前检查点，这里显式关闭以保持行为一致
      createBeforeModelCheckpoint: false,
      // 重试的是 AI 回复，回合起始用户消息不变，复用其上缓存的动态上下文
      isNewTurn: false,
      promptModeSnapshot,
      dynamicContextStrategy,
    })) {
      yield output as ChatStreamOutput;
    }
  }

  /**
   * 流式 Reroll 流程（TREE-01：重新生成并保留旧回答）。
   *
   * 与 handleRetryStream 并存（决策 5）：retryStream 保留为内部兼容路径（错误条重试等），
   * 主流程切 reroll；本方法不再调用破坏性 deleteMessage，旧回答由分支图 sidecar 保留。
   *
   * 流程：
   * 1. 确保对话 / 验证配置（与 retry 一致）；
   * 2. 中断未完成的 diff 等待 + 拒绝所有未响应工具调用（与 retry 一致）；
   * 3. BranchService.startReroll：验证目标在活跃路径 → 旧助手节点及子树保留进 sidecar →
   *    创建新候选并激活 → 主历史截断到父用户节点之后（切换到新候选路径）；
   * 4. 复用现有工具循环生成内容（写入主历史尾部，functionResponse 走主历史正常路径，决策 8）；
   * 5. finally 中 BranchService.finishReroll：把流式结果回填进新候选节点（含续接节点）+ 更新摘要；
   *    失败也回填（决策 10：保留旧候选，新候选保留部分内容可切回查看）。
   */
  async *handleRerollStream(
    request: RerollRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, modelOverride } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    if (!config.enabled) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'reroll_stream');

    // 3. 中断之前未完成的 diff 等待并关闭编辑器
    this.diffInterruptService.markUserInterrupt(conversationId);
    let rerollStarted: { candidateNodeId: string } | undefined;
    try {
      await this.diffInterruptService.cancelAllPending(conversationId);

      // 3.5 拒绝所有未响应的工具调用（与 retry 一致；悬空 functionCall 会被标记 rejected 并补
      // functionResponse，随后由 startReroll 的主历史截断一并移除——它们属于被 reroll 的旧子树）
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      // 3.6 reroll 底座：验证节点 → 旧候选进 sidecar → 创建新候选并激活 → 主历史切到新候选路径
      const branchService = getGlobalBranchService();
      if (!branchService) {
        yield {
          conversationId,
          error: {
            code: 'BRANCH_SERVICE_UNAVAILABLE',
            message: 'branch service is not registered; open the branch panel first',
          },
        };
        return;
      }

      // startReroll 会从目标助手消息自身开始截断；截断前先清理同一起点及之后的旧检查点。
      // 对工具续接回答，目标前的模型工具调用与 functionResponse 都会保留。
      const historyBeforeTruncate = await this.conversationManager.getMessagesRaw(conversationId);
      const truncateIndex = resolveRerollTruncateIndex(historyBeforeTruncate, request.assistantNodeId);
      if (truncateIndex > 0) {
        await this.checkpointService.deleteCheckpointsFromIndex(conversationId, truncateIndex);
      }

      rerollStarted = await branchService.startReroll(conversationId, request.assistantNodeId);
    } finally {
      // 4. 重置中断标记：中途任何 await 抛错都必须清理（与 handleRetryStream 的 finally 用法一致）
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    // 5. 判断是否需要刷新动态系统提示词（截断后主历史可能只剩首条用户消息，与 retry 语义一致）
    const rerollHistoryCheck = await this.conversationManager.getHistoryRef(conversationId);
    const isRerollFirstMessage =
      rerollHistoryCheck.length === 1 && rerollHistoryCheck[0].role === 'user';

    // 6. 工具调用循环（复用现有循环；functionResponse 走主历史正常路径，决策 8）
    const maxToolIterations = this.getMaxToolIterations();
    let finishError: { code: string; message: string } | undefined;
    try {
      for await (const output of this.toolIterationLoopService.runToolLoop({
        conversationId,
        configId,
        config,
        modelOverride,
        abortSignal: request.abortSignal,
        summarizeAbortSignal: request.summarizeAbortSignal,
        isFirstMessage: isRerollFirstMessage,
        maxIterations: maxToolIterations,
        // reroll 的是 AI 回复，回合起始用户消息不变，复用其上缓存的动态上下文
        createBeforeModelCheckpoint: false,
        isNewTurn: false,
        promptModeSnapshot,
        dynamicContextStrategy,
      })) {
        yield output as ChatStreamOutput;
      }
    } finally {
      // 7. 流式结果写入新节点 + 更新摘要；失败也回填（决策 10：失败保留旧候选，可切回）
      if (rerollStarted) {
        try {
          const branchService = getGlobalBranchService();
          if (branchService) {
            await branchService.finishReroll(conversationId, rerollStarted.candidateNodeId);
          }
        } catch (error) {
          // M2（R6a-FIX）：不再只 log.warn 吞掉——记录结构化事件，并在下方透出 error chunk
          this.log.warn('reroll_finish_sync_failed', {
            conversationId,
            candidateNodeId: rerollStarted.candidateNodeId,
            error: (error as Error)?.message ?? String(error),
          });
          finishError = {
            code: 'REROLL_FINISH_SYNC_FAILED',
            message: `reroll result sync to branch graph failed: ${(error as Error)?.message ?? String(error)}`,
          };
        }
      }
    }
    // 7.5 M2：主历史已显示新内容但图回填失败 → 透出结构化 error chunk（前端错误条可见），
    // 候选保留占位（决策 10：失败候选保留，可切回查看）。
    // 注：工具循环自身抛错时此处不可达（异常直接传播，由 ChatHandler 转 error chunk）。
    if (finishError) {
      yield {
        conversationId,
        error: finishError,
      };
    }
  }

  /**
   * 流式编辑用户消息（TREE-03：编辑用户消息时默认创建新的用户消息分支，不覆盖原消息；
   * request.mode === 'keep' 时改为原地改写原消息，保持当前分支）。
   *
   * 与 handleEditAndRetryStream（破坏性覆盖 + 截断）并存（决策 5 精神）：旧路径保留为内部兼容，
   * 主流程切编辑分支；本方法不覆盖原消息——旧用户节点及其子树由分支图 sidecar 保留。
   *
   * 流程（复用 reroll 底座编排结构，TREE-01/02 同款锁与验证结构）：
   * 1. 确保对话 / 验证配置（与 reroll 一致）；
   * 2. 中断未完成的 diff 等待 + 拒绝所有未响应工具调用（与 reroll 一致）；
   * 3. 解析并校验编辑目标（活跃路径 + role==='user' + 非根节点）；
   * 4. mode='branch'（默认）：BranchService.editCandidate——在旧用户节点父节点下创建编辑候选
   *    （新 user 节点 kind='edit'，文本=编辑后内容）并激活（旧子树保留进 sidecar）；
   *    mode='keep'：直接改写活跃路径上的原用户消息（updateMessage + 截断其后内容），
   *    BranchService.updateActiveNodeParts 同步分支图节点内容（保持当前分支，不产生新候选）；
   * 5. mode='branch'：BranchService.createRerollCandidate——在新用户节点下创建模型候选占位
   *    （流式结果写入此节点；缺少 startEditBranch 公共方法，见设计说明）；
   * 6. 主历史截断（branch：截断到旧用户节点之前并追加编辑后的用户消息，id 对齐新用户节点 BR-01；
   *    keep：截断到目标消息之后）
   * 7. 复用现有工具循环生成内容（编辑后用户消息内容变化 → 新回合语义，与 editAndRetryStream 一致）；
   * 8. finally 中（仅 branch）BranchService.finishReroll：把流式结果回填进模型候选节点（含续接节点）
   *    + 更新摘要；失败也回填（决策 10 精神：保留旧候选，新候选保留部分内容可切回查看）。
   */
  async *handleEditBranchStream(
    request: EditBranchRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, modelOverride } = request;

    // 0. 新文本校验
    if (typeof request.newText !== 'string' || request.newText.trim() === '') {
      yield {
        conversationId,
        error: {
          code: 'EDIT_BRANCH_INVALID_ARGS',
          message: 'newText is required',
        },
      };
      return;
    }

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    if (!config.enabled) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'edit_branch_stream');

    // 3. 中断之前未完成的 diff 等待并关闭编辑器
    this.diffInterruptService.markUserInterrupt(conversationId);
    let editStarted: { modelCandidateNodeId: string; parentNodeId: string } | undefined;
    try {
      await this.diffInterruptService.cancelAllPending(conversationId);

      // 3.5 拒绝所有未响应的工具调用（与 reroll 一致；悬空 functionCall 会被标记 rejected 并补
      // functionResponse，随后由主历史截断一并移除——它们属于被编辑的旧子树）
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      // 3.6 编辑分支底座需要全局 BranchService（懒初始化在 webview handler 完成）
      const branchService = getGlobalBranchService();
      if (!branchService) {
        yield {
          conversationId,
          error: {
            code: 'BRANCH_SERVICE_UNAVAILABLE',
            message: 'branch service is not registered; open the branch panel first',
          },
        };
        return;
      }

      // 3.7 解析并校验编辑目标（活跃路径 + user 角色 + 非根节点）；sidecar 损坏时快速失败
      const graphResult = await branchService.getBranchGraph(conversationId);
      if (graphResult.errorCode === 'BRANCH_STORAGE_CORRUPT') {
        throw new BranchError(
          'BRANCH_STORAGE_CORRUPT',
          `branches.json is corrupt for ${conversationId}; refusing to edit`
        );
      }
      const historyBefore = await this.conversationManager.getMessagesRaw(conversationId);
      const target = resolveEditTargetNode(graphResult.graph, historyBefore, request.userNodeId);

      // 3.8 按编辑模式分流：
      // - 'keep'：原地改写活跃路径上的原消息（保持当前分支，不产生新候选）；
      // - 'branch'（默认）：创建编辑候选（新 user 节点 kind='edit'，文本=编辑后内容）+ 激活 + 摘要
      //   （旧用户节点及其子树完整保留进 sidecar——先建图后截断，线性模式首次建图不丢旧消息）
      if (request.mode === 'keep') {
        // —— keep 模式：直接改写原消息，保持当前分支 ——
        const targetIndex = historyBefore.findIndex(message => message.id === target.nodeId);
        if (targetIndex === -1) {
          yield {
            conversationId,
            error: {
              code: 'NODE_NOT_FOUND',
              message: `target user node ${target.nodeId} not found in main history`,
            },
          };
          return;
        }

        // 3.8.1 先建图后截断：把完整旧历史并入分支图（无图时建线性基线图），
        //     截断后再软删被移除的子树——保证旧版本可回看（与 branch 模式 editCandidate 时机对齐）
        await branchService.ensureBranchGraph(conversationId);

        // 3.8.2 截断前清理目标消息之后的所有旧检查点（索引错位会让新内容命中旧检查点）
        await this.checkpointService.deleteCheckpointsFromIndex(conversationId, targetIndex);

        // 3.8.3 改写目标消息（清除 token 计数，强制在裁剪评估中重新计算）
        await this.conversationManager.updateMessage(conversationId, targetIndex, {
          parts: [{ text: request.newText }],
          isUserInput: true,
          tokenCountByChannel: {},
        });

        // 3.8.4 截断目标消息之后的内容（旧子树整体移出主历史；图侧同步软删为候选，可切回查看）
        const historyAfterEdit = await this.conversationManager.getHistoryRef(conversationId);
        if (targetIndex + 1 < historyAfterEdit.length) {
          // 决策 6：删除前捕获锚点（第一个被删消息 id）与最后保留消息 id，供删除后同步软删分支图子树
          const deletedFromMessageId = historyAfterEdit[targetIndex + 1]?.id ?? null;
          const lastKeptMessageId = historyAfterEdit[targetIndex]?.id ?? null;
          await this.conversationManager.deleteMessagesInRange(
            conversationId,
            targetIndex + 1,
            historyAfterEdit.length - 1,
          );
          await this.rebuildTodoListMetadataFromHistory(conversationId);
          try {
            await branchService.syncGraphAfterHistoryDelete(conversationId, deletedFromMessageId, {
              lastKeptMessageId,
            });
          } catch (error) {
            // 失败仅告警不阻断：主历史为唯一真源，图侧由下次读图/写图自校验兜底
            this.log.warn('edit_keep_branch_delete_sync_failed', {
              conversationId,
              targetIndex,
              error: (error as Error)?.message ?? String(error),
            });
          }
        }

        // 3.8.5 同步分支图：改写活跃节点内容 + 更新候选摘要（BR-01 同源：节点 id == Content.id）
        await branchService.updateActiveNodeParts(conversationId, target.nodeId, [{ text: request.newText }]);

        // 3.8.6 清除裁剪状态（编辑后应重新计算裁剪起点）
        await this.toolIterationLoopService.clearTrimState(conversationId);
        // editStarted 保持 undefined：无候选节点，流结束后无需 finishReroll
      } else {
        // —— branch 模式：创建编辑候选并切换分支 ——
        const created = await branchService.editCandidate(conversationId, target.parentNodeId, {
          role: 'user',
          parts: [{ text: request.newText }],
        });
        const newUserNodeId = created.nodeId;

        // 3.9 创建模型候选占位（流式结果将写入此节点；createRerollCandidate 是当前唯一可用的
        //     模型节点创建入口，kind 固定为 'reroll'——缺少 startEditBranch 公共方法，见设计说明）
        const modelCreated = await branchService.createRerollCandidate(conversationId, newUserNodeId, {
          parts: [],
        });
        const modelCandidateNodeId = modelCreated.nodeId;

        // 3.10 主历史截断到旧用户节点之前（父节点保留，旧子树整体移出主历史；图侧已保留）
        const historyAfterGraph = await this.conversationManager.getMessagesRaw(conversationId);
        const parentIndex = historyAfterGraph.findIndex(message => message.id === target.parentNodeId);
        // M1（R6a-FIX）：截断前清理截断点之后的旧检查点（与 handleEditAndRetryStream 对齐）——
        // 旧回合检查点原样保留在相同索引会让新候选消息命中旧检查点（索引错位，回档/恢复错状态）
        if (parentIndex >= 0) {
          await this.checkpointService.deleteCheckpointsFromIndex(conversationId, parentIndex + 1);
        }
        if (parentIndex >= 0 && parentIndex < historyAfterGraph.length - 1) {
          await this.conversationManager.deleteMessagesInRange(
            conversationId,
            parentIndex + 1,
            historyAfterGraph.length - 1,
          );
        }

        // 3.11 追加编辑后的用户消息（id 对齐新用户节点，BR-01 同源：节点 id == Content.id）
        await this.conversationManager.addContent(conversationId, {
          role: 'user',
          parts: [{ text: request.newText }],
          id: newUserNodeId,
          isUserInput: true,
        });

        editStarted = { modelCandidateNodeId, parentNodeId: target.parentNodeId };
      }
    } finally {
      // 4. 重置中断标记：中途任何 await 抛错都必须清理（与 handleRerollStream 的 finally 用法一致）
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    // 5. 工具调用循环（编辑后用户消息内容变化 → 新回合语义，与 editAndRetryStream 一致；
    //    模型消息前检查点保持默认开启）
    const maxToolIterations = this.getMaxToolIterations();
    let finishError: { code: string; message: string } | undefined;
    try {
      for await (const output of this.toolIterationLoopService.runToolLoop({
        conversationId,
        configId,
        config,
        modelOverride,
        abortSignal: request.abortSignal,
        summarizeAbortSignal: request.summarizeAbortSignal,
        // 编辑分支永不可能是会话首条消息（根节点不可编辑，编辑目标必有父节点）
        isFirstMessage: false,
        maxIterations: maxToolIterations,
        isNewTurn: true,
        promptModeSnapshot,
        dynamicContextStrategy,
      })) {
        yield output as ChatStreamOutput;
      }
    } finally {
      // 6. 流式结果写入模型候选节点 + 更新摘要；失败也回填（决策 10 精神：保留旧候选，可切回）
      if (editStarted) {
        try {
          const branchService = getGlobalBranchService();
          if (branchService) {
            await branchService.finishReroll(conversationId, editStarted.modelCandidateNodeId);
          }
        } catch (error) {
          // M2（R6a-FIX）：不再只 log.warn 吞掉——记录结构化事件，并在下方透出 error chunk
          this.log.warn('edit_branch_finish_sync_failed', {
            conversationId,
            candidateNodeId: editStarted.modelCandidateNodeId,
            error: (error as Error)?.message ?? String(error),
          });
          finishError = {
            code: 'EDIT_BRANCH_FINISH_SYNC_FAILED',
            message: `edit branch result sync to branch graph failed: ${(error as Error)?.message ?? String(error)}`,
          };
        }
      }
    }
    // 6.5 M2：主历史已显示新内容但图回填失败 → 透出结构化 error chunk（前端错误条可见）
    if (finishError) {
      yield {
        conversationId,
        error: finishError,
      };
    }
  }

  /**
   * 流式 EditAndRetry 流程
   */
  async *handleEditAndRetryStream(
    request: EditAndRetryRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, messageIndex, newMessage, configId, modelOverride, preserveCheckpointId } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    if (!config.enabled) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'edit_and_retry');

    // 3. 验证消息索引和角色
    const message = await this.conversationManager.getMessage(conversationId, messageIndex);
    if (!message) {
      yield {
        conversationId,
        error: {
          code: 'MESSAGE_NOT_FOUND',
          message: t('modules.api.chat.errors.messageNotFound', { messageIndex }),
        },
      };
      return;
    }

    if (message.role !== 'user') {
      yield {
        conversationId,
        error: {
          code: 'INVALID_MESSAGE_ROLE',
          message: t('modules.api.chat.errors.canOnlyEditUserMessage', { role: message.role }),
        },
      };
      return;
    }

    // 4. 中断之前未完成的 diff 等待并关闭编辑器
    this.diffInterruptService.markUserInterrupt(conversationId);
    try {
      await this.diffInterruptService.cancelAllPending(conversationId);
      
      // 4.5 拒绝所有未响应的工具调用
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      // 5. 删除该消息及后续所有消息的检查点（回档场景下保留刚用于恢复的存档点）
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, messageIndex, preserveCheckpointId);

      // 6. 为编辑后的用户消息创建存档点（执行前）
      const beforeEditCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
        conversationId,
        'before',
        messageIndex,
      );
      if (beforeEditCheckpoint) {
        yield {
          conversationId,
          checkpoints: [beforeEditCheckpoint],
          checkpointOnly: true as const,
        } satisfies ChatStreamCheckpointsData;
      }

      // 7. 更新消息内容（包含附件），并标记为动态提示词插入点
      const editParts = this.messageBuilderService.buildUserMessageParts(newMessage, request.attachments);
      await this.conversationManager.updateMessage(conversationId, messageIndex, {
        parts: editParts,
        isUserInput: true,
        // 清除旧的 token 计数，强制重新计算
        tokenCountByChannel: {}
      });
      
      // 注：编辑后消息的 token 计数将在 getHistoryWithContextTrimInfo 中
      // 与系统提示词、动态上下文一起并行计算

      // 8. 删除后续所有消息
      const historyRef = await this.conversationManager.getHistoryRef(conversationId);
      if (messageIndex + 1 < historyRef.length) {
        await this.conversationManager.deleteToMessage(conversationId, messageIndex + 1);
        await this.rebuildTodoListMetadataFromHistory(conversationId);
      }
      
      // 8.5 清除裁剪状态（编辑后应重新计算裁剪）
      await this.toolIterationLoopService.clearTrimState(conversationId);

      // 9. 为编辑后的用户消息创建存档点（执行后）
      const afterEditCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
        conversationId,
        'after',
        messageIndex,
      );
      if (afterEditCheckpoint) {
        yield {
          conversationId,
          checkpoints: [afterEditCheckpoint],
          checkpointOnly: true as const,
        } satisfies ChatStreamCheckpointsData;
      }
    } finally {
      // 10. 重置中断标记：中途任何 await 抛错都必须清理，
      // 否则全局中断标记残留，无会话 diff 被误取消。
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    // 11. 判断是否是编辑首条消息（需要刷新动态系统提示词）
    const isEditFirstMessage = messageIndex === 0;

    // 12. 工具调用循环（委托给 ToolIterationLoopService）
    const maxToolIterations = this.getMaxToolIterations();

    for await (const output of this.toolIterationLoopService.runToolLoop({
      conversationId,
      configId,
      config,
      modelOverride,
      abortSignal: request.abortSignal,
      summarizeAbortSignal: request.summarizeAbortSignal,
      isFirstMessage: isEditFirstMessage,
      maxIterations: maxToolIterations,
      promptModeSnapshot,
      dynamicContextStrategy,
    })) {
      yield output as ChatStreamOutput;
    }
  }

  /**
   * 工具确认流程
   */
  async *handleToolConfirmation(
    request: ToolConfirmationResponseData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, toolResponses, modelOverride } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    // 3. 寻找最后一条包含工具调用的 model 消息及其索引
    const history = await this.conversationManager.getHistoryRef(conversationId);
    if (history.length === 0) {
      yield {
        conversationId,
        error: {
          code: 'NO_HISTORY',
          message: t('modules.api.chat.errors.noHistory'),
        },
      };
      return;
    }

    // 从后往前找最近的一个 model 消息，它必须包含函数调用
    let modelMessageIndex = -1;
    let lastMessage: Content | undefined;

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'model') {
        const calls = this.toolCallParserService.extractFunctionCalls(history[i]);
        if (calls.length > 0) {
          modelMessageIndex = i;
          lastMessage = history[i];
          break;
        }
      }
    }

    if (!lastMessage || modelMessageIndex === -1) {
      yield {
        conversationId,
        error: {
          code: 'INVALID_STATE',
          message: t('modules.api.chat.errors.lastMessageNotModel'),
        },
      };
      return;
    }

    const allFunctionCalls = this.toolCallParserService.extractFunctionCalls(lastMessage);
    
    // 收集所有已经存在的函数响应 ID
    const respondedToolIds = new Set<string>();
    for (let i = modelMessageIndex + 1; i < history.length; i++) {
      const msg = history[i];
      if (msg.parts) {
        for (const part of msg.parts) {
          if (part.functionResponse?.id) {
            respondedToolIds.add(part.functionResponse.id);
          }
        }
      }
    }

    // 过滤掉已经有响应的工具调用（比如已经自动执行过的）
    const pendingCalls = allFunctionCalls.filter(call => !respondedToolIds.has(call.id));

    if (pendingCalls.length === 0) {
      // 如果没有待确认的工具，可能是已经被其他操作处理了，直接继续循环
      for await (const output of this.toolIterationLoopService.runToolLoop({
        conversationId,
        configId,
        config,
        modelOverride,
        abortSignal: request.abortSignal,
        summarizeAbortSignal: request.summarizeAbortSignal,
        isFirstMessage: false,
        maxIterations: this.getMaxToolIterations(),
        createBeforeModelCheckpoint: false,
        isNewTurn: false,
        promptModeSnapshot,
        dynamicContextStrategy,
      })) {
        yield output as ChatStreamOutput;
      }
      return;
    }

    // 4. 按“队列顺序”处理工具：一次只允许推进到下一个需要批准的工具。
    // 目标：工具之间解耦，但严格保证顺序（后一个必须等前一个成功/失败后才开始）。

    const messageIndex = modelMessageIndex;

    // 队首待处理工具（按 AI 输出顺序）
    const nextCall = allFunctionCalls.find(call => !respondedToolIds.has(call.id));
    if (!nextCall) {
      // 理论上不会发生，但为了健壮性，直接继续循环
      for await (const output of this.toolIterationLoopService.runToolLoop({
        conversationId,
        configId,
        config,
        modelOverride,
        abortSignal: request.abortSignal,
        summarizeAbortSignal: request.summarizeAbortSignal,
        isFirstMessage: false,
        maxIterations: this.getMaxToolIterations(),
        createBeforeModelCheckpoint: false,
        isNewTurn: false,
        promptModeSnapshot,
        dynamicContextStrategy,
      })) {
        yield output as ChatStreamOutput;
      }
      return;
    }

    const nextDecision = toolResponses.find(r => r.id === nextCall.id);
    if (!nextDecision) {
      yield {
        conversationId,
        error: {
          code: 'INVALID_TOOL_CONFIRMATION',
          message: `Invalid tool confirmation. Expected toolId=${nextCall.id}, got=${toolResponses.map(r => r.id).join(',')}`,
        },
      };
      return;
    }

    const toolResultsThisTurn: Array<{ id: string; name: string; result: Record<string, unknown> }> = [];
    const checkpointsThisTurn: CheckpointRecord[] = [];

    let responseParts: ContentPart[] = [];
    let multimodalAttachments: ContentPart[] = [];

    const mergeExecutionResult = (res: ToolExecutionFullResult) => {
      toolResultsThisTurn.push(...res.toolResults);
      checkpointsThisTurn.push(...res.checkpoints);
      responseParts.push(...res.responseParts);
      if (res.multimodalAttachments && res.multimodalAttachments.length > 0) {
        multimodalAttachments.push(...res.multimodalAttachments);
      }
    };

    const resolvedIdsThisTurn = new Set<string>();

    // 4.1 先处理队首工具（该工具一定是“当前等待批准”的那个）
    if (nextDecision.confirmed) {
      const gen = this.toolExecutionService.executeFunctionCallsWithProgress(
        [nextCall],
        conversationId,
        messageIndex,
        config,
        request.abortSignal,
        promptModeSnapshot,
        new Set([nextCall.id]),
        undefined,
        undefined,
        // A-COMM：主会话信箱按 conversationId + 主会话保留 runId 挂载
        conversationId,
        MAIN_SESSION_RUN_ID
      );

      while (true) {
        // gen.next() 与 abort race（复用 ToolIterationLoopService 857-870 行 abort-race 模式）：
        // 若当前工具不响应 abortSignal 且永不结束，单独的 await gen.next() 会让整个请求
        // （含停止按钮）永久挂起。abort 先到时先给生成器一个短暂收尾窗口：响应 abort 的
        // 工具会快速返回已完成部分的真实结果（不能丢，否则历史只剩“用户拒绝”占位），
        // 窗口结束仍未返回则放弃，随后由下方 abort 检查输出 cancelled 可读信号。
        let onAbort: (() => void) | undefined;
        const abortPromise = request.abortSignal
          ? new Promise<void>((resolve) => {
            onAbort = () => resolve();
            request.abortSignal!.addEventListener('abort', onAbort, { once: true });
          })
          : undefined;
        try {
          const nextPromise = gen.next();
          const winner = abortPromise
            ? await Promise.race([nextPromise, abortPromise])
            : await nextPromise;
          if (winner === undefined) {
            // abort 先到：收尾窗口内等生成器返回已完成部分的真实结果
            const drainedResult = await drainToolExecutionGeneratorAfterAbort(
              gen,
              nextPromise,
              MAIN_LOOP_ABORT_DRAIN_GRACE_MS,
            );
            if (drainedResult) {
              mergeExecutionResult(drainedResult);
            }
            break;
          }
          const { value, done } = winner;
          if (done) {
            mergeExecutionResult(value as ToolExecutionFullResult);
            break;
          }

          const event = value as ToolExecutionProgressEvent;

          if (event.type === 'start') {
            yield {
              conversationId,
              content: lastMessage,
              toolsExecuting: true as const,
              pendingToolCalls: [{
                id: event.call.id,
                name: event.call.name,
                args: event.call.args,
              }],
            } satisfies ChatStreamToolsExecutingData;
            continue;
          }

          if (event.type === 'end') {
            const r = event.toolResult.result as any;
            let status: ChatStreamToolStatusData['tool']['status'] = 'success';
            if (r?.success === false || r?.error || r?.cancelled || r?.rejected) {
              status = 'error';
            } else if (r?.data && r.data.appliedCount > 0 && r.data.failedCount > 0) {
              status = 'warning';
            }

            yield {
              conversationId,
              toolStatus: true as const,
              tool: {
                id: event.call.id,
                name: event.call.name,
                status,
                result: event.toolResult.result,
              },
            } satisfies ChatStreamToolStatusData;
          }
        } finally {
          if (onAbort && request.abortSignal) {
            request.abortSignal.removeEventListener('abort', onAbort);
          }
        }
      }

      resolvedIdsThisTurn.add(nextCall.id);
    } else {
      await this.conversationManager.rejectToolCalls(conversationId, messageIndex, [nextCall.id]);

      const rejectedResult = {
        success: false,
        error: t('modules.api.chat.errors.userRejectedTool'),
        rejected: true,
      };

      toolResultsThisTurn.push({
        id: nextCall.id,
        name: nextCall.name,
        result: rejectedResult,
      });

      yield {
        conversationId,
        toolStatus: true as const,
        tool: {
          id: nextCall.id,
          name: nextCall.name,
          status: 'error',
          result: rejectedResult,
        },
      } satisfies ChatStreamToolStatusData;

      resolvedIdsThisTurn.add(nextCall.id);
    }

    // 4.2 继续自动执行“紧随其后、且无需批准”的工具，直到遇到下一个需要批准的工具
    const nextIndex = allFunctionCalls.findIndex(c => c.id === nextCall.id);
    const autoSuffix: typeof allFunctionCalls = [];
    let nextConfirmTool: (typeof allFunctionCalls)[number] | null = null;

    for (let i = nextIndex + 1; i < allFunctionCalls.length; i++) {
      const c = allFunctionCalls[i];
      if (respondedToolIds.has(c.id) || resolvedIdsThisTurn.has(c.id)) {
        continue;
      }
      if (this.toolExecutionService.toolNeedsConfirmation(c.name, c.args, promptModeSnapshot)) {
        nextConfirmTool = c;
        break;
      }
      autoSuffix.push(c);
    }

    if (autoSuffix.length > 0) {
      const gen = this.toolExecutionService.executeFunctionCallsWithProgress(
        autoSuffix,
        conversationId,
        messageIndex,
        config,
        request.abortSignal,
        promptModeSnapshot,
        undefined,
        undefined,
        undefined,
        // A-COMM：主会话信箱按 conversationId + 主会话保留 runId 挂载
        conversationId,
        MAIN_SESSION_RUN_ID
      );

      while (true) {
        // 与上方队首工具循环相同的 abort-race + 收尾窗口模式：
        // 不响应 abort 且永不结束的工具不再让请求（含停止按钮）永久挂起；
        // abort 后由下方 abort 检查输出 cancelled 可读信号。
        let onAbort: (() => void) | undefined;
        const abortPromise = request.abortSignal
          ? new Promise<void>((resolve) => {
            onAbort = () => resolve();
            request.abortSignal!.addEventListener('abort', onAbort, { once: true });
          })
          : undefined;
        try {
          const nextPromise = gen.next();
          const winner = abortPromise
            ? await Promise.race([nextPromise, abortPromise])
            : await nextPromise;
          if (winner === undefined) {
            // abort 先到：收尾窗口内等生成器返回已完成部分的真实结果
            const drainedResult = await drainToolExecutionGeneratorAfterAbort(
              gen,
              nextPromise,
              MAIN_LOOP_ABORT_DRAIN_GRACE_MS,
            );
            if (drainedResult) {
              mergeExecutionResult(drainedResult);
            }
            break;
          }
          const { value, done } = winner;
          if (done) {
            mergeExecutionResult(value as ToolExecutionFullResult);
            break;
          }

          const event = value as ToolExecutionProgressEvent;

          if (event.type === 'start') {
            yield {
              conversationId,
              content: lastMessage,
              toolsExecuting: true as const,
              pendingToolCalls: [{
                id: event.call.id,
                name: event.call.name,
                args: event.call.args,
              }],
            } satisfies ChatStreamToolsExecutingData;
            continue;
          }

          if (event.type === 'end') {
            const r = event.toolResult.result as any;
            let status: ChatStreamToolStatusData['tool']['status'] = 'success';
            if (r?.success === false || r?.error || r?.cancelled || r?.rejected) {
              status = 'error';
            } else if (r?.data && r.data.appliedCount > 0 && r.data.failedCount > 0) {
              status = 'warning';
            }

            yield {
              conversationId,
              toolStatus: true as const,
              tool: {
                id: event.call.id,
                name: event.call.name,
                status,
                result: event.toolResult.result,
              },
            } satisfies ChatStreamToolStatusData;
          }
        } finally {
          if (onAbort && request.abortSignal) {
            request.abortSignal.removeEventListener('abort', onAbort);
          }
        }
      }

      for (const c of autoSuffix) {
        resolvedIdsThisTurn.add(c.id);
      }
    }

    // 5. 持久化本轮已执行工具的真实结果。
    // 必须在 abort 检查之前执行：cancelStream 的 rejectAllPendingToolCalls
    // 会抢先写入「用户拒绝」占位，若等 abort 检查后再写，addContent 的去重
    // 会把真实结果丢弃（副作用已发生：文件已写、命令已跑、检查点已建）。
    // settleFunctionResponses 会用真实结果就地覆盖占位，同时清除 functionCall.rejected 标记。
    if (responseParts.length > 0 || multimodalAttachments.length > 0) {
      const settleParts = multimodalAttachments.length > 0
        ? [...multimodalAttachments, ...responseParts]
        : responseParts;

      await this.conversationManager.settleFunctionResponses(conversationId, settleParts);
    }

    // 5.5 如果有用户批注，添加为新的用户消息
    if (request.annotation && request.annotation.trim()) {
      await this.conversationManager.addContent(conversationId, {
        role: 'user',
        parts: [{ text: request.annotation.trim() }],
      });
    }

    // 6. 检查是否已被中断。持久化（上方的 settleFunctionResponses / annotation）
    // 必须在 abort 检查之前执行，否则真实执行产生的工具结果会被丢弃，
    // 历史里只剩 rejectAllPendingToolCalls 写下的「用户拒绝」占位。
    if (request.abortSignal?.aborted) {
      yield {
        conversationId,
        cancelled: true as const,
      } as any;
      return;
    }

    const postToolStopState = await resolveAndPersistPostToolStopState(
      this.conversationManager,
      conversationId,
      allFunctionCalls,
      toolResultsThisTurn,
      {
        logger: this.log,
        logContext: { executionPath: 'tool_confirmation' }
      }
    );

    if (postToolStopState.shouldStop) {
      yield {
        conversationId,
        content: lastMessage,
        toolIteration: true as const,
        toolResults: toolResultsThisTurn,
        checkpoints: checkpointsThisTurn,
      } satisfies ChatStreamToolIterationData;
      return;
    }

    // 如果本轮存在 cancelled，则不再继续推进，也不再等待下一次确认
    const hasCancelledTools = toolResultsThisTurn.some(r => (r.result as any).cancelled);
    if (hasCancelledTools) {
      yield {
        conversationId,
        content: lastMessage,
        toolIteration: true as const,
        toolResults: toolResultsThisTurn,
        checkpoints: checkpointsThisTurn,
      } satisfies ChatStreamToolIterationData;
      return;
    }

    // 6. 如果还有需要批准的工具，进入等待确认阶段（不触发 toolIteration，也不继续 AI）
    if (nextConfirmTool) {
      yield {
        conversationId,
        pendingToolCalls: [{
          id: nextConfirmTool.id,
          name: nextConfirmTool.name,
          args: nextConfirmTool.args,
        }],
        content: lastMessage,
        awaitingConfirmation: true as const,
        toolResults: toolResultsThisTurn,
        checkpoints: checkpointsThisTurn,
      } satisfies ChatStreamToolConfirmationData;
      return;
    }

    // 7. 工具队列已全部完成，发送 toolIteration，并继续 AI 对话
    yield {
      conversationId,
      content: lastMessage,
      toolIteration: true as const,
      toolResults: toolResultsThisTurn,
      checkpoints: checkpointsThisTurn,
    } satisfies ChatStreamToolIterationData;

    // 注：工具响应和批注消息的 token 计数将在 getHistoryWithContextTrimInfo 中
    // 与系统提示词、动态上下文一起并行计算

    // 8. 继续 AI 对话（让 AI 处理工具结果）
    const maxToolIterations = this.getMaxToolIterations();

    for await (const output of this.toolIterationLoopService.runToolLoop({
      conversationId,
      configId,
      config,
      modelOverride,
      abortSignal: request.abortSignal,
      summarizeAbortSignal: request.summarizeAbortSignal,
      // 工具确认后的继续对话不视为首条消息
      isFirstMessage: false,
      maxIterations: maxToolIterations,
      // 原逻辑未在确认后的循环中创建模型消息前检查点，这里保持一致
      createBeforeModelCheckpoint: false,
      isNewTurn: false,
      promptModeSnapshot,
      dynamicContextStrategy,
    })) {
      yield output as ChatStreamOutput;
    }
  }

  /**
   * 删除到指定消息的流程
   */
  async handleDeleteToMessage(
    request: DeleteToMessageRequestData,
  ): Promise<DeleteToMessageSuccessData | DeleteToMessageErrorData> {
    const { conversationId, targetIndex, preserveCheckpointId } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 中断之前未完成的 diff 等待
    this.diffInterruptService.markUserInterrupt(conversationId);

    try {
      // 3. 取消所有待处理的 diff（关闭编辑器并恢复文件）
      await this.diffInterruptService.cancelAllPending(conversationId);
      
      // 4. 拒绝所有未响应的工具调用并持久化
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      await this.clearPendingApprovalGateIfPresent(conversationId, 'delete_to_message');

      // 5. 删除关联的检查点（回档场景下保留刚用于恢复的存档点，支持反复回档）
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, targetIndex, preserveCheckpointId);

      // 6. 删除消息
      // 决策 6：删除前捕获锚点（第一个被删消息 id）与最后保留消息 id，供删除后同步软删分支图子树。
      // 注意：必须在 deleteToMessage 之前读取（删除后这些消息已不在主历史中）。
      const historyBeforeDelete = await this.conversationManager.getMessagesRaw(conversationId);
      const deletedFromMessageId = historyBeforeDelete[targetIndex]?.id ?? null;
      const lastKeptMessageId = targetIndex > 0 ? (historyBeforeDelete[targetIndex - 1]?.id ?? null) : null;
      const deletedCount = await this.conversationManager.deleteToMessage(conversationId, targetIndex);

      // 6.2 决策 6：删除成功后同步软删分支图「该点之后」的整棵子树（TREE-09 软删语义：
      // 节点标记 deleted + deletedAt，不物理移除 sidecar；活跃尾同步回退到保留锚点）。
      // 锁取舍：deleteToMessage 的仓储互斥（会话写锁）已随方法返回释放，此处再取会话写锁
      // 是顺序获取（非嵌套），故同步 await 而非 fire-and-forget——删除响应返回前保证分支图一致
      // （避免响应后立即续写新消息时 appendHistoryToGraph 挂在已被硬删除的旧尾上）。
      // 失败仅告警不阻断：主历史为唯一真源，硬删除已提交，图侧由下次读图/写图自校验兜底。
      try {
        const branchService = getGlobalBranchService();
        if (branchService) {
          await branchService.syncGraphAfterHistoryDelete(conversationId, deletedFromMessageId, {
            lastKeptMessageId,
          });
        }
      } catch (error) {
        this.log.warn('branch_delete_to_sync_failed', {
          conversationId,
          targetIndex,
          error: (error as Error)?.message ?? String(error),
        });
      }

      // 6.5 根据剩余历史重放 todo 工具，修正 ConversationMetadata.custom.todoList
      await this.rebuildTodoListMetadataFromHistory(conversationId);
      
      // 7. 清除裁剪状态（回退后应重新计算裁剪）
      await this.toolIterationLoopService.clearTrimState(conversationId);

      return {
        success: true,
        deletedCount,
      };
    } finally {
      // 8. 重置 diff 中断标记：mark 之后的任何 await 抛错都必须清理，
      // 否则全局中断标记残留，无会话 diff 被误取消。
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }
  }
}
