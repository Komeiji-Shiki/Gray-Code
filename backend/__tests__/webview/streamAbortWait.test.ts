/**
 * H1：旧流退出等待（abortAndWaitForCompletion / waitForOldStreamCompletion）回归测试。
 *
 * 覆盖「停止后立即重发」写序竞态的关键语义：
 * 1. 无旧流时等待立即返回（不阻塞新流启动）；
 * 2. 活跃旧流：abort 后必须等其 finally（delete()）完成，等待才返回；
 * 3. cancel() 后旧流已移出 controllers：其 finally 的 delete() 走引用不匹配路径，
 *    也必须释放退出信号（否则「停止后立即重发」仍会竞态）；
 * 4. 旧流挂死（finally 永不执行）时超时兜底，新流不会被永久阻塞；
 * 5. waitForOldStreamCompletion（后端入口）只等已退休旧流，不中止新流控制器；
 * 6. 连续 stop/重发：退出信号链式叠加，等待所有旧代退出；
 * 7. delete() 引用不匹配不会误删新流控制器（保留新流可取消能力）。
 */

import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';

describe('StreamAbortManager - 旧流退出等待（H1 写序竞态）', () => {
    afterEach(() => {
        StreamAbortManager.setGlobalInstance(undefined);
    });

    it('无旧流时 abortAndWaitForCompletion 立即返回', async () => {
        const manager = new StreamAbortManager();
        const start = Date.now();
        await manager.abortAndWaitForCompletion('conv-free', 1000);
        expect(Date.now() - start).toBeLessThan(100);
    });

    it('活跃旧流：abort 后等待其 finally delete() 完成再返回', async () => {
        const manager = new StreamAbortManager();
        const controller = manager.create('conv-active');
        const waiting = manager.abortAndWaitForCompletion('conv-active', 2000);

        // 旧流正在做工具结算：尚未注销控制器，等待不应完成
        let settled = false;
        void waiting.then(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(settled).toBe(false);
        expect(controller.signal.aborted).toBe(true);

        // 旧流 finally 注销控制器 → 等待完成
        manager.delete('conv-active', controller);
        await expect(waiting).resolves.toBeUndefined();

        // 等待完成后新流再 create（写序安全）
        const next = manager.create('conv-active');
        expect(next.signal.aborted).toBe(false);
    });

    it('cancel 后旧流的 finally 走引用不匹配路径仍能唤醒等待（停止后立即重发）', async () => {
        const manager = new StreamAbortManager();
        const controller = manager.create('conv-cancel');
        manager.cancel('conv-cancel'); // 停止：abort + 移出 controllers + 登记退出信号

        const waiting = manager.abortAndWaitForCompletion('conv-cancel', 2000);
        // 旧流还在结算窗口内：等待不应提前完成
        let settled = false;
        void waiting.then(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        // 旧流 finally 注销（引用已不匹配）：必须释放退出信号
        manager.delete('conv-cancel', controller);
        await expect(waiting).resolves.toBeUndefined();
    });

    it('旧流挂死（finally 永不执行）时超时兜底，不阻塞新流启动', async () => {
        const manager = new StreamAbortManager();
        manager.create('conv-hang');
        const start = Date.now();
        await manager.abortAndWaitForCompletion('conv-hang', 60);
        // 超时兜底后返回（真实计时器，60ms 窗口 + 调度余量）
        expect(Date.now() - start).toBeLessThan(2000);
    });

    it('waitForOldStreamCompletion 只等已退休旧流，不中止新流控制器', async () => {
        const manager = new StreamAbortManager();
        const oldController = manager.create('conv-backend');
        manager.cancel('conv-backend'); // 旧流退休（停止后重发）
        const newController = manager.create('conv-backend'); // 新流已登记（webview create）

        const waiting = manager.waitForOldStreamCompletion('conv-backend', 2000);
        expect(newController.signal.aborted).toBe(false);

        // 旧流 finally（引用不匹配路径）→ 后端等待完成
        manager.delete('conv-backend', oldController);
        await expect(waiting).resolves.toBeUndefined();
        expect(newController.signal.aborted).toBe(false);
    });

    it('连续 stop/重发：退出信号链式叠加，等待所有旧代退出', async () => {
        const manager = new StreamAbortManager();
        const c1 = manager.create('conv-chain');
        manager.cancel('conv-chain'); // 第一代退休
        const c2 = manager.create('conv-chain');
        manager.cancel('conv-chain'); // 第二代退休

        const waiting = manager.abortAndWaitForCompletion('conv-chain', 2000);
        manager.delete('conv-chain', c1); // 第一代 finally 先到

        // 第二代仍未退出：等待不能完成
        let settled = false;
        void waiting.then(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        manager.delete('conv-chain', c2); // 第二代 finally
        await expect(waiting).resolves.toBeUndefined();
    });

    it('delete 引用不匹配不会误删新流控制器（保留新流可取消能力）', async () => {
        const manager = new StreamAbortManager();
        const old = manager.create('conv-mismatch');
        manager.cancel('conv-mismatch');
        const fresh = manager.create('conv-mismatch');

        manager.delete('conv-mismatch', old); // 旧流 finally 后到

        expect(manager.get('conv-mismatch')).toBe(fresh);
        expect(fresh.signal.aborted).toBe(false);
    });
});
