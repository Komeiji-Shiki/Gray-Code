// 供 utils.ts 聚合导出：fetch 超时 + 外部取消信号合并（自上游 imageUtils.createFetchSignal）

/**
 * 把外部取消信号与超时合并为一个 AbortSignal，防止 fetch 无限期挂起。
 *
 * 修改原因：generate_image / remove_background 的 Gemini API 请求只有取消信号、无超时保护，
 *          网络挂起时会无限期等待。
 * 修改方式：手动组合 AbortController（不用 AbortSignal.any，兼容 Electron 内置 Node < 20.3），
 *          调用方在 finally 中调用 cleanup 清理超时定时器。
 */
export function createFetchSignal(
    abortSignal: AbortSignal | undefined,
    timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        abortSignal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
        cleanup();
        controller.abort(abortSignal?.reason);
    };
    if (abortSignal?.aborted) {
        controller.abort(abortSignal.reason);
    } else {
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        timeoutId = setTimeout(() => controller.abort(new Error(`API request timed out after ${timeoutMs}ms`)), timeoutMs);
    }
    return { signal: controller.signal, cleanup };
}
