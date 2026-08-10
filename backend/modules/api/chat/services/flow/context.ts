/**
 * Chat 流程编排共享执行上下文（flow 拆分辅助文件）。
 *
 * 承载 ChatFlowService 拆分后各流程编排器（orchestrator / retry / reroll / editBranch）
 * 共享的依赖引用、共享类型与私有辅助逻辑。所有编排器共享同一个 ChatFlowDeps 实例：
 * settingsManager 热更新通过该实例一处同步、全局生效（ChatFlowService.setSettingsManager）。
 */

import { Logger } from '../../../../../core/logger';
import type { ConfigManager } from '../../../../config/ConfigManager';
import type { ConversationManager } from '../../../../conversation/ConversationManager';
import type { SettingsManager } from '../../../../settings/SettingsManager';
import type { DynamicContextStrategy, ResolvedPromptModeSnapshot } from '../../../../settings/types';
import type { Content, ContentPart } from '../../../../conversation/types';

import type {
  ChatRequestData,
  HiddenFunctionResponseData,
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
} from '../../types';

import type { MessageBuilderService } from '../MessageBuilderService';
import type { ToolIterationLoopService } from '../ToolIterationLoopService';
import type { CheckpointService } from '../CheckpointService';
import type { DiffInterruptService } from '../DiffInterruptService';
import type { ToolExecutionService } from '../ToolExecutionService';
import type { ToolCallParserService } from '../ToolCallParserService';
import {
  clearPendingApprovalGate,
  getPendingApprovalGate,
  getPendingApprovalGateKindForContinuationIntent
} from '../../../../conversation/pendingApprovalGate';
import { getHiddenContinuationApprovalRequirement } from '../approvalGateRules';

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
  | ChatStreamAutoSummaryStatusData
  | ChatStreamCancelledData;

/**
 * C-19：取消信号输出（流式取消语义的显式类型成员；此前 yield cancelled 只能 as any 逃逸类型检查）。
 */
export interface ChatStreamCancelledData {
  conversationId: string;
  cancelled: true;
  content?: Content;
}

type TodoStatusValue = 'pending' | 'in_progress' | 'completed' | 'cancelled';
type TodoItemValue = { id: string; content: string; status: TodoStatusValue };

const CONVERSATION_PROMPT_MODE_KEY = 'promptModeConfig';

/**
 * 判断主历史是否仍处于「首条消息」状态（仅含首条真实用户消息，无其它活跃消息）。
 *
 * 逻辑截断语义下，被总结消息（isSummarized）会永远保留在历史中，不能计入活跃消息数，
 * 否则总结后的对话永远无法满足 length === 1，导致首条消息的动态系统提示词刷新逻辑失效。
 */
function isFirstMessageHistory(history: Content[]): boolean {
  const active = history.filter(message => !message.isSummarized);
  return active.length === 1 && active[0].role === 'user';
}

export { isFirstMessageHistory };

/**
 * Chat 流程编排依赖集合。
 *
 * 由 ChatFlowService 在构造时装配一次；settingsManager 为可变引用，
 * setSettingsManager 热更新时直接改写本对象的 settingsManager 字段即可全局生效。
 */
export interface ChatFlowDeps {
  log: Logger;
  configManager: ConfigManager;
  conversationManager: ConversationManager;
  settingsManager: SettingsManager | undefined;
  messageBuilderService: MessageBuilderService;
  toolIterationLoopService: ToolIterationLoopService;
  checkpointService: CheckpointService;
  diffInterruptService: DiffInterruptService;
  toolExecutionService: ToolExecutionService;
  toolCallParserService: ToolCallParserService;
  waitForOldStreamExit: (conversationId: string) => Promise<void>;
}

/**
 * Chat 流程编排共享执行上下文基类。
 *
 * 字段通过 getter 直读共享的 ChatFlowDeps 实例（不做拷贝），因此所有编排器
 * 对 settingsManager 的读取始终反映最新热更新值。共享辅助方法（原
 * ChatFlowService 私有方法）按原样迁移至此，行为与拆分前完全一致。
 */
export class ChatFlowContext {
  constructor(public readonly deps: ChatFlowDeps) {}

  get log(): Logger {
    return this.deps.log;
  }

  get configManager(): ConfigManager {
    return this.deps.configManager;
  }

  get conversationManager(): ConversationManager {
    return this.deps.conversationManager;
  }

  get settingsManager(): SettingsManager | undefined {
    return this.deps.settingsManager;
  }

  set settingsManager(value: SettingsManager | undefined) {
    this.deps.settingsManager = value;
  }

  get messageBuilderService(): MessageBuilderService {
    return this.deps.messageBuilderService;
  }

  get toolIterationLoopService(): ToolIterationLoopService {
    return this.deps.toolIterationLoopService;
  }

  get checkpointService(): CheckpointService {
    return this.deps.checkpointService;
  }

  get diffInterruptService(): DiffInterruptService {
    return this.deps.diffInterruptService;
  }

  get toolExecutionService(): ToolExecutionService {
    return this.deps.toolExecutionService;
  }

  get toolCallParserService(): ToolCallParserService {
    return this.deps.toolCallParserService;
  }

  get waitForOldStreamExit(): (conversationId: string) => Promise<void> {
    return this.deps.waitForOldStreamExit;
  }

  /**
   * 获取单回合最大工具调用次数
   */
  getMaxToolIterations(): number {
    return this.settingsManager?.getMaxToolIterations() ?? 20;
  }

  /**
   * 确保对话存在（不存在则创建）
   */
  async ensureConversation(conversationId: string): Promise<void> {
    await this.conversationManager.getHistory(conversationId);
  }

  normalizePromptModeId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized || undefined;
  }

  async resolvePromptModeSnapshot(
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

  resolveDynamicContextStrategy(
    promptModeSnapshot?: ResolvedPromptModeSnapshot,
    override?: DynamicContextStrategy
  ): DynamicContextStrategy {
    return this.settingsManager?.resolveDynamicContextStrategy(promptModeSnapshot, override) ?? (override === 'preserve' ? 'preserve' : 'single');
  }

  mergeResponseWithCleanup(
    existing: Record<string, unknown> | undefined,
    patch: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      ...(existing && typeof existing === 'object' ? existing : {}),
      ...(patch || {})
    };
  }

  async validateHiddenContinuationApproval(
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

  async clearPendingApprovalGateIfPresent(
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

  normalizeTodoStatus(value: unknown): TodoStatusValue {
    if (value === 'in_progress' || value === 'completed' || value === 'cancelled') return value;
    return 'pending';
  }

  normalizePlanUpdateMode(value: unknown): 'revision' | 'progress_sync' {
    return value === 'progress_sync' ? 'progress_sync' : 'revision';
  }

  normalizeTodoList(raw: unknown): TodoItemValue[] {
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

  applyTodoUpdateOps(existing: TodoItemValue[], rawOps: unknown): TodoItemValue[] {
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

  collectRespondedToolCallIds(history: Content[]): Set<string> {
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

  isToolCallResponded(callId: string | undefined, responded: Set<string>): boolean {
    if (!callId) return true;
    const normalized = callId.trim();
    if (!normalized) return true;
    return responded.has(normalized);
  }

  collectFunctionResponseById(history: Content[]): Map<string, Record<string, unknown>> {
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

  replayTodoListFromHistory(history: Content[], respondedToolCallIds?: Set<string>): TodoItemValue[] | null {
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

  async rebuildTodoListMetadataFromHistory(conversationId: string): Promise<void> {
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
  async upsertHiddenFunctionResponse(
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
  async prepareConversationForRequest(conversationId: string): Promise<void> {
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
}
