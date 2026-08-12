/**
 * 消息路由器
 * 
 * 负责将前端消息路由到正确的处理器
 */

import type { HandlerContext, MessageHandlerRegistry } from './types';
import { createMessageHandlerRegistry } from './handlers';
// B1：非阻塞名单迁入 shared/protocol.ts 单一来源；此处 re-export 保持既有导出路径
// （backend/__tests__/webview/messageRouterNonBlockingBehavior.test.ts 直接 import 它）。
import { MESSAGE_NAMES, NON_BLOCKING_MESSAGE_TYPES } from '../shared/protocol';
export { NON_BLOCKING_MESSAGE_TYPES } from '../shared/protocol';
import { StreamRequestHandler, StreamAbortManager } from './stream';
import type { ChatHandler } from '../backend/modules/api/chat';
import type { ConversationManager } from '../backend/modules/conversation';
import type { SettingsManager } from '../backend/modules/settings';
import { WebviewClientRegistry, type WebviewClientId } from './runtime/WebviewClientRegistry';
import type * as vscode from 'vscode';

/**
 * requestId → clientId 路由映射的收敛封装（04#8）。
 *
 * 背景：映射的删除策略曾散落在 MessageRouter 的约 9 处（登记、非阻塞成功/失败兜底、阻塞成功/异常、
 * sendRoutedResponse/sendRoutedError 回退、runStreamTask finally、runRegistryStreamHandler 成功/失败），
 * 与三套执行模型（阻塞 await / 非阻塞 fire-and-forget / 流式后台任务）耦合，曾导致
 * 「错误错投主聊天」「Map 无界泄漏」两类事故。这里把登记、路由与删除收口到语义化方法，
 * 删除时机只由本类决定。
 *
 * 删除策略（唯一事实来源）：
 * - track 记录 keepUntilFinalize：流式请求为 true（started 之后流仍在进行，后续
 *   cancelled/error 响应仍需按 requestId 路由回发起方）；非流式请求为 false。
 * - routeResponse 投递成功时：keepUntilFinalize=true 保留条目；false 视为终态、就地删除。
 * - routeError 是终态：无论是否流式，投递成功或回退都必须删除。
 * - 投递失败/未命中条目：删除后回退主聊天，防止无界泄漏。
 * - finish/fail：幂等兜底删除，分别对应正常收尾与错误收尾。
 */
class RequestRouteTable {
  constructor(
    private readonly entries: Map<string, { clientId: WebviewClientId; keepUntilFinalize: boolean }>,
    private readonly deliverResponse: (clientId: WebviewClientId, requestId: string, data: unknown) => boolean,
    private readonly deliverError: (clientId: WebviewClientId, requestId: string, code: string, message: string) => boolean,
    private readonly fallbackResponse: (requestId: string, data: unknown) => void,
    private readonly fallbackError: (requestId: string, code: string, message: string) => void,
  ) {}

  /** 登记映射。requestId 或 clientId 为空时不登记（与既有入口守卫一致）。 */
  track(requestId: string, clientId: WebviewClientId | undefined, keepUntilFinalize: boolean): void {
    if (requestId && clientId) {
      this.entries.set(requestId, { clientId, keepUntilFinalize });
    }
  }

  /** 正常收尾/兜底清理：删除条目（幂等）。 */
  finish(requestId: string): void {
    this.entries.delete(requestId);
  }

  /** 错误收尾清理：删除条目（幂等）。与 finish 同效果，语义上区分失败路径。 */
  fail(requestId: string): void {
    this.entries.delete(requestId);
  }

  /** 按 requestId 路由成功响应，内部决定是否保留条目。 */
  routeResponse(requestId: string, data: unknown): void {
    const entry = this.entries.get(requestId);
    if (entry && this.deliverResponse(entry.clientId, requestId, data)) {
      if (!entry.keepUntilFinalize) {
        this.entries.delete(requestId);
      }
      return;
    }
    this.entries.delete(requestId);
    this.fallbackResponse(requestId, data);
  }

  /** 按 requestId 路由错误响应；错误是终态，路由成功或回退都必须删除条目。 */
  routeError(requestId: string, code: string, message: string): void {
    const entry = this.entries.get(requestId);
    if (entry && this.deliverError(entry.clientId, requestId, code, message)) {
      this.entries.delete(requestId);
      return;
    }
    this.entries.delete(requestId);
    this.fallbackError(requestId, code, message);
  }
}

