/**
 * 流式请求取消控制器注册表（第三批模块化重构：从 StreamAbortManager 拆分）。
 *
 * 管理主流（controllers）与总结请求（summaryControllers）的 AbortController，
 * 以及 waitForIdle 的等待者唤醒表（idleWaiters）。退休链交互经构造注入的
 * RetiredStreamChain 完成；新流启动前的 SubAgent detach 经构造注入的回调完成
 * （由 StreamAbortManager 壳注入，detachActiveSubAgents 留在壳，第五批再处理该依赖）。
 */

import type * as vscode from 'vscode';
import { RetiredStreamChain } from './RetiredStreamChain';

export class AbortControllerRegistry {
  private controllers: Map<string, AbortController> = new Map();
  /** 总结请求专用取消器（仅取消总结 API，不中断主对话流） */
  private summaryControllers: Map<string, AbortController> = new Map();
  /** 会话主流真正退出时唤醒等待者；由 delete() 在控制器引用仍匹配时统一释放。 */
  private idleWaiters: Map<string, Set<() => void>> = new Map();

  constructor(
    private readonly retiredChain: RetiredStreamChain,
    /** 新流启动/替换回合前把该会话前台 SubAgent 转为后台（由壳注入 detachActiveSubAgents） */
    private readonly detachActiveSubAgents?: (conversationId: string) => void,
  ) {}

  /**
   * 创建并存储新的 AbortController
   */
  create(conversationId: string): AbortController {
    // 修改原因：新流启动（用户发新消息/重试/reroll 等）会 abort 旧流；旧流工具循环中等待结果的
    // 前台 SubAgent 挂在父 abort 信号上，会被连带杀掉。用户发新消息应当让它们转为后台继续运行，
    // 而不是终止——所以先 detach 该会话活跃前台 SubAgent，再 abort 旧流。
    // 修改目的：用户发消息不再杀死正在干活的前台子代理；run 继续执行，结果经 Monitor/事件总线呈现。
    this.detachActiveSubAgents?.(conversationId);
    // 同一会话已有活跃流时，先中止旧流再替换（与 createSummary 语义一致）。
    // 否则旧流完全不可取消，且旧流先结束时其 finally 的 delete 会误删新流的控制器。
    const existing = this.controllers.get(conversationId);
    if (existing) {
      existing.abort();
      // 被替换的旧流已不在 controllers 中：记录其退出信号，供「停止后立即重发」的
      // abortAndWaitForCompletion / waitForOldStreamCompletion 等待其 finally 完成。
      this.retiredChain.track(conversationId, existing);
      // 同时释放 waitForIdle 的当前代等待者：旧流 finally 的 delete() 因引用不匹配
      // 只释放退休信号、不会释放 idleWaiters，若这里不放行，等待者会错过唤醒窗口，
      // 只能等到新流也结束后才在重检中醒来（新流挂起时即永久挂起）。释放后等待者
      // 会重检并针对新控制器重新注册，语义不变。
      this.releaseIdleWaiters(conversationId);
    }
    const controller = new AbortController();
    this.controllers.set(conversationId, controller);
    return controller;
  }

  /**
   * 获取指定对话的 AbortController
   */
  get(conversationId: string): AbortController | undefined {
    return this.controllers.get(conversationId);
  }

  /**
   * 取消指定对话的流式请求
   */
  cancel(conversationId: string): boolean {
    const controller = this.controllers.get(conversationId);
    const summaryController = this.summaryControllers.get(conversationId);
    let cancelled = false;

    if (controller) {
      controller.abort();
      // 先登记退休链，再从活跃表移除并释放 waitForIdle 的当前代等待者。等待者醒来后会
      // 继续检查 retiredExits，直到旧流 finally 真正释放该代信号，不会假报空闲。
      this.retiredChain.track(conversationId, controller);
      this.controllers.delete(conversationId);
      this.releaseIdleWaiters(conversationId);
      cancelled = true;
    }

    // 取消主请求时，也一并取消总结请求
    if (summaryController) {
      summaryController.abort();
      this.summaryControllers.delete(conversationId);
      cancelled = true;
    }

    return cancelled;
  }

  /**
   * 为“开始新回合”取消旧流：先把前台 SubAgent 转为后台，再中止父回合。
   *
   * 普通 cancel 仍表示用户显式停止，会保留父级取消传播；只有排队消息的“立即发送”
   * 等明确替换当前回合的操作才调用本方法。
   */
  cancelForNewTurn(conversationId: string): boolean {
    this.detachActiveSubAgents?.(conversationId);
    return this.cancel(conversationId);
  }

