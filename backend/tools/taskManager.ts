/**
 * 工具任务管理模块
 *
 * 提供统一的任务生命周期管理，用于：
 * - 追踪活跃的工具任务（如终端命令、图像生成等）
 * - 支持任务取消
 * - 事件通知
 *
 * 使用方式：
 * 1. 工具开始执行时调用 registerTask() 注册任务
 * 2. 任务完成或取消时调用 unregisterTask() 注销任务
 * 3. 外部可以通过 cancelTask() 取消任务
 * 4. 通过 onTaskEvent() 订阅任务事件
 *
 * 与 SubAgent 运行时事件总线（runEventBus，backend/tools/subagents/eventBus/）的分工边界：
 * - TaskManager：任务级 UI/回执契约。以「任务」为粒度追踪活跃工具任务（终端、图像生成、
 *   后台 SubAgent 等），通过 taskEvent 事件驱动前端任务条/回执（backgroundTaskStore 等）；
 *   无状态机、无 transcript、无持久化，任务终态即从 activeTasks 移除。
 * - runEventBus：SubAgent 专用运行级/内容级 Monitor 协议（subagentMonitor.event / manifest），
 *   以「运行（run）」为粒度维护状态机 + 内容 transcript + 持久化（eventBus/ 下
 *   protocol / transcript / persist），供 SubAgentMonitorPanel 等面板消费。
 * - 桥接：后台 SubAgent（显式 background=true，或前台 detach 转后台）同时存在于两套系统——
 *   subagents.ts / detachedTaskBridge.ts 以 'background_subagent' 注册进 TaskManager；
 *   detachedTaskBridge 订阅 runEventBus 终态事件（run_completed/run_failed/run_cancelled）
 *   后手动调用 unregisterTask() 同步注销任务。两系统互不感知，靠该桥手动同步；
 *   因此同一 SubAgent 完成时 Monitor 面板与任务条/回执各收一份通知，属预期设计
 *   （见 KNOWN_ISSUES.md「有意保留的设计决定」）。
 */

import { EventEmitter } from 'events';
import { t } from '../i18n';
import { agentMailbox } from '../core/services/agentMailbox';
import { generatePrefixedId } from './shared/idGen';

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 后台 SubAgent 的完整结果必须先进入后端 claim/ack 通道，taskEvent 只做 UI 展示与唤醒。
 * 这样 Webview 尚未打开或切换会话时，终态事件即使没有观察者也不会丢失结果。
 */
function enqueueBackgroundSubAgentResult(
    task: TaskInfo,
    status: 'completed' | 'cancelled' | 'error',
    data: Record<string, unknown>
): boolean {
    const metadata = task.metadata ?? {};
    const conversationId = nonEmptyString(data.conversationId) ?? nonEmptyString(metadata.conversationId);
    const runId = nonEmptyString(data.runId) ?? nonEmptyString(metadata.runId) ?? task.id;
    const agentName = nonEmptyString(data.agentName) ?? nonEmptyString(metadata.agentName) ?? 'Sub-agent';
    if (!conversationId) return false;

    const lines = [`Task: sub-agent "${agentName}" (runId: ${runId})`];
    const statusText = status === 'completed'
        ? 'success'
        : status === 'cancelled' ? 'cancelled by user' : 'failed';
    const statusMetadata: string[] = [];
    if (typeof data.steps === 'number' && data.steps > 0) {
        statusMetadata.push(`${data.steps} steps`);
    }
    if (Array.isArray(data.toolsUsed)) {
        const toolsUsed = data.toolsUsed.filter((tool): tool is string => typeof tool === 'string');
        statusMetadata.push(toolsUsed.length > 0 ? `tools: ${toolsUsed.join(', ')}` : 'tools: none');
    }
    const durationSeconds = Math.max(0, Math.round((Date.now() - task.startTime) / 1000));
    statusMetadata.push(`${durationSeconds}s`);
    lines.push(`Status: ${statusText}${statusMetadata.length > 0 ? ` (${statusMetadata.join(', ')})` : ''}`);

    const error = nonEmptyString(data.error);
    if (error) lines.push(`Error: ${error}`);
    const response = nonEmptyString(data.response);
    if (response) {
        lines.push('Result:', response);
    } else {
        lines.push('Open Monitor to view full transcript.');
    }

    const stableMessageId = `background-task:${task.id}`;
    const result = agentMailbox.enqueueMainSessionSystemMessage({
        conversationId,
        messageId: stableMessageId,
        threadId: stableMessageId,
        fromRunId: runId,
        fromAgentName: agentName,
        text: `[Background task completed]\n\n${lines.join('\n')}`
    });
    if (!result.success) {
        console.warn('[TaskManager] Failed to enqueue background SubAgent result:', result.error);
    }
    return result.success;
}

