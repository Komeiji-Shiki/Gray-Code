/**
 * 检查点模块有界并发与取消辅助（CPF-06 / CPF-11）。
 *
 * - runBounded：有界并发池，替代无限 Promise.all（文件哈希 / 复制 / 恢复 / 目录统计）
 * - CheckpointAbortError / throwIfAborted：AbortSignal 风格取消标志，操作循环内检查
 */
export const DEFAULT_CHECKPOINT_CONCURRENCY = 8;

/** 存档操作被取消时抛出的错误 */
export class CheckpointAbortError extends Error {
    constructor(message = 'Checkpoint operation aborted') {
        super(message);
        this.name = 'CheckpointAbortError';
    }
}

/** 在操作循环内检查取消标志；已取消时抛 CheckpointAbortError 中止当前操作 */
export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new CheckpointAbortError();
    }
}

/**
 * 有界并发池：以固定并发度执行 items，全部完成后返回。
 *
 * 与 CheckpointSnapshotBuilder 内部的 runBounded 语义一致（并发执行、按需取下一个任务），
 * 这里作为模块级共享实现供 CheckpointManager / CheckpointRestoreEngine / 查询服务复用。
 *
 * 错误语义：任意 worker 抛错时停止取新任务，只抛出第一个错误；
 * 其余 worker 的错误被吞掉，避免多个并发 rejection 产生 unhandled rejection。
 */
export async function runBounded<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
): Promise<void> {
    if (items.length === 0) return;
    let nextIndex = 0;
    let firstError: unknown;
    const runNext = async (): Promise<void> => {
        while (nextIndex < items.length) {
            if (firstError !== undefined) return;
            const index = nextIndex;
            nextIndex += 1;
            try {
                await worker(items[index]);
            } catch (error) {
                if (firstError === undefined) {
                    firstError = error;
                }
                return;
            }
        }
    };
    const workers = Array.from(
        { length: Math.min(Math.max(concurrency, 1), items.length) },
        () => runNext()
    );
    await Promise.all(workers);
    if (firstError !== undefined) {
        throw firstError;
    }
}
