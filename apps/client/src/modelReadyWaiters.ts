interface Waiter<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
/** 同一文件的并发调用共享等待，任何旧超时都不能删除后来建立的等待。 */
export class ModelReadyWaiters<T> {
  private readonly waiters = new Map<string, Waiter<T>>();
  private disposed = false;
  constructor(private readonly error: () => Error, private readonly timeout = 10_000) {}
  wait(key: string): Promise<T> {
    if (this.disposed) return Promise.reject(this.error());
    const existing = this.waiters.get(key);
    if (existing) return existing.promise;
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
    const timer = setTimeout(() => { this.waiters.delete(key); reject(this.error()); }, this.timeout);
    this.waiters.set(key, { promise, resolve, reject, timer });
    return promise;
  }
  resolve(key: string, value: T): void {
    const waiting = this.waiters.get(key);
    if (!waiting) return;
    this.waiters.delete(key); clearTimeout(waiting.timer); waiting.resolve(value);
  }
  dispose(): void {
    this.disposed = true;
    for (const waiting of this.waiters.values()) { clearTimeout(waiting.timer); waiting.reject(this.error()); }
    this.waiters.clear();
  }
}
