/**
 * Todo 工具模块
 *
 * 导出所有 Todo 相关的工具
 */

import type { ToolRegistration } from '../types';
import { registerTodoWrite } from './todo_write';
import { registerTodoUpdate } from './todo_update';

// 导出各个工具的创建函数
export { registerTodoWrite } from './todo_write';
export { registerTodoUpdate } from './todo_update';

// 导出 todo_write 模块的所有内容（方便外部引用）
export * from './todo_write';

/**
 * TODO 工具名称。
 *
 * 修改原因：SubAgent 的执行路径不携带主会话 conversationId（以 runId 作为缓存域），
 * todo_write/todo_update 依赖 ToolContext.conversationId 读写会话元数据，子代理调用必然失败，
 * 但旧实现仍把这两个工具声明发给子代理模型，导致子代理反复尝试调用并报错浪费迭代。
 * 修改方式：集中导出工具名常量，供子代理工具声明过滤（executor/subagents）统一排除。
 */
export const TODO_TOOL_NAMES = ['todo_write', 'todo_update'] as const;

/**
 * 获取所有 Todo 工具的注册函数
 */
export function getTodoToolRegistrations(): ToolRegistration[] {
    return [registerTodoWrite, registerTodoUpdate];
}
