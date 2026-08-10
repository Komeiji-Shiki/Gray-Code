/**
 * 已退休旧流退出信号链状态机（第三批模块化重构：从 StreamAbortManager 拆分）。
 *
 * 管理被 cancel / create 替换的旧流的退出信号（retiredExits / retiredResolvers），
 * 由 StreamAbortManager 壳通过组合持有；代际计数、尾代先退、等待超时语义与拆分前逐字一致。
 */

/**
 * 旧流退出等待超时（毫秒）。
 *
 * 用户「停止后立即重发」时，新流必须在旧流完全退出（工具结算落盘、finally 注销控制器）
 * 后才能写入用户消息，否则旧流的结算 addContent 会落在新用户消息之后，历史出现半截旧回答/
 * 错位结算。旧流 abort 后通常在工具结算窗口（约 3s）+ 收尾窗口（约 2s）内退出，这里留出余量；
 * 超时兜底保证旧流异常挂死时也不会阻塞新流启动太久。
 */
export const OLD_STREAM_EXIT_WAIT_TIMEOUT_MS = 6000;

/** 一代退休链条目：chain 为所有旧代退出后的总信号；resolvers 为链上全部代的 resolver 快照 */
export interface RetiredChainEntry {
  chain: Promise<void>;
  resolveTail: () => void;
  pending: number;
  resolvers: Set<() => void>;
}

export class RetiredStreamChain {
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
  private retiredExits: Map<string, RetiredChainEntry> = new Map();
  /** 已退休旧流 controller → 该代退出信号的 resolve（delete() 按引用释放） */
  private retiredResolvers: Map<AbortController, () => void> = new Map();

  /**
   * 记录一代已退休旧流的退出信号；其 finally 调用 delete() 时由 release 释放。
   *
   * pending：该会话尚未释放的退休代数。连续 stop/重发会叠加多代退休流，只有所有代都释放
   * （pending 归零）才删除条目——避免「尾代先退」时提前删条目，让等待前代的调用方误判空闲。
   * resolvers：该链上全部代的退出 resolver 快照（复制前代并追加本代），clear
   * 超时清理时按此一并释放全部代（不只尾代）。
   * 自清理定时器：旧流 finally 可能因工具挂死/网络挂起永不执行，条目会永久残留；超时后按
   * identity 校验清理，不误清新代条目。
   */
  track(conversationId: string, controller: AbortController): void {
    const prev = this.retiredExits.get(conversationId);
    let resolveTail: () => void = () => {};
    const tail = new Promise<void>((resolve) => { resolveTail = resolve; });
    const chain = prev ? prev.chain.then(() => tail) : tail;
    const resolvers = new Set(prev?.resolvers ?? []);
    resolvers.add(resolveTail);
    const entry: RetiredChainEntry = {
      chain,
      resolveTail,
      pending: (prev?.pending ?? 0) + 1,
      resolvers
    };
    this.retiredExits.set(conversationId, entry);
    this.retiredResolvers.set(controller, resolveTail);
    setTimeout(() => this.clear(conversationId, entry), OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);
  }

  /**
   * 释放指定旧流的退出信号（其 finally 已执行）。若该代就是当前链尾，一并移除记录防残留；
   * 不是链尾时只释放自身（链式 promise 会继续等待后续代）。
   */
  release(conversationId: string, controller: AbortController): void {
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

  /** 释放全部退休链信号（仅用于视图/扩展整体销毁路径，避免销毁等待者挂起）。 */
  releaseAll(): void {
    const resolvers = Array.from(this.retiredResolvers.values());
    this.retiredResolvers.clear();
    this.retiredExits.clear();
    for (const resolve of resolvers) resolve();
  }

  /**
   * 超时清理指定会话的退休链条目（identity 校验，不误清新代条目）。
   */
  clear(
    conversationId: string,
    retired: RetiredChainEntry
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

  /** 读取会话当前的退休链条目（无则 undefined），供等待语义读取 chain。 */
  getEntry(conversationId: string): RetiredChainEntry | undefined {
    return this.retiredExits.get(conversationId);
  }
}
