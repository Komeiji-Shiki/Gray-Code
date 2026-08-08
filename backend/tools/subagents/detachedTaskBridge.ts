import { TaskManager } from '../taskManager';
import { subAgentRunController } from './runController';
import { subAgentRunEventBus, type SubAgentRunSnapshot } from './runEventBus';

/** detach 后的前台 SubAgent → 后台任务映射。 */
const detachedTaskIds = new Map<string, string>();

function getEventPayload(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
}

/**
 * 前台 SubAgent 被新回合替换后，注册成与显式 background=true 相同的任务。
 *
 * 这里复用 TaskManager，而不是另造一套前端协议；前端收到 start/terminal 事件后即可沿用
 * backgroundTaskStore 的任务栏、状态和完整回执逻辑。
 */
export function registerDetachedSubAgentTask(snapshot: SubAgentRunSnapshot): void {
    const { runId, conversationId, agentName } = snapshot;
    if (!conversationId || detachedTaskIds.has(runId)) return;

    const taskId = TaskManager.generateTaskId('bgagent');
    const taskAbortController = new AbortController();
    detachedTaskIds.set(runId, taskId);

    taskAbortController.signal.addEventListener('abort', () => {
        subAgentRunController.exit(runId, '用户取消了已转后台的 SubAgent');
    }, { once: true });

    TaskManager.registerTask(taskId, 'background_subagent', taskAbortController, {
        conversationId,
        agentName,
        runId,
        detached: true,
        promptPreview: `Detached SubAgent ${agentName || runId}`
    });
}

/** 终态事件到达时注销任务，把子代理完整结果交给现有后台回流协议。 */
subAgentRunEventBus.subscribe((event) => {
    if (event.type !== 'run_completed' && event.type !== 'run_failed' && event.type !== 'run_cancelled') {
        return;
    }

    const taskId = detachedTaskIds.get(event.runId);
    if (!taskId) return;

    const payload = getEventPayload(event.payload);
    const snapshot = subAgentRunEventBus.getSnapshot(event.runId);
    const status = event.type === 'run_completed'
        ? 'completed'
        : event.type === 'run_cancelled' ? 'cancelled' : 'error';

    TaskManager.unregisterTask(taskId, status, {
        runId: event.runId,
        agentName: event.agentName,
        response: typeof payload.response === 'string' ? payload.response : undefined,
        steps: typeof payload.steps === 'number' ? payload.steps : undefined,
        ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
        ...(snapshot?.conversationId ? { conversationId: snapshot.conversationId } : {})
    });
    detachedTaskIds.delete(event.runId);
});
