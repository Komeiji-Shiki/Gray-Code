import { createHash } from 'node:crypto';

export type ListenerState = 'disabled' | 'stopped' | 'starting' | 'listening' | 'stopping' | 'error';

/** 支持轮换令牌的监听服务保留已有连接；不支持时令牌变化会重启监听。 */
export interface ManagedListener {
  close(): Promise<void>;
  rotateToken?(token: string): Promise<void>;
}

export interface ListenerPlan<S extends ManagedListener> {
  /** 端口、地址等监听参数的稳定序列化；变化时必须重新监听。 */
  target: string;
  token: string;
  start(): Promise<S>;
}

/**
 * 跟随设置启停的本地监听器。所有变更串行执行：监听参数变化时重启，令牌变化时轮换或重启；
 * 手动停止后保持停止，直到配置变化或再次启动。
 */
export class ListenerLifecycle<S extends ManagedListener> {
  server?: S;
  state: ListenerState = 'disabled';
  error?: string;
  private initialized = false;
  private closed = false;
  private paused = false;
  private desiredKey = '';
  private running = { target: '', tokenHash: '' };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly hooks: {
    /** 当前期望的监听计划；未启用时返回 undefined，配置不可用时抛错。 */
    plan(): Promise<ListenerPlan<S> | undefined>;
    changed(): void;
  }) {}

  /** 只有正在监听或启动中才让应用留在后台；未启用、手动停止或启动失败时不再持有进程。 */
  get serving(): boolean { return !this.closed && (this.state === 'listening' || this.state === 'starting'); }

  initialize(): Promise<void> {
    this.initialized = true;
    return this.enqueue(() => this.apply());
  }

  /** 设置变化后重新应用；失败只体现在状态和错误信息里。 */
  reapply(): void {
    if (this.initialized && !this.closed) void this.enqueue(() => this.apply()).catch(() => {});
  }

  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.paused = false;
    return this.enqueue(() => this.apply());
  }

  stop(): void {
    if (this.closed) return;
    this.paused = true; this.state = this.server ? 'stopping' : 'stopped'; this.emit();
    void this.enqueue(async () => {
      if (this.closed) return;
      await this.disconnect();
      this.state = 'stopped';
      this.error = undefined;
      this.emit();
    }).catch(error => this.fail(error));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => {});
    await this.disconnect();
    this.state = 'stopped';
  }

  private emit() { if (!this.closed) this.hooks.changed(); }

  private fail(error: unknown) {
    if (this.closed) return;
    this.state = 'error'; this.error = error instanceof Error ? error.message : String(error); this.emit();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.catch(() => {}).then(async () => {
      // 设置保存先完成当前请求的处理，再开始变更监听状态。
      await new Promise<void>(resolve => setImmediate(resolve));
      return operation();
    });
    this.queue = current;
    return current;
  }

  private async disconnect() {
    const server = this.server;
    if (!server) return;
    this.state = 'stopping'; this.emit();
    await server.close();
    this.server = undefined;
  }

  private async apply(): Promise<void> {
    if (this.closed || !this.initialized) return;
    let cleanupAttempted = false;
    try {
      const plan = await this.hooks.plan();
      if (!plan) {
        cleanupAttempted = true; await this.disconnect();
        this.state = 'disabled'; this.error = undefined; this.paused = false; this.desiredKey = ''; this.emit(); return;
      }
      const tokenHash = createHash('sha256').update(plan.token).digest('hex');
      const key = `${plan.target}\n${tokenHash}`;
      // 改了端口或令牌说明希望新配置生效，撤销之前的手动停止。
      if (this.desiredKey !== key) this.paused = false;
      this.desiredKey = key;
      if (this.paused) return;
      if (this.server && this.state === 'listening' && plan.target === this.running.target) {
        if (tokenHash === this.running.tokenHash) return;
        if (this.server.rotateToken) {
          await this.server.rotateToken(plan.token);
          this.running.tokenHash = tokenHash; this.emit(); return;
        }
      }
      cleanupAttempted = true; await this.disconnect();
      this.state = 'starting'; this.error = undefined; this.emit();
      const server = await plan.start();
      if (this.closed) { await server.close(); return; }
      this.server = server; this.running = { target: plan.target, tokenHash }; this.state = 'listening'; this.emit();
    } catch (error) {
      try { if (!cleanupAttempted) await this.disconnect(); }
      finally { this.fail(error); }
      throw error;
    }
  }
}
