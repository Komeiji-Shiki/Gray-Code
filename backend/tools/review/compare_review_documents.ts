// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './compare_review_documentsRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './compare_review_documentsRuntime';
export const createCompareReviewDocumentsToolDeclaration: typeof runtime.createCompareReviewDocumentsToolDeclaration = (...args: Parameters<typeof runtime.createCompareReviewDocumentsToolDeclaration>) => withLegacyArtifactHost(() => runtime.createCompareReviewDocumentsToolDeclaration(...args));
export const createCompareReviewDocumentsTool: typeof runtime.createCompareReviewDocumentsTool = (...args: Parameters<typeof runtime.createCompareReviewDocumentsTool>) => withLegacyArtifactHost(() => runtime.createCompareReviewDocumentsTool(...args));
export const registerCompareReviewDocuments: typeof runtime.registerCompareReviewDocuments = (...args: Parameters<typeof runtime.registerCompareReviewDocuments>) => withLegacyArtifactHost(() => runtime.registerCompareReviewDocuments(...args));
