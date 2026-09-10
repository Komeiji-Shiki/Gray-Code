// 旧扩展入口：共享文档算法由当前宿主提供文件操作。
import * as runtime from './sourceArtifactSectionRuntime';
import { withLegacyArtifactHost } from '../shared/legacyArtifactHost';
export * from './sourceArtifactSectionRuntime';
export const isPlanSourceArtifactPathAllowedWithMultiRoot: typeof runtime.isPlanSourceArtifactPathAllowedWithMultiRoot = (...args: Parameters<typeof runtime.isPlanSourceArtifactPathAllowedWithMultiRoot>) => withLegacyArtifactHost(() => runtime.isPlanSourceArtifactPathAllowedWithMultiRoot(...args));
export const computeSourceArtifactHash: typeof runtime.computeSourceArtifactHash = (...args: Parameters<typeof runtime.computeSourceArtifactHash>) => withLegacyArtifactHost(() => runtime.computeSourceArtifactHash(...args));
export const renderPlanSourceArtifactSection: typeof runtime.renderPlanSourceArtifactSection = (...args: Parameters<typeof runtime.renderPlanSourceArtifactSection>) => withLegacyArtifactHost(() => runtime.renderPlanSourceArtifactSection(...args));
export const extractPlanSourceArtifactSection: typeof runtime.extractPlanSourceArtifactSection = (...args: Parameters<typeof runtime.extractPlanSourceArtifactSection>) => withLegacyArtifactHost(() => runtime.extractPlanSourceArtifactSection(...args));
export const stripPlanSourceArtifactSection: typeof runtime.stripPlanSourceArtifactSection = (...args: Parameters<typeof runtime.stripPlanSourceArtifactSection>) => withLegacyArtifactHost(() => runtime.stripPlanSourceArtifactSection(...args));
export const extractPlanSourceArtifact: typeof runtime.extractPlanSourceArtifact = (...args: Parameters<typeof runtime.extractPlanSourceArtifact>) => withLegacyArtifactHost(() => runtime.extractPlanSourceArtifact(...args));
export const buildTrackedPlanSourceArtifact: typeof runtime.buildTrackedPlanSourceArtifact = (...args: Parameters<typeof runtime.buildTrackedPlanSourceArtifact>) => withLegacyArtifactHost(() => runtime.buildTrackedPlanSourceArtifact(...args));
export const getPlanSourceStatusFromContent: typeof runtime.getPlanSourceStatusFromContent = (...args: Parameters<typeof runtime.getPlanSourceStatusFromContent>) => withLegacyArtifactHost(() => runtime.getPlanSourceStatusFromContent(...args));
