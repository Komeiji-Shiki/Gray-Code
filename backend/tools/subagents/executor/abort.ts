/**
 * 子代理执行器的中止语义辅助（可中断等待 / 优雅宽限）。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

/** 不响应 AbortSignal 的工具最多允许用于清理的时间；超时后 SubAgent 必须收敛终态。 */
export const SUBAGENT_TOOL_ABORT_GRACE_MS = 500;

export type AbortableOperationOutcome<T> =
    | { status: 'completed'; value: T }
    | { status: 'failed'; error: unknown }
    | { status: 'aborted' };

export async function waitForAbortableOperation<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    graceMs: number
): Promise<AbortableOperationOutcome<T>> {
    const settled = operation.then<AbortableOperationOutcome<T>, AbortableOperationOutcome<T>>(
        value => ({ status: 'completed', value }),
        error => ({ status: 'failed', error })
    );
    if (!signal) return await settled;

    let releaseAbortListener: () => void = () => undefined;
    const aborted = new Promise<AbortableOperationOutcome<T>>(resolve => {
        const onAbort = () => resolve({ status: 'aborted' });
        if (signal.aborted) {
            resolve({ status: 'aborted' });
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        releaseAbortListener = () => signal.removeEventListener('abort', onAbort);
    });

    const first = await Promise.race([settled, aborted]);
    releaseAbortListener();
    if (first.status !== 'aborted') return first;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = new Promise<AbortableOperationOutcome<T>>(resolve => {
        timer = setTimeout(() => resolve({ status: 'aborted' }), Math.max(0, graceMs));
    });
    const afterGrace = await Promise.race([settled, graceExpired]);
    if (timer) clearTimeout(timer);
    return afterGrace;
}

/**
 * 可中断等待：signal 触发中止时立即返回 false，正常等到时间返回 true。
 */
export function waitWithAbort(ms: number, signal?: AbortSignal | null): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            if (timer) clearTimeout(timer);
            resolve(false);
        };
        timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
