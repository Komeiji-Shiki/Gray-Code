/**
 * Progress 文档与工具共享 schema
 */

export type ProgressStatus = 'active' | 'blocked' | 'completed' | 'archived';
export type ProgressPhase = 'design' | 'plan' | 'implementation' | 'review' | 'maintenance';
export type ProgressTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type ProgressMilestoneStatus = 'in_progress' | 'completed';
export type ProgressRiskStatus = 'active' | 'resolved' | 'accepted';
export type ProgressLogType = 'created' | 'updated' | 'milestone_recorded' | 'artifact_changed' | 'risk_changed';

export interface ProgressArtifactRef {
  design?: string;
  plan?: string;
  review?: string;
}

export interface ProgressTodoItem {
  id: string;
  content: string;
  status: ProgressTodoStatus;
}

export interface ProgressMilestoneRecord {
  id: string;
  title: string;
  status: ProgressMilestoneStatus;
  summary: string;
  relatedTodoIds: string[];
  relatedReviewMilestoneIds: string[];
  relatedArtifacts?: ProgressArtifactRef;
  startedAt?: string;
  completedAt?: string;
  recordedAt: string;
  nextAction?: string | null;
}

export interface ProgressRiskItem {
  id: string;
  title: string;
  status: ProgressRiskStatus;
  description: string;
}

export interface ProgressLogItem {
  at: string;
  type: ProgressLogType;
  refId?: string;
  message: string;
}

export interface ProgressStats {
  milestonesTotal: number;
  milestonesCompleted: number;
  todosTotal: number;
  todosCompleted: number;
  todosInProgress: number;
  todosCancelled: number;
  activeRisks: number;
}

export interface ProgressDocumentMetadataV1 {
  formatVersion: 1;
  kind: 'limcode.progress';
  projectId: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
  status: ProgressStatus;
  phase: ProgressPhase;
  currentFocus?: string | null;
  latestConclusion?: string | null;
  currentBlocker?: string | null;
  nextAction?: string | null;
  activeArtifacts: ProgressArtifactRef;
  todos: ProgressTodoItem[];
  milestones: ProgressMilestoneRecord[];
  risks: ProgressRiskItem[];
  log: ProgressLogItem[];
  stats: ProgressStats;
  render: {
    rendererVersion: number;
    generatedAt: string;
    bodyHash: string;
  };
}

export interface ProgressSummarySnapshotV1 {
  formatVersion: 1;
  kind: 'limcode.progress';
  path: string;
  projectId: string;
  projectName?: string;
  status: ProgressStatus;
  phase: ProgressPhase;
  currentFocus?: string | null;
  currentProgress?: string | null;
  latestConclusion?: string | null;
  currentBlocker?: string | null;
  nextAction?: string | null;
  updatedAt: string;
  activeArtifacts: ProgressArtifactRef;
  stats: ProgressStats;
  latestMilestone?: {
    id: string;
    title: string;
    status: ProgressMilestoneStatus;
    recordedAt: string;
  };
}

export interface ProgressValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ProgressValidationSummaryV1 {
  isValid: boolean;
  formatVersion: number | null;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  issues: ProgressValidationIssue[];
  metadata?: ProgressDocumentMetadataV1;
}

export interface ProgressToolDeltaV1 {
  type: 'created' | 'updated' | 'milestone_recorded' | 'validated';
  milestoneId?: string;
  changedFields?: string[];
}

export interface ProgressToolStructuredResultV1 {
  path: string;
  progressSnapshot?: ProgressSummarySnapshotV1;
  progressValidation?: ProgressValidationSummaryV1;
  progressDelta?: ProgressToolDeltaV1;
  projectId?: string;
  projectName?: string;
  status?: ProgressStatus;
  phase?: ProgressPhase;
  currentFocus?: string | null;
  currentProgress?: string | null;
  latestConclusion?: string | null;
  currentBlocker?: string | null;
  nextAction?: string | null;
  updatedAt?: string;
  activeArtifacts?: ProgressArtifactRef;
  stats?: ProgressStats;
  latestMilestone?: ProgressSummarySnapshotV1['latestMilestone'];
  formatVersion?: number | null;
  isValid?: boolean;
  issueCount?: number;
  errorCount?: number;
  warningCount?: number;
  issues?: ProgressValidationIssue[];
  warnings?: string[];
}

export const PROGRESS_RENDERER_VERSION = 1;
export const MAX_PROGRESS_LOG_ENTRIES = 20;

export const PROGRESS_DOCUMENT_TITLE = '# 项目进度';
export const PROGRESS_SUMMARY_SECTION_TITLE = '## 当前摘要';
export const PROGRESS_ARTIFACTS_SECTION_TITLE = '## 关联文档';
export const PROGRESS_TODOS_SECTION_TITLE = '## 当前 TODO 快照';
export const PROGRESS_MILESTONES_SECTION_TITLE = '## 项目里程碑';
export const PROGRESS_RISKS_SECTION_TITLE = '## 风险与阻塞';
export const PROGRESS_LOG_SECTION_TITLE = '## 最近更新';

export const PROGRESS_SUMMARY_START = '<!-- LIMCODE_PROGRESS_SUMMARY_START -->';
export const PROGRESS_SUMMARY_END = '<!-- LIMCODE_PROGRESS_SUMMARY_END -->';
export const PROGRESS_ARTIFACTS_START = '<!-- LIMCODE_PROGRESS_ARTIFACTS_START -->';
export const PROGRESS_ARTIFACTS_END = '<!-- LIMCODE_PROGRESS_ARTIFACTS_END -->';
export const PROGRESS_TODOS_START = '<!-- LIMCODE_PROGRESS_TODOS_START -->';
export const PROGRESS_TODOS_END = '<!-- LIMCODE_PROGRESS_TODOS_END -->';
export const PROGRESS_MILESTONES_START = '<!-- LIMCODE_PROGRESS_MILESTONES_START -->';
export const PROGRESS_MILESTONES_END = '<!-- LIMCODE_PROGRESS_MILESTONES_END -->';
export const PROGRESS_RISKS_START = '<!-- LIMCODE_PROGRESS_RISKS_START -->';
export const PROGRESS_RISKS_END = '<!-- LIMCODE_PROGRESS_RISKS_END -->';
export const PROGRESS_LOG_START = '<!-- LIMCODE_PROGRESS_LOG_START -->';
export const PROGRESS_LOG_END = '<!-- LIMCODE_PROGRESS_LOG_END -->';
export const PROGRESS_METADATA_START = '<!-- LIMCODE_PROGRESS_METADATA_START -->';
export const PROGRESS_METADATA_END = '<!-- LIMCODE_PROGRESS_METADATA_END -->';
