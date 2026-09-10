// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './record_review_milestoneRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './record_review_milestoneRuntime';
export const createRecordReviewMilestoneToolDeclaration: typeof runtime.createRecordReviewMilestoneToolDeclaration = (...args: Parameters<typeof runtime.createRecordReviewMilestoneToolDeclaration>) => withLegacyArtifactHost(() => runtime.createRecordReviewMilestoneToolDeclaration(...args));
export const createRecordReviewMilestoneTool: typeof runtime.createRecordReviewMilestoneTool = (...args: Parameters<typeof runtime.createRecordReviewMilestoneTool>) => withLegacyArtifactHost(() => runtime.createRecordReviewMilestoneTool(...args));
export const registerRecordReviewMilestone: typeof runtime.registerRecordReviewMilestone = (...args: Parameters<typeof runtime.registerRecordReviewMilestone>) => withLegacyArtifactHost(() => runtime.registerRecordReviewMilestone(...args));
