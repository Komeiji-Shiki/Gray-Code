/**
 * TaskManager.cleanup() 泄漏清扫单测（发现 20 的测试缺口 2）。
 *
 * 覆盖发现 01 的兜底语义：
 * - abortController 已触发但从未走 unregisterTask → 补发 cancelled 后移除；
 * - 驻留超过 CLEANUP_STALE_TASK_TIMEOUT_MS（30 分钟）→ abort + 补发 cancelled 后移除；
 * - metadata.timeout = 0（显式不超时）/ timeout > 兜底阈值 / background=true → 跳过兜底；
 * - registerTask 同 ID 重复注册告警。
 */

import { TaskManager, type TaskEvent } from '../../tools/taskManager';

const STALE_TIMEOUT_MS = 30 * 60 * 1000;

describe('TaskManager.cleanup() - 泄漏清扫兜底', () => {
    const registeredTaskIds: string[] = [];
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });

    afterEach(() => {
        // 清理本用例注册的任务（含被兜底跳过、仍驻留的条目），避免跨用例污染
        for (const taskId of registeredTaskIds.splice(0)) {
            if (TaskManager.hasTask(taskId)) {
                TaskManager.unregisterTask(taskId, 'error', { error: 'test cleanup' });
            }
        }
        nowSpy.mockRestore();
    });

    function advancePastStaleTimeout(): void {
        nowSpy.mockReturnValue(1_000_000 + STALE_TIMEOUT_MS + 1);
    }

    test('abortController 已触发但未注销的任务：补发 cancelled 后移除', () => {
        const taskId = `cleanup_aborted_${Date.now()}`;
        registeredTaskIds.push(taskId);
        const controller = new AbortController();
        const events: TaskEvent[] = [];
        const off = TaskManager.onTaskEvent(event => events.push(event));

        TaskManager.registerTask(taskId, 'terminal', controller);
        controller.abort();

        TaskManager.cleanup();

        expect(TaskManager.hasTask(taskId)).toBe(false);
        const cancelled = events.find(event => event.taskId === taskId && event.type === 'cancelled');
        expect(cancelled).toBeDefined();
        expect(cancelled?.data?.reason).toBe('cleanup_aborted');
        off();
    });

    test('驻留超过 30 分钟仍未终态的任务：abort + 补发 cancelled 后移除', () => {
        const taskId = `cleanup_stale_${Date.now()}`;
        registeredTaskIds.push(taskId);
        const controller = new AbortController();
        const events: TaskEvent[] = [];
        const off = TaskManager.onTaskEvent(event => events.push(event));

        TaskManager.registerTask(taskId, 'terminal', controller);
        advancePastStaleTimeout();

        TaskManager.cleanup();

        expect(controller.signal.aborted).toBe(true);
        expect(TaskManager.hasTask(taskId)).toBe(false);
        const cancelled = events.find(event => event.taskId === taskId && event.type === 'cancelled');
        expect(cancelled).toBeDefined();
        expect(cancelled?.data?.reason).toBe('cleanup_stale');
        off();
    });

    test('metadata.timeout = 0（显式不超时）：超期也跳过兜底', () => {
        const taskId = `cleanup_timeout_zero_${Date.now()}`;
        registeredTaskIds.push(taskId);
        const controller = new AbortController();

        TaskManager.registerTask(taskId, 'terminal', controller, { timeout: 0 });
        advancePastStaleTimeout();

        TaskManager.cleanup();

        expect(controller.signal.aborted).toBe(false);
        expect(TaskManager.hasTask(taskId)).toBe(true);
    });

    test('metadata.timeout 大于兜底阈值（如 >30min 长命令）：跳过兜底', () => {
        const taskId = `cleanup_long_timeout_${Date.now()}`;
        registeredTaskIds.push(taskId);
        const controller = new AbortController();

        TaskManager.registerTask(taskId, 'terminal', controller, { timeout: STALE_TIMEOUT_MS + 60_000 });
        advancePastStaleTimeout();

        TaskManager.cleanup();

        expect(controller.signal.aborted).toBe(false);
        expect(TaskManager.hasTask(taskId)).toBe(true);
    });

    test('background=true 的后台任务：超期也跳过兜底', () => {
        const taskId = `cleanup_background_${Date.now()}`;
        registeredTaskIds.push(taskId);
        const controller = new AbortController();

        TaskManager.registerTask(taskId, 'background_subagent', controller, { background: true });
        advancePastStaleTimeout();

        TaskManager.cleanup();

        expect(controller.signal.aborted).toBe(false);
        expect(TaskManager.hasTask(taskId)).toBe(true);
    });

    test('同 ID 重复注册给出告警（发现 01）', () => {
        const taskId = `duplicate_register_${Date.now()}`;
        registeredTaskIds.push(taskId);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        TaskManager.registerTask(taskId, 'terminal', new AbortController());
        TaskManager.registerTask(taskId, 'terminal', new AbortController());

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`Duplicate task registration for id "${taskId}"`)
        );
        warnSpy.mockRestore();
    });
});
