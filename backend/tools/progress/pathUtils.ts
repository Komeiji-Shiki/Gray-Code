// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './pathUtilsRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './pathUtilsRuntime';
export const isProgressModePathAllowedWithMultiRoot: typeof runtime.isProgressModePathAllowedWithMultiRoot = (...args: Parameters<typeof runtime.isProgressModePathAllowedWithMultiRoot>) => withLegacyArtifactHost(() => runtime.isProgressModePathAllowedWithMultiRoot(...args));
export const isProgressArtifactPathAllowedWithMultiRoot: typeof runtime.isProgressArtifactPathAllowedWithMultiRoot = (...args: Parameters<typeof runtime.isProgressArtifactPathAllowedWithMultiRoot>) => withLegacyArtifactHost(() => runtime.isProgressArtifactPathAllowedWithMultiRoot(...args));
export const validateProgressArtifactRefInput: typeof runtime.validateProgressArtifactRefInput = (...args: Parameters<typeof runtime.validateProgressArtifactRefInput>) => withLegacyArtifactHost(() => runtime.validateProgressArtifactRefInput(...args));
export const normalizeProgressArtifactRef: typeof runtime.normalizeProgressArtifactRef = (...args: Parameters<typeof runtime.normalizeProgressArtifactRef>) => withLegacyArtifactHost(() => runtime.normalizeProgressArtifactRef(...args));
export const applyProgressArtifactPatch: typeof runtime.applyProgressArtifactPatch = (...args: Parameters<typeof runtime.applyProgressArtifactPatch>) => withLegacyArtifactHost(() => runtime.applyProgressArtifactPatch(...args));
