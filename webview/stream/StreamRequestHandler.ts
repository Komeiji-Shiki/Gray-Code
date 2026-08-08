/**
 * 流式请求处理器
 * 
 * 处理所有流式消息类型
 */

import type * as vscode from 'vscode';
import type { ChatHandler } from '../../backend/modules/api/chat';
import type { ConversationManager } from '../../backend/modules/conversation/ConversationManager';
import { StreamAbortManager, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from './StreamAbortManager';
import { StreamChunkProcessor } from './StreamChunkProcessor';
import { t } from '../../backend/i18n';
import { getDiffManager } from '../../backend/tools/file/diffManager';
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
    // H1：把 abort manager 注册为全局单例，供后端 ChatFlowService 读取同一实例，
    // 在写入用户消息/截断历史之前等待旧流退出（reroll / editBranch 等不经本类
    // create 的入口同样被覆盖）。
    StreamAbortManager.setGlobalInstance(this.deps.abortManager);
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
   * 规范化请求携带的 Prompt 模式 ID。
   */
  private normalizePromptModeId(promptModeId: unknown): string | undefined {
    if (typeof promptModeId !== 'string') return undefined
    const normalized = promptModeId.trim()
    return normalized || undefined
  }

  private isAbortError(error: any): boolean {
    const name = error?.name
    const message = typeof error?.message === 'string' ? error.message : ''
    return name === 'AbortError' || message.toLowerCase().includes('aborted') || message.toLowerCase().includes('cancelled')
  }

  /** conversationId 来自 webview 消息层，进入存储路径前必须校验，防止 `..` 路径穿越 */
  private validateConversationId(conversationId: unknown): string {
    return assertSafeId(conversationId, 'conversationId')
  }

  private reportCancelled(processor: StreamChunkProcessor): void {
    // 确保前端一定能收到 cancelled 事件以清理占位消息
    processor.processChunk({ cancelled: true })
    processor.flush()
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
    this.deps.abortManager.cancelAll(this.deps.getClientView());
    await this.cleanupAbortedConversations(conversationIds, { cancelAllPendingDiffs: true });
  }

  /**
   * 处理普通聊天流
   */
  async handleChatStream(data: any, requestId: string, clientId?: string): Promise<void> {
    let conversationId: string
    let streamId: string
    try {
      const {
        conversationId: rawConversationId,
        streamId: clientStreamId
      } = data || {};
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
      source
    } = data;

    const processor = new StreamChunkProcessor(() => this.deps.getClientView(clientId), conversationId, streamId);
    let controller: AbortController | undefined;
    let summarizeController: AbortController | undefined;

    try {
      await this.awaitOldStreamCompletion(conversationId);
      controller = this.deps.abortManager.create(conversationId);
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
      // AbortError 可能来自：用户点击中断 / 网络抖动 / 上游直接抛 abort
      // 关键：无论哪种情况，都必须给前端一个明确的 stream 结尾事件，避免残留空占位消息。
      if (controller?.signal.aborted) {
        this.reportCancelled(processor)
        return
      }
      if (this.isAbortError(error)) {
        this.reportNetworkAbort(error, processor, requestId)
        return
      }
      this.handleStreamError(error, processor, requestId);
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
      await this.awaitOldStreamCompletion(conversationId);
      controller = this.deps.abortManager.create(conversationId);
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
      if (controller?.signal.aborted) {
        this.reportCancelled(processor)
        return
      }
      if (this.isAbortError(error)) {
        this.reportNetworkAbort(error, processor, requestId)
        return
      }
      this.handleStreamError(error, processor, requestId);
    } finally {
      if (controller) this.deps.abortManager.delete(conversationId, controller);
      if (summarizeController) this.deps.abortManager.deleteSummary(conversationId, summarizeController);
      this.deps.finalizeRequest(requestId);
    }
  }

  /**
   * 处理编辑并重试流
   */
  async handleEditAndRetryStream(data: any, requestId: string, clientId?: string): Promise<void> {
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
    const { messageIndex, newMessage, configId, modelOverride, attachments, promptModeId, preserveCheckpointId, messageId } = data;
    const processor = new StreamChunkProcessor(() => this.deps.getClientView(clientId), conversationId, streamId);
    let controller: AbortController | undefined;
    let summarizeController: AbortController | undefined;

    try {
      await this.awaitOldStreamCompletion(conversationId);
      controller = this.deps.abortManager.create(conversationId);
      summarizeController = this.deps.abortManager.createSummary(conversationId);
      const stream = this.deps.chatHandler.handleEditAndRetryStream({
        conversationId,
        messageIndex,
        newMessage,
        configId,
        modelOverride,
        attachments,
        preserveCheckpointId,
        // M1：透传消息 id 供后端做防索引漂移校验（可选；旧前端不传时保持旧行为）
        messageId,
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
      if (controller?.signal.aborted) {
        this.reportCancelled(processor)
        return
      }
      if (this.isAbortError(error)) {
        this.reportNetworkAbort(error, processor, requestId)
        return
      }
      this.handleStreamError(error, processor, requestId);
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
    const { toolResponses, annotation, annotationMessageId, configId, modelOverride, promptModeId } = data;
    const processor = new StreamChunkProcessor(() => this.deps.getClientView(clientId), conversationId, streamId);
    let controller: AbortController | undefined;
    let summarizeController: AbortController | undefined;

    try {
      await this.awaitOldStreamCompletion(conversationId);
      controller = this.deps.abortManager.create(conversationId);
      summarizeController = this.deps.abortManager.createSummary(conversationId);
      const stream = this.deps.chatHandler.handleToolConfirmation({
        conversationId,
        toolResponses,
        annotation,
        annotationMessageId,
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
      if (controller?.signal.aborted) {
        this.reportCancelled(processor)
        return
      }
      if (this.isAbortError(error)) {
        this.reportNetworkAbort(error, processor, requestId)
        return
      }
      this.handleStreamError(error, processor, requestId);
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
   * 处理流式错误
   */
  private handleStreamError(error: any, processor: StreamChunkProcessor, requestId: string): void {
    if (error instanceof ChannelError) {
      if (error.type === ErrorType.CANCELLED_ERROR) {
        this.reportCancelled(processor)
        return
      }

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
