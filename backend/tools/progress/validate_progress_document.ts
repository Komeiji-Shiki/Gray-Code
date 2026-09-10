// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './validate_progress_documentRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './validate_progress_documentRuntime';
export const createValidateProgressDocumentToolDeclaration: typeof runtime.createValidateProgressDocumentToolDeclaration = (...args: Parameters<typeof runtime.createValidateProgressDocumentToolDeclaration>) => withLegacyArtifactHost(() => runtime.createValidateProgressDocumentToolDeclaration(...args));
export const createValidateProgressDocumentTool: typeof runtime.createValidateProgressDocumentTool = (...args: Parameters<typeof runtime.createValidateProgressDocumentTool>) => withLegacyArtifactHost(() => runtime.createValidateProgressDocumentTool(...args));
export const registerValidateProgressDocument: typeof runtime.registerValidateProgressDocument = (...args: Parameters<typeof runtime.registerValidateProgressDocument>) => withLegacyArtifactHost(() => runtime.registerValidateProgressDocument(...args));
