/**
 * withLinkedAbort 单元测试。
 *
 * 媒体工具原先在 handler 里直接 `context.abortSignal.addEventListener('abort', ...)`，
 * 既不摘除（一个回合内反复调用会累积监听器），也不处理「父信号已中止」的情况
 * （abort 事件早已派发，新挂的监听器永不触发，工具会照常跑完）。
 */

import { withLinkedAbort } from '../../tools/abortLink';
import type { ToolContext } from '../../tools/types';

function makeContext(signal?: AbortSignal): ToolContext {
    return { abortSignal: signal } as ToolContext;
}

describe('withLinkedAbort', () => {
    it('父信号中止时同步中止注入的子控制器', async () => {
        const parent = new AbortController();
        let observed: AbortSignal | undefined;

        const handler = withLinkedAbort(async (_args, _ctx, controller) => {
            observed = controller.signal;
            parent.abort();
            return { success: true };
        });

        await handler({}, makeContext(parent.signal));
        expect(observed?.aborted).toBe(true);
    });

    it('父信号在调用前已中止时，子控制器进入 handler 就是中止态', async () => {
        const parent = new AbortController();
        parent.abort();

        let abortedOnEntry: boolean | undefined;
        const handler = withLinkedAbort(async (_args, _ctx, controller) => {
            abortedOnEntry = controller.signal.aborted;
            return { success: true };
        });

        await handler({}, makeContext(parent.signal));
        expect(abortedOnEntry).toBe(true);
    });

    it('handler 正常返回后摘除监听器，反复调用不累积', async () => {
        const parent = new AbortController();
        const added: unknown[] = [];
        const removed: unknown[] = [];
        const realAdd = parent.signal.addEventListener.bind(parent.signal);
        const realRemove = parent.signal.removeEventListener.bind(parent.signal);
        parent.signal.addEventListener = ((type: string, listener: never) => {
            added.push(listener);
            realAdd(type, listener);
        }) as typeof parent.signal.addEventListener;
        parent.signal.removeEventListener = ((type: string, listener: never) => {
            removed.push(listener);
            realRemove(type, listener);
        }) as typeof parent.signal.removeEventListener;

        const handler = withLinkedAbort(async () => ({ success: true }));
        const context = makeContext(parent.signal);
        await handler({}, context);
        await handler({}, context);
        await handler({}, context);

        expect(added).toHaveLength(3);
        expect(removed).toHaveLength(3);
        expect(removed).toEqual(added);
    });

    it('handler 抛出时同样摘除监听器', async () => {
        const parent = new AbortController();
        const removed: unknown[] = [];
        const realRemove = parent.signal.removeEventListener.bind(parent.signal);
        parent.signal.removeEventListener = ((type: string, listener: never) => {
            removed.push(listener);
            realRemove(type, listener);
        }) as typeof parent.signal.removeEventListener;

        const handler = withLinkedAbort(async () => {
            throw new Error('boom');
        });

        await expect(handler({}, makeContext(parent.signal))).rejects.toThrow('boom');
        expect(removed).toHaveLength(1);
    });

    it('没有父信号时也能拿到可用的子控制器', async () => {
        let controllerSeen: AbortController | undefined;
        const handler = withLinkedAbort(async (_args, _ctx, controller) => {
            controllerSeen = controller;
            return { success: true };
        });

        await handler({}, undefined);
        expect(controllerSeen).toBeInstanceOf(AbortController);
        expect(controllerSeen?.signal.aborted).toBe(false);
    });
});
