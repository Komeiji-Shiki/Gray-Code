// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './reopen_reviewRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './reopen_reviewRuntime';
export const createReopenReviewToolDeclaration: typeof runtime.createReopenReviewToolDeclaration = (...args: Parameters<typeof runtime.createReopenReviewToolDeclaration>) => withLegacyArtifactHost(() => runtime.createReopenReviewToolDeclaration(...args));
export const createReopenReviewTool: typeof runtime.createReopenReviewTool = (...args: Parameters<typeof runtime.createReopenReviewTool>) => withLegacyArtifactHost(() => runtime.createReopenReviewTool(...args));
export const registerReopenReview: typeof runtime.registerReopenReview = (...args: Parameters<typeof runtime.registerReopenReview>) => withLegacyArtifactHost(() => runtime.registerReopenReview(...args));
