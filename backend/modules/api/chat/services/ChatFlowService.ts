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
import { randomUUID } from 'node:crypto';
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
  extractBranchContentMetadata,
  getGlobalBranchService,
  isFunctionResponseMessage,
} from '../../../conversation/branch';
import type { BranchService, ConversationBranchGraph } from '../../../conversation/branch';
// H1：读取 webview 层注册的全局 abort manager，在写入用户消息/截断历史前等待旧流退出。
// StreamAbortManager 仅依赖 backend/core 与 tools/subagents，不构成与 api/chat 的循环依赖。
import {
  StreamAbortManager,
  OLD_STREAM_EXIT_WAIT_TIMEOUT_MS,
} from '../../../../../webview/stream/StreamAbortManager';

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

/**
 * C-6：创建与 abortSignal race 的 Promise，供 gen.next() 主循环防挂起。
 *
 * - 信号已中止时立即 resolve（避免 listener 注册后信号永不触发、Promise 永不落定）；
 * - 返回 dispose() 在 finally 中移除 listener，防止泄漏。
 */
function createAbortRacePromise(signal: AbortSignal | undefined): {
  abortPromise: Promise<void> | undefined;
  dispose: () => void;
} {
  if (!signal) {
    return { abortPromise: undefined, dispose: () => {} };
  }
  if (signal.aborted) {
    return { abortPromise: Promise.resolve(), dispose: () => {} };
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    abortPromise,
    dispose: () => {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/**
 * reroll（重新生成并保留旧回答）请求数据（TREE-01）。
 * 与 RetryRequestData 的区别：不删除旧回答——后端在 BranchGraph 中把旧助手节点及其子树
 * 保留为候选（进 sidecar），新建候选并切换主历史到新候选路径；失败时旧候选始终保留，
 * 新候选已有部分输出则保留，完全无输出则移除空占位。
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
 * 失败时旧候选始终保留；新模型候选完全无输出时移除空占位。
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
  /**
   * 可选，被编辑消息的消息 ID（与 userNodeId 同源；前端二者均传目标消息 id）。
   *
   * 供后端做防索引漂移校验（与 EditAndRetryRequestData.messageId 同语义）；
   * 旧前端不带该字段时保持旧行为。
   */
  messageId?: string;
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
  /**
   * 新编辑候选的父节点 id（旧用户节点的父节点；null 即根节点，不可编辑）。
   * keep 模式（原地改写）编辑根节点时为 null（该模式不创建候选，不使用父节点）。
   */
  parentNodeId: string | null;
}

/**
 * TREE-03：解析并校验编辑目标（纯函数，可单测）。
 *
 * - 显式 userNodeId：图模式校验「存在 + 在活跃路径 + role==='user' + 非根节点」；
 *   线性模式（graph 为 null）以主历史为活跃路径，父节点取前一个非 functionResponse 消息
 *   （与 importLinearHistory 的线性链接规则一致，决策 8）；
 * - keep 模式（mode='keep'，原地改写）放行根节点：不创建候选、不需要父节点；
 *   branch 模式（默认）仍拒绝根节点（BranchGraph 单根模型，根节点无父节点可挂编辑候选）。
 * - 省略 userNodeId：取活跃路径上最后一条可编辑用户消息；
 * - 错误码：节点缺失 NODE_NOT_FOUND；非 user / 不在活跃路径 / branch 模式编辑根节点 → INVALID_BRANCH_RELATION。
 */
export function resolveEditTargetNode(
  graph: ConversationBranchGraph | null,
  history: ReadonlyArray<Content>,
  userNodeId?: string,
  mode: 'branch' | 'keep' = 'branch',
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
        // 根节点（无父节点可挂「新 user 编辑节点」）：keep 原地改写；
        // branch（TREE-03-R）原地改写根节点 + 截断其后 + 新建模型候选重新生成。
        return { nodeId: userNodeId, parentNodeId: null };
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
      // 线性模式根节点（首条消息）：语义同上方图模式根节点分支
      return { nodeId: userNodeId, parentNodeId: null };
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

/**
 * 解析 retry 主历史截断起始索引（最后一段 AI 回复的起点）。
 *
 * retry 语义是“重新生成最后一段 AI 回复”：只删除最后一个非 model 消息（user /
 * functionResponse）之后的 model 尾巴。若历史末尾本来就不是 model（例如失败流从未
 * 写出内容，最后一条仍是 user），则返回 -1 不截断——此时重试 = 继续生成，绝不能
 * 误删更早已经正常完成的 AI 回复。
 *
 * 若末尾 model 保留，请求 messages 的最后一条会是 assistant——
 * - 带 tool_calls 时，DeepSeek 等 API 会把最后一条 assistant 当作 prefill 前缀，
 *   直接 400 "Function call should not be used with prefix"（被重试的消息原样被预填）；
 * - 纯文本时也会被当作 prefill 续写，重试变成接龙，语义错误。
 */
export function resolveRetryTruncateIndex(history: ReadonlyArray<Content>): number {
  // 从末尾往前找最后一个「非 model 消息」（user / functionResponse / system 等）。
  // 它之后的所有 model 消息就是需要重试的 AI 回复尾巴。
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message.role !== 'model' || isFunctionResponseMessage(message)) {
      return i + 1 < history.length ? i + 1 : -1;
    }
  }
  // 历史全部是 model（异常状态）：从 0 开始删，保证请求不再以 assistant 结尾。
  return history.length > 0 ? 0 : -1;
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
  // 决策 8 口径：functionResponse 是隐藏回复（不独立成消息），upsertHiddenFunctionResponse
  // 追加的 user+functionResponse 回复不能算作「首条用户消息」，否则隐藏续接场景下
  // 动态系统提示词会被当作首条消息错误刷新（多余 token 消耗）。
  return active.length === 1 && active[0].role === 'user' && !isFunctionResponseMessage(active[0]);
}

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
   * H1：等待旧流完全退出后再写用户消息/截断历史。
   *
   * 竞态：用户「停止后立即重发」时，旧流取消路径还要等工具结算窗口（约 3s）落盘、finally
   * 注销控制器；若新流不等旧流退出就写入，旧流的结算 addContent 会落在新用户消息之后
   * （半截旧回答/错位结算）。webview 层（StreamRequestHandler）已在 create() 前等待过一遍，
   * 这里对 reroll / editBranch 等不经 StreamRequestHandler 的入口兜底：
   * 只等「已退休旧流」的退出信号（新流控制器此时已登记，不能 abort），带超时兜底。
   * 未注册全局 abort manager（测试/独立调用）时退化为 no-op。
   */
  private async waitForOldStreamExit(conversationId: string): Promise<void> {
    const abortManager = StreamAbortManager.getGlobalInstance();
    if (!abortManager) return;
    try {
      await abortManager.waitForOldStreamCompletion(conversationId, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);
    } catch (error) {
      // 等待失败不应阻断请求主流程（等待内部已有超时兜底，此处仅防御性兜底）
      this.log.warn('old_stream_exit_wait_failed', {
        conversationId,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /**
   * M1：可选的消息 id 防索引漂移校验。
   *
   * 请求携带 messageId 时，校验索引处消息 id 与之一致；不一致说明索引已漂移（并发
   * 插入/删除/上下文压缩等），返回 MESSAGE_CHANGED 错误。不带 messageId 时返回 null，
   * 保持旧行为（兼容旧前端）。
   */
  private validateMessageIdForEdit(
    message: Content | undefined,
    messageId?: string,
  ): { code: string; message: string } | null {
    if (typeof messageId !== 'string' || messageId.trim() === '') {
      return null;
    }
    if (!message || message.id !== messageId.trim()) {
      return {
        code: 'MESSAGE_CHANGED',
        message: t('modules.api.chat.errors.messageChanged'),
      };
    }
    return null;
  }

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
    await this.conversationManager.getHistoryRef(conversationId);
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
    const { conversationId, configId, message, messageId, modelOverride, hiddenFunctionResponse } = request;

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
    // H1：先等旧流完全退出，再执行清理与写入用户消息（避免旧流结算落在新用户消息之后）
    await this.waitForOldStreamExit(conversationId);
    await this.prepareConversationForRequest(conversationId);

    // 3. 添加输入到历史；真实用户消息在创建时一次性携带动态上下文快照。
    if (hiddenFunctionResponse) {
      await this.upsertHiddenFunctionResponse(conversationId, hiddenFunctionResponse);
    } else {
      const userParts = this.messageBuilderService.buildUserMessageParts(message, request.attachments);
      const persistedMessageId = messageId || randomUUID();
      const turnDynamicContext = request.source === 'background_task'
        ? undefined
        : await this.toolIterationLoopService.createTurnDynamicContext(
            conversationId,
            persistedMessageId,
            promptModeSnapshot
          );
      await this.conversationManager.addMessage(conversationId, 'user', userParts, {
        isUserInput: request.source !== 'background_task',
        source: request.source,
        ...(turnDynamicContext
          ? { turnDynamicContext, turnDynamicContextStrategy: dynamicContextStrategy }
          : {})
      }, persistedMessageId);
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
      !hiddenFunctionResponse && request.source !== 'background_task',
      // H5：透传取消信号（自动总结调用使用 merged signal）
      request.abortSignal,
      request.summarizeAbortSignal,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        // maxToolIterations=-1 无限制模式的硬性兜底保障触发时，优先透出明确的
        // 硬性保障错误（迭代硬上限/墙钟时间上限）；否则走通用最大迭代次数错误。
        error: loopResult.guardError ?? {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    // C-1：非流式路径透传取消语义——abort 后若返回 success:true + content:undefined，
    // 前端会把取消当成功处理；流式路径已有 cancelled 输出，这里与之一致。
    if (loopResult.cancelled) {
      return {
        success: false,
        error: {
          code: 'CANCELLED',
          message: t('modules.api.chat.errors.requestCancelled'),
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
    // H1：先等旧流完全退出，再执行清理与截断（避免旧流结算落在重试截断之后）
    await this.waitForOldStreamExit(conversationId);
    await this.prepareConversationForRequest(conversationId);

    // 2.6 重试截断：删除主历史末尾的 model 消息（重新生成最后一条 AI 回复）。
    // 不删的话请求 messages 最后一条是 assistant——带 tool_calls 时 DeepSeek 等 API
    // 会把它当作 prefill 前缀直接 400（"Function call should not be used with prefix"），
    // 纯文本时也会被 prefill 续写（重试变接龙）。放在 prepareConversationForRequest 之后：
    // 拒绝悬空工具调用补充的 functionResponse 一并落在删除范围内，避免残留孤儿 tool 消息。
    const retryHistory = await this.conversationManager.getMessagesRaw(conversationId);
    const retryTruncateIndex = resolveRetryTruncateIndex(retryHistory);
    if (retryTruncateIndex >= 0) {
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, retryTruncateIndex);
      await this.conversationManager.deleteMessagesInRange(conversationId, retryTruncateIndex, retryHistory.length - 1);
    }

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
      // H5：透传取消信号（自动总结调用使用 merged signal）
      request.abortSignal,
      request.summarizeAbortSignal,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        // maxToolIterations=-1 无限制模式的硬性兜底保障触发时，优先透出明确的
        // 硬性保障错误（迭代硬上限/墙钟时间上限）；否则走通用最大迭代次数错误。
        error: loopResult.guardError ?? {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    // C-1：非流式路径透传取消语义（与 handleChat 一致）
    if (loopResult.cancelled) {
      return {
        success: false,
        error: {
          code: 'CANCELLED',
          message: t('modules.api.chat.errors.requestCancelled'),
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

    if (message.role !== 'user' || isFunctionResponseMessage(message)) {
      return {
        success: false,
        error: {
          code: 'INVALID_MESSAGE_ROLE',
          message: t('modules.api.chat.errors.canOnlyEditUserMessage', { role: message.role }),
        },
      };
    }

    // M1：请求带 messageId 时校验索引处消息 id 一致，防止索引漂移导致编辑错消息
    const messageIdError = this.validateMessageIdForEdit(message, request.messageId);
    if (messageIdError) {
      return {
        success: false,
        error: messageIdError,
      };
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'edit_and_retry');

    // 3.5 请求前置清理：中断上一轮未完成的 diff 等待、拒绝所有未响应的工具调用
    //（与 handleChat/handleRetry 一致，避免悬空 functionCall/pending diff 跨回合残留）
    // H1：先等旧流完全退出，再执行清理与截断（避免旧流结算落在编辑截断之后）
    await this.waitForOldStreamExit(conversationId);
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
      // 编辑后的用户消息内容变化 → 新回合语义（与流式 editAndRetryStream 一致）
      true,
      // H5：透传取消信号（自动总结调用使用 merged signal）
      request.abortSignal,
      request.summarizeAbortSignal,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        // maxToolIterations=-1 无限制模式的硬性兜底保障触发时，优先透出明确的
        // 硬性保障错误（迭代硬上限/墙钟时间上限）；否则走通用最大迭代次数错误。
        error: loopResult.guardError ?? {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    // C-1：非流式路径透传取消语义（与 handleChat 一致）
    if (loopResult.cancelled) {
      return {
        success: false,
        error: {
          code: 'CANCELLED',
          message: t('modules.api.chat.errors.requestCancelled'),
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
    const { conversationId, configId, message, messageId, modelOverride, hiddenFunctionResponse } = request;

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
    // H1：先等旧流完全退出（webview 层已等待过一遍，这里对直接调用入口兜底），
    // 避免旧流取消结算落在新用户消息之后（半截旧回答/错位结算）
    await this.waitForOldStreamExit(conversationId);
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

        // 5. 添加用户消息到历史（包含附件）；携带前端稳定节点 id（BR-01 对齐）
        const userParts = this.messageBuilderService.buildUserMessageParts(message, request.attachments);
        const persistedMessageId = messageId || randomUUID();
        const turnDynamicContext = request.source === 'background_task'
          ? undefined
          : await this.toolIterationLoopService.createTurnDynamicContext(
              conversationId,
              persistedMessageId,
              promptModeSnapshot
            );
        await this.conversationManager.addMessage(conversationId, 'user', userParts, {
          isUserInput: request.source !== 'background_task',
          source: request.source,
          ...(turnDynamicContext
            ? { turnDynamicContext, turnDynamicContextStrategy: dynamicContextStrategy }
            : {})
        }, persistedMessageId);

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
    // 只有首条真实用户消息（逻辑截断下排除 isSummarized 残留）
    const isFirstMessage = isFirstMessageHistory(currentHistoryCheck);

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
      isNewTurn: !hiddenFunctionResponse && request.source !== 'background_task',
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
    // H1：先等旧流完全退出（webview 层已等待过一遍，这里对直接调用入口兜底）
    await this.waitForOldStreamExit(conversationId);
    await this.prepareConversationForRequest(conversationId);

    // 3.5 重试截断：删除主历史末尾的 model 消息（重新生成最后一条 AI 回复）。
    // 不删的话请求 messages 最后一条是 assistant——带 tool_calls 时 DeepSeek 等 API
    // 会把它当作 prefill 前缀直接 400（"Function call should not be used with prefix"），
    // 纯文本时也会被 prefill 续写（重试变接龙）。放在 prepareConversationForRequest 之后：
    // 拒绝悬空工具调用补充的 functionResponse 一并落在删除范围内，避免残留孤儿 tool 消息。
    // 注意：截断必须先于下方 isFirstMessageHistory 判断——截断后历史可能回到"仅首条用户消息"。
    const retryHistory = await this.conversationManager.getMessagesRaw(conversationId);
    const retryTruncateIndex = resolveRetryTruncateIndex(retryHistory);
    if (retryTruncateIndex >= 0) {
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, retryTruncateIndex);
      await this.conversationManager.deleteMessagesInRange(conversationId, retryTruncateIndex, retryHistory.length - 1);
    }

    // 6. 判断是否需要刷新动态系统提示词
    const retryHistoryCheck = await this.conversationManager.getHistoryRef(conversationId);
    const isRetryFirstMessage = isFirstMessageHistory(retryHistoryCheck);

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
   *    失败也回填：保留旧候选；新候选有部分内容则保留，无输出则移除空占位。
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

    // H1：先等旧流完全退出，再截断主历史并创建新候选——旧流取消结算若落在截断之后，
    // 半截旧回答会残留进新候选路径（reroll/editBranch 不经 StreamRequestHandler 的 create
    // 前置等待，此处在后端兜底）。
    await this.waitForOldStreamExit(conversationId);

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

    let finishError: { code: string; message: string } | undefined;
    try {
      // 5. 判断是否需要刷新动态系统提示词。放进最终回填保护区：即使读取历史或解析
      // 迭代上限意外失败，也不能把刚创建的空 reroll 占位永久留在活跃尾。
      const rerollHistoryCheck = await this.conversationManager.getHistoryRef(conversationId);
      const isRerollFirstMessage = isFirstMessageHistory(rerollHistoryCheck);

      // 6. 工具调用循环（复用现有循环；functionResponse 走主历史正常路径，决策 8）
      const maxToolIterations = this.getMaxToolIterations();
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
      // 7. 流式结果写入新节点 + 更新摘要；失败也回填（部分输出保留，无输出移除空占位）
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
    // 新候选可能已保留部分输出，也可能已移除空占位；旧候选始终可切回查看。
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
   *    + 更新摘要；失败也回填：保留旧候选，新候选有部分内容则保留，无输出则移除空占位。
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

    // H1：先等旧流完全退出，再截断主历史并创建编辑候选（与 reroll 同理，此处后端兜底）
    await this.waitForOldStreamExit(conversationId);

    // 3. 中断之前未完成的 diff 等待并关闭编辑器
    this.diffInterruptService.markUserInterrupt(conversationId);
    let editStarted: { modelCandidateNodeId: string; parentNodeId: string | null } | undefined;
    let editSetup: {
      branchService: BranchService;
      oldUserNodeId: string;
      newUserNodeId: string;
      modelCandidateNodeId: string;
      parentNodeId: string | null; // 根节点编辑（TREE-03-R）为 null
    } | undefined;
    try {
      await this.diffInterruptService.cancelAllPending(conversationId);

      // 3.5 拒绝所有未响应的工具调用（与 reroll 一致；悬空 functionCall 会被标记 rejected 并补
      // functionResponse，随后由主历史截断一并移除——它们属于被编辑的旧子树）
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      // 3.6 编辑分支底座需要启动期注册的全局 BranchService
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
      // 旧版本可能把已结束的空 reroll/edit 占位留在活跃尾，导致主历史继续增长而
      // branches.json 停更。编辑会截断/改写历史，必须先把当前路径安全归档；修复前先备份旧图。
      await branchService.ensureMainHistoryRepresentedInGraph(conversationId);
      const graphResult = await branchService.getBranchGraph(conversationId);
      if (graphResult.errorCode === 'BRANCH_STORAGE_CORRUPT') {
        throw new BranchError(
          'BRANCH_STORAGE_CORRUPT',
          `branches.json is corrupt for ${conversationId}; refusing to edit`
        );
      }
      const historyBefore = await this.conversationManager.getMessagesRaw(conversationId);
      // mode：keep 原地改写（不重新生成）；branch 根节点（TREE-03-R）原地改写 + 截断重生成
      const target = resolveEditTargetNode(graphResult.graph, historyBefore, request.userNodeId, request.mode);

      // 3.8 按编辑模式分流：
      // - 'keep'：真·原地保存——只改写目标消息文本，后续消息与分支全部保留，不重新生成；
      // - 'branch'（默认）：创建编辑候选（新 user 节点 kind='edit'，文本=编辑后内容）+ 激活 + 摘要
      //   （旧用户节点及其子树完整保留进 sidecar——先建图后截断，线性模式首次建图不丢旧消息）
      if (request.mode === 'keep') {
        // —— keep 模式：只改写目标消息，后续内容全部保留 ——
        const targetIndex = historyBefore.findIndex(message => message.id === target.nodeId);
        if (targetIndex === -1) {
          yield {
            conversationId,
            error: {
              code: 'NODE_NOT_FOUND',
              // C-16：旧数据消息可能无 id，findIndex 恒返回 -1——报错里说明可能原因，避免笼统的 not found
              message: `target user node ${target.nodeId} not found in main history (the message may lack an id or have been removed by context compaction)`,
            },
          };
          return;
        }

        // 3.8.1 建图（图节点内容同步需要；无图时建线性基线图）
        await branchService.ensureBranchGraph(conversationId);

        // 3.8.2 改写目标消息（清除 token 计数，强制在裁剪评估中重新计算）
        await this.conversationManager.updateMessage(conversationId, targetIndex, {
          parts: [{ text: request.newText }],
          isUserInput: true,
          tokenCountByChannel: {},
        });

        // 3.8.3 同步分支图节点内容 + 更新候选摘要（BR-01 同源：节点 id == Content.id）
        await branchService.updateActiveNodeParts(conversationId, target.nodeId, [{ text: request.newText }]);

        // 3.8.4 清除裁剪状态（编辑后应重新计算裁剪起点）
        await this.toolIterationLoopService.clearTrimState(conversationId);
        // 真·原地保存语义：不截断后续消息、不软删图子树、不删除检查点、不创建候选、不重新生成。
        // 后续 AI 回复与分支树保持原样，只有这条消息的文本被更新。
        // editStarted 保持 undefined：无候选节点，流结束后无需 finishReroll
      } else {
        // —— branch 模式：创建编辑候选并切换分支 ——
        // 根节点（TREE-03-R，parentNodeId === null）：无父节点可挂「新 user 编辑节点」，
        // 改为原地改写根节点文本 + 截断其后消息 + 新建模型候选重新生成（旧回答保留为
        // 可切换候选，与 reroll 同语义）；非根节点走常规 editCandidate 流程。
        const isRootEdit = target.parentNodeId === null;

        if (isRootEdit) {
          // 3.8R 根节点编辑重生成：改写根节点（同 keep 3.8.2/3.8.3）+ 模型候选 + 截断
          const targetIndex = historyBefore.findIndex(message => message.id === target.nodeId);
          if (targetIndex === -1) {
            yield {
              conversationId,
              error: {
                code: 'NODE_NOT_FOUND',
                // C-16：旧数据消息可能无 id，findIndex 恒返回 -1——报错里说明可能原因，避免笼统的 not found
                message: `target user node ${target.nodeId} not found in main history (the message may lack an id or have been removed by context compaction)`,
              },
            };
            return;
          }

          // 建图（图节点内容同步需要；无图时建线性基线图）
          await branchService.ensureBranchGraph(conversationId);

          // 改写根节点（清除 token 计数，强制在裁剪评估中重新计算）
          await this.conversationManager.updateMessage(conversationId, targetIndex, {
            parts: [{ text: request.newText }],
            isUserInput: true,
            tokenCountByChannel: {},
          });
          await branchService.updateActiveNodeParts(conversationId, target.nodeId, [{ text: request.newText }]);

          // 创建模型候选占位（流式结果写入此节点；根节点下挂候选与 reroll 同语义）
          const modelCreated = await branchService.createRerollCandidate(conversationId, target.nodeId, {
            parts: [],
          });
          const modelCandidateNodeId = modelCreated.nodeId;
          editSetup = {
            branchService,
            oldUserNodeId: target.nodeId,
            newUserNodeId: target.nodeId,
            modelCandidateNodeId,
            parentNodeId: null,
          };

          // 截断根节点之后的主历史（旧消息已由 3.7 ensureMainHistoryRepresentedInGraph 归档进图）
          await this.checkpointService.deleteCheckpointsFromIndex(conversationId, targetIndex + 1);
          if (targetIndex < historyBefore.length - 1) {
            await this.conversationManager.deleteMessagesInRange(
              conversationId,
              targetIndex + 1,
              historyBefore.length - 1,
            );
          }

          editStarted = { modelCandidateNodeId, parentNodeId: null };
        } else {
          // —— 非根节点：创建新 user 编辑候选（旧子树保留进 sidecar） ——
          const created = await branchService.editCandidate(conversationId, target.parentNodeId!, {
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
          editSetup = {
            branchService,
            oldUserNodeId: target.nodeId,
            newUserNodeId,
            modelCandidateNodeId,
            parentNodeId: target.parentNodeId!,
          };

          // 3.10 主历史截断到旧用户节点之前（父节点保留，旧子树整体移出主历史；图侧已保留）
          const historyAfterGraph = await this.conversationManager.getMessagesRaw(conversationId);
          const parentIndex = historyAfterGraph.findIndex(message => message.id === target.parentNodeId);
          // H3：父节点不在主历史时快速失败——继续追加消息会让主历史与分支图分叉（静默降级
          // 产生"幽灵"编辑候选：图侧激活了它，主历史却停在无关节点上）。父节点缺失通常意味着
          // 它已被上下文压缩移除，给出可读错误让用户刷新。
          if (parentIndex < 0) {
            throw new BranchError(
              'INVALID_BRANCH_RELATION',
              t('modules.api.chat.errors.editTargetNotInHistory'),
            );
          }
          // M1（R6a-FIX）：截断前清理截断点之后的旧检查点（与 handleEditAndRetryStream 对齐）——
          // 旧回合检查点原样保留在相同索引会让新候选消息命中旧检查点（索引错位，回档/恢复错状态）
          await this.checkpointService.deleteCheckpointsFromIndex(conversationId, parentIndex + 1);
          if (parentIndex < historyAfterGraph.length - 1) {
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

          // 3.11b 把持久化后的用户消息元数据补写进图节点——editCandidate 建节点时只有
          // parts/role/kind，没有主历史侧元数据（isUserInput/tokenCountByChannel 等）；
          // 不补写则切分支重写主历史时这些字段丢失（动态提示词插入点、前端用户图标、裁剪统计口径）。
          try {
            const persistedHistory = await this.conversationManager.getMessagesRaw(conversationId);
            const persistedUserMessage = persistedHistory.find(message => message.id === newUserNodeId);
            if (persistedUserMessage) {
              await branchService.updateNodeMetadata(
                conversationId,
                newUserNodeId,
                extractBranchContentMetadata(persistedUserMessage),
              );
            }
          } catch (metadataError) {
            // 元数据补写失败不阻断编辑主流程：切分支时的完整对账（rewriteHistoryFromBranchGraph）
            // 会按图节点内容重建，缺少数个非拓扑字段只影响展示/裁剪口径，下次分支操作可再修复。
            this.log.warn('edit_node_metadata_sync_failed', {
              conversationId,
              newUserNodeId,
              error: (metadataError as Error)?.message ?? String(metadataError),
            });
          }

          // branch 模式：非根节点 parentNodeId 必非 null
          editStarted = { modelCandidateNodeId, parentNodeId: target.parentNodeId! };
        }
      }
    } catch (error) {
      if (editSetup && !editStarted) {
        try {
          const currentHistory = await this.conversationManager.getMessagesRaw(conversationId);
          if (currentHistory.some(message => message.id === editSetup!.newUserNodeId)) {
            // addContent 可能已提交后才抛错；此时保留已落盘的编辑用户节点，只移除空模型占位。
            await editSetup.branchService.finishReroll(conversationId, editSetup.modelCandidateNodeId);
          } else {
            // 截断前失败则恢复旧用户路径；截断已落盘则回退其父节点。两种情况都只允许
            // 删除本次 edit + 空 reroll 的精确临时子树。
            // 根节点编辑（TREE-03-R）：parentNodeId 为 null，回退到根节点自身
            // （newUserNodeId === oldUserNodeId === 根节点，此时必然命中 oldUserNodeId 分支）
            const fallbackNodeId = currentHistory.some(message => message.id === editSetup!.oldUserNodeId)
              ? editSetup.oldUserNodeId
              : (editSetup!.parentNodeId ?? editSetup!.oldUserNodeId);
            await editSetup.branchService.abortEmptyCandidateSetup(conversationId, {
              setupRootNodeId: editSetup.newUserNodeId,
              emptyCandidateNodeId: editSetup.modelCandidateNodeId,
              fallbackNodeId,
            });
          }
        } catch (rollbackError) {
          this.log.error('edit_branch_setup_rollback_failed', {
            conversationId,
            newUserNodeId: editSetup.newUserNodeId,
            modelCandidateNodeId: editSetup.modelCandidateNodeId,
            error: (rollbackError as Error)?.message ?? String(rollbackError),
          });
        }
      }
      throw error;
    } finally {
      // 4. 重置中断标记：中途任何 await 抛错都必须清理（与 handleRerollStream 的 finally 用法一致）
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    // 5. 工具调用循环（branch 模式：编辑后用户消息内容变化 → 新回合语义；
    //    keep 模式为真·原地保存：不重新生成，流直接完成）
    if (request.mode !== 'keep') {
      let finishError: { code: string; message: string } | undefined;
      try {
        // 迭代上限解析同样必须位于最终回填保护区，避免异常时遗留空模型占位。
        const maxToolIterations = this.getMaxToolIterations();
        for await (const output of this.toolIterationLoopService.runToolLoop({
        conversationId,
        configId,
        config,
        modelOverride,
        abortSignal: request.abortSignal,
        summarizeAbortSignal: request.summarizeAbortSignal,
        // 根节点编辑（TREE-03-R）后主历史只剩首条消息：动态判断 isFirstMessage 以刷新
        // 系统提示词（与 send/retry/reroll 同口径）；非根节点编辑后必非首条，判断自然为 false
        isFirstMessage: isFirstMessageHistory(await this.conversationManager.getHistoryRef(conversationId)),
        maxIterations: maxToolIterations,
        isNewTurn: true,
        promptModeSnapshot,
        dynamicContextStrategy,
      })) {
        yield output as ChatStreamOutput;
      }
    } finally {
      // 6. 流式结果写入模型候选节点 + 更新摘要；失败也回填（部分输出保留，无输出移除空占位）
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
    } else {
      // keep 模式：不重新生成——直接结束流。complete **不带 content**：
      // 前端 handleStreamChunk 对无 content 的终结 chunk 走 resetTerminalStreamState
      // （纯状态复位，不替换消息）。此前携带 tail 最后一条消息（可能是 user 角色），
      // 若前端残留 streamingMessageId（旧流占位未清理），handleComplete 会用 user
      // 内容替换 assistant 消息，造成内容错乱；无 content 语义与 resetTerminalStreamState
      // 的设计注释（后端可能发送 content 为 null/undefined 的终结 chunk）一致。
      yield {
        conversationId,
      } satisfies ChatStreamCompleteData;
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

    if (message.role !== 'user' || isFunctionResponseMessage(message)) {
      yield {
        conversationId,
        error: {
          code: 'INVALID_MESSAGE_ROLE',
          message: t('modules.api.chat.errors.canOnlyEditUserMessage', { role: message.role }),
        },
      };
      return;
    }

    // M1：请求带 messageId 时校验索引处消息 id 一致，防止索引漂移导致编辑错消息
    const messageIdError = this.validateMessageIdForEdit(message, request.messageId);
    if (messageIdError) {
      yield {
        conversationId,
        error: messageIdError,
      };
      return;
    }

    // H1：先等旧流完全退出，再执行截断与更新（避免旧流结算落在编辑截断之后）
    await this.waitForOldStreamExit(conversationId);

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
        MAIN_SESSION_RUN_ID,
        // 主会话路径无嵌套深度、无工作区 URI（General Worker 模型继承见下）
        undefined,
        undefined,
        // General Worker 模型继承：把主会话当前模型透传给工具上下文
        modelOverride
      );

      while (true) {
        // gen.next() 与 abort race（复用 ToolIterationLoopService 857-870 行 abort-race 模式）：
        // 若当前工具不响应 abortSignal 且永不结束，单独的 await gen.next() 会让整个请求
        // （含停止按钮）永久挂起。abort 先到时先给生成器一个短暂收尾窗口：响应 abort 的
        // 工具会快速返回已完成部分的真实结果（不能丢，否则历史只剩“用户拒绝”占位），
        // 窗口结束仍未返回则放弃，随后由下方 abort 检查输出 cancelled 可读信号。
        const { abortPromise, dispose } = createAbortRacePromise(request.abortSignal);
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
            // C-19：工具结果按宽松形状窄化访问（unknown 收窄），替代裸 as any
            const r = event.toolResult.result as {
              success?: boolean;
              error?: string;
              cancelled?: boolean;
              rejected?: boolean;
              data?: { partial?: boolean; status?: string; appliedCount?: number; failedCount?: number };
            } | null | undefined;
            let status: ChatStreamToolStatusData['tool']['status'] = 'success';
            if (r?.success === false || r?.error || r?.cancelled || r?.rejected) {
              status = 'error';
            } else if (r?.data && (r.data.partial === true || r.data.status === 'partial' || ((r.data.appliedCount ?? 0) > 0 && (r.data.failedCount ?? 0) > 0))) {
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
          dispose();
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
        MAIN_SESSION_RUN_ID,
        // 主会话路径无嵌套深度、无工作区 URI（General Worker 模型继承见下）
        undefined,
        undefined,
        // General Worker 模型继承：把主会话当前模型透传给工具上下文
        modelOverride
      );

      while (true) {
        // 与上方队首工具循环相同的 abort-race + 收尾窗口模式：
        // 不响应 abort 且永不结束的工具不再让请求（含停止按钮）永久挂起；
        // abort 后由下方 abort 检查输出 cancelled 可读信号。
        const { abortPromise, dispose } = createAbortRacePromise(request.abortSignal);
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
            // C-19：工具结果按宽松形状窄化访问（unknown 收窄），替代裸 as any
            const r = event.toolResult.result as {
              success?: boolean;
              error?: string;
              cancelled?: boolean;
              rejected?: boolean;
              data?: { partial?: boolean; status?: string; appliedCount?: number; failedCount?: number };
            } | null | undefined;
            let status: ChatStreamToolStatusData['tool']['status'] = 'success';
            if (r?.success === false || r?.error || r?.cancelled || r?.rejected) {
              status = 'error';
            } else if (r?.data && (r.data.partial === true || r.data.status === 'partial' || ((r.data.appliedCount ?? 0) > 0 && (r.data.failedCount ?? 0) > 0))) {
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
          dispose();
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

    // 5. 检查是否已被中断。持久化（上方的 settleFunctionResponses）
    // 必须在 abort 检查之前执行，否则真实执行产生的工具结果会被丢弃，
    // 历史里只剩 rejectAllPendingToolCalls 写下的「用户拒绝」占位。
    if (request.abortSignal?.aborted) {
      yield {
        conversationId,
        cancelled: true as const,
      } satisfies ChatStreamCancelledData;
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
    const hasCancelledTools = toolResultsThisTurn.some(r => {
      const result = r.result as { cancelled?: boolean } | null | undefined;
      return result?.cancelled === true;
    });
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

    // H1：先等旧流完全退出，再执行删除（旧流取消结算若落在删除之后会把已删内容追加回来）
    await this.waitForOldStreamExit(conversationId);

    // 2. 中断之前未完成的 diff 等待
    this.diffInterruptService.markUserInterrupt(conversationId);

    try {
      // M1：请求带 messageId 时校验索引处消息 id 一致，防止索引漂移误删其他消息。
      // DeleteToMessageRequestData 已声明该可选字段，旧前端不传时保持旧行为。
      const requestMessageId = request.messageId;
      // 决策 6：删除前捕获锚点（第一个被删消息 id）与最后保留消息 id，供删除后同步软删分支图子树。
      // 必须同时用于 M1 校验：在校验与删除之间不得有其他写入（rejectAllPendingToolCalls 只追加）。
      const historyBeforeDelete = await this.conversationManager.getMessagesRaw(conversationId);
      // C-3：校验 targetIndex 边界。负数/越界此前会让 deletedFromMessageId 变 null、删除语义错误，
      // 这里在删除动作前显式拒绝，返回明确的 INVALID_TARGET_INDEX。
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= historyBeforeDelete.length) {
        return {
          success: false,
          error: {
            code: 'INVALID_TARGET_INDEX',
            message: t('modules.api.chat.errors.invalidTargetIndex', { targetIndex }),
          },
        };
      }
      if (typeof requestMessageId === 'string' && requestMessageId.trim() !== '') {
        const targetMessage = historyBeforeDelete[targetIndex];
        if (!targetMessage || targetMessage.id !== requestMessageId.trim()) {
          return {
            success: false,
            error: {
              code: 'MESSAGE_CHANGED',
              message: t('modules.api.chat.errors.messageChanged'),
            },
          };
        }
      }

      // 3. 取消所有待处理的 diff（关闭编辑器并恢复文件）
      await this.diffInterruptService.cancelAllPending(conversationId);
      
      // 4. 拒绝所有未响应的工具调用并持久化
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      await this.clearPendingApprovalGateIfPresent(conversationId, 'delete_to_message');

      // 5. 删除关联的检查点（回档场景下保留刚用于恢复的存档点，支持反复回档）
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, targetIndex, preserveCheckpointId);

      // 6. 删除消息
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
          // 截断区间内含总结消息：原文的 isSummarized 标记已恢复，必须按当前主历史重建
          // 活跃路径与消息元数据（summary_deleted），否则切分支后已恢复的原文会被图中
          // 陈旧的 isSummarized 元数据重新压缩；否则走常规「软删被删节点及其后续子树」。
          const deletedWasSummary = historyBeforeDelete
            .slice(targetIndex)
            .some(message => message.isSummary === true);
          if (deletedWasSummary) {
            await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'summary_deleted');
          } else {
            await branchService.syncGraphAfterHistoryDelete(conversationId, deletedFromMessageId, {
              lastKeptMessageId,
            });
          }
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
