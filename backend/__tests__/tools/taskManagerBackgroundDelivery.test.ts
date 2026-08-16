import { agentMailbox, MAIN_SESSION_RUN_ID } from '../../core/services/agentMailbox';
import { TaskManager, type TaskEvent } from '../../tools/taskManager';

describe('TaskManager - background SubAgent reliable delivery', () => {
    const registeredTaskIds: string[] = [];

    beforeEach(() => {
        agentMailbox.clearAll();
    });

    afterEach(() => {
        for (const taskId of registeredTaskIds.splice(0)) {
            if (TaskManager.hasTask(taskId)) {
                TaskManager.unregisterTask(taskId, 'error', { error: 'test cleanup' });
            }
        }
        agentMailbox.clearAll();
    });

    test('Webview/事件订阅者缺席时终态仍留在 mailbox，重复结算不会复制', () => {
        const taskId = `bgagent_no_view_${Date.now()}`;
        registeredTaskIds.push(taskId);
        const fullResponse = `result:${'z'.repeat(20_000)}`;

        TaskManager.registerTask(taskId, 'background_subagent', new AbortController(), {
            conversationId: 'conv_no_view',
            runId: 'run_no_view',
            agentName: 'researcher'
        });
        TaskManager.unregisterTask(taskId, 'completed', {
            conversationId: 'conv_no_view',
            runId: 'run_no_view',
            agentName: 'researcher',
            response: fullResponse,
            steps: 3,
            toolsUsed: ['search', 'read']
        });

        expect(TaskManager.hasTask(taskId)).toBe(false);
        const claim = agentMailbox.claimMainSessionAgentMessages('conv_no_view');
        expect(claim?.messages).toHaveLength(1);
        expect(claim?.messages[0].id).toBe(`background-task:${taskId}`);
        expect(claim?.messages[0].text).toContain('[Background task completed]');
        expect(claim?.messages[0].text).toContain(fullResponse);

        TaskManager.unregisterTask(taskId, 'completed', { response: 'duplicate' });
        expect(agentMailbox.claimMainSessionAgentMessages('conv_no_view')?.messages).toHaveLength(1);
        expect(agentMailbox.acknowledgeMessageClaim(
            'conv_no_view',
            MAIN_SESSION_RUN_ID,
            claim!.claimId
        )).toBe(true);
    });

    test('终态事件标记为 mailbox 交付，让前端不再发送旧 background_task 回执', () => {
        const taskId = `bgagent_delivery_flag_${Date.now()}`;
        registeredTaskIds.push(taskId);
        const events: TaskEvent[] = [];
        const dispose = TaskManager.onTaskEvent(event => events.push(event));
        try {
            TaskManager.registerTask(taskId, 'background_subagent', new AbortController(), {
                conversationId: 'conv_flag',
                runId: 'run_flag',
                agentName: 'reviewer'
            });
            TaskManager.unregisterTask(taskId, 'error', {
                conversationId: 'conv_flag',
                runId: 'run_flag',
                agentName: 'reviewer',
                error: 'boom'
            });
        } finally {
            dispose();
        }

        const terminal = events.find(event => event.taskId === taskId && event.type === 'error');
        expect(terminal?.data?.delivery).toBe('agent_mailbox');
        expect(agentMailbox.claimMainSessionAgentMessages('conv_flag')?.messages[0].text).toContain('Error: boom');
    });

    test('嵌套后台子代理：parentRunId 活跃时结果投递给发起者 run，而非主会话', () => {
        const taskId = `bgagent_nested_${Date.now()}`;
        registeredTaskIds.push(taskId);
        agentMailbox.registerRun('conv_nested', 'run_parent', 'reviewer');

        TaskManager.registerTask(taskId, 'background_subagent', new AbortController(), {
            conversationId: 'conv_nested',
            runId: 'run_child',
            agentName: 'researcher',
            parentRunId: 'run_parent'
        });
        TaskManager.unregisterTask(taskId, 'completed', {
            conversationId: 'conv_nested',
            runId: 'run_child',
            agentName: 'researcher',
            response: 'nested result',
            steps: 2
        });

        const parentInbox = agentMailbox.peekMessages('conv_nested', 'run_parent');
        expect(parentInbox).toHaveLength(1);
        expect(parentInbox[0].id).toBe(`background-task:${taskId}`);
        expect(parentInbox[0].toRunId).toBe('run_parent');
        expect(parentInbox[0].text).toContain('[Background task completed]');
        expect(parentInbox[0].text).toContain('nested result');
        // 主会话不应收到嵌套结果
        expect(agentMailbox.claimMainSessionAgentMessages('conv_nested')).toBeUndefined();
    });

    test('嵌套后台子代理：parentRunId 已注销时回退投递主会话', () => {
        const taskId = `bgagent_nested_gone_${Date.now()}`;
        registeredTaskIds.push(taskId);

        TaskManager.registerTask(taskId, 'background_subagent', new AbortController(), {
            conversationId: 'conv_nested_gone',
            runId: 'run_child',
            agentName: 'researcher',
            parentRunId: 'run_parent_gone'
        });
        TaskManager.unregisterTask(taskId, 'completed', {
            conversationId: 'conv_nested_gone',
            runId: 'run_child',
            agentName: 'researcher',
            response: 'result after parent ended'
        });

        const claim = agentMailbox.claimMainSessionAgentMessages('conv_nested_gone');
        expect(claim?.messages).toHaveLength(1);
        expect(claim?.messages[0].toRunId).toBe(MAIN_SESSION_RUN_ID);
        expect(claim?.messages[0].text).toContain('result after parent ended');
    });

    test('子代理内部后台命令：结果投递给发起子代理 run，任务条不再生成回执', () => {
        const taskId = `bgterminal_${Date.now()}`;
        registeredTaskIds.push(taskId);
        agentMailbox.registerRun('conv_term', 'run_agent', 'coder');
        const events: TaskEvent[] = [];
        const dispose = TaskManager.onTaskEvent(event => events.push(event));
        try {
            TaskManager.registerTask(taskId, 'terminal', new AbortController(), {
                conversationId: 'conv_term',
                command: 'npm test',
                background: true
            });
            TaskManager.unregisterTask(taskId, 'completed', {
                conversationId: 'conv_term',
                subagentRunId: 'run_agent',
                command: 'npm test',
                background: true,
                exitCode: 0,
                output: 'PASS'
            });
        } finally {
            dispose();
        }

        const agentInbox = agentMailbox.peekMessages('conv_term', 'run_agent');
        expect(agentInbox).toHaveLength(1);
        expect(agentInbox[0].id).toBe(`background-task:${taskId}`);
        expect(agentInbox[0].text).toContain('[Background task completed]');
        expect(agentInbox[0].text).toContain('exit code 0');
        expect(agentInbox[0].text).toContain('PASS');

        const terminal = events.find(event => event.taskId === taskId && event.type === 'complete');
        expect(terminal?.data?.delivery).toBe('agent_mailbox');
        // 子代理发起的后台命令不回主会话
        expect(agentMailbox.claimMainSessionAgentMessages('conv_term')).toBeUndefined();
    });

    test('子代理内部后台命令：子代理已结束时回退投递主会话', () => {
        const taskId = `bgterminal_gone_${Date.now()}`;
        registeredTaskIds.push(taskId);

        TaskManager.registerTask(taskId, 'terminal', new AbortController(), {
            conversationId: 'conv_term_gone',
            command: 'sleep 10',
            background: true
        });
        TaskManager.unregisterTask(taskId, 'completed', {
            conversationId: 'conv_term_gone',
            subagentRunId: 'run_gone',
            command: 'sleep 10',
            background: true,
            exitCode: 0
        });

        const claim = agentMailbox.claimMainSessionAgentMessages('conv_term_gone');
        expect(claim?.messages).toHaveLength(1);
        expect(claim?.messages[0].toRunId).toBe(MAIN_SESSION_RUN_ID);
        expect(claim?.messages[0].text).toContain('exit code 0');
    });

    test('前台 terminal 任务不投递 mailbox（结果已随 functionResponse 返回）', () => {
        const taskId = `fgterminal_${Date.now()}`;
        registeredTaskIds.push(taskId);
        agentMailbox.registerRun('conv_fg', 'run_fg_agent', 'coder');

        TaskManager.registerTask(taskId, 'terminal', new AbortController(), {
            conversationId: 'conv_fg',
            command: 'npm test'
        });
        TaskManager.unregisterTask(taskId, 'completed', {
            conversationId: 'conv_fg',
            subagentRunId: 'run_fg_agent',
            command: 'npm test',
            background: false,
            exitCode: 0,
            output: 'FG PASS'
        });

        // 前台命令不投递 mailbox：子代理 inbox 与主会话都应为空
        expect(agentMailbox.peekMessages('conv_fg', 'run_fg_agent')).toHaveLength(0);
        expect(agentMailbox.claimMainSessionAgentMessages('conv_fg')).toBeUndefined();
    });
});
