// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './create_designRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './create_designRuntime';
export const createCreateDesignToolDeclaration: typeof runtime.createCreateDesignToolDeclaration = (...args: Parameters<typeof runtime.createCreateDesignToolDeclaration>) => withLegacyArtifactHost(() => runtime.createCreateDesignToolDeclaration(...args));
export const createCreateDesignTool: typeof runtime.createCreateDesignTool = (...args: Parameters<typeof runtime.createCreateDesignTool>) => withLegacyArtifactHost(() => runtime.createCreateDesignTool(...args));
export const registerCreateDesign: typeof runtime.registerCreateDesign = (...args: Parameters<typeof runtime.registerCreateDesign>) => withLegacyArtifactHost(() => runtime.registerCreateDesign(...args));
