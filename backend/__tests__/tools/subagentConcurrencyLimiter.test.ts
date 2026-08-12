/**
 * SubAgentConcurrencyLimiter 单元测试
 *
 * 覆盖：容量内直接放行、满员 FIFO 排队、release 唤醒、-1 无限制、
 * 排队中取消、release 幂等、容量动态调大后的批量唤醒、排队超时。
 */

import {
    SubAgentConcurrencyLimiter,
    SubAgentQueueCancelledError
} from '../../tools/subagents';
import { SubAgentQueueTimeoutError } from '../../tools/subagents/concurrencyLimiter';

/** 让微任务队列排空，用于断言"仍在排队" */
const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('SubAgentConcurrencyLimiter', () => {
    test('容量内立即放行', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 2);
        await limiter.acquire('r1');
        await limiter.acquire('r2');
        expect(limiter.getRunningCount()).toBe(2);
        expect(limiter.getQueueLength()).toBe(0);
    });

    test('满员时排队，release 后按 FIFO 唤醒', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 1);
        await limiter.acquire('r1');

        const order: string[] = [];
        const p2 = limiter.acquire('r2').then(() => order.push('r2'));
        const p3 = limiter.acquire('r3').then(() => order.push('r3'));
        await flushMicrotasks();
        expect(limiter.getQueueLength()).toBe(2);

        limiter.release('r1');
        await p2;
        expect(order).toEqual(['r2']);

        limiter.release('r2');
        await p3;
        expect(order).toEqual(['r2', 'r3']);
    });

    test('容量 -1 表示无限制', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => -1);
        for (let i = 0; i < 10; i++) {
            await limiter.acquire(`r${i}`);
        }
        expect(limiter.getRunningCount()).toBe(10);
    });

    test('容量 0 视为配置错误，按无限制处理避免死锁', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 0);
        await limiter.acquire('r1');
        expect(limiter.getRunningCount()).toBe(1);
    });

    test('未配置容量时默认 3', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => undefined);
        await limiter.acquire('r1');
        await limiter.acquire('r2');
        await limiter.acquire('r3');
        const pending = limiter.acquire('r4');
        await flushMicrotasks();
        expect(limiter.getQueueLength()).toBe(1);
        limiter.release('r1');
        await pending;
    });

    test('排队中被取消时移出队列并抛出取消错误', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 1);
        await limiter.acquire('r1');

        const controller = new AbortController();
        const pending = limiter.acquire('r2', controller.signal);
        await flushMicrotasks();
        expect(limiter.getQueueLength()).toBe(1);

        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(SubAgentQueueCancelledError);
        expect(limiter.getQueueLength()).toBe(0);

        // 取消者不占席位，后续 release 不受影响
        limiter.release('r1');
        expect(limiter.getRunningCount()).toBe(0);
    });

    test('已取消的信号直接拒绝', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 1);
        const controller = new AbortController();
        controller.abort();
        await expect(limiter.acquire('r1', controller.signal))
            .rejects.toBeInstanceOf(SubAgentQueueCancelledError);
    });

    test('release 幂等：重复释放不产生多余席位', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 1);
        await limiter.acquire('r1');
        limiter.release('r1');
        limiter.release('r1');
        expect(limiter.getRunningCount()).toBe(0);
    });

    test('容量动态调大后一次 release 唤醒多个等待者', async () => {
        let capacity = 1;
        const limiter = new SubAgentConcurrencyLimiter(() => capacity);
        await limiter.acquire('r1');

        const p2 = limiter.acquire('r2');
        const p3 = limiter.acquire('r3');
        await flushMicrotasks();
        expect(limiter.getQueueLength()).toBe(2);

        capacity = 3;
        limiter.release('r1');
        await Promise.all([p2, p3]);
        expect(limiter.getRunningCount()).toBe(2);
        expect(limiter.getQueueLength()).toBe(0);
    });

    test('排队超时：timeoutMs 到达后 reject SubAgentQueueTimeoutError 并从队列移除（release 不再唤醒它）', async () => {
        jest.useFakeTimers();
        try {
            const limiter = new SubAgentConcurrencyLimiter(() => 1);
            await limiter.acquire('r1');

            // acquire 的 promise executor 同步入队，无需推进定时器即可断言在排队
            const pending = limiter.acquire('r2', undefined, 100);
            expect(limiter.getQueueLength()).toBe(1);

            jest.advanceTimersByTime(100);
            await expect(pending).rejects.toBeInstanceOf(SubAgentQueueTimeoutError);
            expect(limiter.getQueueLength()).toBe(0);
            // 定时器已触发消费，无残留 open handle
            expect(jest.getTimerCount()).toBe(0);

            // 超时者不占席位：release 不再唤醒它
            limiter.release('r1');
            expect(limiter.getRunningCount()).toBe(0);
            expect(limiter.getQueueLength()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('排队超时前获得席位：定时器被清除，超时不再触发', async () => {
        jest.useFakeTimers();
        try {
            const limiter = new SubAgentConcurrencyLimiter(() => 1);
            await limiter.acquire('r1');

            const order: string[] = [];
            const pending = limiter.acquire('r2', undefined, 100).then(() => order.push('r2'));
            expect(limiter.getQueueLength()).toBe(1);

            // 超时前 release：drainQueue 唤醒并清理定时器（无 open handle 残留）
            limiter.release('r1');
            await pending;
            expect(order).toEqual(['r2']);
            expect(jest.getTimerCount()).toBe(0);

            // 超时点已过：不再 reject，也不再有排队条目
            jest.advanceTimersByTime(200);
            expect(limiter.getRunningCount()).toBe(1);
            expect(limiter.getQueueLength()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('排队超时前被 abort：定时器被清除，不产生超时错误', async () => {
        jest.useFakeTimers();
        try {
            const limiter = new SubAgentConcurrencyLimiter(() => 1);
            await limiter.acquire('r1');

            const controller = new AbortController();
            const pending = limiter.acquire('r2', controller.signal, 100);
            expect(limiter.getQueueLength()).toBe(1);

            controller.abort();
            await expect(pending).rejects.toBeInstanceOf(SubAgentQueueCancelledError);
            expect(limiter.getQueueLength()).toBe(0);
            // abort 移除路径同样清除排队超时定时器
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('排队超时溢出防护：超过 setTimeout 上限（2^31-1 ms）的 timeoutMs 被 clamp，不会立即触发', async () => {
        jest.useFakeTimers();
        try {
            const limiter = new SubAgentConcurrencyLimiter(() => 1);
            await limiter.acquire('r1');

            // 2^31 毫秒超过 setTimeout 上限：若未 clamp，Node 会把超限值当作 1ms 立即触发回调
            const pending = limiter.acquire('r2', undefined, 2 ** 31);
            expect(limiter.getQueueLength()).toBe(1);

            // 推进 1ms：未 clamp 的话此刻已 reject；clamp 后仍在排队
            jest.advanceTimersByTime(1);
            expect(limiter.getQueueLength()).toBe(1);

            // 推进到 clamp 后的上限（2^31-1）附近：超时触发，队列清空
            jest.advanceTimersByTime(2 ** 31 - 2);
            await expect(pending).rejects.toBeInstanceOf(SubAgentQueueTimeoutError);
            expect(limiter.getQueueLength()).toBe(0);
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});