/**
 * 流式消息类型（由 MESSAGE_NAMES 常量组成，避免成为协议消息名的第二事实源）
 */
export const STREAM_MESSAGE_TYPES = [
  MESSAGE_NAMES.chatStream,
  MESSAGE_NAMES.retryStream,
  MESSAGE_NAMES.toolConfirmation,
  MESSAGE_NAMES.cancelStream,
  // H2（R6a-FIX）：reroll/editBranch 长流与 chatStream/retryStream 同模式——
  // 走 fire-and-forget，避免 route() 串行 await 整个流占死 IPC 消息队列
  // （期间 cancelStream/deleteMessage/switchBranchCandidate/新消息全部排队）。
  MESSAGE_NAMES['chat.rerollStream'],
  MESSAGE_NAMES['chat.editBranchStream']
] as const;

type StreamMessageType = typeof STREAM_MESSAGE_TYPES[number];

/**
 * 消息路由器
 */
export class MessageRouter {
  private registry: MessageHandlerRegistry;
  private streamHandler: StreamRequestHandler;
  private abortManager: StreamAbortManager;
  private clientRegistry: WebviewClientRegistry;
  // 底层 Map 保留 MessageRouter.requestClients 命名：既有测试经 (router as any).requestClients.size
  // 断言「无残留」，且历史事故也以此名留档。RequestRouteTable 是唯一的增删入口。
  private requestClients = new Map<string, { clientId: WebviewClientId; keepUntilFinalize: boolean }>();
  private requestRoutes: RequestRouteTable;

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
    this.requestRoutes = new RequestRouteTable(
      this.requestClients,
      (clientId, requestId, data) => this.clientRegistry.sendResponse(clientId, requestId, data),
      (clientId, requestId, code, message) => this.clientRegistry.sendError(clientId, requestId, code, message),
      (requestId, data) => this.sendResponse(requestId, data),
      (requestId, code, message) => this.sendError(requestId, code, message)
    );
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
      finalizeRequest: (requestId) => this.requestRoutes.finish(requestId)
    });
  }

  /**
   * 路由消息到正确的处理器
   * 
   * @returns true 如果消息已处理，false 如果需要回退到原有处理
   */
  async route(type: string, data: any, requestId: string, ctx: HandlerContext, clientId?: string): Promise<boolean> {
    const resolvedClientId = this.clientRegistry.resolveClientId(clientId, ctx.clientId);

    // requestId → clientId 的映射：只对「确实会被本 router 处理」的请求登记（未命中处理器而
    // 回退的消息、handler 抛异常的请求都不应留下永不清理的条目）。删除策略统一收敛到
    // RequestRouteTable：流式请求 keepUntilFinalize=true，由流的 finally/finalizeRequest 清理；
    // 非流式请求由 finish/fail 与 routeError 清理。
    const trackRequestClient = (keepUntilFinalize: boolean) => {
      this.requestRoutes.track(requestId, resolvedClientId, keepUntilFinalize);
    };

    // 检查是否是流式消息
    if (this.isStreamMessage(type)) {
      trackRequestClient(true);
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
      trackRequestClient(false);
      const routedCtx = this.createRoutedContext(ctx, resolvedClientId);
      handler(data, requestId, routedCtx).then(
        () => {
          // handler 成功但未调用 sendResponse/sendError（成功但不回复）时，路由条目会永久残留。
          // 非阻塞请求都是非流式 handler，resolve 后映射不再被使用，统一兜底释放防泄漏
          // （createRoutedContext 的 sendResponse/sendError 不负责删除，删除统一由本表收口）。
          this.requestRoutes.finish(requestId);
        },
        (error) => {
          console.error(`[MessageRouter] Non-blocking handler error for ${type}:`, error);
          // 必须先 routeError 再兜底清理：routeError 依赖 requestId → clientId 映射路由回发起方，
          // 先删会导致错误必然错投主聊天，Monitor 面板请求永久挂起。
          try {
            this.sendRoutedError(requestId, 'HANDLER_ERROR', error?.message || String(error));
          } catch {
            // 发送错误失败则静默忽略
          }
          // routeError 在成功路由与回退时都会删除条目；这里兜底清理防泄漏（幂等）。
          this.requestRoutes.fail(requestId);
        }
      );
      return true;
    }

    trackRequestClient(false);
    const routedCtx = this.createRoutedContext(ctx, resolvedClientId);
    try {
      await handler(data, requestId, routedCtx);
      // 阻塞 handler 正常返回却没有响应时也必须释放路由映射。
      this.requestRoutes.finish(requestId);
    } catch (error) {
      // handler 抛出时没有任何一方会回复，映射必须就地清理
      this.requestRoutes.fail(requestId);
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
      // H6/R2-xx：实时存活探测（registry.isAlive 包装）——流式 handler（reroll/editBranch）
      // 的 StreamChunkProcessor.getView 用它判断「视图从可达变为不可达」并中止后端生成
      // （见 ChatHandlers.createRoutedChunkProcessor）。
      isClientAlive: () => this.clientRegistry.isClientReachable(clientId),
      sendResponse: (requestId, data) => {
        if (!this.clientRegistry.sendResponse(clientId, requestId, data)) {
          ctx.sendResponse(requestId, data);
        }
        // 不在此处删除路由条目：流式请求（chat.rerollStream / chat.editBranchStream）
        // 的 started:true 之后流仍在进行，后续错误响应仍要靠 requestId → clientId 映射
        // 路由回发起方；条目由 RequestRouteTable 的 keepUntilFinalize 语义保留，
        // 并在 route()/runRegistryStreamHandler/finalizeRequest 的 finish/fail 统一清理。
      },
      sendError: (requestId, code, message) => {
        if (!this.clientRegistry.sendError(clientId, requestId, code, message)) {
          ctx.sendError(requestId, code, message);
        }
      },
      postMessage: (message: any): boolean => {
        // 同步失败由返回值回退；异步投递失败（webview 已销毁/拒绝）经 onDeliveryFailed
        // 回调回退（下方注册的回调执行 ctx.postMessage 兜底投递）——二者互斥，不会双重
        // 回退。返回值透出投递结果（R2-09，统一语义）：true = 已送达或已进入异步投递
        // （异步失败经回调回退，不保证最终送达）；false = 完全未送达（registry 丢弃且
        // 回退不可用/失败），调用方可留痕。
        if (!this.clientRegistry.postMessage(clientId, message, () => {
          ctx.postMessage?.(message);
        })) {
          return ctx.postMessage?.(message) ?? false;
        }
        return true;
      }
    };
  }

  private sendRoutedResponse(requestId: string, data: any): void {
    this.requestRoutes.routeResponse(requestId, data);
  }

  private sendRoutedError(requestId: string, code: string, message: string): void {
    this.requestRoutes.routeError(requestId, code, message);
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
        this.requestRoutes.fail(requestId);
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
        // data 缺失时直接解构会抛 TypeError（被上层 catch 吞掉），已登记的请求会永久残留；
        // 先 routeError 回传错误（映射还在，能路由到发起方），再兜底清理。
        if (!data || typeof data.conversationId !== 'string' || !data.conversationId) {
          try {
            this.sendRoutedError(requestId, 'INVALID_DATA', 'cancelStream: missing conversationId');
          } catch {
            // 发送错误失败则静默忽略
          }
          this.requestRoutes.fail(requestId);
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
   * 不会被长流占死；错误先经 routeError 按路由回传（依赖 requestId → clientId 映射），
   * 再兜底清理路由映射（RequestRouteTable.fail）。
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
      this.requestRoutes.fail(requestId);
      return;
    }
    const routedCtx = this.createRoutedContext(ctx, clientId);
    Promise.resolve(handler(data, requestId, routedCtx)).then(
      () => {
        // 流正常结束后统一清理路由映射（与 finalizeRequest 语义一致；
        // 流期间错误由 handler 内经 routedCtx 回传，不依赖该映射）
        this.requestRoutes.finish(requestId);
      },
      (error: any) => {
        console.error(`[MessageRouter] Stream handler error for ${type}:`, error);
        // 必须先 routeError 再兜底清理：routeError 依赖 requestId → clientId 映射路由回发起方
        try {
          this.sendRoutedError(requestId, 'HANDLER_ERROR', error?.message || String(error));
        } catch {
          // 发送错误失败则静默忽略
        }
        this.requestRoutes.fail(requestId);
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
