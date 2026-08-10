/**
 * 流式请求管理器
 * 
 * 管理流式请求的取消控制器
 */

import type * as vscode from 'vscode';
import type { ConversationRunScope, IRunController, RunControllerSnapshot } from '../../backend/core/RunController';
import { subAgentRunController } from '../../backend/tools/subagents/runController';
import { subAgentRunEventBus } from '../../backend/tools/subagents/runEventBus';
import { registerDetachedSubAgentTask } from '../../backend/tools/subagents/detachedTaskBridge';

/**
 * 旧流退出等待超时（毫秒）。
 *
 * 用户「停止后立即重发」时，新流必须在旧流完全退出（工具结算落盘、finally 注销控制器）
 * 后才能写入用户消息，否则旧流的结算 addContent 会落在新用户消息之后，历史出现半截旧回答/
 * 错位结算。旧流 abort 后通常在工具结算窗口（约 3s）+ 收尾窗口（约 2s）内退出，这里留出余量；
 * 超时兜底保证旧流异常挂死时也不会阻塞新流启动太久。
 */
export const OLD_STREAM_EXIT_WAIT_TIMEOUT_MS = 6000;

/**
 * 流式请求管理器
 *
 * 修改原因：WP21 需要把 conversation run 的最小控制能力提升为共享契约，供后续 RunController / TurnSession 演进复用。
 * 修改方式：保持现有 create/get/cancel/delete 等方法不变，只额外声明实现 IRunController 并提供轻量只读适配方法。
 * 修改目的：统一主聊天与 SubAgent 控制器的类型语言，同时不改变任何 cancel / retry / edit / delete 相关用户语义。
 */
export class StreamAbortManager implements IRunController<ConversationRunScope> {
  readonly scopeType = 'conversation' as const;
  private controllers: Map<string, AbortController> = new Map();
  /** 总结请求专用取消器（仅取消总结 API，不中断主对话流） */
  private summaryControllers: Map<string, AbortController> = new Map();
  /** 会话主流真正退出时唤醒等待者；由 delete() 在控制器引用仍匹配时统一释放。 */
  private idleWaiters: Map<string, Set<() => void>> = new Map();
  /**
   * 已退休旧流（被 cancel / create 替换）的退出信号链：conversationId → { chain, resolveTail }。
   *
   * 背景（H1）：停止按钮 cancel() 会先把旧流控制器移出 controllers，但旧流取消路径还要等
   * 工具结算窗口（约 3s）落盘、finally 执行 delete() 才算真正退出；若新流不等旧流退出就写入
   * 用户消息，旧流的结算 addContent 会落在新用户消息之后（半截旧回答/错位结算）。
   * cancel() 移出 controllers 后，旧流 finally 的 delete() 因引用校验不匹配而提前 return，
   * 退出信号必须独立于 controllers 记录，由 delete() 按 controller 引用释放。
   * 链式叠加：连续多次 stop/重发时，新请求等待的是所有旧代退出后的总信号。
   */
  private retiredExits: Map<string, { chain: Promise<void>; resolveTail: () => void; pending: number; resolvers: Set<() => void> }> = new Map();
  /** 已退休旧流 controller → 该代退出信号的 resolve（delete() 按引用释放） */
  private retiredResolvers: Map<AbortController, () => void> = new Map();

  /**
   * 记录一代已退休旧流的退出信号；其 finally 调用 delete() 时由 releaseRetiredExit 释放。
   *
   * pending：该会话尚未释放的退休代数。连续 stop/重发会叠加多代退休流，只有所有代都释放
   * （pending 归零）才删除条目——避免「尾代先退」时提前删条目，让等待前代的调用方误判空闲。
   * resolvers：该链上全部代的退出 resolver 快照（复制前代并追加本代），clearRetiredChain
   * 超时清理时按此一并释放全部代（不只尾代）。
   * 自清理定时器：旧流 finally 可能因工具挂死/网络挂起永不执行，条目会永久残留；超时后按
   * identity 校验清理，不误清新代条目。
   */
  private trackRetiredExit(conversationId: string, controller: AbortController): void {
    const prev = this.retiredExits.get(conversationId);
    let resolveTail: () => void = () => {};
    const tail = new Promise<void>((resolve) => { resolveTail = resolve; });
    const chain = prev ? prev.chain.then(() => tail) : tail;
    const resolvers = new Set(prev?.resolvers ?? []);
    resolvers.add(resolveTail);
    const entry = {
      chain,
      resolveTail,
      pending: (prev?.pending ?? 0) + 1,
      resolvers
    };
    this.retiredExits.set(conversationId, entry);
    this.retiredResolvers.set(controller, resolveTail);
    setTimeout(() => this.clearRetiredChain(conversationId, entry), OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);
  }

