/**
 * 消息路由器
 * 
 * 负责将前端消息路由到正确的处理器
 */

import type { HandlerContext, MessageHandlerRegistry } from './types';
import { createMessageHandlerRegistry } from './handlers';
import { StreamRequestHandler, StreamAbortManager } from './stream';
import type { ChatHandler } from '../backend/modules/api/chat';
import type { ConversationManager } from '../backend/modules/conversation/ConversationManager';
import type { SettingsManager } from '../backend/modules/settings/SettingsManager';
import { WebviewClientRegistry, type WebviewClientId } from './runtime/WebviewClientRegistry';
import type * as vscode from 'vscode';

/**
 * 流式消息类型
 */
export const STREAM_MESSAGE_TYPES = [
  'chatStream',
  'retryStream',
  'editAndRetryStream',
  'toolConfirmation',
  'cancelStream',
  // H2（R6a-FIX）：reroll/editBranch 长流与 chatStream/retryStream 同模式——
  // 走 fire-and-forget，避免 route() 串行 await 整个流占死 IPC 消息队列
  // （期间 cancelStream/deleteMessage/switchBranchCandidate/新消息全部排队）。
  'chat.rerollStream',
  'chat.editBranchStream'
] as const;

type StreamMessageType = typeof STREAM_MESSAGE_TYPES[number];

/**
 * 非阻塞消息类型。
 *
 * 这些 handler 可能执行数秒到数分钟（LLM 请求、依赖安装等），
 * 若在 messageHandlingQueue 中串行 await 会阻塞取消类消息，
 * 导致 webview 消息通道整体冻结。
 *
 * 修改方式：route() 命中这些类型时采用 fire-and-forget，
 * 不 await handler，catch 中就地清理 requestClients 并回传错误。
 */
export const NON_BLOCKING_MESSAGE_TYPES = new Set([
  'summarizeContext',
  'dependencies.install',
  'dependencies.uninstall',
  'storagePath.migrate',
  // M-1: 检查点全量扫描/枚举可能耗时数秒到数分钟（大工作区），
  // 若在串行队列中 await 会阻塞 cancelStream / checkpoint.cancelOperation / 消息删除等全部 IPC，
  // 导致 webview 消息通道整体冻结；fire-and-forget 让取消类消息始终能及时送达。
  'checkpoint.previewExclusions',
  'checkpoint.getAllConversationsWithCheckpoints',
  // Monitor 控制消息必须绕过普通 handler 队列；否则前面一次慢磁盘读取会让暂停/退出点击排队，
  // 用户看到按钮可点却迟迟没有任何效果。
  'subagents.pauseRun',
  'subagents.resumeRun',
  'subagents.exitRun'
]);

/**
 * 消息路由器
 */
export class MessageRouter {
  private registry: MessageHandlerRegistry;
  private streamHandler: StreamRequestHandler;
  private abortManager: StreamAbortManager;
  private clientRegistry: WebviewClientRegistry;
  private requestClients = new Map<string, WebviewClientId>();

  constructor(
    private chatHandler: ChatHandler,
    private conversationManager: ConversationManager,
    private settingsManager: SettingsManager,
    private getClientView: (clientId?: string) => { webview: vscode.Webview } | undefined,
    private sendResponse: (requestId: string, data: any) => void,
    private sendError: (requestId: string, code: string, message: string) => void,
    clientRegistry: WebviewClientRegistry
  ) {
    this.clientRegistry = clientRegistry;
    // 创建处理器注册表
    this.registry = createMessageHandlerRegistry();
    
    // 创建流式处理器
    this.abortManager = new StreamAbortManager();
    this.streamHandler = new StreamRequestHandler({
      chatHandler: this.chatHandler,
      abortManager: this.abortManager,
      conversationManager: this.conversationManager,
      getClientView: this.getClientView,
      sendResponse: (requestId, data) => this.sendRoutedResponse(requestId, data),
      sendError: (requestId, code, message) => this.sendRoutedError(requestId, code, message),
      settingsManager: this.settingsManager,
      finalizeRequest: (requestId) => this.requestClients.delete(requestId)
    });
  }

