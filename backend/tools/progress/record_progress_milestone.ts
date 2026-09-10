// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './record_progress_milestoneRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './record_progress_milestoneRuntime';
export const createRecordProgressMilestoneToolDeclaration: typeof runtime.createRecordProgressMilestoneToolDeclaration = (...args: Parameters<typeof runtime.createRecordProgressMilestoneToolDeclaration>) => withLegacyArtifactHost(() => runtime.createRecordProgressMilestoneToolDeclaration(...args));
export const createRecordProgressMilestoneTool: typeof runtime.createRecordProgressMilestoneTool = (...args: Parameters<typeof runtime.createRecordProgressMilestoneTool>) => withLegacyArtifactHost(() => runtime.createRecordProgressMilestoneTool(...args));
export const registerRecordProgressMilestone: typeof runtime.registerRecordProgressMilestone = (...args: Parameters<typeof runtime.registerRecordProgressMilestone>) => withLegacyArtifactHost(() => runtime.registerRecordProgressMilestone(...args));