/**
 * 任务类型
 *
 * 全仓实际取值清单（与 registerTask()/emitEvent() 调用处一致）：
 * - 'terminal'             终端命令（backend/tools/terminal/processRunner.ts）
 * - 'image_generation'     图像生成（backend/tools/media/generate_image.ts）
 * - 'background_subagent'  后台 SubAgent 任务（backend/tools/subagents/subagents.ts、detachedTaskBridge.ts）
 * - 'agent_message'        agent_send_message 入队轻量通知（backend/tools/subagents/agentSendMessage.ts；
 *                          emitEvent 直发，不注册任务）
* - 'crop_image' / 'remove_background' / 'resize_image' / 'rotate_image'
 *                          图像批处理（backend/tools/media/）
 *
 * 显式联合（去掉 `| string` 兜底）：新增任务类型时需显式扩展本声明，
 * 编译期即可捕获 `taskEvent:${taskType}` 事件名与 type 比较中的拼写错误。
 */
export type TaskType = 'terminal' | 'image_generation' | 'background_subagent' | 'agent_message' | 'crop_image' | 'remove_background' | 'resize_image' | 'rotate_image';

/**
 * 任务状态
 */
export type TaskStatus = 'running' | 'completed' | 'cancelled' | 'error';

/**
 * 任务信息
 */
export interface TaskInfo {
    /** 任务 ID（唯一标识） */
    id: string;
    /** 任务类型 */
    type: TaskType;
    /** 任务开始时间 */
    startTime: number;
    /** 取消控制器 */
    abortController: AbortController;
    /** 任务元数据（如命令、提示词等） */
    metadata?: Record<string, unknown>;
}

/**
 * 任务事件类型
 */
export type TaskEventType = 'start' | 'progress' | 'complete' | 'cancelled' | 'error';

/**
 * 任务事件
 */
export interface TaskEvent {
    /** 事件创建时间戳 */
    createdAt?: number;
    /** 任务 ID */
    taskId: string;
    /** 任务类型 */
    taskType: TaskType;
    /** 事件类型 */
    type: TaskEventType;
    /** 事件数据 */
    data?: Record<string, unknown>;
    /** 错误信息 */
    error?: string;
}

/**
 * 取消结果
 */
export interface CancelResult {
    success: boolean;
    error?: string;
}

/**
 * 工具任务管理器
 *
 * 单例模式，提供全局任务管理
 */
class TaskManagerClass {
    /** 活跃任务 Map */
    private activeTasks: Map<string, TaskInfo> = new Map();
    
    /** 事件发射器 */
    private eventEmitter: EventEmitter = new EventEmitter();
    
    /**
     * 生成唯一任务 ID
     */
    generateTaskId(prefix: string = 'task'): string {
        return generatePrefixedId(prefix);
    }
    
    /**
     * 注册任务
     *
     * @param id 任务 ID
     * @param type 任务类型
     * @param abortController 取消控制器
     * @param metadata 任务元数据
     */
    registerTask(
        id: string,
        type: TaskType,
        abortController: AbortController,
        metadata?: Record<string, unknown>
    ): void {
        // 同 ID 重复注册通常是调用方生命周期错误（旧任务未注销就重注册同名任务），
        // 新条目会覆盖旧条目的 abortController，导致旧任务无法再被取消；告警留痕便于排查。
        if (this.activeTasks.has(id)) {
            console.warn(`[TaskManager] Duplicate task registration for id "${id}" (type: ${type}); the previous entry will be overwritten.`);
        }

        const taskInfo: TaskInfo = {
            id,
            type,
            startTime: Date.now(),
            abortController,
            metadata
        };
        
        this.activeTasks.set(id, taskInfo);
        
        // 发送开始事件
        this.emitEvent({
            taskId: id,
            taskType: type,
            type: 'start',
            data: metadata
        });
    }
    
