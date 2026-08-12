import { TaskManager } from '../taskManager';
import { subAgentRunController } from './runController';
import { subAgentRunEventBus, type SubAgentRunSnapshot } from './runEventBus';

interface BackgroundSubAgentTaskBinding {
    taskId: string;
    conversationId?: string;
    agentName?: string;
}

/**
 * SubAgent run → TaskManager 任务映射。
 *
 * 同一 runId 理论上只有一个后台任务；这里仍按 taskId 再分一层，避免
 * continueFromRunId 的并发拒绝窗口中，后注册任务覆盖先注册任务的终态绑定。
 */
const backgroundTaskBindings = new Map<string, Map<string, BackgroundSubAgentTaskBinding>>();

function getEventPayload(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
}

/**
 * 把已经注册到 TaskManager 的显式后台 SubAgent 绑到 run 终态事件。
 *
 * 修改原因：默认 executor 先广播 run_completed/run_failed，然后在 finally 等待
 * transcript 终态落盘。旧后台分支只在 executor Promise settle 后注销 TaskManager，
 * 落盘阻塞时 Monitor 已显示完成，但完成回执永远不会发给主模型。
 *
 * 自定义 executor 可能不发 run 事件；调用方仍保留 Promise settle 兜底，并在
 * 兜底前调用 unbindBackgroundSubAgentTask。
 */
export function bindBackgroundSubAgentTask(binding: BackgroundSubAgentTaskBinding & { runId: string }): void {
    let bindings = backgroundTaskBindings.get(binding.runId);
    if (!bindings) {
        bindings = new Map();
        backgroundTaskBindings.set(binding.runId, bindings);
    }
    bindings.set(binding.taskId, {
        taskId: binding.taskId,
        conversationId: binding.conversationId,
        agentName: binding.agentName
    });
}

/** Promise settle 兜底路径解除终态事件绑定（幂等）。 */
export function unbindBackgroundSubAgentTask(runId: string, taskId: string): void {
    const bindings = backgroundTaskBindings.get(runId);
    if (!bindings) return;
    bindings.delete(taskId);
    if (bindings.size === 0) {
        backgroundTaskBindings.delete(runId);
    }
}

/**
 * 前台 SubAgent 被新回合替换后，注册成与显式 background=true 相同的任务。
 *
 * 这里复用 TaskManager，而不是另造一套前端协议；前端收到 start/terminal 事件后即可沿用
 * backgroundTaskStore 的任务栏、状态和完整回执逻辑。
 */
export function registerDetachedSubAgentTask(snapshot: SubAgentRunSnapshot): void {
    const { runId, conversationId, agentName } = snapshot;
    if (!conversationId || backgroundTaskBindings.has(runId)) return;

    const taskId = TaskManager.generateTaskId('bgagent');
    const taskAbortController = new AbortController();
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
    bindBackgroundSubAgentTask({ runId, taskId, conversationId, agentName });
}

/** 终态事件到达时注销任务，把子代理完整结果交给现有后台回流协议。 */
subAgentRunEventBus.subscribe((event) => {
    if (event.type !== 'run_completed' && event.type !== 'run_failed' && event.type !== 'run_cancelled') {
        return;
    }

    const bindings = backgroundTaskBindings.get(event.runId);
    if (!bindings || bindings.size === 0) return;
    backgroundTaskBindings.delete(event.runId);

    const payload = getEventPayload(event.payload);
    const snapshot = subAgentRunEventBus.getSnapshot(event.runId);
    const status = event.type === 'run_completed'
        ? 'completed'
        : event.type === 'run_cancelled' ? 'cancelled' : 'error';

    for (const binding of bindings.values()) {
        const error = typeof payload.error === 'string'
            ? payload.error
            : (typeof payload.reason === 'string' ? payload.reason : undefined);
        const toolsUsed = Array.isArray(payload.toolsUsed)
            ? payload.toolsUsed.filter((tool): tool is string => typeof tool === 'string')
            : undefined;
        const conversationId = binding.conversationId || snapshot?.conversationId;
        TaskManager.unregisterTask(binding.taskId, status, {
            runId: event.runId,
            agentName: event.agentName || binding.agentName,
            response: typeof payload.response === 'string' ? payload.response : undefined,
            steps: typeof payload.steps === 'number' ? payload.steps : undefined,
            ...(toolsUsed ? { toolsUsed } : {}),
            ...(error ? { error } : {}),
            ...(conversationId ? { conversationId } : {})
        });
    }
});
