/** 由审查快照生成正文、尾部快照与摘要。 */

import { normalizeNullableMarkdown, snapshotFindingToInput, hashText, formatDateTime } from './documentValues';
import { normalizeLineEndingsToLF as normalizeLineEndings, normalizeSingleLineText } from '../shared/textUtils';
import { type ReviewSnapshotV4, REVIEW_SNAPSHOT_RENDERER_VERSION, type ReviewDocumentSummarySnapshot } from './schema';
import {
  resolveReviewDocumentLocale,
  getReviewDocumentMessages,
  formatCurrentProgress,
  getDisplayMilestoneStatus,
  joinDisplayList,
  formatFindingsBySeverity,
  formatSingleLineValue,
  getDisplayOverallDecision,
  getLocalizedNoFindingsPlaceholder,
  getDisplaySeverity,
  getDisplayCategory,
  getDisplayTrackingStatus,
  formatEvidenceRefText,
  getLocalizedNoMilestonesPlaceholder,
  formatFindingSummaryText,
  getLocalizedDefaultFinalConclusion,
  getReviewSectionHeadings,
  getLocalizedDefaultReviewScope
} from './documentLocale';
import { reconcileReviewSnapshot } from './documentSnapshot';

function appendLabeledMarkdownBlock(lines: string[], label: string, markdown?: string | null): void {
  const normalized = normalizeNullableMarkdown(markdown);
  if (!normalized) return;
  lines.push(`- ${label}:`);
  lines.push('');
  for (const line of normalizeLineEndings(normalized).split('\n')) {
    lines.push(line ? `  ${line}` : '');
  }
}

function renderReviewSummary(snapshot: ReviewSnapshotV4): string {
  const locale = resolveReviewDocumentLocale(snapshot.render.locale, 'en');
  const labels = getReviewDocumentMessages(locale).summary;
  const currentProgress = formatCurrentProgress(snapshot, locale);

  return [
    `- ${labels.currentStatus}: ${getDisplayMilestoneStatus(snapshot.status, locale)}`,
    `- ${labels.reviewedModules}: ${joinDisplayList(snapshot.summary.reviewedModules, locale)}`,
    `- ${labels.currentProgress}: ${currentProgress}`,
    `- ${labels.totalMilestones}: ${snapshot.stats.totalMilestones}`,
    `- ${labels.completedMilestones}: ${snapshot.stats.completedMilestones}`,
    `- ${labels.totalFindings}: ${snapshot.stats.totalFindings}`,
    `- ${labels.findingsBySeverity}: ${formatFindingsBySeverity(snapshot.stats.severity, locale)}`,
    `- ${labels.latestConclusion}: ${formatSingleLineValue(snapshot.summary.latestConclusion, locale)}`,
    `- ${labels.recommendedNextAction}: ${formatSingleLineValue(snapshot.summary.recommendedNextAction, locale)}`,
    `- ${labels.overallDecision}: ${getDisplayOverallDecision(snapshot.overallDecision, locale)}`
  ].join('\n');
}

function renderReviewFindings(snapshot: ReviewSnapshotV4): string {
  const locale = resolveReviewDocumentLocale(snapshot.render.locale, 'en');
  const labels = getReviewDocumentMessages(locale).finding;
  if (snapshot.findings.length === 0) {
    return getLocalizedNoFindingsPlaceholder(locale);
  }

  return snapshot.findings.map((finding) => {
    const lines = [
      `### ${finding.title}`,
      '',
      `- ID: ${finding.id}`,
      `- ${labels.severity}: ${getDisplaySeverity(finding.severity, locale)}`,
      `- ${labels.category}: ${getDisplayCategory(finding.category, locale)}`,
      `- ${labels.trackingStatus}: ${getDisplayTrackingStatus(finding.trackingStatus, locale)}`
    ];

    if (finding.relatedMilestoneIds.length > 0) {
      lines.push(`- ${labels.relatedMilestones}: ${finding.relatedMilestoneIds.join(', ')}`);
    }

    appendLabeledMarkdownBlock(lines, labels.description, finding.descriptionMarkdown);
    appendLabeledMarkdownBlock(lines, labels.recommendation, finding.recommendationMarkdown);

    if (finding.evidence.length > 0) {
      lines.push(`- ${labels.evidenceFiles}:`);
      for (const evidence of finding.evidence) {
        lines.push(`  - \`${formatEvidenceRefText(evidence)}\``);
      }
    }

    return lines.join('\n');
  }).join('\n\n');
}

