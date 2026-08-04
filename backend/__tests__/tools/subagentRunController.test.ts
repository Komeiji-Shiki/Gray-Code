/**
 * SubAgentRunController 单元测试。
 *
 * 覆盖 Monitor 暂停 / 继续 / 退出的控制语义，重点是等待唤醒器的生命周期：
 * 曾经 waitUntilRunnable 会同时向 resumeWaiters 和 exitWaiters 各注册一次 resolve，
 * 而 resume 只清空前者，于是每一轮「暂停→继续」都在退出唤醒列表里留下一个僵尸回调。
 */

import { SubAgentRunController } from '../../tools/subagents/runController';
import { subAgentRunEventBus } from '../../tools/subagents/runEventBus';

describe('SubAgentRunController - 暂停/继续/退出', () => {
    it('暂停后 waitUntilRunnable 挂起，继续后返回 running', async () => {
        const controller = new SubAgentRunController();
        controller.register('run_pause', 'Agent');

        expect(controller.pause('run_pause')).toBe(true);
        const waiting = controller.waitUntilRunnable('run_pause');

        let settled = false;
        void waiting.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        expect(controller.resume('run_pause')).toBe(true);
        await expect(waiting).resolves.toBe('running');
    });

    it('退出会唤醒等待者并返回 cancelled', async () => {
        const controller = new SubAgentRunController();
        controller.register('run_exit', 'Agent');
        controller.pause('run_exit');

        const waiting = controller.waitUntilRunnable('run_exit');
        expect(controller.exit('run_exit', '用户退出')).toBe(true);

        await expect(waiting).resolves.toBe('cancelled');
        expect(controller.getExitReason('run_exit')).toBe('用户退出');
    });

    it('反复暂停/继续不会累积唤醒器，最后一次退出仍只唤醒当前等待者', async () => {
        const controller = new SubAgentRunController();
        controller.register('run_cycle', 'Agent');

        for (let i = 0; i < 5; i++) {
            expect(controller.pause('run_cycle')).toBe(true);
            const waiting = controller.waitUntilRunnable('run_cycle');
            expect(controller.resume('run_cycle')).toBe(true);
            await expect(waiting).resolves.toBe('running');
        }

        // 五轮循环后内部唤醒列表必须是空的，否则每轮都会残留一个永不清理的回调
        const record = (controller as unknown as {
            activeRuns: Map<string, { waiters: Array<() => void> }>;
        }).activeRuns.get('run_cycle');
        expect(record!.waiters.length).toBe(0);

        controller.pause('run_cycle');
        const finalWait = controller.waitUntilRunnable('run_cycle');
        controller.exit('run_cycle');
        await expect(finalWait).resolves.toBe('cancelled');
    });

    it('resume 会重建 AbortController，让继续后的操作使用未中止的信号', () => {
        const controller = new SubAgentRunController();
        controller.register('run_signal', 'Agent');

        controller.pause('run_signal');
        expect(controller.getAbortSignal('run_signal')!.aborted).toBe(true);

        controller.resume('run_signal');
        expect(controller.getAbortSignal('run_signal')!.aborted).toBe(false);
    });

    it('暂停期间的时长不计入活跃运行时间', async () => {
        const controller = new SubAgentRunController();
        controller.register('run_inactive', 'Agent');
        expect(controller.getInactiveDurationMs('run_inactive')).toBe(0);

        controller.pause('run_inactive');
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(controller.getInactiveDurationMs('run_inactive')).toBeGreaterThan(0);

        controller.resume('run_inactive');
        const accumulated = controller.getInactiveDurationMs('run_inactive');
        expect(accumulated).toBeGreaterThan(0);
        // 恢复后不再继续累加
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(controller.getInactiveDurationMs('run_inactive')).toBe(accumulated);
    });

    it('非活跃 run 的控制操作一律失败，不会伪造可控状态', () => {
        const controller = new SubAgentRunController();
        expect(controller.pause('missing')).toBe(false);
        expect(controller.resume('missing')).toBe(false);
        expect(controller.exit('missing')).toBe(false);
        expect(controller.getState('missing')).toBeUndefined();
    });

    it('运行中的 run 不能被 resume（状态机不允许的转换返回 false）', () => {
        const controller = new SubAgentRunController();
        controller.register('run_running', 'Agent');
        expect(controller.resume('run_running')).toBe(false);
    });
});


describe('SubAgentRunController - 转后台（detach）', () => {
    it('detachFromParent 解除父信号绑定：标记 detached、同步调用 listener、广播 run_detached', () => {
        const controller = new SubAgentRunController();
        controller.register('run_detach', 'Agent', 0, true);
        let listenerCalled = false;
        controller.registerDetachListener('run_detach', () => { listenerCalled = true; });
        const types: string[] = [];
        const dispose = subAgentRunEventBus.subscribe(event => {
            if (event.runId === 'run_detach') types.push(event.type);
        });
        try {
            expect(controller.detachFromParent('run_detach')).toBe(true);
            expect(controller.isDetached('run_detach')).toBe(true);
            expect(listenerCalled).toBe(true);
            expect(types).toContain('run_detached');
        } finally {
            dispose();
            controller.unregister('run_detach');
        }
    });

    it('重复 detach 返回 false（幂等）', () => {
        const controller = new SubAgentRunController();
        controller.register('run_detach2', 'Agent', 0, true);
        expect(controller.detachFromParent('run_detach2')).toBe(true);
        expect(controller.detachFromParent('run_detach2')).toBe(false);
        controller.unregister('run_detach2');
    });

    it('后台 run（attachedToParent=false）不被 detach，保留 TaskManager 取消能力', () => {
        const controller = new SubAgentRunController();
        controller.register('run_detach_bg', 'Agent', 0, false);
        expect(controller.detachFromParent('run_detach_bg')).toBe(false);
        expect(controller.isDetached('run_detach_bg')).toBe(false);
        controller.unregister('run_detach_bg');
    });

    it('未注册的 run detach 返回 false', () => {
        const controller = new SubAgentRunController();
        expect(controller.detachFromParent('run_missing')).toBe(false);
    });

    it('unregister 清理 detach listener，detach 不再触发回调', () => {
        const controller = new SubAgentRunController();
        controller.register('run_detach3', 'Agent', 0, true);
        let calls = 0;
        controller.registerDetachListener('run_detach3', () => { calls++; });
        controller.unregister('run_detach3');
        expect(controller.detachFromParent('run_detach3')).toBe(false);
        expect(calls).toBe(0);
    });
});