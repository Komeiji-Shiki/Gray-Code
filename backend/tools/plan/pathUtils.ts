// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './pathUtilsRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './pathUtilsRuntime';
export const isPlanModePathAllowedWithMultiRoot: typeof runtime.isPlanModePathAllowedWithMultiRoot = (...args: Parameters<typeof runtime.isPlanModePathAllowedWithMultiRoot>) => withLegacyArtifactHost(() => runtime.isPlanModePathAllowedWithMultiRoot(...args));
