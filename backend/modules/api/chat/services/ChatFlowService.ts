/**
 * GrayCode - Chat 流程服务（应用服务层）
 *
 * 负责编排单次 Chat 调用的核心业务逻辑：
 * - 配置校验
 * - 对话存在性检查
 * - 用户消息写入 & checkpoint
 * - 工具调用循环（委托 ToolIterationLoopService / ToolExecutionService）
 *
 * 本文件为流程编排壳（第二批模块化拆分）：具体编排逻辑按职责拆分为 ./flow/ 子目录
 * （orchestrator / retry / reroll / editBranch），共享执行上下文见 ./flow/context。
 * 本类保留全部 public 方法与文件级导出符号（含流式/非流式各入口、reroll/editBranch
 * 请求类型与截断解析纯函数），对外 API 与拆分前完全一致。
 */

import { Logger } from '../../../../core/logger';
import type { ConfigManager } from '../../../config/ConfigManager';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { SettingsManager } from '../../../settings/SettingsManager';
import type { MessageBuilderService } from './MessageBuilderService';
import type { TokenEstimationService } from './TokenEstimationService';
import type { ToolIterationLoopService } from './ToolIterationLoopService';
import type { CheckpointService } from './CheckpointService';
import type { DiffInterruptService } from './DiffInterruptService';
import type { ToolExecutionService } from './ToolExecutionService';
import type { ToolCallParserService } from './ToolCallParserService';

import type {
  ChatRequestData,
  RetryRequestData,
  EditAndRetryRequestData,
  ToolConfirmationResponseData,
  DeleteToMessageRequestData,
  ChatSuccessData,
  ChatErrorData,
  DeleteToMessageSuccessData,
  DeleteToMessageErrorData,
} from '../types';

import type { ChatStreamOutput } from './flow/context';
import { ChatFlowDeps, ChatFlowContext } from './flow/context';
import type { RerollRequestData } from './flow/reroll';
import type { EditBranchRequestData } from './flow/editBranch';
import { ChatFlowOrchestrator } from './flow/orchestrator';
import { ChatFlowRetry } from './flow/retry';
import { ChatFlowReroll } from './flow/reroll';
import { ChatFlowEditBranch } from './flow/editBranch';

// H1：读取 webview 层注册的全局 abort manager，在写入用户消息/截断历史前等待旧流退出。
// 经 backend/core 桥接读取（第六批层反转修复）：webview 层 StreamRequestHandler 构造时
// 调用 setStreamAbortManager 注册实例，本类经 getStreamAbortManager() 读取；
// 未注册（测试/独立调用）时返回 undefined，等待退化为 no-op（与改造前一致）。
// 等待超时常量 OLD_STREAM_EXIT_WAIT_TIMEOUT_MS 已下沉 backend/core（第五批层反转修复）。
import { getStreamAbortManager } from '../../../../core/streamAbortBridge';
import { OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from '../../../../core/streamConstants';

// —— 文件级导出符号（保持与拆分前完全一致）——
export { ChatStreamOutput, ChatStreamCancelledData } from './flow/context';
export { RerollRequestData, resolveRerollTruncateIndex } from './flow/reroll';
export { EditBranchRequestData, EditTargetResolution, resolveEditTargetNode, buildEditUserParts } from './flow/editBranch';
export { resolveRetryTruncateIndex } from './flow/retry';

export class ChatFlowService {
  private readonly log = Logger.get('ChatFlow');
  private readonly flowDeps: ChatFlowDeps;
  private readonly flowContext: ChatFlowContext;
  private readonly orchestrator: ChatFlowOrchestrator;
  private readonly retryFlow: ChatFlowRetry;
  private readonly rerollFlow: ChatFlowReroll;
  private readonly editBranchFlow: ChatFlowEditBranch;

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
  ) {
    this.flowDeps = {
      log: this.log,
      configManager: this.configManager,
      conversationManager: this.conversationManager,
      settingsManager: this.settingsManager,
      messageBuilderService: this.messageBuilderService,
      toolIterationLoopService: this.toolIterationLoopService,
      checkpointService: this.checkpointService,
      diffInterruptService: this.diffInterruptService,
      toolExecutionService: this.toolExecutionService,
      toolCallParserService: this.toolCallParserService,
      waitForOldStreamExit: (conversationId) => this.waitForOldStreamExit(conversationId),
    };
    this.flowContext = new ChatFlowContext(this.flowDeps);
    this.orchestrator = new ChatFlowOrchestrator(this.flowDeps);
    this.retryFlow = new ChatFlowRetry(this.flowDeps);
    this.rerollFlow = new ChatFlowReroll(this.flowDeps);
    this.editBranchFlow = new ChatFlowEditBranch(this.flowDeps);
  }

  /**
   * 设置 SettingsManager（热更新引用，避免整体重建 ChatFlowService）。
   */
  setSettingsManager(settingsManager: SettingsManager | undefined): void {
    this.settingsManager = settingsManager;
    // 同步到 flow 执行上下文（各编排器共享同一 deps 对象，一次更新全局生效）
    this.flowDeps.settingsManager = settingsManager;
  }

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
    const abortManager = getStreamAbortManager();
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

  async refreshDerivedMetadataAfterHistoryMutation(conversationId: string): Promise<void> {
    await this.flowContext.refreshDerivedMetadataAfterHistoryMutation(conversationId);
  }

  /**
   * 非流式 Chat 流程
   */
  async handleChat(request: ChatRequestData): Promise<ChatSuccessData | ChatErrorData> {
    return this.orchestrator.handleChat(request);
  }

  /**
   * 流式 Chat 流程
   */
  async *handleChatStream(
    request: ChatRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    yield* this.orchestrator.handleChatStream(request);
  }

  /**
   * 工具确认流程
   */
  async *handleToolConfirmation(
    request: ToolConfirmationResponseData,
  ): AsyncGenerator<ChatStreamOutput> {
    yield* this.orchestrator.handleToolConfirmation(request);
  }

  /**
   * 删除到指定消息的流程
   */
  async handleDeleteToMessage(
    request: DeleteToMessageRequestData,
  ): Promise<DeleteToMessageSuccessData | DeleteToMessageErrorData> {
    return this.orchestrator.handleDeleteToMessage(request);
  }

  /**
   * 非流式 Retry 流程
   */
  async handleRetry(request: RetryRequestData): Promise<ChatSuccessData | ChatErrorData> {
    return this.retryFlow.handleRetry(request);
  }

  /**
   * 流式 Retry 流程
   */
  async *handleRetryStream(
    request: RetryRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    yield* this.retryFlow.handleRetryStream(request);
  }

  /**
   * 流式 Reroll 流程（TREE-01：重新生成并保留旧回答）
   */
  async *handleRerollStream(
    request: RerollRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    yield* this.rerollFlow.handleRerollStream(request);
  }

  /**
   * 流式编辑用户消息（TREE-03：编辑分支）
   */
  async *handleEditBranchStream(
    request: EditBranchRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    yield* this.editBranchFlow.handleEditBranchStream(request);
  }

  /**
   * 非流式 EditAndRetry 流程
   */
  async handleEditAndRetry(
    request: EditAndRetryRequestData,
  ): Promise<ChatSuccessData | ChatErrorData> {
    return this.editBranchFlow.handleEditAndRetry(request);
  }

  /**
   * 流式 EditAndRetry 流程
   */
  async *handleEditAndRetryStream(
    request: EditAndRetryRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    yield* this.editBranchFlow.handleEditAndRetryStream(request);
  }
}

