/**
 * 流式请求管理器（第三批模块化重构：拆分为 abort/ 子模块后的组合壳）
 *
 * 管理流式请求的取消控制器。
 *
 * 拆分（纯移动，逻辑不变）：
 * - abort/AbortControllerRegistry.ts ← 控制器注册表（controllers/summaryControllers 的
 *   create/get/cancel/delete/cancelAll/createSummary/cancelSummary/deleteSummary/
 *   getAbortSignal/isActive/registerIdleWaiter + idleWaiters 释放）
 * - abort/RetiredStreamChain.ts ← 退休链状态机（retiredExits/retiredResolvers/
 *   track/release/releaseAll/clear + OLD_STREAM_EXIT_WAIT_TIMEOUT_MS 常量）
 * 本文件保留：等待语义（waitForIdle/waitForOldStreamCompletion/abortAndWaitForCompletion）、
 * IRunController 适配层、detachActiveSubAgents（子代理解绑，第五批再处理该依赖）、
 * 全局实例注册；通过组合（new AbortControllerRegistry + new RetiredStreamChain）对外行为完全一致。
 */

import type { ConversationRunScope, IRunController, RunControllerSnapshot } from '../../backend/core/RunController';
import { subAgentRunController } from '../../backend/tools/subagents/runController';
import { subAgentRunEventBus } from '../../backend/tools/subagents/runEventBus';
import { AbortControllerRegistry } from './abort/AbortControllerRegistry';
import { RetiredStreamChain } from './abort/RetiredStreamChain';
import { OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from '../../backend/core/streamConstants';

/**
 * 旧流退出等待超时（毫秒），定义于 backend/core/streamConstants（第五批层反转修复：
 * 后端 ChatFlowService 改从 core 导入；与退休链自清理定时器同源同值 6000ms），
 * 此处 re-export 保持既有 import（ChatFlowService / StreamRequestHandler /
 * ConversationHandlers）不破坏。
 */
export { OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from '../../backend/core/streamConstants';

/**
 * 流式请求管理器
 *
 * 修改原因：WP21 需要把 conversation run 的最小控制能力提升为共享契约，供后续 RunController / TurnSession 演进复用。
 * 修改方式：保持现有 create/get/cancel/delete 等方法不变，只额外声明实现 IRunController 并提供轻量只读适配方法。
 * 修改目的：统一主聊天与 SubAgent 控制器的类型语言，同时不改变任何 cancel / retry / edit / delete 相关用户语义。
 */
export class StreamAbortManager implements IRunController<ConversationRunScope> {
  readonly scopeType = 'conversation' as const;

  /** 退休链状态机：被 cancel / create 替换的旧流退出信号（组合，语义与拆分前一致） */
  private readonly retiredChain = new RetiredStreamChain();
  /** 控制器注册表：主流/总结控制器 + waitForIdle 等待者唤醒（组合，detach 经回调注入） */
  private readonly registry = new AbortControllerRegistry(
    this.retiredChain,
    (conversationId) => this.detachActiveSubAgents(conversationId),
  );

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
   * 用途：流式入口（chatStream / retryStream / toolConfirmationStream）
   * 在 create() 之前调用，保证写入用户消息/截断历史时旧流已完全退出——
   * 旧流的工具结算 addContent 不会再落在新用户消息之后（H1 写序竞态）。
   * 无旧流时立即返回；有活跃流时先 abort 再等其 finally（delete 唤醒 waitForIdle）。
   *
   * @param timeoutMs 超时兜底，默认 OLD_STREAM_EXIT_WAIT_TIMEOUT_MS
   */
  async abortAndWaitForCompletion(conversationId: string, timeoutMs: number = OLD_STREAM_EXIT_WAIT_TIMEOUT_MS): Promise<void> {
    const existing = this.registry.get(conversationId);
    // 先注册等待者再 abort：若旧流在 abort 与 waitForIdle 之间退出，waitForIdle 会立即返回，
    // 不存在漏唤醒。waitForIdle 内部使用同一 timeoutMs（M7：旧实现固定 6s，外层传更小
    // 超时先返回时其内部定时器仍挂起最多 6s，残留 open handle）。
    const idle = this.waitForIdle(conversationId, timeoutMs);
    if (existing) {
      existing.abort();
    }
    // 已退休（cancel 场景）与当前活跃流两路信号都要等：cancel 移出 controllers 后旧流
    // finally 的 delete() 走引用不匹配分支，只释放 retired 信号；活跃流走匹配分支释放 idle。
    const retired = this.retiredChain.getEntry(conversationId);
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
    const retired = this.retiredChain.getEntry(conversationId);
    if (!retired) return;
    await this.raceWithTimeout([retired.chain], timeoutMs);
  }

  /**
   * 创建并存储新的 AbortController（委托注册表；注册表内部负责 detach 旧流前台 SubAgent、
   * 登记退休链、释放 idleWaiters，语义与拆分前一致）
   */
  create(conversationId: string): AbortController {
    return this.registry.create(conversationId);
  }

  /**
   * 获取指定对话的 AbortController
   */
  get(conversationId: string): AbortController | undefined {
    return this.registry.get(conversationId);
  }

  /**
   * 取消指定对话的流式请求
   */
  cancel(conversationId: string): boolean {
    return this.registry.cancel(conversationId);
  }

  /**
   * 为“开始新回合”取消旧流：先把前台 SubAgent 转为后台，再中止父回合。
   *
   * 普通 cancel 仍表示用户显式停止，会保留父级取消传播；只有排队消息的“立即发送”
   * 等明确替换当前回合的操作才调用本方法。
   */
  cancelForNewTurn(conversationId: string): boolean {
    return this.registry.cancelForNewTurn(conversationId);
  }

  /**
   * 获取指定会话的取消代次（P1 TOCTOU 修复用）。
   *
   * 流式入口（handleChatStream / handleRetryStream / handleToolConfirmationStream）在
   * awaitOldStreamCompletion 等待前快照、create() 后复查：代次变化说明等待窗口内到达过
   * cancelStream（「停止」），应立即取消刚创建的控制器、不启动新流，避免停止操作丢失。
   */
  getCancelEpoch(conversationId: string): number {
    return this.registry.getCancelEpoch(conversationId);
  }

  /**
   * 获取当前仍有活跃主流请求的对话 ID 列表
   */
  listConversationIds(): string[] {
    return this.registry.listConversationIds();
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
    return this.registry.isActive(conversationId);
  }

  /**
   * 等待指定会话的主流真正退出。
   *
   * 前端 complete chunk 只表示模型消息已经落盘，并不代表 StreamRequestHandler 的 finally
   * 已执行。后台任务回执若只看前端 isStreaming，会在这个窗口创建新流并中止旧流。
   * 本方法以控制器 Map 为唯一生命周期事实来源；空闲时立即返回，活跃时由 delete() 唤醒。
   *
   * @param timeoutMs 单轮等待上限（默认 OLD_STREAM_EXIT_WAIT_TIMEOUT_MS）；
   *                  M7：调用方传更小超时（如 abortAndWaitForCompletion 的外层超时）时
   *                  内部定时器同步使用该值，避免外层已返回而内部定时器仍挂起残留 open handle。
   */
  async waitForIdle(conversationId: string, timeoutMs: number = OLD_STREAM_EXIT_WAIT_TIMEOUT_MS): Promise<void> {
    while (true) {
      if (this.registry.isActive(conversationId)) {
        // 活跃流分支同样需要超时兜底：流的 finally 可能因工具挂死/网络挂起长期不执行，
        // 仅靠 delete() 唤醒会让等待方永久挂起。与 retired 分支同口径：
        // 超时视同「已空闲」返回（而不是 continue 循环重试，避免每 6s 重试一次、永不返回）。
        const waiter = this.registry.registerIdleWaiter(conversationId);
        const timedOut = await this.raceWithTimeout([waiter.promise], timeoutMs);
        if (timedOut) {
          // P2：超时分支从 idleWaiters Set 摘除本等待者——resolve 已随超时返回失去意义，
          // 滞留会让「会话持续活跃 + 多次超时」下 idleWaiters 无界增长。
          // 已由 releaseIdleWaiters 整体释放时 unregister 为无害 no-op。
          waiter.unregister();
          return;
        }
        continue;
      }

      const retired = this.retiredChain.getEntry(conversationId);
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
        timeoutMs
      );
      if (timedOut) {
        this.retiredChain.clear(conversationId, retired);
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
    return this.registry.getAbortSignal(conversationId);
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
   * 删除指定对话的 AbortController（委托注册表；引用校验与退休信号释放语义与拆分前一致）
   */
  delete(conversationId: string, controller?: AbortController): void {
    this.registry.delete(conversationId, controller);
  }

  /**
   * 创建并存储总结请求的 AbortController
   */
  createSummary(conversationId: string): AbortController {
    return this.registry.createSummary(conversationId);
  }

  /** 获取总结请求的 AbortController */
  getSummary(conversationId: string): AbortController | undefined {
    return this.registry.getSummary(conversationId);
  }

  /** 取消总结请求（不影响主对话流） */
  cancelSummary(conversationId: string): boolean {
    return this.registry.cancelSummary(conversationId);
  }

  /** 删除总结请求控制器 */
  deleteSummary(conversationId: string, controller?: AbortController): void {
    this.registry.deleteSummary(conversationId, controller);
  }

  /**
   * 取消所有活跃的流式请求（R2-07：移除从未使用的 _view 参数）
   */
  cancelAll(): void {
    this.registry.cancelAll();
  }

  /**
   * 会话删除路径的注册表清理（R2-07）：移除取消代次等会话级残留状态。
   */
  removeConversation(conversationId: string): void {
    this.registry.removeConversation(conversationId);
  }

  /**
   * 获取活跃的流式请求数量
   */
  get size(): number {
    return this.registry.size;
  }

  /**
   * 把该会话仍在前台等待的活跃 SubAgent 转为后台继续运行（detach）。
   *
   * 修改原因：前台 SubAgent 的 abort 信号挂在主会话工具循环上；本方法在 abort 旧流之前调用，
   * 确保旧流取消不再连带杀掉还在干活的 SubAgent（与 background:true 语义一致）。
   * 后台 run（attachedToParent=false）不受影响；已 detach 的 run 跳过；其他会话的 run 不受影响。
   * （依赖 backend/tools/subagents，第五批模块化重构再处理）
   */
  private detachActiveSubAgents(conversationId: string): void {
    try {
      const snapshots = subAgentRunEventBus.getSnapshots();
      for (const snapshot of snapshots) {
        if (snapshot.conversationId !== conversationId) continue;
        if (!subAgentRunController.isActive(snapshot.runId)) continue;
        if (subAgentRunController.isDetached(snapshot.runId)) continue;
        if (subAgentRunController.detachFromParent(snapshot.runId)) {
          // 本地 detach 机制已接管后台运行（executor 父信号解绑 + 后台回执展示层），
          // 上游 detachedTaskBridge 后台任务体系未引入（见 63676f2/b0fb1f5 适配说明），无需注册。
        }
      }
    } catch (err) {
      console.warn('[StreamAbortManager] Failed to detach active subagents before starting new stream:', err);
    }
  }
}
