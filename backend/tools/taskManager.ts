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
 */

import { EventEmitter } from 'events';
import { t } from '../i18n';

/**
 * 任务类型
 */
export type TaskType = 'terminal' | 'image_generation' | string;

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
     * 泄漏兜底清扫周期：cleanup() 兜底此前无任何调用点，驻留任务（已取消却未注销、
     * 超 30 分钟未终态）会永久留在 activeTasks。挂一个 unref 定时器周期性清扫，
     * 不阻止进程退出；仅在注册过任务后才启动，无任务时零开销。
     */
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
    
    /**
     * 生成唯一任务 ID
     */
    generateTaskId(prefix: string = 'task'): string {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
        const taskInfo: TaskInfo = {
            id,
            type,
            startTime: Date.now(),
            abortController,
            metadata
        };
        
        this.activeTasks.set(id, taskInfo);
        
        // 惰性启动泄漏兜底清扫（unref：不阻止进程退出；任务全部注销后定时器自然空转，
        // 每轮 cleanup 都无事可做，开销可忽略）
        if (this.cleanupTimer === null) {
            this.cleanupTimer = setInterval(() => this.cleanup(), TaskManagerClass.CLEANUP_INTERVAL_MS);
            if (typeof this.cleanupTimer.unref === 'function') {
                this.cleanupTimer.unref();
            }
        }
        
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
        
        this.emitEvent({
            taskId: id,
            taskType: task.type,
            type: eventType,
            data
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
     * 清理异常泄漏的任务。
     *
     * 正常生命周期中，任务在终态（completed/cancelled/error）时由 unregisterTask
     * 从 activeTasks 移除并发出终态事件，因此 activeTasks 中不会残留「已终态」的条目；
     * 本方法清扫的是「应该已终态却仍驻留」的泄漏任务：
     * - 已取消（abortController 已触发）但从未走 unregisterTask 注销的任务：
     *   补发 cancelled 终态事件后移除，前端任务条不会永久停留在「已取消但无结果」；
     *
     * 注意：只清扫「已 abort 却未注销」的任务，不对仍运行中的任务做时长兜底——
     * 合法长任务（长时间终端命令/后台子代理 run）可能运行数小时，按驻留时长强行
     * 补发 cancelled 会伪造「用户取消」回执，而任务实际还在运行（这里也并未真正
     * abort 它），取消能力随之丢失、真实完成事件被 no-op 吞掉，比泄漏更糟。
     *
     * 兼容性：unregisterTask 后续对已清理 ID 的调用是安全空操作（Map 查不到即返回），
     * 不会重复发事件；正在正常执行的任务不受影响。
     */
    cleanup(): void {
        for (const [id, task] of [...this.activeTasks]) {
            if (task.abortController.signal.aborted) {
                this.activeTasks.delete(id);
                this.emitEvent({
                    taskId: id,
                    taskType: task.type,
                    type: 'cancelled',
                    data: { reason: 'cleanup_aborted' }
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