  /**
   * 释放指定旧流的退出信号（其 finally 已执行）。若该代就是当前链尾，一并移除记录防残留；
   * 不是链尾时只释放自身（链式 promise 会继续等待后续代）。
   */
  private releaseIdleWaiters(conversationId: string): void {
    const waiters = this.idleWaiters.get(conversationId);
    if (!waiters) return;
    this.idleWaiters.delete(conversationId);
    for (const resolve of waiters) resolve();
  }

  private releaseAllRetiredExits(): void {
    const resolvers = Array.from(this.retiredResolvers.values());
    this.retiredResolvers.clear();
    this.retiredExits.clear();
    for (const resolve of resolvers) resolve();
  }

  private clearRetiredChain(
    conversationId: string,
    retired: { chain: Promise<void>; resolveTail: () => void; pending: number; resolvers: Set<() => void> }
  ): void {
    // identity 校验：条目已被新代替换或已正常释放时，不误清新代状态
    if (this.retiredExits.get(conversationId) === retired) {
      this.retiredExits.delete(conversationId);
    }
    // 释放该链上全部代的退出信号（而不只是尾代）：等待方可能已捕获 chain 引用，
    // 任一代的 resolver 不释放都会让 chain 永不落定；同时清出 retiredResolvers 防残留。
    for (const [controller, resolve] of this.retiredResolvers) {
      if (retired.resolvers.has(resolve)) {
        this.retiredResolvers.delete(controller);
      }
    }
    for (const resolve of retired.resolvers) {
      resolve();
    }
  }

  private releaseRetiredExit(conversationId: string, controller: AbortController): void {
    const resolver = this.retiredResolvers.get(controller);
    if (!resolver) return;
    this.retiredResolvers.delete(controller);
    const current = this.retiredExits.get(conversationId);
    if (current) {
      // pending 归零才删条目：尾代先退时条目保留，等待方继续等前代退出
      current.pending -= 1;
      if (current.pending <= 0) {
        this.retiredExits.delete(conversationId);
      }
    }
    resolver();
  }

