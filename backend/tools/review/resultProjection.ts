/**
 * Review tool result projection helpers
 */

import type { ReviewDocumentSummarySnapshot, ReviewToolDeltaV4, ReviewToolStructuredResultV4, ReviewValidationResult, ReviewValidationSummaryV4 } from './schema';
import { buildSummaryFromSnapshot, summarizeReviewDocument, validateReviewDocument } from './reviewDocumentSection';

export interface ProjectReviewToolResultOptions {
  path: string;
  content: string;
  delta?: ReviewToolDeltaV4;
  extra?: Record<string, unknown>;
  includeContent?: boolean;
}

export function buildReviewValidationSummary(content: string): ReviewValidationSummaryV4 {
  return buildReviewValidationSummaryFromResult(validateReviewDocument(content));
}

/** 由已计算的校验结果构造摘要（供多处复用同一份 validation，避免重复解析文档） */
export function buildReviewValidationSummaryFromResult(validation: ReviewValidationResult): ReviewValidationSummaryV4 {
  return {
    isValid: validation.isValid,
    detectedFormat: validation.detectedFormat,
    formatVersion: validation.formatVersion,
    issueCount: validation.issues.length,
    errorCount: validation.issues.filter((item) => item.severity === 'error').length,
    warningCount: validation.issues.filter((item) => item.severity === 'warning').length,
    canAutoUpgrade: validation.canAutoUpgrade,
    issues: validation.issues
  };
}

export function projectReviewToolResultData(options: ProjectReviewToolResultOptions): ReviewToolStructuredResultV4 {
  // 修改原因：validateReviewDocument 过去被调用两次（此处 + buildReviewValidationSummary 内部），
  //           加上 summarizeReviewDocument 各自重新解析文档，同一份 content 被重复解析三遍。
  // 修改方式：一次校验的结果三处复用——validation 直接使用；reviewValidation 由该校验结果派生；
  //           summary 优先用校验结果内嵌的 reviewSnapshot 构建（v3/v4 有效文档快照一致），
  //           未知格式（无快照）才回退 summarizeReviewDocument（行为与旧实现一致）。
  const validation = validateReviewDocument(options.content);
  const summary: ReviewDocumentSummarySnapshot = validation.reviewSnapshot
    ? buildSummaryFromSnapshot(validation.reviewSnapshot)
    : summarizeReviewDocument(options.content);
  const reviewValidation = buildReviewValidationSummaryFromResult(validation);

  const data: ReviewToolStructuredResultV4 = {
    path: options.path,
    reviewSnapshot: validation.reviewSnapshot,
    reviewValidation,
    reviewDelta: options.delta,
    title: summary.title,
    date: summary.date,
    status: summary.status,
    currentStatus: summary.status,
    overallDecision: summary.overallDecision,
    milestoneCount: summary.totalMilestones,
    totalMilestones: summary.totalMilestones,
    completedMilestones: summary.completedMilestones,
    currentProgress: summary.currentProgress,
    totalFindings: summary.totalFindings,
    findingsBySeverity: summary.findingsBySeverity,
    reviewedModules: summary.reviewedModules,
    latestConclusion: summary.latestConclusion,
    recommendedNextAction: summary.recommendedNextAction,
    metadata: validation.metadata,
    formatVersion: validation.formatVersion,
    detectedFormat: validation.detectedFormat,
    isValid: validation.isValid,
    canAutoUpgrade: validation.canAutoUpgrade,
    issues: validation.issues,
    issueCount: reviewValidation.issueCount,
    errorCount: reviewValidation.errorCount,
    warningCount: reviewValidation.warningCount,
    content: options.includeContent === false ? undefined : options.content
  };

  if (options.extra) {
    Object.assign(data, options.extra);
  }

  return data;
}