  /**
   * 路由消息到正确的处理器
   * 
   * @returns true 如果消息已处理，false 如果需要回退到原有处理
   */
  async route(type: string, data: any, requestId: string, ctx: HandlerContext, clientId?: string): Promise<boolean> {
    const resolvedClientId = this.clientRegistry.resolveClientId(clientId, ctx.clientId);

    // requestId → clientId 的映射：非流式请求在 sendResponse / sendError 路由成功或回退时删除，
    // 流式请求由流的 finally/finalizeRequest 统一清理。因此只能为「确实会被本 router 处理」的
    // 请求登记：以前无论如何都先 set，未命中处理器而回退的消息、以及 handler 抛异常的请求都会
    // 留下一条永不清理的条目，这个 Map 没有上界。
    const trackRequestClient = () => {
      if (requestId && resolvedClientId) {
        this.requestClients.set(requestId, resolvedClientId);
      }
    };

    // 检查是否是流式消息
    if (this.isStreamMessage(type)) {
      trackRequestClient();
      try {
        await this.handleStreamMessage(type as StreamMessageType, data, requestId, resolvedClientId, ctx);
      } catch (error) {
        // 异常路径（如载荷解构失败）必须兜底清理路由表，否则 requestClients 泄漏、前端请求永久挂起
        console.error(`[MessageRouter] Stream handler error for ${type}:`, error);
        try {
          this.sendRoutedError(requestId, 'STREAM_HANDLER_ERROR', error?.message || String(error));
        } catch {
          this.requestClients.delete(requestId);
        }
      }
      return true;
    }

    // 检查注册表中是否有处理器
    const handler = this.registry.get(type);
    if (!handler) {
      // 未找到处理器，返回 false 表示需要回退
      return false;
    }

    // 非阻塞消息：fire-and-forget，不占住消息队列。
    // 长任务（总结、依赖安装等）耗时数十秒到数分钟，串行 await 会让
    // 取消类消息排不到队，导致 webview 消息通道整体冻结。
    if (NON_BLOCKING_MESSAGE_TYPES.has(type)) {
      trackRequestClient();
      const routedCtx = this.createRoutedContext(ctx, resolvedClientId);
      handler(data, requestId, routedCtx).catch((error) => {
        console.error(`[MessageRouter] Non-blocking handler error for ${type}:`, error);
        // 必须先 sendRoutedError 再清理：sendRoutedError 需要 requestClients 里的路由信息，
        // 先 delete 会导致错误必然错投主聊天，Monitor 面板请求永久挂起。
        try {
          this.sendRoutedError(requestId, 'HANDLER_ERROR', error?.message || String(error));
        } catch {
          // 发送错误失败则静默忽略
        }
        // sendRoutedError 内部成功路由时会删除条目；回退路径不删，这里兜底清理防泄漏。
        this.requestClients.delete(requestId);
      });
      return true;
    }

    trackRequestClient();
    const routedCtx = this.createRoutedContext(ctx, resolvedClientId);
    try {
      await handler(data, requestId, routedCtx);
    } catch (error) {
      // handler 抛出时没有任何一方会回复，映射必须就地清理
      this.requestClients.delete(requestId);
      throw error;
    }
    return true;
  }

  private createRoutedContext(ctx: HandlerContext, clientId?: WebviewClientId): HandlerContext {
    if (!clientId) {
      return ctx;
    }

    return {
      ...ctx,
      clientId,
      view: ctx.view,
      sendResponse: (requestId, data) => {
        if (!this.clientRegistry.sendResponse(clientId, requestId, data)) {
          ctx.sendResponse(requestId, data);
        }
        this.requestClients.delete(requestId);
      },
      sendError: (requestId, code, message) => {
        if (!this.clientRegistry.sendError(clientId, requestId, code, message)) {
          ctx.sendError(requestId, code, message);
        }
        this.requestClients.delete(requestId);
      },
      postMessage: (message: any) => {
        if (!this.clientRegistry.postMessage(clientId, message)) {
          ctx.postMessage?.(message);
        }
      }
    };
  }

  private sendRoutedResponse(requestId: string, data: any): void {
    const clientId = this.requestClients.get(requestId);
    if (clientId && this.clientRegistry.sendResponse(clientId, requestId, data)) {
      // 流式请求的 started:true / cancelled 响应发出后流可能仍在进行（后续错误响应仍要靠
      // requestId → clientId 映射路由回发起方），此处不删除条目；由流的 finally/finalizeRequest
      // 统一清理，避免 Monitor 侧错误被错投主聊天、await 永久挂起。
      return;
    }

    // 回退到主聊天：目标客户端不存在或已销毁，条目必须清理，否则 requestClients 无界泄漏
    this.requestClients.delete(requestId);
    this.sendResponse(requestId, data);
  }

