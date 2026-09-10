// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './update_designRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './update_designRuntime';
export const createUpdateDesignToolDeclaration: typeof runtime.createUpdateDesignToolDeclaration = (...args: Parameters<typeof runtime.createUpdateDesignToolDeclaration>) => withLegacyArtifactHost(() => runtime.createUpdateDesignToolDeclaration(...args));
export const createUpdateDesignTool: typeof runtime.createUpdateDesignTool = (...args: Parameters<typeof runtime.createUpdateDesignTool>) => withLegacyArtifactHost(() => runtime.createUpdateDesignTool(...args));
export const registerUpdateDesign: typeof runtime.registerUpdateDesign = (...args: Parameters<typeof runtime.registerUpdateDesign>) => withLegacyArtifactHost(() => runtime.registerUpdateDesign(...args));
