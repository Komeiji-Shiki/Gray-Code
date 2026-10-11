/** 审查快照归一化、关系同步与旧元数据转换。 */

import {
  type ReviewMilestoneRecordV4,
  type ReviewMilestoneStatus,
  type ReviewOverallDecision,
  type ReviewDocumentLocale,
  type ReviewSnapshotV4,
  type ReviewFindingRecordV4,
  REVIEW_SNAPSHOT_RENDERER_VERSION,
  type ReviewDocumentMetadataV3
} from './schema';
import {
  asRecord,
  nextMilestoneId,
  normalizeMilestoneStatus,
  formatDateTime,
  normalizeMarkdownText,
  normalizeNullableMarkdown,
  normalizeEvidenceRefs,
  normalizeStringList,
  nextFindingId,
  normalizeFindingCategory,
  normalizeFindingSeverity,
  normalizeFindingTrackingStatus,
  formatDate,
  parseDateToIsoStart,
  normalizeOverallDecision,
  uniqueStrings,
  countFindingsBySeverity,
  evidenceRefsToFiles,
  evidenceFilesToRefs
} from './documentValues';
import { normalizeSingleLineText } from '../shared/textUtils';
import { resolveReviewDocumentLocale, getLocalizedDefaultReviewScope } from './documentLocale';
import { generateReviewRunId } from '../shared/idGen';
import { type ReviewDocumentV3State } from './documentLegacy';

function normalizeMilestoneRecordV4(raw: unknown, existingIds: Set<string>, indexHint: number): ReviewMilestoneRecordV4 {
  const record = asRecord(raw) || {};
  const requestedId = normalizeSingleLineText(record.id);
  const id = requestedId || nextMilestoneId(existingIds, indexHint);
  existingIds.add(id);

  return {
    id,
    title: normalizeSingleLineText(record.title) || id,
    status: normalizeMilestoneStatus(record.status),
    recordedAt: normalizeSingleLineText(record.recordedAt) || formatDateTime(),
    summaryMarkdown: normalizeMarkdownText(record.summaryMarkdown ?? record.summary) || normalizeSingleLineText(record.title) || id,
    conclusionMarkdown: normalizeNullableMarkdown(record.conclusionMarkdown ?? record.conclusion),
    evidence: normalizeEvidenceRefs(record.evidence ?? record.evidenceFiles),
    reviewedModules: normalizeStringList(record.reviewedModules),
    recommendedNextAction: normalizeNullableMarkdown(record.recommendedNextAction),
    findingIds: normalizeStringList(record.findingIds)
  };
}

