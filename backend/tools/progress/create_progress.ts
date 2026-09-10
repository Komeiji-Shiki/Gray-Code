// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './create_progressRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './create_progressRuntime';
export const createCreateProgressToolDeclaration: typeof runtime.createCreateProgressToolDeclaration = (...args: Parameters<typeof runtime.createCreateProgressToolDeclaration>) => withLegacyArtifactHost(() => runtime.createCreateProgressToolDeclaration(...args));
export const createCreateProgressTool: typeof runtime.createCreateProgressTool = (...args: Parameters<typeof runtime.createCreateProgressTool>) => withLegacyArtifactHost(() => runtime.createCreateProgressTool(...args));
export const registerCreateProgress: typeof runtime.registerCreateProgress = (...args: Parameters<typeof runtime.registerCreateProgress>) => withLegacyArtifactHost(() => runtime.registerCreateProgress(...args));
