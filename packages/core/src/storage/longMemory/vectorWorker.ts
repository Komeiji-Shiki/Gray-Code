import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { VectorMatch, VectorRankingRequest } from './vectors';

/** 存储调度器每次交给此线程一个计算任务，数据库句柄始终留在原线程。 */
export class VectorRanker {
  private readonly worker = new Worker(path.join(__dirname, 'long-memory-vector.worker.cjs'));
  private failure?: Error;
  constructor() {
    this.worker.on('error', error => { this.failure = error; });
    this.worker.on('exit', code => { this.failure ??= new Error(`向量计算线程已退出：${code}`); });
  }
  rank(input: VectorRankingRequest): Promise<VectorMatch[]> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.worker.off('message', message); this.worker.off('error', error); this.worker.off('exit', exited); };
      const message = (reply: { matches?: VectorMatch[]; error?: string }) => {
        cleanup(); if (reply.error) reject(new Error(reply.error)); else resolve(reply.matches!);
      };
      const error = (cause: Error) => { cleanup(); reject(cause); };
      const exited = (code: number) => error(new Error(`向量计算线程已退出：${code}`));
      this.worker.once('message', message); this.worker.once('error', error); this.worker.once('exit', exited);
      try { this.worker.postMessage(input, input.vectors ? [input.vectors] : []); } catch (cause) { error(cause as Error); }
    });
  }
  async close(): Promise<void> { await this.worker.terminate(); }
}
