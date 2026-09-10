// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './update_planRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './update_planRuntime';
export const createUpdatePlanToolDeclaration: typeof runtime.createUpdatePlanToolDeclaration = (...args: Parameters<typeof runtime.createUpdatePlanToolDeclaration>) => withLegacyArtifactHost(() => runtime.createUpdatePlanToolDeclaration(...args));
export const createUpdatePlanTool: typeof runtime.createUpdatePlanTool = (...args: Parameters<typeof runtime.createUpdatePlanTool>) => withLegacyArtifactHost(() => runtime.createUpdatePlanTool(...args));
export const registerUpdatePlan: typeof runtime.registerUpdatePlan = (...args: Parameters<typeof runtime.registerUpdatePlan>) => withLegacyArtifactHost(() => runtime.registerUpdatePlan(...args));