export function normalizeReviewSnapshot(raw: unknown, fallbacks?: {
  title?: string;
  date?: string;
  overview?: string;
  scopeMarkdown?: string;
  reviewRunId?: string;
  createdAt?: string;
  status?: ReviewMilestoneStatus;
  overallDecision?: ReviewOverallDecision | null;
  locale?: ReviewDocumentLocale;
}): ReviewSnapshotV4 {
  const source = asRecord(raw) || {};
  const headerRecord = asRecord(source.header) || {};
  const scopeRecord = asRecord(source.scope) || {};
  const summaryRecord = asRecord(source.summary) || {};
  const renderRecord = asRecord(source.render) || {};
  const milestoneIds = new Set<string>();
  const milestones = Array.isArray(source.milestones)
    ? source.milestones.map((item, index) => normalizeMilestoneRecordV4(item, milestoneIds, index + 1))
    : [];

  const findingIds = new Set<string>();
  const findings = Array.isArray(source.findings)
    ? source.findings
        .map((item, index) => {
          const finding = asRecord(item) || {};
          const requestedId = normalizeSingleLineText(finding.id);
          const id = requestedId || nextFindingId(
            findingIds,
            normalizeSingleLineText(finding.title),
            normalizeFindingCategory(finding.category),
            index + 1
          );
          findingIds.add(id);
          return {
            id,
            severity: normalizeFindingSeverity(finding.severity),
            category: normalizeFindingCategory(finding.category),
            title: normalizeSingleLineText(finding.title),
            descriptionMarkdown: normalizeNullableMarkdown(finding.descriptionMarkdown ?? finding.description),
            recommendationMarkdown: normalizeNullableMarkdown(finding.recommendationMarkdown ?? finding.recommendation),
            evidence: normalizeEvidenceRefs(finding.evidence ?? finding.evidenceFiles),
            relatedMilestoneIds: normalizeStringList(finding.relatedMilestoneIds),
            trackingStatus: normalizeFindingTrackingStatus(finding.trackingStatus)
          } satisfies ReviewFindingRecordV4;
        })
        .filter((item) => !!item.title)
    : [];

  const title = normalizeSingleLineText(headerRecord.title) || normalizeSingleLineText(fallbacks?.title) || 'Review';
  const date = normalizeSingleLineText(headerRecord.date) || normalizeSingleLineText(fallbacks?.date) || formatDate();
  const overview = normalizeSingleLineText(headerRecord.overview) || normalizeSingleLineText(fallbacks?.overview) || 'Workspace review';
  const createdAt = normalizeSingleLineText(source.createdAt) || normalizeSingleLineText(fallbacks?.createdAt) || parseDateToIsoStart(date);
  const updatedAt = normalizeSingleLineText(source.updatedAt) || normalizeSingleLineText(source.finalizedAt) || createdAt;
  const finalizedAt = normalizeSingleLineText(source.finalizedAt) || null;
  const locale = resolveReviewDocumentLocale(renderRecord.locale ?? fallbacks?.locale, 'en');
  const status = normalizeMilestoneStatus(source.status ?? fallbacks?.status);
  const overallDecision = normalizeOverallDecision(source.overallDecision ?? fallbacks?.overallDecision) || null;
  const scopeMarkdown = normalizeMarkdownText(scopeRecord.markdown)
    || normalizeMarkdownText(fallbacks?.scopeMarkdown)
    || getLocalizedDefaultReviewScope(locale);
  const reviewedModules = uniqueStrings([
    ...normalizeStringList(summaryRecord.reviewedModules),
    ...milestones.flatMap((item) => item.reviewedModules)
  ]);
  const latestMilestone = milestones[milestones.length - 1];
  const latestConclusion = normalizeNullableMarkdown(summaryRecord.latestConclusion)
    || latestMilestone?.conclusionMarkdown
    || null;
  const recommendedNextAction = normalizeNullableMarkdown(summaryRecord.recommendedNextAction)
    || latestMilestone?.recommendedNextAction
    || null;

  const snapshot: ReviewSnapshotV4 = {
    formatVersion: 4,
    kind: 'graycode.review',
    reviewRunId: normalizeSingleLineText(source.reviewRunId) || normalizeSingleLineText(fallbacks?.reviewRunId) || generateReviewRunId(),
    createdAt,
    updatedAt,
    finalizedAt,
    status,
    overallDecision,
    header: {
      title,
      date,
      overview
    },
    scope: {
      markdown: scopeMarkdown
    },
    summary: {
      latestConclusion,
      recommendedNextAction,
      reviewedModules
    },
    stats: {
      totalMilestones: 0,
      completedMilestones: 0,
      totalFindings: 0,
      severity: {
        high: 0,
        medium: 0,
        low: 0
      }
    },
    milestones,
    findings,
    render: {
      rendererVersion: REVIEW_SNAPSHOT_RENDERER_VERSION,
      bodyHash: normalizeSingleLineText(renderRecord.bodyHash),
      generatedAt: normalizeSingleLineText(renderRecord.generatedAt) || updatedAt,
      locale
    }
  };

  return reconcileReviewSnapshot(snapshot);
}

export function reconcileReviewSnapshot(snapshot: ReviewSnapshotV4): ReviewSnapshotV4 {
  const findingMap = new Map(snapshot.findings.map((item) => [item.id, { ...item, relatedMilestoneIds: uniqueStrings(item.relatedMilestoneIds) }]));
  const milestones = snapshot.milestones.map((item) => ({
    ...item,
    findingIds: uniqueStrings(item.findingIds),
    reviewedModules: uniqueStrings(item.reviewedModules),
    evidence: normalizeEvidenceRefs(item.evidence)
  }));

  for (const finding of findingMap.values()) {
    finding.relatedMilestoneIds = uniqueStrings(
      finding.relatedMilestoneIds.filter((id) => milestones.some((milestone) => milestone.id === id))
    );
    finding.evidence = normalizeEvidenceRefs(finding.evidence);
  }

  for (const milestone of milestones) {
    milestone.findingIds = uniqueStrings(
      milestone.findingIds.filter((id) => findingMap.has(id))
    );
  }

  for (const finding of findingMap.values()) {
    for (const milestoneId of finding.relatedMilestoneIds) {
      const milestone = milestones.find((item) => item.id === milestoneId);
      if (!milestone) continue;
      milestone.findingIds = uniqueStrings([...milestone.findingIds, finding.id]);
    }
  }

  for (const milestone of milestones) {
    for (const findingId of milestone.findingIds) {
      const finding = findingMap.get(findingId);
      if (!finding) continue;
      finding.relatedMilestoneIds = uniqueStrings([...finding.relatedMilestoneIds, milestone.id]);
    }
  }

  const findings = Array.from(findingMap.values());
  const reviewedModules = uniqueStrings([...snapshot.summary.reviewedModules, ...milestones.flatMap((item) => item.reviewedModules)]);
  const latestMilestone = milestones[milestones.length - 1];
  const latestConclusion = normalizeNullableMarkdown(snapshot.summary.latestConclusion) || latestMilestone?.conclusionMarkdown || null;
  const recommendedNextAction = normalizeNullableMarkdown(snapshot.summary.recommendedNextAction) || latestMilestone?.recommendedNextAction || null;

  return {
    ...snapshot,
    summary: {
      ...snapshot.summary,
      latestConclusion,
      recommendedNextAction,
      reviewedModules
    },
    stats: {
      totalMilestones: milestones.length,
      completedMilestones: milestones.filter((item) => item.status === 'completed').length,
      totalFindings: findings.length,
      severity: countFindingsBySeverity(findings)
    },
    milestones,
    findings,
    render: {
      rendererVersion: REVIEW_SNAPSHOT_RENDERER_VERSION,
      bodyHash: normalizeSingleLineText(snapshot.render.bodyHash),
      generatedAt: normalizeSingleLineText(snapshot.render.generatedAt) || normalizeSingleLineText(snapshot.updatedAt) || formatDateTime(),
      locale: resolveReviewDocumentLocale(snapshot.render.locale, 'en')
    }
  };
}

