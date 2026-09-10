// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './create_reviewRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './create_reviewRuntime';
export const createCreateReviewToolDeclaration: typeof runtime.createCreateReviewToolDeclaration = (...args: Parameters<typeof runtime.createCreateReviewToolDeclaration>) => withLegacyArtifactHost(() => runtime.createCreateReviewToolDeclaration(...args));
export const createCreateReviewTool: typeof runtime.createCreateReviewTool = (...args: Parameters<typeof runtime.createCreateReviewTool>) => withLegacyArtifactHost(() => runtime.createCreateReviewTool(...args));
export const registerCreateReview: typeof runtime.registerCreateReview = (...args: Parameters<typeof runtime.registerCreateReview>) => withLegacyArtifactHost(() => runtime.registerCreateReview(...args));
