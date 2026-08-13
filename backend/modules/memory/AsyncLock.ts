/**
 * GrayCode - Memory 异步锁
 *
 * 保证 LOG/TREE 写操作串行化。从 MemoryManager.ts 抽离（纯重构，行为不变）。
 */

export class AsyncLock {
    private _chain: Promise<void> = Promise.resolve();

    async acquire(): Promise<() => void> {
        let release!: () => void;
        const next = new Promise<void>(r => { release = r; });
        const prev = this._chain;
        this._chain = prev.then(() => next);
        await prev;
        return release;
    }
}
