/**
 * Design 工具模块
 */

import type { ToolRegistration } from '../types';

// 静态导入注册函数（与下方 re-export 共用同一模块实例，替代原函数内 require）
import { registerCreateDesign } from './create_design';
import { registerUpdateDesign } from './update_design';

// 导出各个工具的注册函数
export { registerCreateDesign } from './create_design';
export { registerUpdateDesign } from './update_design';

/**
 * 获取所有 Design 工具的注册函数
 */
export function getDesignToolRegistrations(): ToolRegistration[] {
  return [registerCreateDesign, registerUpdateDesign];
}
