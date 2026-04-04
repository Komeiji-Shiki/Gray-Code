/**
 * Progress tool result projection helpers
 */

import type {
  ProgressDocumentMetadataV1,
  ProgressSummarySnapshotV1,
  ProgressToolDeltaV1,
  ProgressToolStructuredResultV1,
} from './schema';
import { buildCurrentProgressText, getLatestProgressMilestone } from './documentLayout';

export interface ProjectProgressToolResultOptions {
  path: string;
  metadata: ProgressDocumentMetadataV1;
  delta?: ProgressToolDeltaV1;
  warnings?: string[];
}

export function buildProgressSummarySnapshot(
  path: string,
  metadata: ProgressDocumentMetadataV1
): ProgressSummarySnapshotV1 {
  const latestMilestone = getLatestProgressMilestone(metadata);
  return {
    formatVersion: 1,
    kind: 'limcode.progress',
    path,
    projectId: metadata.projectId,
    projectName: metadata.projectName,
    status: metadata.status,
    phase: metadata.phase,
    currentFocus: metadata.currentFocus,
    currentProgress: buildCurrentProgressText(metadata),
    latestConclusion: metadata.latestConclusion,
    currentBlocker: metadata.currentBlocker,
    nextAction: metadata.nextAction,
    updatedAt: metadata.updatedAt,
    activeArtifacts: { ...metadata.activeArtifacts },
    stats: { ...metadata.stats },
    latestMilestone: latestMilestone
      ? {
        id: latestMilestone.id,
        title: latestMilestone.title,
        status: latestMilestone.status,
        recordedAt: latestMilestone.recordedAt,
      }
      : undefined,
  };
}

export function projectProgressToolResultData(
  options: ProjectProgressToolResultOptions
): ProgressToolStructuredResultV1 {
  const snapshot = buildProgressSummarySnapshot(options.path, options.metadata);
  return {
    path: options.path,
    progressSnapshot: snapshot,
    progressDelta: options.delta,
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    status: snapshot.status,
    phase: snapshot.phase,
    currentFocus: snapshot.currentFocus,
    currentProgress: snapshot.currentProgress,
    latestConclusion: snapshot.latestConclusion,
    currentBlocker: snapshot.currentBlocker,
    nextAction: snapshot.nextAction,
    updatedAt: snapshot.updatedAt,
    activeArtifacts: snapshot.activeArtifacts,
    stats: snapshot.stats,
    latestMilestone: snapshot.latestMilestone,
    warnings: options.warnings && options.warnings.length > 0 ? options.warnings : undefined,
  };
}
