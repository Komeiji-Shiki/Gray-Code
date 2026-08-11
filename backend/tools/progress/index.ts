/**
 * Progress 工具模块
 */

import type { ToolRegistration } from '../types';

// 静态导入注册函数（与下方 re-export 共用同一模块实例，替代原函数内 require）
import { registerCreateProgress } from './create_progress';
import { registerUpdateProgress } from './update_progress';
import { registerRecordProgressMilestone } from './record_progress_milestone';
import { registerValidateProgressDocument } from './validate_progress_document';

export { registerCreateProgress } from './create_progress';
export { registerUpdateProgress } from './update_progress';
export { registerRecordProgressMilestone } from './record_progress_milestone';
export { registerValidateProgressDocument } from './validate_progress_document';

export function getProgressToolRegistrations(): ToolRegistration[] {
  return [registerCreateProgress, registerUpdateProgress, registerRecordProgressMilestone, registerValidateProgressDocument];
}
