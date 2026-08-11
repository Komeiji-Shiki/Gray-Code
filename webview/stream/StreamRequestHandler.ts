/**
 * 流式请求处理器
 * 
 * 处理所有流式消息类型
 */

import type * as vscode from 'vscode';
import type { ChatHandler } from '../../backend/modules/api/chat';
import type { ConversationManager } from '../../backend/modules/conversation';
import { StreamAbortManager, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from './StreamAbortManager';
import { setStreamAbortManager } from '../../backend/core/streamAbortBridge';
import { StreamChunkProcessor } from './StreamChunkProcessor';
import { t } from '../../backend/i18n';
import { getDiffManager } from '../../backend/core/services/diffManager';
import { ChannelError, ErrorType } from '../../backend/modules/channel/types';
import { assertSafeId } from '../../backend/core/idValidation';

export interface StreamHandlerDeps {
  chatHandler: ChatHandler;
  abortManager: StreamAbortManager;
  conversationManager: ConversationManager;
  /** 按 clientId 获取目标 webview；undefined 时回退到主聊天视图 */
  getClientView: (clientId?: string) => { webview: vscode.Webview } | undefined;
  sendResponse: (requestId: string, data: any) => void;
  sendError: (requestId: string, code: string, message: string) => void;
  /** 请求结束时清理 requestId → clientId 路由映射，防止 requestClients 泄漏 */
  finalizeRequest: (requestId: string) => void;
}

/**
 * 流式请求处理器
 */
export class StreamRequestHandler {
  constructor(private deps: StreamHandlerDeps) {
    // H1：把 abort manager 注册进 backend/core 桥接（setStreamAbortManager），供后端
    // ChatFlowService 读取同一实例，在写入用户消息/截断历史之前等待旧流退出
    // （reroll / editBranch 等不经本类 create 的入口同样被覆盖）。
    // 第六批层反转：不再调用 StreamAbortManager.setGlobalInstance（该类静态槽保留供测试清理用）。
    setStreamAbortManager(this.deps.abortManager);
  }

  /**
   * 在启动新流之前等待旧流完全退出（H1 写序竞态）。
   *
   * 用户「停止后立即重发」时，旧流取消路径还要等工具结算窗口（约 3s）落盘、finally 注销
   * 控制器；若不等它退出就 create() 新流并写入用户消息，旧流的结算 addContent 会落在新
   * 用户消息之后（半截旧回答/错位结算）。本方法 abort 旧流并等待其 finally（带超时兜底，
   * 不阻塞新流启动太久）。
   */
  private async awaitOldStreamCompletion(conversationId: string): Promise<void> {
    try {
      await this.deps.abortManager.abortAndWaitForCompletion(conversationId, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);
    } catch (error) {
      // 等待失败不应阻断新流启动（等待内部已有超时兜底，此处仅防御性兜底）
      console.warn('[StreamRequestHandler] Failed to wait for old stream completion:', error);
    }
  }

  /**
   * 只等待已退休旧流退出，不中止当前活跃流（与 awaitOldStreamCompletion 的区别）。
   *
   * 用途：工具确认（toolConfirmation）路径不可打断——若仍走 abortAndWaitForCompletion，
   * 会在写入确认前把正在运行的活跃流 abort 掉（用户确认工具时不应中止当前回合）。
   * 只等被 cancel/替换的旧流 finally 完成（带超时兜底），与后端 waitForOldStreamCompletion 同语义。
   */
  private async awaitRetiredStreamCompletion(conversationId: string): Promise<void> {
    try {
      await this.deps.abortManager.waitForOldStreamCompletion(conversationId, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);
    } catch (error) {
      // 等待失败不应阻断新流启动（等待内部已有超时兜底，此处仅防御性兜底）
      console.warn('[StreamRequestHandler] Failed to wait for retired stream completion:', error);
    }
  }

  /**
   * 规范化请求携带的 Prompt 模式 ID。
   */
  private normalizePromptModeId(promptModeId: unknown): string | undefined {
    if (typeof promptModeId !== 'string') return undefined
    const normalized = promptModeId.trim()
    return normalized || undefined
  }

  private isAbortError(error: any): boolean {
    // 只认结构化标识（DOMException name / Node code），不按 message 子串猜测：
    // 业务错误消息里出现 “aborted/cancelled” 字样的场景不应被误判为网络中止。
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
  }

  /** conversationId 来自 webview 消息层，进入存储路径前必须校验，防止 `..` 路径穿越 */
  private validateConversationId(conversationId: unknown): string {
    return assertSafeId(conversationId, 'conversationId')
  }

  private reportCancelled(processor: StreamChunkProcessor): void {
    // 确保前端一定能收到 cancelled 事件以清理占位消息
    const delivered = processor.processChunk({ cancelled: true })
    processor.flush()
    // 视图不可达（已销毁/重建）时 processChunk 返回 false：留痕便于排查占位消息残留
    if (!delivered) {
      console.warn('[StreamRequestHandler] Cancelled event not delivered: target view unreachable')
    }
  }

  private reportNetworkAbort(error: any, processor: StreamChunkProcessor, requestId: string): void {
    const details = typeof error?.message === 'string' && error.message.trim() ? `: ${error.message}` : ''
    const message = `${t('errors.networkError')}${details}`
    processor.sendError('NETWORK_ERROR', message)
    // 确保请求侧也有响应（即使前端已收到 started:true，这里也安全）
    this.deps.sendError(requestId, 'NETWORK_ERROR', message)
  }

  private serializeErrorDetails(details: unknown): string {
    if (details === undefined || details === null) return ''
    if (typeof details === 'string') return details.trim()
    try {
      return JSON.stringify(details, null, 2)
    } catch {
      return String(details)
    }
  }

  private normalizeErrorMessage(error: any): string {
    if (typeof error?.message === 'string' && error.message.trim()) {
      return error.message.trim()
    }
    return t('errors.unknown')
  }

  private resolveStreamId(clientStreamId: unknown, requestId: string): string {
    if (typeof clientStreamId === 'string') {
      const id = clientStreamId.trim()
      if (id) return id
    }
    return requestId
  }

  private async cleanupAbortedConversations(
    conversationIds: string[],
    options: { cancelAllPendingDiffs?: boolean; preserveDetachedSubAgents?: boolean } = {}
  ): Promise<void> {
    if (options.cancelAllPendingDiffs) {
      // 扩展整体关闭/停止全部必须清理所有未决 diff，包括已没有活跃主流但仍在等确认的会话。
      try {
        await getDiffManager().cancelAllPending();
      } catch (err) {
        console.error('Failed to cancel pending diffs:', err);
      }
    }

    await Promise.all(conversationIds.map(async (conversationId) => {
      // 普通停止只清理当前会话。旧实现漏传 conversationId，会把其他标签页仍在等待确认的
      // diff 一并取消，表现为“停止 A 会话，B 会话也莫名停止/拒绝工具”。
      if (!options.cancelAllPendingDiffs) {
        try {
          await getDiffManager().cancelAllPending(conversationId);
        } catch (err) {
          console.error(`Failed to cancel pending diffs for conversation ${conversationId}:`, err);
        }
      }
      try {
        if (options.preserveDetachedSubAgents === true) {
          await this.deps.conversationManager.rejectAllPendingToolCalls(this.validateConversationId(conversationId), {
            preserveDetachedSubAgents: true
          });
        } else {
          await this.deps.conversationManager.rejectAllPendingToolCalls(this.validateConversationId(conversationId));
        }
      } catch (err) {
        console.error(`Failed to reject pending tool calls for conversation ${conversationId}:`, err);
      }
    }));
  }

  async cancelAllStreams(): Promise<void> {
    const conversationIds = this.deps.abortManager.listConversationIds();
    // R2-07：cancelAll 已移除未使用的 _view 参数
    this.deps.abortManager.cancelAll();
    await this.cleanupAbortedConversations(conversationIds, { cancelAllPendingDiffs: true });
  }

  /**
   * 处理普通聊天流
   */
  async handleChatStream(data: any, requestId: string, clientId?: string): Promise<void> {
    // 入口统一校验（与 cancelStream 对齐）：参数缺失时直接回传 INVALID_DATA 并清理路由映射，
    // 避免流启动后才失败、前端 await sendToExtension 永久挂起。
    // message 只要求存在且为字符串：hiddenFunctionResponse 隐藏模式允许空串（不创建可见用户文本）。
    if (!data || typeof data.conversationId !== 'string' || !data.conversationId || typeof data.message !== 'string') {
      this.deps.sendError(requestId, 'INVALID_DATA', 'chatStream: missing conversationId or message');
      this.deps.finalizeRequest(requestId);
      return;
    }
    let conversationId: string
    let streamId: string
    try {
      const { conversationId: rawConversationId, streamId: clientStreamId } = data;
      conversationId = this.validateConversationId(rawConversationId)
      streamId = this.resolveStreamId(clientStreamId, requestId)
    } catch (error: any) {
      // 校验失败也必须回给前端错误响应并清理路由表，否则前端请求永久挂起
      this.deps.sendError(requestId, 'INVALID_CONVERSATION_ID', error?.message || 'Invalid conversation id');
      this.deps.finalizeRequest(requestId);
      return;
    }

    const {
      message,
      messageId,
      configId,
      attachments,
      modelOverride,
      hiddenFunctionResponse,
      promptModeId,
      dynamicContextStrategyOverride,
      // 消息来源：background_task 时后端不把回执当作真实用户新回合（isUserInput 判定）
      source,
      agentMessageClaimId
    } = data;

    const processor = new StreamChunkProcessor(() => this.deps.getClientView(clientId), conversationId, streamId);
    let controller: AbortController | undefined;
    let summarizeController: AbortController | undefined;

    try {
      // P1（TOCTOU）：快照取消代次——等待窗口（最长 6s）内到达的 cancelStream 只会中止
      // 旧流；若 create() 后不复查，「停止」操作会丢失（新流照常启动）。
      const cancelEpoch = this.deps.abortManager.getCancelEpoch(conversationId);
      await this.awaitOldStreamCompletion(conversationId);
      controller = this.deps.abortManager.create(conversationId);
      // P1 复查：等待期间有取消 → 立即取消刚创建的控制器、不启动新流。
      // 汇报协议与 handleStreamError 的取消路径一致（cancelled 结尾事件 + cancelled 响应）。
      if (this.deps.abortManager.getCancelEpoch(conversationId) !== cancelEpoch) {
        controller.abort();
        this.reportCancelled(processor);
        this.deps.sendResponse(requestId, { cancelled: true });
        return;
      }
      summarizeController = this.deps.abortManager.createSummary(conversationId);
      const stream = this.deps.chatHandler.handleChatStream({
        conversationId,
        message,
        messageId,
        configId,
        modelOverride,
        attachments,
        hiddenFunctionResponse,
        promptModeId: this.normalizePromptModeId(promptModeId),
        dynamicContextStrategyOverride,
        source,
        agentMessageClaimId,
        abortSignal: controller.signal,
        summarizeAbortSignal: summarizeController.signal
      });
      
      // 发送响应，通知前端请求已接收并开始
      this.deps.sendResponse(requestId, { started: true });
      
      for await (const chunk of stream) {
        const isError = processor.processChunk(chunk);
        if (isError) break;
      }
      // 流结束后刷新缓冲区，确保所有消息都已发送
      processor.flush();
    } catch (error: any) {
      // 取消/网络中止/普通错误统一由 handleStreamError 判定（signal.aborted + 错误类型双条件）
      this.handleStreamError(error, processor, requestId, controller?.signal.aborted === true);
    } finally {
      if (controller) this.deps.abortManager.delete(conversationId, controller);
      if (summarizeController) this.deps.abortManager.deleteSummary(conversationId, summarizeController);
      this.deps.finalizeRequest(requestId);
    }
  }

  /**
   * 处理重试流
   */
  async handleRetryStream(data: any, requestId: string, clientId?: string): Promise<void> {
    // 入口统一校验（与 handleChatStream 对齐）：参数缺失时直接回传 INVALID_DATA 并清理路由映射，
    // 避免流启动后才失败、前端 await sendToExtension 永久挂起。
    if (!data || typeof data.conversationId !== 'string' || !data.conversationId) {
      this.deps.sendError(requestId, 'INVALID_DATA', 'retryStream: missing conversationId');
      this.deps.finalizeRequest(requestId);
      return;
    }
    let conversationId: string
    let streamId: string
    try {
      const { conversationId: rawConversationId, streamId: clientStreamId } = data || {};
      conversationId = this.validateConversationId(rawConversationId)
      streamId = this.resolveStreamId(clientStreamId, requestId)
    } catch (error: any) {
      this.deps.sendError(requestId, 'INVALID_CONVERSATION_ID', error?.message || 'Invalid conversation id');
      this.deps.finalizeRequest(requestId);
      return;
    }
    const { configId, modelOverride, promptModeId } = data;
    const processor = new StreamChunkProcessor(() => this.deps.getClientView(clientId), conversationId, streamId);
    let controller: AbortController | undefined;
    let summarizeController: AbortController | undefined;

    try {
      // P1（TOCTOU）：快照取消代次并复查（同 handleChatStream）——等待窗口内到达的
      // cancelStream 不得丢失：已取消则不启动新流。
      const cancelEpoch = this.deps.abortManager.getCancelEpoch(conversationId);
      await this.awaitOldStreamCompletion(conversationId);
      controller = this.deps.abortManager.create(conversationId);
      if (this.deps.abortManager.getCancelEpoch(conversationId) !== cancelEpoch) {
        controller.abort();
        this.reportCancelled(processor);
        this.deps.sendResponse(requestId, { cancelled: true });
        return;
      }
      summarizeController = this.deps.abortManager.createSummary(conversationId);
      const stream = this.deps.chatHandler.handleRetryStream({
        conversationId,
        configId,
        modelOverride,
        promptModeId: this.normalizePromptModeId(promptModeId),
        abortSignal: controller.signal,
        summarizeAbortSignal: summarizeController.signal
      });
      
      // 发送响应，通知前端请求已接收并开始
      this.deps.sendResponse(requestId, { started: true });
      
      for await (const chunk of stream) {
        const isError = processor.processChunk(chunk);
        if (isError) break;
      }
      processor.flush();
    } catch (error: any) {
      // 取消/网络中止/普通错误统一由 handleStreamError 判定（signal.aborted + 错误类型双条件）
      this.handleStreamError(error, processor, requestId, controller?.signal.aborted === true);
    } finally {
      if (controller) this.deps.abortManager.delete(conversationId, controller);
      if (summarizeController) this.deps.abortManager.deleteSummary(conversationId, summarizeController);
      this.deps.finalizeRequest(requestId);
    }
  }

  /**
   * 处理工具确认流
   */
  async handleToolConfirmationStream(data: any, requestId: string, clientId?: string): Promise<void> {
    // 入口统一校验（与 handleChatStream 对齐）
    if (!data || typeof data.conversationId !== 'string' || !data.conversationId) {
      this.deps.sendError(requestId, 'INVALID_DATA', 'toolConfirmation: missing conversationId');
      this.deps.finalizeRequest(requestId);
      return;
    }
    let conversationId: string
    let streamId: string
    try {
      const { conversationId: rawConversationId, streamId: clientStreamId } = data || {};
      conversationId = this.validateConversationId(rawConversationId)
      streamId = this.resolveStreamId(clientStreamId, requestId)
    } catch (error: any) {
      this.deps.sendError(requestId, 'INVALID_CONVERSATION_ID', error?.message || 'Invalid conversation id');
      this.deps.finalizeRequest(requestId);
      return;
    }
    const { toolResponses, configId, modelOverride, promptModeId } = data;
    const processor = new StreamChunkProcessor(() => this.deps.getClientView(clientId), conversationId, streamId);
    let controller: AbortController | undefined;
    let summarizeController: AbortController | undefined;

    try {
      // 工具确认路径不可打断：只等待已退休旧流退出，不 abort 当前活跃流
      // P1（TOCTOU）：快照取消代次并复查——等待窗口内用户点过「停止」则不启动确认流。
      const cancelEpoch = this.deps.abortManager.getCancelEpoch(conversationId);
      await this.awaitRetiredStreamCompletion(conversationId);
      controller = this.deps.abortManager.create(conversationId);
      if (this.deps.abortManager.getCancelEpoch(conversationId) !== cancelEpoch) {
        controller.abort();
        this.reportCancelled(processor);
        this.deps.sendResponse(requestId, { cancelled: true });
        return;
      }
      summarizeController = this.deps.abortManager.createSummary(conversationId);
      const stream = this.deps.chatHandler.handleToolConfirmation({
        conversationId,
        toolResponses,
        configId,
        modelOverride,
        promptModeId: this.normalizePromptModeId(promptModeId),
        summarizeAbortSignal: summarizeController.signal,
        abortSignal: controller.signal
      });
      
      // 发送响应，通知前端请求已接收并开始
      this.deps.sendResponse(requestId, { started: true });
      
      for await (const chunk of stream) {
        const isError = processor.processChunk(chunk);
        if (isError) break;
      }
      processor.flush();
    } catch (error: any) {
      // 取消/网络中止/普通错误统一由 handleStreamError 判定（signal.aborted + 错误类型双条件）
      this.handleStreamError(error, processor, requestId, controller?.signal.aborted === true);
    } finally {
      if (controller) this.deps.abortManager.delete(conversationId, controller);
      if (summarizeController) this.deps.abortManager.deleteSummary(conversationId, summarizeController);
      this.deps.finalizeRequest(requestId);
    }
  }

  /**
   * 取消流
   */
  async cancelStream(
    conversationId: string,
    requestId: string,
    options: { preserveSubAgents?: boolean } = {}
  ): Promise<void> {
    // “立即发送排队消息”是在替换当前回合：必须先解除前台 SubAgent 的父信号绑定，
    // 再取消旧流。普通停止操作仍走 cancel，继续保持真正终止的语义。
    if (options.preserveSubAgents === true) {
      this.deps.abortManager.cancelForNewTurn(this.validateConversationId(conversationId));
    } else {
      this.deps.abortManager.cancel(this.validateConversationId(conversationId));
    }

    await this.cleanupAbortedConversations([conversationId], {
      preserveDetachedSubAgents: options.preserveSubAgents === true
    });

    this.deps.sendResponse(requestId, { cancelled: true });
    this.deps.finalizeRequest(requestId);
  }

  /**
   * 统一处理流式错误：以「abort 信号已触发 + 错误类型」双条件判定取消语义。
   *
   * - 取消（signal.aborted 或底层 CANCELLED_ERROR，含非 ChannelError 包装）：透出 cancelled
   *   结尾事件并回传 cancelled 响应（幂等），避免残留空占位消息、前端 await 永久挂起；
   * - AbortError（name/code 命中但信号未触发）：按网络中止处理；
   * - ChannelError：按类型透传 NETWORK_ERROR/TIMEOUT_ERROR 或通用错误码；
   * - 其他错误：回传 STREAM_ERROR。
   */
  private handleStreamError(error: any, processor: StreamChunkProcessor, requestId: string, aborted: boolean): void {
    // 统一取消判定：不再只认 ChannelError 的 CANCELLED_ERROR（instanceof 跨模块实例可能失配），
    // signal.aborted 与错误 type 任一命中即视为用户取消。
    if (aborted || error?.type === ErrorType.CANCELLED_ERROR) {
      this.reportCancelled(processor)
      // 幂等兜底：前端 await sendToExtension 需要收到明确的结尾响应
      this.deps.sendResponse(requestId, { cancelled: true })
      return
    }

    if (this.isAbortError(error)) {
      this.reportNetworkAbort(error, processor, requestId)
      return
    }

    if (error instanceof ChannelError) {
      // CANCELLED_ERROR 已由上方统一取消判定（signal.aborted + 错误类型双条件）拦截，
      // 能走到这里的 ChannelError 必然不是取消类型；无需再判 type——在类型收窄后
      // 该比较已成为「无交集」的不可达比较（TS2367），删除以免误导后续维护。
      const details = this.serializeErrorDetails(error.details)
      const message = details ? `${error.message}\n${details}` : error.message

      if (error.type === ErrorType.NETWORK_ERROR || error.type === ErrorType.TIMEOUT_ERROR) {
        const networkMessage = message || t('errors.networkError')
        processor.sendError('NETWORK_ERROR', networkMessage)
        this.deps.sendError(requestId, 'NETWORK_ERROR', networkMessage)
        return
      }

      const errorCode = error.type || 'STREAM_ERROR'
      const fallbackMessage = message || t('errors.unknown')
      processor.sendError(errorCode, fallbackMessage)
      this.deps.sendError(requestId, errorCode, fallbackMessage)
      return
    }

    const errorMessage = this.normalizeErrorMessage(error)
    processor.sendError('STREAM_ERROR', t('core.channel.errors.streamRequestFailed', { error: errorMessage }))

    // 同时发送请求错误响应，确保前端 await sendToExtension 能够返回
    this.deps.sendError(requestId, 'STREAM_ERROR', errorMessage)
  }
}
