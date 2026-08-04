/**
 * GrayCode - 全局设置类型定义（聚合入口）
 *
 * 类型定义已按主题拆分到独立文件，本文件仅做聚合重导出，
 * 保持原有 `from '../settings/types'` 导入路径完全兼容。
 */

export * from './checkpointTypes';
export * from './toolsTypes';
export * from './promptTypes';
export * from './contextTypes';
export * from './pinnedFilesTypes';
export * from './skillsTypes';
export * from './summarizeTypes';
export * from './tokenCountTypes';
export * from './subAgentsTypes';
export * from './uiTypes';
export * from './generalTypes';

/**
 * 内置提示词模板与内置模式定义已拆分到 promptModes.ts。
 * 此处重导出以保持旧的 import 路径兼容（如 from '../settings/types'）。
 */
export * from './promptModes';