  /**
   * 获取当前仍有活跃主流请求的对话 ID 列表
   */
  listConversationIds(): string[] {
    return Array.from(this.controllers.keys());
  }

  /**
   * 修改原因：共享抽象需要判断某个 conversation scope 当前是否仍处于活跃运行态。
   * 修改方式：复用既有 controllers Map，而不是引入新的状态源。
   * 修改目的：保证适配层只读观察现有状态，不改变取消时机或控制流。
   */
  isActive(conversationId: string): boolean {
    return this.controllers.has(conversationId);
  }

  /**
   * 修改原因：统一接口要求用同一方法读取运行时 AbortSignal。
   * 修改方式：直接委托给既有 get()。
   * 修改目的：后续共享运行时可以透过接口拿到 signal，而不依赖具体 controller 名称。
   */
  getAbortSignal(conversationId: string): AbortSignal | undefined {
    return this.get(conversationId)?.signal;
  }

  /**
   * 删除指定对话的 AbortController
   */
  delete(conversationId: string, controller?: AbortController): void {
    // 引用校验：同一会话可能已启动新流，旧流结束时不能误删新流的控制器，
    // 否则新流变孤儿，点停止无反应。
    if (controller && this.controllers.get(conversationId) !== controller) {
      // 已退休旧流（被 cancel / create 替换）的 finally：只释放其退出信号，
      // 不动新流控制器；「停止后立即重发」的等待方（abortAndWaitForCompletion /
      // waitForOldStreamCompletion）据此继续。
      this.retiredChain.release(conversationId, controller);
      return;
    }
    this.controllers.delete(conversationId);
    if (controller) {
      this.retiredChain.release(conversationId, controller);
    }
    this.releaseIdleWaiters(conversationId);
  }

  /**
   * 创建并存储总结请求的 AbortController
   */
  createSummary(conversationId: string): AbortController {
    // 若存在旧的总结请求控制器，先中断再替换
    const existing = this.summaryControllers.get(conversationId);
    if (existing) {
      existing.abort();
    }
    const controller = new AbortController();
    this.summaryControllers.set(conversationId, controller);
    return controller;
  }

  /** 获取总结请求的 AbortController */
  getSummary(conversationId: string): AbortController | undefined {
    return this.summaryControllers.get(conversationId);
  }

  /** 取消总结请求（不影响主对话流） */
  cancelSummary(conversationId: string): boolean {
    const controller = this.summaryControllers.get(conversationId);
    if (!controller) return false;
    controller.abort();
    this.summaryControllers.delete(conversationId);
    return true;
  }

  /** 删除总结请求控制器 */
  deleteSummary(conversationId: string, controller?: AbortController): void {
    // 与 delete 相同的引用校验：旧总结流结束时不能误删新总结流的控制器。
    if (controller && this.summaryControllers.get(conversationId) !== controller) {
      return;
    }
    this.summaryControllers.delete(conversationId);
  }

  /**
   * 取消所有活跃的流式请求
   */
  cancelAll(_view?: { webview: vscode.Webview }): void {
    for (const [conversationId, controller] of this.controllers) {
      controller.abort();
      this.retiredChain.track(conversationId, controller);
    }
    this.controllers.clear();
    // cancelAll 仅用于视图/扩展整体销毁，不会有后续写入；直接终结所有退休链，避免销毁等待者挂起。
    this.retiredChain.releaseAll();
    for (const waiters of this.idleWaiters.values()) {
      for (const resolve of waiters) {
        resolve();
      }
    }
    this.idleWaiters.clear();

    for (const [, controller] of this.summaryControllers) {
      controller.abort();
    }
    this.summaryControllers.clear();
  }

  /**
   * 获取活跃的流式请求数量
   */
  get size(): number {
    return this.controllers.size;
  }

  /**
   * 会话主流仍活跃时注册等待者（waitForIdle 调用）：空闲时由 delete()/cancel()/create()
   * 替换路径统一释放，避免漏唤醒。
   */
  registerIdleWaiter(conversationId: string): Promise<void> {
    return new Promise<void>(resolve => {
      let waiters = this.idleWaiters.get(conversationId);
      if (!waiters) {
        waiters = new Set();
        this.idleWaiters.set(conversationId, waiters);
      }
      waiters.add(resolve);
    });
  }

  private releaseIdleWaiters(conversationId: string): void {
    const waiters = this.idleWaiters.get(conversationId);
    if (!waiters) return;
    this.idleWaiters.delete(conversationId);
    for (const resolve of waiters) resolve();
  }
}
