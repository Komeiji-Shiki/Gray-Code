import type { ToolArgs, ToolContext, ToolHandler, ToolResult } from './types';

/**
 * 带父信号桥接的工具处理器签名：AbortController 由包装器注入，handler 不再自行创建。
 */
export type LinkedAbortHandler = (
    args: ToolArgs,
    context: ToolContext | undefined,
    abortController: AbortController
) => Promise<ToolResult>;

/**
 * 把回合级的 `context.abortSignal` 桥接到工具自己的 AbortController。
 *
 * 直接在 handler 里 `addEventListener('abort', ...)` 有两个问题：
 * 1. 父信号的生命周期覆盖整个回合，监听器不摘除的话，一个回合内多次调用同一工具会持续累积；
 * 2. 父信号在工具启动前就已中止时，'abort' 事件早已派发完毕，新挂的监听器永远不会触发，
 *    子信号会停留在未中止状态，工具照常执行完整个任务。
 *
 * 包装器统一处理这两点：进入时若父信号已中止则立即同步中止子信号，退出时无条件摘除监听器。
 */
export function withLinkedAbort(handler: LinkedAbortHandler): ToolHandler {
    return async (args: ToolArgs, context?: ToolContext): Promise<ToolResult> => {
        const abortController = new AbortController();
        const parentSignal = context?.abortSignal;

        if (!parentSignal) {
            return handler(args, context, abortController);
        }

        if (parentSignal.aborted) {
            abortController.abort();
            return handler(args, context, abortController);
        }

        const onParentAbort = () => abortController.abort();
        parentSignal.addEventListener('abort', onParentAbort);
        try {
            return await handler(args, context, abortController);
        } finally {
            parentSignal.removeEventListener('abort', onParentAbort);
        }
    };
}
