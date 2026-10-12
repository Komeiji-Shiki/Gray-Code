import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RegexContext, RegexRule, RegexTransform, WorldActivation } from '@graycode/contracts';
import type { WorldEvaluation } from './engine';

/** 不可信正则留在可终止线程中；正常完成后复用线程及其编译缓存。 */
export class CharacterEngine {
  private readonly workers = new Set<Worker>();
  private readonly busy = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private closed = false;
  constructor(private readonly timeoutMs = 1000) {}
  transform(text: string, rules: RegexRule[], context: RegexContext, signal?: AbortSignal): Promise<RegexTransform> {
    if (text.length > 2 * 1024 * 1024 || rules.length > 1000) return Promise.reject(new Error('正则输入超出单次处理限制。'));
    return this.evaluate({ type: 'regex', text, rules, context }, signal);
  }
  transformBatch(items: { text: string; context: RegexContext }[], rules: RegexRule[], signal?: AbortSignal): Promise<RegexTransform[]> {
    if (!rules.length) {
      if (this.closed) return Promise.reject(new Error('角色资源处理器已关闭。'));
      signal?.throwIfAborted();
      return Promise.resolve(items.map(item => ({ text: item.text, applied: [], errors: [] })));
    }
    return this.evaluate({ type: 'regex-batch', items, rules }, signal);
  }
  worldbooks(options: WorldEvaluation, signal?: AbortSignal): Promise<WorldActivation> { return this.evaluate({ type: 'world', options }, signal); }
  private evaluate<T>(input: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('角色资源处理器已关闭。'));
    if (this.busy.size >= 8) return Promise.reject(new Error('角色资源处理器繁忙，请稍后重试。'));
    signal?.throwIfAborted();
    const worker = this.idle.pop() ?? this.createWorker();
    worker.ref();
    this.busy.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        worker.off('message', message);
        worker.off('error', failed);
        worker.off('exit', exited);
        this.busy.delete(worker);
        if (error || this.closed) {
          void worker.terminate().then(() => reject(error ?? new Error('角色资源处理器已关闭。')), reject);
        } else {
          this.idle.push(worker);
          worker.unref();
          resolve(value!);
        }
      };
      const abort = () => finish(new Error('角色资源处理已取消。'));
      const message = (reply: { error?: string; value?: T }) => finish(reply.error ? new Error(reply.error) : undefined, reply.value);
      const failed = (error: Error) => finish(error);
      const exited = () => finish(new Error('角色资源处理器已退出。'));
      const timer = setTimeout(() => finish(new Error('正则或世界书处理超时，请检查复杂表达式。')), this.timeoutMs);
      worker.once('message', message);
      worker.once('error', failed);
      worker.once('exit', exited);
      signal?.addEventListener('abort', abort, { once: true });
      try { if (signal?.aborted) abort(); else worker.postMessage(input); }
      catch (error) { finish(error as Error); }
    });
  }
  private createWorker(): Worker {
    const worker = new Worker(path.join(__dirname, 'characters.worker.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 128 } });
    this.workers.add(worker);
    const removeIdle = () => {
      const index = this.idle.indexOf(worker);
      if (index >= 0) this.idle.splice(index, 1);
    };
    worker.on('error', removeIdle);
    worker.once('exit', () => { this.workers.delete(worker); removeIdle(); });
    return worker;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workers].map(worker => worker.terminate()));
    this.workers.clear();
    this.busy.clear();
    this.idle.length = 0;
  }
}
