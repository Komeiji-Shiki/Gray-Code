/**
 * StreamAbortManager 转后台（detach）测试。
 *
 * 覆盖：新流启动（用户发新消息/重试/reroll 等）时，该会话活跃前台 SubAgent 转为后台
 * 继续运行（detach），而不是被旧流 abort 连带杀掉；后台 run 与其他会话的 run 不受影响。
 */

import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';
import { subAgentRunEventBus } from '../../tools/subagents/runEventBus';
import { subAgentRunController } from '../../tools/subagents/runController';
import { TaskManager, type TaskEvent } from '../../tools/taskManager';

describe('StreamAbortManager - 新流启动时前台 SubAgent 转后台', () => {
    afterEach(() => {
        for (const runId of ['detach_fg', 'detach_bg', 'detach_other', 'detach_replace', 'detach_stop', 'detach_report']) {
            if (TaskManager.getAllTasks().some(task => task.metadata?.runId === runId)) {
                subAgentRunEventBus.emit({ runId, type: 'run_cancelled', payload: { error: 'test cleanup' } });
            }
            subAgentRunController.unregister(runId);
        }
    });

    it('create 新流时把该会话活跃前台 SubAgent detach：旧流被 abort 但 run 继续活跃', () => {
        subAgentRunEventBus.createRun('detach_fg', 'Agent', undefined, { conversationId: 'conv_a' });
        subAgentRunController.register('detach_fg', 'Agent', 0, true);

        const manager = new StreamAbortManager();
        const oldStream = manager.create('conv_a');
        manager.create('conv_a'); // 用户发新消息：第二次 create 触发 detach + abort 旧流

        expect(oldStream.signal.aborted).toBe(true); // 旧流确实被 abort
        expect(subAgentRunController.isDetached('detach_fg')).toBe(true); // 但 SubAgent 已转后台
        expect(subAgentRunController.isActive('detach_fg')).toBe(true); // 仍活跃，没有被杀
        expect(subAgentRunController.getState('detach_fg')?.status).toBe('running');
    });

    it('后台 SubAgent 不受 detach 影响（保留 TaskManager 取消能力）', () => {
        subAgentRunEventBus.createRun('detach_bg', 'Agent', undefined, { conversationId: 'conv_a' });
        subAgentRunController.register('detach_bg', 'Agent', 0, false);

        const manager = new StreamAbortManager();
        manager.create('conv_a');

        expect(subAgentRunController.isDetached('detach_bg')).toBe(false);
    });

    it('其他会话的活跃 SubAgent 不受影响', () => {
        subAgentRunEventBus.createRun('detach_other', 'Agent', undefined, { conversationId: 'conv_b' });
        subAgentRunController.register('detach_other', 'Agent', 0, true);

        const manager = new StreamAbortManager();
        manager.create('conv_a');

        expect(subAgentRunController.isDetached('detach_other')).toBe(false);
    });

    it('无活跃 SubAgent 时 create 正常工作', () => {
        const manager = new StreamAbortManager();
        const controller = manager.create('conv_c');
        expect(controller.signal.aborted).toBe(false);
    });

    it('立即发送新回合的取消先 detach 前台 SubAgent，再 abort 旧流', () => {
        const manager = new StreamAbortManager();
        const oldStream = manager.create('conv_replace');
        subAgentRunEventBus.createRun('detach_replace', 'Agent', undefined, { conversationId: 'conv_replace' });
        subAgentRunController.register('detach_replace', 'Agent', 0, true);

        let oldStreamWasAbortedWhenDetached: boolean | undefined;
        subAgentRunController.registerDetachListener('detach_replace', () => {
            oldStreamWasAbortedWhenDetached = oldStream.signal.aborted;
        });

        manager.cancelForNewTurn('conv_replace');

        expect(oldStreamWasAbortedWhenDetached).toBe(false);
        expect(oldStream.signal.aborted).toBe(true);
        expect(subAgentRunController.isDetached('detach_replace')).toBe(true);
        expect(subAgentRunController.isActive('detach_replace')).toBe(true);
    });

    it('detach 后 run 保持活跃（本地机制：后台回执经既有展示层处理，不注册 TaskManager 后台任务）', () => {
        const manager = new StreamAbortManager();
        manager.create('conv_report');
        subAgentRunEventBus.createRun('detach_report', 'Review Agent', undefined, { conversationId: 'conv_report' });
        subAgentRunController.register('detach_report', 'Review Agent', 0, true);

        manager.cancelForNewTurn('conv_report');

        // detach 成功且 run 继续活跃（本地 detach 机制：executor 父信号解绑 + 后台回执展示层）
        expect(subAgentRunController.isDetached('detach_report')).toBe(true);
        expect(subAgentRunController.isActive('detach_report')).toBe(true);
        // 上游 detachedTaskBridge 后台任务体系未引入（见 63676f2/b0fb1f5 适配说明），
        // 本地不在 TaskManager 注册 background_subagent 任务
        expect(TaskManager.getAllTasks().find(item => item.metadata?.runId === 'detach_report')).toBeUndefined();
    });

    it('普通 cancel 保持显式停止语义，不会把前台 SubAgent 转后台', () => {
        const manager = new StreamAbortManager();
        const oldStream = manager.create('conv_stop');
        subAgentRunEventBus.createRun('detach_stop', 'Agent', undefined, { conversationId: 'conv_stop' });
        subAgentRunController.register('detach_stop', 'Agent', 0, true);

        manager.cancel('conv_stop');

        expect(oldStream.signal.aborted).toBe(true);
        expect(subAgentRunController.isDetached('detach_stop')).toBe(false);
    });

    it('waitForIdle 只在匹配控制器被 delete 后释放', async () => {
        const manager = new StreamAbortManager();
        const controller = manager.create('conv_idle');
        let settled = false;
        const waiting = manager.waitForIdle('conv_idle').then(() => { settled = true; });

        manager.delete('conv_idle', new AbortController());
        await Promise.resolve();
        expect(settled).toBe(false);

        manager.delete('conv_idle', controller);
        await waiting;
        expect(settled).toBe(true);
    });

    it('waitForIdle 在会话原本空闲时立即完成，cancelAll 也会释放等待者', async () => {
        const manager = new StreamAbortManager();
        await expect(manager.waitForIdle('conv_free')).resolves.toBeUndefined();

        manager.create('conv_cancel_all');
        const waiting = manager.waitForIdle('conv_cancel_all');
        manager.cancelAll();
        await expect(waiting).resolves.toBeUndefined();
    });
});
