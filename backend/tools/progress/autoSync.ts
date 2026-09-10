// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './autoSyncRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './autoSyncRuntime';
export const syncProgressFromDesignArtifact: typeof runtime.syncProgressFromDesignArtifact = (...args: Parameters<typeof runtime.syncProgressFromDesignArtifact>) => withLegacyArtifactHost(() => runtime.syncProgressFromDesignArtifact(...args));
export const syncProgressFromPlanArtifact: typeof runtime.syncProgressFromPlanArtifact = (...args: Parameters<typeof runtime.syncProgressFromPlanArtifact>) => withLegacyArtifactHost(() => runtime.syncProgressFromPlanArtifact(...args));
export const syncProgressFromReviewArtifact: typeof runtime.syncProgressFromReviewArtifact = (...args: Parameters<typeof runtime.syncProgressFromReviewArtifact>) => withLegacyArtifactHost(() => runtime.syncProgressFromReviewArtifact(...args));
