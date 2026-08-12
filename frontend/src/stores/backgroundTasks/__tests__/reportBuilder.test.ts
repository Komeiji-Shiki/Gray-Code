/**
 * 后台任务回执构建（reportBuilder）单元测试
 *
 * 覆盖：后台任务事件识别、start 事件归约、完成事件应用、回执文本构建与多任务合并。
 */

import {
    isBackgroundStartEvent,
    taskRecordFromStartEvent,
    applyCompletionEvent,
    buildCompletionReport,
    type TaskEventLike,
    type BackgroundTaskRecord
} from '../reportBuilder';

function startEvent(overrides: Partial<TaskEventLike> = {}): TaskEventLike {
    return {
        taskId: 'bgagent_1',
        taskType: 'background_subagent',
        type: 'start',
        createdAt: 1000,
        data: { agentName: 'Code Reviewer', runId: 'run_1', conversationId: 'conv_1' },
        ...overrides
    };
}

describe('isBackgroundStartEvent', () => {
    test('background_subagent 的 start 事件是后台任务', () => {
        expect(isBackgroundStartEvent(startEvent())).toBe(true);
    });

    test('terminal 仅在 metadata.background 为 true 时是后台任务', () => {
        expect(isBackgroundStartEvent({
            taskId: 't1', taskType: 'terminal', type: 'start',
            data: { command: 'npm test', background: true }
        })).toBe(true);
        expect(isBackgroundStartEvent({
            taskId: 't2', taskType: 'terminal', type: 'start',
            data: { command: 'npm test' }
        })).toBe(false);
    });

    test('非 start 事件不识别为后台任务登记', () => {
        expect(isBackgroundStartEvent(startEvent({ type: 'complete' }))).toBe(false);
    });
});

describe('taskRecordFromStartEvent', () => {
    test('构建 subagent 任务记录', () => {
        const record = taskRecordFromStartEvent(startEvent());
        expect(record.kind).toBe('subagent');
        expect(record.label).toBe('Code Reviewer');
        expect(record.runId).toBe('run_1');
        expect(record.conversationId).toBe('conv_1');
        expect(record.status).toBe('running');
        expect(record.startedAt).toBe(1000);
        expect(record.reported).toBe(false);
    });

    test('构建 terminal 任务记录并截断超长命令', () => {
        const longCommand = 'x'.repeat(100);
        const record = taskRecordFromStartEvent({
            taskId: 'term_1', taskType: 'terminal', type: 'start',
            data: { command: longCommand, background: true, conversationId: 'conv_1' }
        });
        expect(record.kind).toBe('terminal');
        expect(record.terminalId).toBe('term_1');
        expect(record.label.length).toBeLessThan(longCommand.length);
        expect(record.label.endsWith('…')).toBe(true);
    });
});

describe('applyCompletionEvent', () => {
    const base = taskRecordFromStartEvent(startEvent());

    test('complete 事件写入结果载荷', () => {
        const done = applyCompletionEvent(base, {
            taskId: 'bgagent_1', taskType: 'background_subagent', type: 'complete',
            createdAt: 5000,
            data: { response: 'All good.', steps: 12 }
        });
        expect(done.status).toBe('completed');
        expect(done.response).toBe('All good.');
        expect(done.steps).toBe(12);
        expect(done.finishedAt).toBe(5000);
        // 原记录不可变
        expect(base.status).toBe('running');
    });

    test('后端 mailbox 已接管交付时直接标记 reported，避免旧回执重复发送', () => {
        const done = applyCompletionEvent(base, {
            taskId: 'bgagent_1', taskType: 'background_subagent', type: 'complete',
            data: { response: 'Delivered through claim/ack.', delivery: 'agent_mailbox' }
        });
        expect(done.status).toBe('completed');
        expect(done.reported).toBe(true);
        expect(base.reported).toBe(false);
    });

    test('error 事件保留错误信息', () => {
        const failed = applyCompletionEvent(base, {
            taskId: 'bgagent_1', taskType: 'background_subagent', type: 'error',
            data: { error: 'boom' }
        });
        expect(failed.status).toBe('error');
        expect(failed.error).toBe('boom');
    });

    test('cancelled 事件（无 data）标记取消状态', () => {
        const cancelled = applyCompletionEvent(base, {
            taskId: 'bgagent_1', taskType: 'background_subagent', type: 'cancelled'
        });
        expect(cancelled.status).toBe('cancelled');
    });
});

describe('buildCompletionReport', () => {
    test('subagent 单任务回执包含标识、状态与结果全文', () => {
        const task: BackgroundTaskRecord = {
            ...taskRecordFromStartEvent(startEvent()),
            status: 'completed',
            finishedAt: 253000,
            startedAt: 1000,
            response: 'Full review report here.',
            steps: 23
        };
        const report = buildCompletionReport([task]);
        expect(report).toContain('[Background task completed]');
        expect(report).toContain('sub-agent "Code Reviewer"');
        expect(report).toContain('runId: run_1');
        expect(report).toContain('23 steps');
        expect(report).toContain('252s');
        expect(report).toContain('Full review report here.');
    });

    test('超长结果不再截断：回执包含完整正文，不出现 [Truncated ...] 提示（回归：后台完成消息被腰斩）', () => {
        const longResponse = 'R'.repeat(12000)
        const task: BackgroundTaskRecord = {
            ...taskRecordFromStartEvent(startEvent()),
            status: 'completed',
            finishedAt: 2000,
            response: longResponse,
            steps: 5
        };
        const report = buildCompletionReport([task]);
        // 主模型必须能读到全文（与前台 functionResponse 同规格），而不是 4000 字符截断 + Monitor 提示
        expect(report).toContain(longResponse);
        expect(report).not.toContain('[Truncated');
        expect(report).not.toContain('Open Monitor');
        expect(report.length).toBeGreaterThan(longResponse.length);
    });

    test('terminal 任务回执包含退出码与输出', () => {
        const task: BackgroundTaskRecord = {
            ...taskRecordFromStartEvent({
                taskId: 'term_1', taskType: 'terminal', type: 'start',
                createdAt: 0,
                data: { command: 'npm test', background: true }
            }),
            status: 'completed',
            finishedAt: 35000,
            exitCode: 0,
            output: 'Tests: 10 passed'
        };
        const report = buildCompletionReport([task]);
        expect(report).toContain('command `npm test`');
        expect(report).toContain('exit code 0');
        expect(report).toContain('Tests: 10 passed');
    });

    test('多个任务合并为一条回执，用分隔线分段', () => {
        const agentTask: BackgroundTaskRecord = {
            ...taskRecordFromStartEvent(startEvent()),
            status: 'completed',
            finishedAt: 2000,
            response: 'A done.'
        };
        const cmdTask: BackgroundTaskRecord = {
            ...taskRecordFromStartEvent({
                taskId: 'term_1', taskType: 'terminal', type: 'start',
                createdAt: 0,
                data: { command: 'npm run build', background: true }
            }),
            status: 'error',
            finishedAt: 3000,
            exitCode: 1,
            output: 'build failed',
            error: 'Command exited with code 1'
        };
        const report = buildCompletionReport([agentTask, cmdTask]);
        expect(report).toContain('A done.');
        expect(report).toContain('build failed');
        expect(report).toContain('\n\n---\n\n');
        expect(report.startsWith('[Background task completed]')).toBe(true);
    });
});
