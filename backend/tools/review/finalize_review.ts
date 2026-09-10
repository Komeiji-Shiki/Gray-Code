// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './finalize_reviewRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './finalize_reviewRuntime';
export const createFinalizeReviewToolDeclaration: typeof runtime.createFinalizeReviewToolDeclaration = (...args: Parameters<typeof runtime.createFinalizeReviewToolDeclaration>) => withLegacyArtifactHost(() => runtime.createFinalizeReviewToolDeclaration(...args));
export const createFinalizeReviewTool: typeof runtime.createFinalizeReviewTool = (...args: Parameters<typeof runtime.createFinalizeReviewTool>) => withLegacyArtifactHost(() => runtime.createFinalizeReviewTool(...args));
export const registerFinalizeReview: typeof runtime.registerFinalizeReview = (...args: Parameters<typeof runtime.registerFinalizeReview>) => withLegacyArtifactHost(() => runtime.registerFinalizeReview(...args));
