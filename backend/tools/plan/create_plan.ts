// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './create_planRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './create_planRuntime';
export const createCreatePlanToolDeclaration: typeof runtime.createCreatePlanToolDeclaration = (...args: Parameters<typeof runtime.createCreatePlanToolDeclaration>) => withLegacyArtifactHost(() => runtime.createCreatePlanToolDeclaration(...args));
export const createCreatePlanTool: typeof runtime.createCreatePlanTool = (...args: Parameters<typeof runtime.createCreatePlanTool>) => withLegacyArtifactHost(() => runtime.createCreatePlanTool(...args));
export const registerCreatePlan: typeof runtime.registerCreatePlan = (...args: Parameters<typeof runtime.registerCreatePlan>) => withLegacyArtifactHost(() => runtime.registerCreatePlan(...args));
