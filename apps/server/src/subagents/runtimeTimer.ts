/** 按实际执行时间计时；明确暂停期间不计入时长，长时限分段安排以避开 Node 定时器溢出。 */
export class SubagentRuntimeTimer {
  private timer?: ReturnType<typeof setTimeout>;
  private remainingMs: number;
  private startedAt?: number;
  private disposed = false;

  constructor(seconds: number, private readonly expire: () => void) {
    this.remainingMs = seconds > 0 ? seconds * 1000 : Infinity;
    this.resume();
  }

  pause(): void {
    if (this.startedAt === undefined) return;
    this.remainingMs -= Math.max(0, performance.now() - this.startedAt);
    this.startedAt = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  resume(): void {
    if (this.disposed || this.startedAt !== undefined || !Number.isFinite(this.remainingMs)) return;
    this.startedAt = performance.now();
    this.timer = setTimeout(() => {
      this.pause();
      if (this.remainingMs <= 0) { this.disposed = true; this.expire(); }
      else this.resume();
    }, Math.max(1, Math.min(this.remainingMs, 2_147_483_647)));
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
  }
}