  /**
   * 竞速等待一组信号，超时兜底（避免等待方永久挂起）。
   *
   * @returns true = 超时胜出（信号未全部落定）；false = 信号先落定
   */
  private async raceWithTimeout(signals: Array<Promise<void> | undefined>, timeoutMs: number): Promise<boolean> {
    const pending = signals.filter((signal): signal is Promise<void> => !!signal);
    if (pending.length === 0) return false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, Math.max(0, timeoutMs));
    });
    try {
      await Promise.race([Promise.all(pending), timeoutPromise]);
    } finally {
      // 信号先落定时清理 timer，避免残留 open handle
      if (timer) clearTimeout(timer);
    }
    return timedOut;
  }

  /**
   * 中止当前活跃流并等待其完全退出（含已退休旧流的收尾），带超时兜底。
   *
   * 用途：流式入口（chatStream / retryStream / editAndRetryStream / toolConfirmationStream）
   * 在 create() 之前调用，保证写入用户消息/截断历史时旧流已完全退出——
   * 旧流的工具结算 addContent 不会再落在新用户消息之后（H1 写序竞态）。
   * 无旧流时立即返回；有活跃流时先 abort 再等其 finally（delete 唤醒 waitForIdle）。
   *
   * @param timeoutMs 超时兜底，默认 OLD_STREAM_EXIT_WAIT_TIMEOUT_MS
   */
  async abortAndWaitForCompletion(conversationId: string, timeoutMs: number = OLD_STREAM_EXIT_WAIT_TIMEOUT_MS): Promise<void> {
    const existing = this.controllers.get(conversationId);
    // 先注册等待者再 abort：若旧流在 abort 与 waitForIdle 之间退出，waitForIdle 会立即返回，
    // 不存在漏唤醒。
    const idle = this.waitForIdle(conversationId);
    if (existing) {
      existing.abort();
    }
    // 已退休（cancel 场景）与当前活跃流两路信号都要等：cancel 移出 controllers 后旧流
    // finally 的 delete() 走引用不匹配分支，只释放 retired 信号；活跃流走匹配分支释放 idle。
    const retired = this.retiredExits.get(conversationId);
    await this.raceWithTimeout([idle, retired?.chain], timeoutMs);
  }

  /**
   * 只等待旧流退出信号，不中止当前流。
   *
   * 用途：后端 ChatFlowService 各入口在写入用户消息/截断历史之前调用——此时新流控制器
   * 已在 webview 层 create() 登记，不能再 abort；本方法只等被 cancel/替换的旧流 finally
   * 完成（delete() 释放 retired 信号）。无旧流时立即返回；旧流挂死时由超时兜底。
   */
  async waitForOldStreamCompletion(conversationId: string, timeoutMs: number = OLD_STREAM_EXIT_WAIT_TIMEOUT_MS): Promise<void> {
    const retired = this.retiredExits.get(conversationId);
    if (!retired) return;
    await this.raceWithTimeout([retired.chain], timeoutMs);
  }

  /**
   * 全局实例注册（供后端 ChatFlowService 读取同一实例做旧流退出等待，H1）。
   *
   * 后端 ChatFlowService 由 ChatHandler 在 webview 层之前构建，无法通过构造函数拿到
   * abort manager，因此在 StreamRequestHandler 构造时注册到这里；ChatFlowService 经
   * getGlobalInstance() 读取。测试/独立调用路径未注册时为 undefined，等待退化为 no-op。
   */
  private static globalInstance: StreamAbortManager | undefined;
  static setGlobalInstance(manager: StreamAbortManager | undefined): void {
    StreamAbortManager.globalInstance = manager;
  }
  static getGlobalInstance(): StreamAbortManager | undefined {
    return StreamAbortManager.globalInstance;
  }

  /**
   * 创建并存储新的 AbortController
   */
  create(conversationId: string): AbortController {
    // 修改原因：新流启动（用户发新消息/重试/reroll 等）会 abort 旧流；旧流工具循环中等待结果的
    // 前台 SubAgent 挂在父 abort 信号上，会被连带杀掉。用户发新消息应当让它们转为后台继续运行，
    // 而不是终止——所以先 detach 该会话活跃前台 SubAgent，再 abort 旧流。
    // 修改目的：用户发消息不再杀死正在干活的前台子代理；run 继续执行，结果经 Monitor/事件总线呈现。
    this.detachActiveSubAgents(conversationId);
    // 同一会话已有活跃流时，先中止旧流再替换（与 createSummary 语义一致）。
    // 否则旧流完全不可取消，且旧流先结束时其 finally 的 delete 会误删新流的控制器。
    const existing = this.controllers.get(conversationId);
    if (existing) {
      existing.abort();
      // 被替换的旧流已不在 controllers 中：记录其退出信号，供「停止后立即重发」的
      // abortAndWaitForCompletion / waitForOldStreamCompletion 等待其 finally 完成。
      this.trackRetiredExit(conversationId, existing);
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
   * 把该会话仍在前台等待的活跃 SubAgent 转为后台继续运行（detach）。
   *
   * 修改原因：前台 SubAgent 的 abort 信号挂在主会话工具循环上；本方法在 abort 旧流之前调用，
   * 确保旧流取消不再连带杀掉还在干活的 SubAgent（与 background:true 语义一致）。
   * 后台 run（attachedToParent=false）不受影响；已 detach 的 run 跳过；其他会话的 run 不受影响。
   */
  private detachActiveSubAgents(conversationId: string): void {
    try {
      const snapshots = subAgentRunEventBus.getSnapshots();
      for (const snapshot of snapshots) {
        if (snapshot.conversationId !== conversationId) continue;
        if (!subAgentRunController.isActive(snapshot.runId)) continue;
        if (subAgentRunController.isDetached(snapshot.runId)) continue;
        if (subAgentRunController.detachFromParent(snapshot.runId)) {
          registerDetachedSubAgentTask(snapshot);
        }
      }
    } catch (err) {
      console.warn('[StreamAbortManager] Failed to detach active subagents before starting new stream:', err);
    }
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
      this.trackRetiredExit(conversationId, controller);
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
    this.detachActiveSubAgents(conversationId);
    return this.cancel(conversationId);
  }

  /**
   * 获取当前仍有活跃主流请求的对话 ID 列表
   */
  listConversationIds(): string[] {
    return Array.from(this.controllers.keys());
  }

  /**
   * 修改原因：WP21 共享接口需要显式暴露 controller 所属 scope 类型。
   * 修改方式：返回固定的 conversation 字面量，不引入任何运行时分支。
   * 修改目的：让上层共享代码可直接根据接口识别“这是 conversation scope controller”。
   */
  getScopeType(): 'conversation' {
    return this.scopeType;
  }

  /**
   * 修改原因：统一接口不能继续把 conversationId 当成匿名字符串四处传递。
   * 修改方式：把现有 conversationId 包装为显式 RunScope 数据。
   * 修改目的：后续共享运行时可以在不写 source/view 特判的情况下识别作用域。
   */
  getScope(conversationId: string): ConversationRunScope {
    return {
      type: 'conversation',
      conversationId
    };
  }

  /**
   * 修改原因：IRunController 需要统一的活跃 ID 读取入口。
   * 修改方式：复用既有 listConversationIds 结果，不改变“只统计主流请求”的现有语义。
   * 修改目的：共享调用方不必知道 conversation controller 的历史命名。
   */
  listActiveIds(): string[] {
    return this.listConversationIds();
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
   * 等待指定会话的主流真正退出。
   *
   * 前端 complete chunk 只表示模型消息已经落盘，并不代表 StreamRequestHandler 的 finally
   * 已执行。后台任务回执若只看前端 isStreaming，会在这个窗口创建新流并中止旧流。
   * 本方法以控制器 Map 为唯一生命周期事实来源；空闲时立即返回，活跃时由 delete() 唤醒。
   */
  async waitForIdle(conversationId: string): Promise<void> {
    while (true) {
      if (this.controllers.has(conversationId)) {
        // 活跃流分支同样需要超时兜底：流的 finally 可能因工具挂死/网络挂起长期不执行，
        // 仅靠 delete() 唤醒会让等待方永久挂起。与 retired 分支同口径：
        // 超时视同「已空闲」返回（而不是 continue 循环重试，避免每 6s 重试一次、永不返回）。
        const timedOut = await this.raceWithTimeout([
          new Promise<void>(resolve => {
            let waiters = this.idleWaiters.get(conversationId);
            if (!waiters) {
              waiters = new Set();
              this.idleWaiters.set(conversationId, waiters);
            }
            waiters.add(resolve);
          })
        ], OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);
        if (timedOut) return;
        continue;
      }

      const retired = this.retiredExits.get(conversationId);
      if (!retired) return;
      // 超时兜底：退休旧流的 finally 可能因工具挂死/网络挂起长期不执行，其退出信号链
      // 永不 resolve。与 abortAndWaitForCompletion 的退出等待同一超时口径；**超时后必须
      // 返回**（而不是 continue 循环重试）——否则 waitForIdle 会每 6s 重试一次、
      // 永不返回，chat.awaitConversationIdle → backgroundTaskStore.flushReports 依旧
      // 永久挂起。超时视同「旧流已退出」：调用方按既有语义继续。
      // 顺带移除该代退出记录：晚到的 finally 由 releaseRetiredExit 按 resolver 释放，
      // 条目残留会让后续 waitForIdle 再白等 6s。
      const timedOut = await this.raceWithTimeout(
        [retired.chain],
        OLD_STREAM_EXIT_WAIT_TIMEOUT_MS
      );
      if (timedOut) {
        this.clearRetiredChain(conversationId, retired);
        return;
      }
    }
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
   * 修改原因：WP21 需要一个最小只读快照来描述 conversation run 的活跃状态。
   * 修改方式：仅当主流请求存在时返回 running 快照；summary controller 仍是内部细节，不额外提升为独立 run。
   * 修改目的：给共享契约提供稳定读取面，同时保持当前“主请求取消时顺带取消总结”的既有语义。
   */
  getSnapshot(conversationId: string): RunControllerSnapshot<ConversationRunScope> | undefined {
    const controller = this.get(conversationId);
    if (!controller) {
      return undefined;
    }

    return {
      scope: this.getScope(conversationId),
      active: true,
      status: 'running',
      abortSignal: controller.signal,
      capabilities: {
        pause: false,
        resume: false,
        exit: false
      }
    };
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
      this.releaseRetiredExit(conversationId, controller);
      return;
    }
    this.controllers.delete(conversationId);
    if (controller) {
      this.releaseRetiredExit(conversationId, controller);
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
      this.trackRetiredExit(conversationId, controller);
    }
    this.controllers.clear();
    // cancelAll 仅用于视图/扩展整体销毁，不会有后续写入；直接终结所有退休链，避免销毁等待者挂起。
    this.releaseAllRetiredExits();
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
}
