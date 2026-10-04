import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RegexContext, RegexRule, RegexTransform, WorldActivation } from '@graycode/contracts';
import type { WorldEvaluation } from './engine';

/** Untrusted regular expressions cannot block the task service or renderer. */
export class CharacterEngine {
  private readonly active = new Set<Worker>();
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
    if (this.active.size >= 8) return Promise.reject(new Error('角色资源处理器繁忙，请稍后重试。'));
    signal?.throwIfAborted();
    const worker = new Worker(path.join(__dirname, 'characters.worker.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 128 } });
    this.active.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        // 调用完成时名额已释放，调用方可以立即接续下一批，而不会撞上尚在退出的线程。
        void worker.terminate().then(
          () => error ? reject(error) : resolve(value!),
          cause => reject(error ?? cause)
        );
      };
      const abort = () => finish(new Error('角色资源处理已取消。'));
      const timer = setTimeout(() => finish(new Error('正则或世界书处理超时，请检查复杂表达式。')), this.timeoutMs);
      worker.once('message', message => finish(message.error ? new Error(message.error) : undefined, message.value));
      worker.once('error', finish);
      worker.once('exit', () => {
        // 收到结果后终止仍是异步的，退出前保留在线程集合中，让 close 等到资源真正释放。
        this.active.delete(worker);
        if (!settled) finish(new Error('角色资源处理器已退出。'));
      });
      signal?.addEventListener('abort', abort, { once: true });
      try { if (signal?.aborted) abort(); else worker.postMessage(input); }
      catch (error) { finish(error as Error); }
    });
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.active].map(worker => worker.terminate())); this.active.clear(); }
}
