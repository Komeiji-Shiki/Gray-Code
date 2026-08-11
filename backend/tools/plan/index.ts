/**
 * Plan 工具模块
 */

import type { ToolRegistration } from '../types';

// 静态导入注册函数（与下方 re-export 共用同一模块实例，替代原函数内 require）
import { registerCreatePlan } from './create_plan';
import { registerUpdatePlan } from './update_plan';

// 导出各个工具的注册函数
export { registerCreatePlan } from './create_plan';
export { registerUpdatePlan } from './update_plan';

// 计划内容辅助（todoListSection）
export { extractPlanTodoListFromContent } from './todoListSection';
export type { PlanTodoItem } from './todoListSection';

/**
 * 获取所有 Plan 工具的注册函数
 */
export function getPlanToolRegistrations(): ToolRegistration[] {
    return [registerCreatePlan, registerUpdatePlan];
}
