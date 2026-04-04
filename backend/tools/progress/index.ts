/**
 * Progress 工具模块
 */

import type { Tool, ToolRegistration } from '../types';

export { registerCreateProgress } from './create_progress';
export { registerUpdateProgress } from './update_progress';
export { registerRecordProgressMilestone } from './record_progress_milestone';
export { registerValidateProgressDocument } from './validate_progress_document';

export function getProgressToolRegistrations(): ToolRegistration[] {
  const { registerCreateProgress } = require('./create_progress');
  const { registerUpdateProgress } = require('./update_progress');
  const { registerRecordProgressMilestone } = require('./record_progress_milestone');
  const { registerValidateProgressDocument } = require('./validate_progress_document');
  return [registerCreateProgress, registerUpdateProgress, registerRecordProgressMilestone, registerValidateProgressDocument];
}

export function getAllProgressTools(): Tool[] {
  const { registerCreateProgress } = require('./create_progress');
  const { registerUpdateProgress } = require('./update_progress');
  const { registerRecordProgressMilestone } = require('./record_progress_milestone');
  const { registerValidateProgressDocument } = require('./validate_progress_document');
  return [registerCreateProgress(), registerUpdateProgress(), registerRecordProgressMilestone(), registerValidateProgressDocument()];
}
