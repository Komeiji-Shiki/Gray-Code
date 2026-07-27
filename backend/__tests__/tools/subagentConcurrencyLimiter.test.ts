/**
 * SubAgentConcurrencyLimiter 单元测试
 *
 * 覆盖：容量内直接放行、满员 FIFO 排队、release 唤醒、-1 无限制、
 * 排队中取消、release 幂等、容量动态调大后的批量唤醒。
 */

import {
    SubAgentConcurrencyLimiter,
    SubAgentQueueCancelledError
} from '../../tools/subagents/concurrencyLimiter';

/** 让微任务队列排空，用于断言"仍在排队" */
const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('SubAgentConcurrencyLimiter', () => {
    it('容量内立即放行', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 2);
        await limiter.acquire('r1');
        await limiter.acquire('r2');
        expect(limiter.getRunningCount()).toBe(2);
        expect(limiter.getQueueLength()).toBe(0);
    });

    it('满员时排队，release 后按 FIFO 唤醒', async () => {
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

    it('容量 -1 表示无限制', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => -1);
        for (let i = 0; i < 10; i++) {
            await limiter.acquire(`r${i}`);
        }
        expect(limiter.getRunningCount()).toBe(10);
    });

    it('容量 0 视为配置错误，按无限制处理避免死锁', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 0);
        await limiter.acquire('r1');
        expect(limiter.getRunningCount()).toBe(1);
    });

    it('未配置容量时默认 3', async () => {
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

    it('排队中被取消时移出队列并抛出取消错误', async () => {
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

    it('已取消的信号直接拒绝', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 1);
        const controller = new AbortController();
        controller.abort();
        await expect(limiter.acquire('r1', controller.signal))
            .rejects.toBeInstanceOf(SubAgentQueueCancelledError);
    });

    it('release 幂等：重复释放不产生多余席位', async () => {
        const limiter = new SubAgentConcurrencyLimiter(() => 1);
        await limiter.acquire('r1');
        limiter.release('r1');
        limiter.release('r1');
        expect(limiter.getRunningCount()).toBe(0);
    });

    it('容量动态调大后一次 release 唤醒多个等待者', async () => {
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
});