export function snapshotToMetadataCompat(snapshot: ReviewSnapshotV4): ReviewDocumentMetadataV3 {
  return {
    formatVersion: 3,
    reviewRunId: snapshot.reviewRunId,
    createdAt: snapshot.createdAt,
    finalizedAt: snapshot.finalizedAt,
    status: snapshot.status,
    overallDecision: snapshot.overallDecision,
    latestConclusion: snapshot.summary.latestConclusion,
    recommendedNextAction: snapshot.summary.recommendedNextAction,
    reviewedModules: snapshot.summary.reviewedModules,
    milestones: snapshot.milestones.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summaryMarkdown,
      status: item.status,
      conclusion: item.conclusionMarkdown,
      evidenceFiles: evidenceRefsToFiles(item.evidence),
      reviewedModules: item.reviewedModules,
      recommendedNextAction: item.recommendedNextAction,
      recordedAt: item.recordedAt,
      findingIds: item.findingIds
    })),
    findings: snapshot.findings.map((item) => ({
      id: item.id,
      severity: item.severity,
      category: item.category,
      title: item.title,
      description: item.descriptionMarkdown,
      evidenceFiles: evidenceRefsToFiles(item.evidence),
      relatedMilestoneIds: item.relatedMilestoneIds,
      recommendation: item.recommendationMarkdown
    }))
  };
}

export function convertV3StateToSnapshot(state: ReviewDocumentV3State): ReviewSnapshotV4 {
  const latestMilestone = state.metadata.milestones[state.metadata.milestones.length - 1];
  return normalizeReviewSnapshot({
    formatVersion: 4,
    kind: 'graycode.review',
    reviewRunId: state.metadata.reviewRunId,
    createdAt: state.metadata.createdAt,
    updatedAt: state.metadata.finalizedAt || latestMilestone?.recordedAt || state.metadata.createdAt,
    finalizedAt: state.metadata.finalizedAt,
    status: state.metadata.status,
    overallDecision: state.metadata.overallDecision,
    header: {
      title: state.header.title,
      date: state.header.date,
      overview: state.header.overview
    },
    scope: {
      markdown: state.scope
    },
    summary: {
      latestConclusion: state.metadata.latestConclusion,
      recommendedNextAction: state.metadata.recommendedNextAction,
      reviewedModules: state.metadata.reviewedModules
    },
    milestones: state.metadata.milestones.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      recordedAt: item.recordedAt,
      summaryMarkdown: item.summary,
      conclusionMarkdown: item.conclusion,
      evidence: evidenceFilesToRefs(item.evidenceFiles),
      reviewedModules: item.reviewedModules,
      recommendedNextAction: item.recommendedNextAction,
      findingIds: item.findingIds
    })),
    findings: state.metadata.findings.map((item) => ({
      id: item.id,
      severity: item.severity,
      category: item.category,
      title: item.title,
      descriptionMarkdown: item.description,
      recommendationMarkdown: item.recommendation,
      evidence: evidenceFilesToRefs(item.evidenceFiles),
      relatedMilestoneIds: item.relatedMilestoneIds,
      trackingStatus: 'open'
    })),
    render: {
      rendererVersion: REVIEW_SNAPSHOT_RENDERER_VERSION,
      bodyHash: '',
      generatedAt: state.metadata.finalizedAt || latestMilestone?.recordedAt || state.metadata.createdAt,
      locale: 'en'
    }
  });
}
