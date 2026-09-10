import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TaskEvent, TaskInfo, TaskType } from '../../../../backend/tools/taskManager';

/** 原终端与媒体运行器共用的任务端口；不使用扩展的全局收件箱或清理定时器。 */
export class ToolTaskPort {
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly events = new EventEmitter();
  constructor(private readonly publish: (event: TaskEvent) => void) {}
  generateTaskId(prefix = 'terminal') { return `${prefix}-${randomUUID()}`; }
  getTasksByType(type: TaskType) { return [...this.tasks.values()].filter(task => task.type === type); }
  getTask(id: string) { return this.tasks.get(id); }
  registerTask(id: string, type: TaskType, abortController: AbortController, metadata?: Record<string, unknown>) {
    this.tasks.set(id, { id, type, abortController, metadata, startTime: Date.now() });
    this.emitEvent({ taskId: id, taskType: type, type: 'start', data: metadata });
  }
  unregisterTask(id: string, status: 'completed' | 'cancelled' | 'error' = 'completed', data?: Record<string, unknown>) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.delete(id);
    this.emitEvent({ taskId: id, taskType: task.type, type: status === 'completed' ? 'complete' : status,
      data: { ...task.metadata, ...data } });
  }
  cancelTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) return { success: false, error: '工具任务不存在或已经结束。' };
    task.abortController.abort();
    return { success: true };
  }
  emitEvent(event: TaskEvent) {
    const value = { createdAt: Date.now(), ...event };
    this.events.emit(event.taskType, value);
    this.publish(value);
  }
  onTaskEventByType(type: TaskType, listener: (event: TaskEvent) => void) {
    this.events.on(type, listener);
    return () => { this.events.off(type, listener); };
  }
}
