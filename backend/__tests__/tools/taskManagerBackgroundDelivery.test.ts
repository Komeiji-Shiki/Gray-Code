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
});
