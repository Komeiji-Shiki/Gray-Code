// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './update_progressRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './update_progressRuntime';
export const createUpdateProgressToolDeclaration: typeof runtime.createUpdateProgressToolDeclaration = (...args: Parameters<typeof runtime.createUpdateProgressToolDeclaration>) => withLegacyArtifactHost(() => runtime.createUpdateProgressToolDeclaration(...args));
export const createUpdateProgressTool: typeof runtime.createUpdateProgressTool = (...args: Parameters<typeof runtime.createUpdateProgressTool>) => withLegacyArtifactHost(() => runtime.createUpdateProgressTool(...args));
export const registerUpdateProgress: typeof runtime.registerUpdateProgress = (...args: Parameters<typeof runtime.registerUpdateProgress>) => withLegacyArtifactHost(() => runtime.registerUpdateProgress(...args));
