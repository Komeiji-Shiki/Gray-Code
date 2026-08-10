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
  'subagents.exitRun',
  // 模态对话框类（showSaveDialog/showOpenDialog/showQuickPick）：对话框打开期间 handler 一直 await，
  // 若占住串行队列，后续保存/取消/新消息全部排队，前端 180s 超时误报失败（保存实际已生效）。
  'exportPromptModes',
  'settings.export',
  'settings.import',
  'storagePath.selectFolder',
  // 网络/下载类：耗时取决于网络状况，不应阻塞队列中的其它请求。
  'countSystemPromptTokens', // token 计数调用渠道 API
  'tokenizer.getResource',   // 首次下载 tokenizer 词表（分钟级）
  // 更新检查/安装类（UpdateHandlers）：checkNow 含网络请求（checker.check），
  // updateNow 除检查外还含下载+安装（分钟级）；若在串行队列中 await，期间
  // cancelStream / deleteMessage 等取消类消息全部排队，webview 通道整体冻结。
  'checkUpdateNow',
  'updateNow'
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
      await this.handleStreamMessage(type as StreamMessageType, data, requestId, resolvedClientId, ctx);
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
      handler(data, requestId, routedCtx).then(
        () => {
          // handler 成功但未调用 sendResponse/sendError（成功但不回复）时，
          // requestClients 条目会永久残留。createRoutedContext 的 sendResponse/sendError
          // 会同步删除条目，因此这里用 has() 判断 handler 是否已回复过：
          // 已回复则条目已被删，无需（也不应）再删；未回复则兜底删除防泄漏。
          if (this.requestClients.has(requestId)) {
            this.requestClients.delete(requestId);
          }
        },
        (error) => {
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
        }
      );
      return true;
    }

    trackRequestClient();
    const routedCtx = this.createRoutedContext(ctx, resolvedClientId);
    try {
      await handler(data, requestId, routedCtx);
      // 阻塞 handler 正常返回却没有响应时也必须释放路由映射。
      this.requestClients.delete(requestId);
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
        // 不在此处删除 requestClients：流式请求（chat.rerollStream / chat.editBranchStream）
        // 的 started:true 之后流仍在进行，后续错误响应仍要靠 requestId → clientId 映射
        // 路由回发起方；条目由 route() 的非阻塞/阻塞兜底与 runRegistryStreamHandler
        // 成功回调统一清理（与 finalizeRequest 语义一致）。
      },
      sendError: (requestId, code, message) => {
        if (!this.clientRegistry.sendError(clientId, requestId, code, message)) {
          ctx.sendError(requestId, code, message);
        }
      },
      postMessage: (message: any) => {
        // 同步失败由返回值回退；异步投递失败（webview 已销毁/拒绝）经回调回退——
        // 二者互斥，不会双重回退
        if (!this.clientRegistry.postMessage(clientId, message, () => {
          ctx.postMessage?.(message);
        })) {
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
  private runStreamTask(task: Promise<void>, requestId: string, type: string): void {
    task.catch((error: any) => {
      console.error(`[MessageRouter] Stream handler error for ${type}:`, error);
      // 空 requestId（如 cancelAllStreams 的 fire-and-forget 任务）没有可路由的发起方：
      // 只记录日志，不回传错误（回传只会错投主聊天且无 requestId 可匹配）
      if (!requestId) return;
      try {
        this.sendRoutedError(requestId, 'STREAM_HANDLER_ERROR', error?.message || String(error));
      } finally {
        this.requestClients.delete(requestId);
      }
    });
  }

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
        this.runStreamTask(this.streamHandler.handleChatStream(data, requestId, clientId), requestId, type);
        break;
        
      case 'retryStream':
        this.runStreamTask(this.streamHandler.handleRetryStream(data, requestId, clientId), requestId, type);
        break;

      case 'toolConfirmation':
        this.runStreamTask(this.streamHandler.handleToolConfirmationStream(data, requestId, clientId), requestId, type);
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
        this.runStreamTask(this.streamHandler.cancelStream(conversationId, requestId, {
          preserveSubAgents: data.preserveSubAgents === true
        }), requestId, type);
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
      this.sendRoutedError(requestId, 'HANDLER_ERROR', `stream handler not registered: ${type}`);
      this.requestClients.delete(requestId);
      return;
    }
    const routedCtx = this.createRoutedContext(ctx, clientId);
    Promise.resolve(handler(data, requestId, routedCtx)).then(
      () => {
        // 流正常结束后统一清理路由映射（与 finalizeRequest 语义一致；
        // 流期间错误由 handler 内经 routedCtx 回传，不依赖该映射）
        this.requestClients.delete(requestId);
      },
      (error: any) => {
        console.error(`[MessageRouter] Stream handler error for ${type}:`, error);
        // 必须先 sendRoutedError 再清理：sendRoutedError 需要 requestClients 里的路由信息
        try {
          this.sendRoutedError(requestId, 'HANDLER_ERROR', error?.message || String(error));
        } catch {
          // 发送错误失败则静默忽略
        }
        this.requestClients.delete(requestId);
      }
    );
  }

  /**
   * 取消所有活跃的流
   */
  cancelAllStreams(): void {
    this.runStreamTask(this.streamHandler.cancelAllStreams(), '', 'cancelAllStreams');
  }

  /**
   * 获取流式请求取消控制器
   */
  getAbortManager(): StreamAbortManager {
    return this.abortManager;
  }
}
