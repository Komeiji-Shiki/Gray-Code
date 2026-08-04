import {
    fileWriteLockManager,
    type LockHolder
} from '../../core/fileWriteLockManager';
import { CheckpointOperationLockManager } from '../../modules/checkpoint/CheckpointOperationLock';

/**
 * CheckpointOperationLock 测试
 *
 * 覆盖：
 * - 同一工作区的存档操作互斥排队
 * - 互不相交工作区的操作并行
 * - 与全局文件写锁的配合（等待写工具结束）
 * - abort 取消排队
 * - 异常路径释放锁
 */

describe('CheckpointOperationLockManager', () => {
    afterEach(() => {
        fileWriteLockManager.releaseAllByHolder('test-holder');
    });

    test('serializes operations on the same workspace', async () => {
        const manager = new CheckpointOperationLockManager();
        const events: string[] = [];

        const first = manager.runExclusive(['ws_a'], 'create', 'op-1', async () => {
            events.push('first:start');
            await new Promise(resolve => setTimeout(resolve, 30));
            events.push('first:end');
        });

        const second = manager.runExclusive(['ws_a'], 'restore', 'op-2', async () => {
            events.push('second:start');
        });

        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    test('serializes disjoint workspace operations through the global write lock', async () => {
        // 当前实现中，所有存档操作都会获取全局根锁（与全部写工具互斥），
        // 因此不同工作区的操作同样按 FIFO 串行；内部工作区锁为将来
        // 引入工作区作用域写锁时保留并行能力。
        const manager = new CheckpointOperationLockManager();
        const events: string[] = [];

        const first = manager.runExclusive(['ws_a'], 'create', 'op-1', async () => {
            events.push('a:start');
            await new Promise(resolve => setTimeout(resolve, 30));
            events.push('a:end');
        });

        const second = manager.runExclusive(['ws_b'], 'create', 'op-2', async () => {
            events.push('b:start');
            await new Promise(resolve => setTimeout(resolve, 30));
            events.push('b:end');
        });

        await Promise.all([first, second]);
        expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    test('waits for a shared workspace between multi-root operations', async () => {
        const manager = new CheckpointOperationLockManager();
        const events: string[] = [];

        const first = manager.runExclusive(['ws_a', 'ws_b'], 'create', 'op-1', async () => {
            events.push('first:start');
            await new Promise(resolve => setTimeout(resolve, 30));
            events.push('first:end');
        });

        const second = manager.runExclusive(['ws_b', 'ws_c'], 'create', 'op-2', async () => {
            events.push('second:start');
        });

        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    test('waits for the global file write lock held by a tool', async () => {
        const manager = new CheckpointOperationLockManager();
        const holder: LockHolder = { kind: 'main', id: 'tool-owner', label: 'main session' };
        expect(fileWriteLockManager.tryAcquire(['src/main.ts'], holder).acquired).toBe(true);

        let checkpointRan = false;
        const operation = manager.runExclusive(['ws_a'], 'restore', 'cp-op', async () => {
            checkpointRan = true;
        });

        // 给等待循环一点时间，确认没有立即执行
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(checkpointRan).toBe(false);

        fileWriteLockManager.release(['src/main.ts'], holder);
        await operation;
        expect(checkpointRan).toBe(true);
    });

    test('blocks new tool writes while a checkpoint operation is running', async () => {
        const manager = new CheckpointOperationLockManager();
        let released = false;

        const operation = manager.runExclusive(['ws_a'], 'create', 'cp-op', async () => {
            // 存档操作进行中，新的写工具尝试获取根锁应失败
            const result = fileWriteLockManager.tryAcquire(
                ['some/file.ts'],
                { kind: 'main', id: 'late-tool', label: 'late tool' }
            );
            expect(result.acquired).toBe(false);
            if (!result.acquired) {
                expect(result.conflicts[0].holder.kind).toBe('checkpoint');
            }
            await new Promise(resolve => setTimeout(resolve, 20));
            released = true;
        });

        await operation;
        expect(released).toBe(true);

        // 操作结束后写工具可以正常获取
        const result = fileWriteLockManager.tryAcquire(
            ['some/file.ts'],
            { kind: 'main', id: 'late-tool-2', label: 'late tool' }
        );
        expect(result.acquired).toBe(true);
        fileWriteLockManager.release(['some/file.ts'], { kind: 'main', id: 'late-tool-2', label: 'late tool' });
    });

    test('releases workspace locks when the task throws', async () => {
        const manager = new CheckpointOperationLockManager();

        await expect(
            manager.runExclusive(['ws_a'], 'delete', 'op-fail', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');

        // 失败后同一工作区的新操作可以立即执行
        let ran = false;
        await manager.runExclusive(['ws_a'], 'create', 'op-next', async () => {
            ran = true;
        });
        expect(ran).toBe(true);
        expect(manager.getActiveWorkspaceCount()).toBe(0);
    });

    test('rejects operations without workspace roots', async () => {
        const manager = new CheckpointOperationLockManager();
        await expect(
            manager.runExclusive([], 'create', 'op-empty', async () => undefined)
        ).rejects.toThrow(/at least one workspace root/);
    });

    test('cancels a pending operation via abort signal', async () => {
        const manager = new CheckpointOperationLockManager();
        const controller = new AbortController();

        const first = manager.runExclusive(['ws_a'], 'create', 'op-1', async () => {
            await new Promise(resolve => setTimeout(resolve, 40));
        });

        const second = manager.runExclusive(['ws_a'], 'restore', 'op-2', async () => undefined, controller.signal);

        // 排队中的操作被取消
        controller.abort();
        await expect(second).rejects.toThrow(/cancelled/i);

        await first;
        expect(manager.getPendingOperationCount()).toBe(0);
        expect(manager.getActiveWorkspaceCount()).toBe(0);
    });

    test('re-enters for the same owner with the same workspace set (nested create -> cleanup -> delete)', async () => {
        const manager = new CheckpointOperationLockManager();
        const events: string[] = [];

        await manager.runExclusive(['ws_a'], 'create', 'owner-x', async () => {
            events.push('outer:start');
            // 嵌套调用（同 owner 同 workspace 集合）：不应排队等待自己而死锁
            await manager.runExclusive(['ws_a'], 'delete', 'owner-x', async () => {
                events.push('inner:run');
            });
            events.push('outer:end');
        });

        expect(events).toEqual(['outer:start', 'inner:run', 'outer:end']);
        expect(manager.getActiveWorkspaceCount()).toBe(0);
        expect(manager.getPendingOperationCount()).toBe(0);
    });

    test('re-enters when the nested workspace set is a subset of the held set', async () => {
        const manager = new CheckpointOperationLockManager();
        const events: string[] = [];

        await manager.runExclusive(['ws_a', 'ws_b'], 'create', 'owner-x', async () => {
            events.push('outer:start');
            // 内层只请求子集 ['ws_a']：应直接放行，不排队等待自己
            await manager.runExclusive(['ws_a'], 'delete', 'owner-x', async () => {
                events.push('inner:run');
            });
            events.push('outer:end');
        });

        expect(events).toEqual(['outer:start', 'inner:run', 'outer:end']);
        expect(manager.getActiveWorkspaceCount()).toBe(0);
        expect(manager.getPendingOperationCount()).toBe(0);
    });

    test('different owner with same workspace still serializes (not re-entrant)', async () => {
        const manager = new CheckpointOperationLockManager();
        const events: string[] = [];

        const outer = manager.runExclusive(['ws_a'], 'create', 'owner-1', async () => {
            events.push('outer:start');
            await new Promise(resolve => setTimeout(resolve, 30));
            events.push('outer:end');
        });

        const inner = manager.runExclusive(['ws_a'], 'delete', 'owner-2', async () => {
            events.push('inner:run');
        });

        await Promise.all([outer, inner]);
        expect(events).toEqual(['outer:start', 'outer:end', 'inner:run']);
    });

    test('re-entrant release does not drop the outer workspace lock early', async () => {
        const manager = new CheckpointOperationLockManager();
        let ran = false;
        let queued: Promise<void> = Promise.resolve();
        await manager.runExclusive(['ws_a'], 'create', 'owner-x', async () => {
            await manager.runExclusive(['ws_a'], 'delete', 'owner-x', async () => {});
            // 内层释放后外层仍持有锁：另一个 owner 的操作必须排队等待（不能提前执行）
            queued = manager.runExclusive(['ws_a'], 'restore', 'owner-y', async () => {
                ran = true;
            });
            await new Promise(resolve => setTimeout(resolve, 30));
            expect(ran).toBe(false);
        });
        // 外层释放后，排队的操作才能执行
        await queued;
        expect(ran).toBe(true);
    });
});