    /**
     * 注销任务
     *
     * @param id 任务 ID
     * @param status 最终状态
     * @param data 结束数据
     */
    unregisterTask(
        id: string,
        status: 'completed' | 'cancelled' | 'error' = 'completed',
        data?: Record<string, unknown>
    ): void {
        const task = this.activeTasks.get(id);
        if (!task) return;
        
        this.activeTasks.delete(id);
        
        // 发送结束事件
        const eventType: TaskEventType = status === 'completed' ? 'complete' 
            : status === 'cancelled' ? 'cancelled' 
            : 'error';

        const terminalData: Record<string, unknown> = { ...(data ?? {}) };
        if (task.type === 'background_subagent' && enqueueBackgroundSubAgentResult(task, status, terminalData)) {
            // 前端据此只更新任务条，不再走旧的 background_task 回执；真正的交付由
            // agentMailbox claim -> conversation.addMessage -> acknowledge 保证。
            terminalData.delivery = 'agent_mailbox';
        }
        
        this.emitEvent({
            taskId: id,
            taskType: task.type,
            type: eventType,
            data: Object.keys(terminalData).length > 0 ? terminalData : undefined
        });
    }
    
    /**
     * 取消任务
     *
     * @param id 任务 ID
     * @returns 取消结果
     */
    cancelTask(id: string): CancelResult {
        const task = this.activeTasks.get(id);
        
        if (!task) {
            return {
                success: false,
                error: t('tools.common.taskNotFound', { id })
            };
        }
        
        try {
            // 只触发取消信号：不删除任务、不发事件。
            // 终态（cancelled 事件带完整输出）由各任务完成路径的 unregisterTask 统一发出；
            // 提前删除会让 unregisterTask 变成 no-op，终态事件丢失，前端任务条卡在「已取消但无结果」。
            task.abortController.abort();
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: t('tools.common.cancelTaskFailed', { error: error instanceof Error ? error.message : String(error) })
            };
        }
    }
    
    /**
     * 取消指定类型的所有任务
     *
     * @param type 任务类型
     * @returns 取消的任务数量
     */
    cancelTasksByType(type: TaskType): number {
        let count = 0;
        for (const [id, task] of this.activeTasks) {
            if (task.type === type) {
                this.cancelTask(id);
                count++;
            }
        }
        return count;
    }
    
    /**
     * 取消所有任务
     *
     * @returns 取消的任务数量
     */
    cancelAllTasks(): number {
        const count = this.activeTasks.size;
        for (const id of [...this.activeTasks.keys()]) {
            this.cancelTask(id);
        }
        return count;
    }
    
    /**
     * 获取任务信息
     *
     * @param id 任务 ID
     * @returns 任务信息，不存在则返回 undefined
     */
    getTask(id: string): TaskInfo | undefined {
        return this.activeTasks.get(id);
    }
    
    /**
     * 检查任务是否存在
     *
     * @param id 任务 ID
     * @returns 是否存在
     */
    hasTask(id: string): boolean {
        return this.activeTasks.has(id);
    }
    
    /**
     * 获取指定类型的所有活跃任务
     *
     * @param type 任务类型
     * @returns 任务列表
     */
    getTasksByType(type: TaskType): TaskInfo[] {
        const tasks: TaskInfo[] = [];
        for (const task of this.activeTasks.values()) {
            if (task.type === type) {
                tasks.push(task);
            }
        }
        return tasks;
    }
    
    /**
     * 获取所有活跃任务
     *
     * @returns 任务列表
     */
    getAllTasks(): TaskInfo[] {
        return [...this.activeTasks.values()];
    }
    
    /**
     * 获取活跃任务数量
     *
     * @param type 可选的任务类型过滤
     * @returns 任务数量
     */
    getTaskCount(type?: TaskType): number {
        if (!type) {
            return this.activeTasks.size;
        }
        let count = 0;
        for (const task of this.activeTasks.values()) {
            if (task.type === type) {
                count++;
            }
        }
        return count;
    }
    
    /**
     * 发送任务事件
     */
    emitEvent(event: TaskEvent): void {
        const normalizedEvent: TaskEvent = {
            ...event,
            createdAt: typeof event.createdAt === 'number' && Number.isFinite(event.createdAt) ? event.createdAt : Date.now()
        };

        this.eventEmitter.emit('taskEvent', normalizedEvent);
        // 也发送特定类型的事件
        this.eventEmitter.emit(`taskEvent:${normalizedEvent.taskType}`, normalizedEvent);
    }
    
    /**
     * 发送进度事件
     *
     * @param id 任务 ID
     * @param data 进度数据
     */
    emitProgress(id: string, data: Record<string, unknown>): void {
        const task = this.activeTasks.get(id);
        if (!task) return;
        
        this.emitEvent({
            taskId: id,
            taskType: task.type,
            type: 'progress',
            data
        });
    }
    
    /**
     * 订阅所有任务事件
     *
     * @param listener 监听器
     * @returns 取消订阅函数
     */
    onTaskEvent(listener: (event: TaskEvent) => void): () => void {
        this.eventEmitter.on('taskEvent', listener);
        return () => this.eventEmitter.off('taskEvent', listener);
    }
    
    /**
     * 订阅特定类型的任务事件
     *
     * @param type 任务类型
     * @param listener 监听器
     * @returns 取消订阅函数
     */
    onTaskEventByType(type: TaskType, listener: (event: TaskEvent) => void): () => void {
        const eventName = `taskEvent:${type}`;
        this.eventEmitter.on(eventName, listener);
        return () => this.eventEmitter.off(eventName, listener);
    }
    
    /**
     * 驻留超过此时长（毫秒）仍未注销的任务视为泄漏（超时兜底，阈值足够大，正常长任务不受影响）
     */
    private static readonly CLEANUP_STALE_TASK_TIMEOUT_MS = 30 * 60 * 1000;

    /**
     * 清理异常泄漏的任务。
     *
     * 正常生命周期中，任务在终态（completed/cancelled/error）时由 unregisterTask
     * 从 activeTasks 移除并发出终态事件，因此 activeTasks 中不会残留「已终态」的条目；
     * 本方法清扫的是「应该已终态却仍驻留」的泄漏任务：
     * - 已取消（abortController 已触发）但从未走 unregisterTask 注销的任务：
     *   补发 cancelled 终态事件后移除，前端任务条不会永久停留在「已取消但无结果」；
     * - 超时兜底：驻留超过 CLEANUP_STALE_TASK_TIMEOUT_MS 的任务同样视为泄漏，
     *   中止其 abortController、补发 cancelled 事件后移除。
     *
     * 兼容性：unregisterTask 后续对已清理 ID 的调用是安全空操作（Map 查不到即返回），
     * 不会重复发事件；正在正常执行且未超时的任务不受影响。
     */
    cleanup(): void {
        const now = Date.now();
        for (const [id, task] of [...this.activeTasks]) {
            const stale = now - task.startTime > TaskManagerClass.CLEANUP_STALE_TASK_TIMEOUT_MS;
            if (task.abortController.signal.aborted || stale) {
                // 修改原因：旧实现删除/补发事件前从不 abort 控制器，泄漏任务的实际操作
                //          （终端进程、图像生成请求等）会脱离任务表继续运行。
                // 修改方式：删除前先 abort 控制器；但对「显式无超时且仍在运行」的任务跳过兜底，
                //          避免误杀合法长任务。
                // 修改目的：终端任务注册 metadata 现已携带 timeout（processRunner 写入），
                //          timeout=0（显式不超时）或 timeout 大于本兜底阈值（如 >30min 的长命令）
                //          的前台任务不再被 30 分钟兜底强杀；后台任务（background=true）保持原跳过逻辑；
                //          自身 timeout 未超过阈值的任务超期未终态仍由本兜底清理。
                if (!task.abortController.signal.aborted) {
                    const metadataTimeout = task.metadata?.timeout;
                    const hasOwnTimeoutBeyondThreshold =
                        typeof metadataTimeout === 'number' && metadataTimeout > TaskManagerClass.CLEANUP_STALE_TASK_TIMEOUT_MS;
                    if (metadataTimeout === 0 || hasOwnTimeoutBeyondThreshold || task.metadata?.background === true) {
                        continue;
                    }
                    task.abortController.abort();
                }
                this.activeTasks.delete(id);
                this.emitEvent({
                    taskId: id,
                    taskType: task.type,
                    type: 'cancelled',
                    data: { reason: stale ? 'cleanup_stale' : 'cleanup_aborted' }
                });
            }
        }
    }
}

/**
 * 全局任务管理器实例
 */
export const TaskManager = new TaskManagerClass();

/**
 * 导出类型和函数
 */
export {
    TaskManagerClass
};
