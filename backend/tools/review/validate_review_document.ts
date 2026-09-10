// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './validate_review_documentRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './validate_review_documentRuntime';
export const createValidateReviewDocumentToolDeclaration: typeof runtime.createValidateReviewDocumentToolDeclaration = (...args: Parameters<typeof runtime.createValidateReviewDocumentToolDeclaration>) => withLegacyArtifactHost(() => runtime.createValidateReviewDocumentToolDeclaration(...args));
export const createValidateReviewDocumentTool: typeof runtime.createValidateReviewDocumentTool = (...args: Parameters<typeof runtime.createValidateReviewDocumentTool>) => withLegacyArtifactHost(() => runtime.createValidateReviewDocumentTool(...args));
export const registerValidateReviewDocument: typeof runtime.registerValidateReviewDocument = (...args: Parameters<typeof runtime.registerValidateReviewDocument>) => withLegacyArtifactHost(() => runtime.registerValidateReviewDocument(...args));
