import { Worker } from 'node:worker_threads';
import { evaluateTextSearch, presentToolMatch, type TextSearchInput, type TextSearchResult } from '../../../shared/textSearch';
import { expandReplacementTemplate } from '../../../shared/regexReplacement';

/** 只将本地固定函数作为启动源码；查询、正文和替换内容始终通过消息传入。 */
function workerMain(evaluate: typeof evaluateTextSearch, expand: typeof expandReplacementTemplate, present: typeof presentToolMatch): void {
    const { parentPort } = require('node:worker_threads') as typeof import('node:worker_threads');
    parentPort!.on('message', (input: TextSearchInput) => {
        parentPort!.postMessage({ started: true });
        try { parentPort!.postMessage({ result: evaluate(input, expand, present) }); }
        catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
    });
}

interface Pending {
    resolve: (result: TextSearchResult) => void;
    reject: (error: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
}

/** 每次搜索复用一个线程；文件顺序不变，取消或超时会真正终止正在回溯的正则。 */
export class TextSearchWorker {
    private worker?: Worker;
    private pending?: Pending;
    private queue: Promise<unknown> = Promise.resolve();
    private closing?: Promise<void>;
    private stopped = false;
    private stopReason: unknown = new Error('搜索计算已关闭。');
    private readonly abort = () => { void this.close(this.options.signal?.reason); };
    constructor(private readonly options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
        if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
            throw new Error('搜索计算时限必须为正数。');
        if (options.signal?.aborted) { this.stopped = true; this.stopReason = options.signal.reason; }
        else options.signal?.addEventListener('abort', this.abort, { once: true });
    }
    run(input: TextSearchInput): Promise<TextSearchResult> {
        const operation = this.queue.then(() => this.execute(input));
        this.queue = operation.catch(() => {});
        return operation;
    }
    private execute(input: TextSearchInput): Promise<TextSearchResult> {
        if (this.stopped) return Promise.reject(this.stopReason);
        const worker = this.worker ?? this.start();
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
            try { worker.postMessage(input); }
            catch (error) { void this.discard(error); }
        });
    }
    private start(): Worker {
        const worker = new Worker('(' + workerMain.toString() + ')(' + evaluateTextSearch.toString() + ',' + expandReplacementTemplate.toString() + ',' + presentToolMatch.toString() + ');', { eval: true });
        this.worker = worker;
        worker.on('message', (message: { started?: boolean; result?: TextSearchResult; error?: string }) => {
            if (this.worker !== worker || !this.pending) return;
            if (message.started) {
                // 等计算开始再计时，线程启动和前一个文件的排队不占单文件预算。
                if (this.options.timeoutMs !== undefined) this.pending.timer = setTimeout(() => {
                    const error = Object.assign(new Error('正则计算超过单文件时限（' + this.options.timeoutMs + ' ms），该文件未完成。'), { code: 'REGEX_TIMEOUT' });
                    void this.discard(error);
                }, this.options.timeoutMs);
                return;
            }
            const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
            if (message.error !== undefined) pending.reject(new Error(message.error));
            else pending.resolve(message.result!);
        });
        worker.once('error', error => { if (this.worker === worker) void this.discard(error); });
        worker.once('exit', code => {
            if (this.worker !== worker) return;
            this.worker = undefined;
            const pending = this.pending; this.pending = undefined; clearTimeout(pending?.timer);
            pending?.reject(new Error('搜索计算线程意外退出：' + code));
        });
        return worker;
    }
    private async discard(error: unknown): Promise<void> {
        const worker = this.worker, pending = this.pending;
        this.worker = undefined; this.pending = undefined; clearTimeout(pending?.timer);
        try { await worker?.terminate(); }
        finally { pending?.reject(error); }
    }
    close(reason: unknown = this.stopReason): Promise<void> {
        if (this.closing) return this.closing;
        this.stopped = true; this.stopReason = reason;
        this.options.signal?.removeEventListener('abort', this.abort);
        return this.closing = this.discard(reason).then(() => this.queue).then(() => {});
    }
}