  private sendRoutedError(requestId: string, code: string, message: string): void {
    const clientId = this.requestClients.get(requestId);
    if (clientId && this.clientRegistry.sendError(clientId, requestId, code, message)) {
      this.requestClients.delete(requestId);
      return;
    }

    // 回退到主聊天：目标客户端不存在或已销毁，条目必须清理，否则 requestClients 无界泄漏
    this.requestClients.delete(requestId);
    this.sendError(requestId, code, message);
  }

  /**
   * 检查是否是流式消息
   */
  private isStreamMessage(type: string): type is StreamMessageType {
    return STREAM_MESSAGE_TYPES.includes(type as StreamMessageType);
  }

  /**
   * 处理流式消息
   */
  private async handleStreamMessage(
    type: StreamMessageType,
    data: any,
    requestId: string,
    clientId: WebviewClientId | undefined,
    ctx: HandlerContext
  ): Promise<void> {
    switch (type) {
      case 'chatStream':
        // 不阻塞消息循环，流式处理在后台进行
        this.streamHandler.handleChatStream(data, requestId, clientId).catch(console.error);
        break;
        
      case 'retryStream':
        this.streamHandler.handleRetryStream(data, requestId, clientId).catch(console.error);
        break;
        
      case 'editAndRetryStream':
        this.streamHandler.handleEditAndRetryStream(data, requestId, clientId).catch(console.error);
        break;
        
      case 'toolConfirmation':
        this.streamHandler.handleToolConfirmationStream(data, requestId, clientId).catch(console.error);
        break;
        
      case 'cancelStream':
        // data 缺失时直接解构会抛 TypeError（被上层 catch 吞掉），requestClients 已登记的条目
        // 将永久残留；先 sendRoutedError 回传错误（映射还在，能路由到发起方），再兜底清理。
        if (!data || typeof data.conversationId !== 'string' || !data.conversationId) {
          try {
            this.sendRoutedError(requestId, 'INVALID_DATA', 'cancelStream: missing conversationId');
          } catch {
            // 发送错误失败则静默忽略
          }
          this.requestClients.delete(requestId);
          break;
        }
        const { conversationId } = data;
        this.streamHandler.cancelStream(conversationId, requestId, {
          preserveSubAgents: data.preserveSubAgents === true
        }).catch(console.error);
        break;

      // H2（R6a-FIX）：reroll/editBranch 长流按 fire-and-forget 处理（与 chatStream/retryStream 同），
      // 不串行 await 占死消息队列；handler 内部自行完成 abort 接线与 chunk 转发。
      case 'chat.rerollStream':
        this.runRegistryStreamHandler('chat.rerollStream', data, requestId, ctx, clientId);
        break;

      case 'chat.editBranchStream':
        this.runRegistryStreamHandler('chat.editBranchStream', data, requestId, ctx, clientId);
        break;
    }
  }

  /**
   * H2：以 fire-and-forget 方式调用注册表中的流式 handler（chat.rerollStream / chat.editBranchStream）。
   *
   * 与 StreamRequestHandler 的流式类型同语义：route() 不 await 长流，取消/删除/新消息等 IPC
   * 不会被长流占死；错误就地清理 requestClients 后按路由回传（sendRoutedError 依赖该映射）。
   */
  private runRegistryStreamHandler(
    type: string,
    data: any,
    requestId: string,
    ctx: HandlerContext,
    clientId: WebviewClientId | undefined
  ): void {
    const handler = this.registry.get(type);
    if (!handler) {
      // 理论上不可能（注册表与 STREAM_MESSAGE_TYPES 同步维护）；兜底回传错误防挂起
      this.requestClients.delete(requestId);
      this.sendRoutedError(requestId, 'HANDLER_ERROR', `stream handler not registered: ${type}`);
      return;
    }
    const routedCtx = this.createRoutedContext(ctx, clientId);
    Promise.resolve(handler(data, requestId, routedCtx)).catch((error: any) => {
      console.error(`[MessageRouter] Stream handler error for ${type}:`, error);
      // 必须先 sendRoutedError 再清理：sendRoutedError 需要 requestClients 里的路由信息
      try {
        this.sendRoutedError(requestId, 'HANDLER_ERROR', error?.message || String(error));
      } catch {
        // 发送错误失败则静默忽略
      }
      this.requestClients.delete(requestId);
    });
  }

  /**
   * 取消所有活跃的流
   */
  cancelAllStreams(): void {
    this.streamHandler.cancelAllStreams().catch(console.error);
  }

  /**
   * 获取流式请求取消控制器
   */
  getAbortManager(): StreamAbortManager {
    return this.abortManager;
  }
}
