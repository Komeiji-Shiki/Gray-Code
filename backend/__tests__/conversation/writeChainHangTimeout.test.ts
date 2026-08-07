/**
 * 会话写队列挂起超时语义测试（SEC）。
 *
 * 覆盖：写队列的挂起超时只让调用方 fail-fast，队列链尾必须等待底层任务真正结束——
 * 否则超时后的旧任务仍在写盘，新任务并发启动会互相覆盖/删除，损坏历史/索引/元数据。
 */

import { withMetadataWriteSerialized, withHangTimeout } from '../../modules/conversation/storage';

describe('写队列挂起超时语义（SEC）', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('withMetadataWriteSerialized：超时后链不前进，后续写等待底层任务真正结束后才执行', async () => {
        jest.useFakeTimers();
        let releaseFirst: () => void = () => undefined;
        const firstTask = () => new Promise<void>(resolve => {
            releaseFirst = resolve;
        });

        // 第一个写任务挂起：30s（METADATA_WRITE_HANG_TIMEOUT_MS）后调用方感知超时失败
        const firstResult = withMetadataWriteSerialized('conv-hang', firstTask);
        const firstRejection = expect(firstResult).rejects.toThrow('hung for 30000ms');
        await jest.advanceTimersByTimeAsync(30000);
        await firstRejection;

        // 第二个写任务入队：修复前链已前进 → 会并发启动；修复后必须等第一个任务真正结束
        let secondRan = false;
        let secondResolve: (() => void) | undefined;
        const secondPromise = withMetadataWriteSerialized('conv-hang', async () => {
            secondRan = true;
            secondResolve?.();
            return 1;
        });
        await jest.advanceTimersByTimeAsync(5000);
        expect(secondRan).toBe(false);

        // 底层任务真正结束后，队列才放行下一个写
        releaseFirst();
        await secondPromise;
        expect(secondRan).toBe(true);
    });

    it('withHangTimeout 本身仍保留 fail-fast 语义（调用方不无限等待）', async () => {
        jest.useFakeTimers();
        const never = new Promise<void>(() => undefined);
        const raced = withHangTimeout(never, 'label-test', 1000);
        const rejection = expect(raced).rejects.toThrow('label-test hung for 1000ms');
        await jest.advanceTimersByTimeAsync(1000);
        await rejection;
    });

    it('正常完成的任务：队列按序执行，后续写在前一个完成后才开始', async () => {
        const order: string[] = [];
        const first = withMetadataWriteSerialized('conv-ok', async () => {
            order.push('first-start');
            await new Promise(resolve => setTimeout(resolve, 20));
            order.push('first-end');
        });
        const second = withMetadataWriteSerialized('conv-ok', async () => {
            order.push('second-start');
        });
        await Promise.all([first, second]);
        expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    });
});
