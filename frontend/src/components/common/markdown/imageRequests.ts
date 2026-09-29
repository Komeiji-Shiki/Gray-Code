interface Consumer<T> { current(): boolean; priority(): number; resolve(value: T | undefined): void; reject(error: unknown): void }
interface Job<T> { key: string; load(): Promise<T>; consumers: Consumer<T>[]; started: boolean }
/** 跨消息共享四个读取名额；同一工作区世代和路径只读取一次，已卸载的排队任务直接释放。 */
export class ImageRequests<T> {
  private readonly jobs = new Map<string, Job<T>>();
  private active = 0;
  request(key: string, load: () => Promise<T>, current: () => boolean, priority: () => number): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(key) ?? { key, load, consumers: [], started: false };
      job.consumers.push({ current, priority, resolve, reject }); this.jobs.set(key, job); this.pump();
    });
  }
  private pump(): void {
    const queued = [...this.jobs.values()].filter(job => !job.started);
    for (const job of queued) {
      job.consumers = job.consumers.filter(consumer => { if (consumer.current()) return true; consumer.resolve(undefined); return false; });
      if (!job.consumers.length) this.jobs.delete(job.key);
    }
    queued.filter(job => job.consumers.length).sort((a, b) => Math.min(...a.consumers.map(item => item.priority())) - Math.min(...b.consumers.map(item => item.priority()))).forEach(job => {
      if (this.active >= 4) return;
      job.started = true; this.active++;
      void job.load().then(value => { for (const consumer of job.consumers) consumer.resolve(consumer.current() ? value : undefined); },
        error => { for (const consumer of job.consumers) { if (consumer.current()) consumer.reject(error); else consumer.resolve(undefined); } })
        .finally(() => { this.active--; if (this.jobs.get(job.key) === job) this.jobs.delete(job.key); this.pump(); });
    });
  }
}