function renderReviewMilestones(snapshot: ReviewSnapshotV4): string {
  const locale = resolveReviewDocumentLocale(snapshot.render.locale, 'en');
  const labels = getReviewDocumentMessages(locale).milestone;
  if (snapshot.milestones.length === 0) {
    return getLocalizedNoMilestonesPlaceholder(locale);
  }

  const findingMap = new Map(snapshot.findings.map((item) => [item.id, item]));
  return snapshot.milestones.map((milestone) => {
    const lines = [
      `### ${milestone.id} · ${milestone.title}`,
      '',
      `- ${labels.status}: ${getDisplayMilestoneStatus(milestone.status, locale)}`,
      `- ${labels.recordedAt}: ${milestone.recordedAt}`
    ];

    if (milestone.reviewedModules.length > 0) {
      lines.push(`- ${labels.reviewedModules}: ${milestone.reviewedModules.join(', ')}`);
    }

    appendLabeledMarkdownBlock(lines, labels.summary, milestone.summaryMarkdown);
    appendLabeledMarkdownBlock(lines, labels.conclusion, milestone.conclusionMarkdown);

    if (milestone.evidence.length > 0) {
      lines.push(`- ${labels.evidenceFiles}:`);
      for (const evidence of milestone.evidence) {
        lines.push(`  - \`${formatEvidenceRefText(evidence)}\``);
      }
    }

    appendLabeledMarkdownBlock(lines, labels.recommendedNextAction, milestone.recommendedNextAction);

    if (milestone.findingIds.length > 0) {
      lines.push(`- ${labels.findings}:`);
      for (const findingId of milestone.findingIds) {
        const finding = findingMap.get(findingId);
        if (!finding) continue;
        lines.push(`  - ${formatFindingSummaryText(snapshotFindingToInput(finding), locale)}`);
      }
    }

    return lines.join('\n');
  }).join('\n\n');
}

function renderReviewFinalConclusion(snapshot: ReviewSnapshotV4): string {
  const locale = resolveReviewDocumentLocale(snapshot.render.locale, 'en');
  return snapshot.summary.latestConclusion || getLocalizedDefaultFinalConclusion(locale);
}

export function renderReviewDocumentBody(snapshot: ReviewSnapshotV4): string {
  const normalizedSnapshot = reconcileReviewSnapshot(snapshot);
  const locale = resolveReviewDocumentLocale(normalizedSnapshot.render.locale, 'en');
  const headings = getReviewSectionHeadings(locale);
  const headerLabels = getReviewDocumentMessages(locale).header;
  const lines = [
    `# ${normalizedSnapshot.header.title}`,
    `- ${headerLabels.date}: ${normalizedSnapshot.header.date}`,
    `- ${headerLabels.overview}: ${normalizedSnapshot.header.overview}`,
    `- ${headerLabels.status}: ${getDisplayMilestoneStatus(normalizedSnapshot.status, locale)}`,
    `- ${headerLabels.overallDecision}: ${getDisplayOverallDecision(normalizedSnapshot.overallDecision, locale)}`,
    '',
    headings.scope,
    '',
    normalizedSnapshot.scope.markdown || getLocalizedDefaultReviewScope(locale),
    '',
    headings.summary,
    '',
    renderReviewSummary(normalizedSnapshot),
    '',
    headings.findings,
    '',
    renderReviewFindings(normalizedSnapshot),
    '',
    headings.milestones,
    '',
    renderReviewMilestones(normalizedSnapshot),
    '',
    headings.finalConclusion,
    '',
    renderReviewFinalConclusion(normalizedSnapshot)
  ];

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderReviewSnapshotSection(snapshot: ReviewSnapshotV4): string {
  const locale = resolveReviewDocumentLocale(snapshot.render.locale, 'en');
  const headings = getReviewSectionHeadings(locale);

  return [
    headings.snapshot,
    '',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```'
  ].join('\n');
}

export function buildReviewDocument(snapshotInput: ReviewSnapshotV4): string {
  const base = reconcileReviewSnapshot(snapshotInput);
  const body = renderReviewDocumentBody(base);
  const finalSnapshot = reconcileReviewSnapshot({
    ...base,
    render: {
      rendererVersion: REVIEW_SNAPSHOT_RENDERER_VERSION,
      bodyHash: hashText(body),
      generatedAt: normalizeSingleLineText(base.render.generatedAt) || normalizeSingleLineText(base.updatedAt) || formatDateTime(),
      locale: resolveReviewDocumentLocale(base.render.locale, 'en')
    }
  });

  return `${body.trimEnd()}\n\n${renderReviewSnapshotSection(finalSnapshot).trimEnd()}\n`;
}

export function buildSummaryFromSnapshot(snapshot: ReviewSnapshotV4): ReviewDocumentSummarySnapshot {
  const locale = resolveReviewDocumentLocale(snapshot.render.locale, 'en');

  return {
    title: snapshot.header.title,
    date: snapshot.header.date,
    overview: snapshot.header.overview,
    status: snapshot.status,
    overallDecision: snapshot.overallDecision,
    totalMilestones: snapshot.stats.totalMilestones,
    completedMilestones: snapshot.stats.completedMilestones,
    currentProgress: formatCurrentProgress(snapshot, locale),
    reviewedModules: snapshot.summary.reviewedModules,
    totalFindings: snapshot.stats.totalFindings,
    findingsBySeverity: snapshot.stats.severity,
    latestConclusion: snapshot.summary.latestConclusion,
    recommendedNextAction: snapshot.summary.recommendedNextAction,
    reviewSnapshot: snapshot
  };
}
