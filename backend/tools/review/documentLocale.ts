/** 审查文档的语言选择与显示文案。 */

import { getMessagesForLanguage, getActualLanguage } from '../../i18n';
import {
  type ReviewDocumentLocale,
  type ReviewSnapshotV4,
  type ReviewEvidenceRef,
  type ReviewMilestoneStatus,
  type ReviewOverallDecision,
  type ReviewFindingSeverity,
  type ReviewFindingCategory,
  type ReviewFindingTrackingStatus,
  NO_FINDINGS_PLACEHOLDER,
  NO_MILESTONES_PLACEHOLDER,
  type ReviewFindingInput
} from './schema';
import { normalizeHeadingToken, normalizeFindingSeverity, normalizeFindingCategory } from './documentValues';
import { normalizeSingleLineText } from '../shared/textUtils';

type ReviewDocumentMessages = ReturnType<typeof getMessagesForLanguage>['tools']['reviewDocument'];

export const REVIEW_DOCUMENT_LOCALES: ReviewDocumentLocale[] = ['zh-CN', 'en', 'ja'];

function applyTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? String(params[key]) : match;
  });
}

export function resolveReviewDocumentLocale(
  value: unknown,
  fallback: ReviewDocumentLocale = 'en'
): ReviewDocumentLocale {
  if (value === 'en' || value === 'ja' || value === 'zh-CN') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.startsWith('zh')) return 'zh-CN';
    if (value.startsWith('en')) return 'en';
    if (value.startsWith('ja')) return 'ja';
  }
  return fallback;
}

export function getCurrentReviewDocumentLocale(fallback: ReviewDocumentLocale = 'zh-CN'): ReviewDocumentLocale {
  return resolveReviewDocumentLocale(getActualLanguage(), fallback);
}

export function getReviewDocumentMessages(locale: ReviewDocumentLocale): ReviewDocumentMessages {
  return getMessagesForLanguage(resolveReviewDocumentLocale(locale)).tools.reviewDocument;
}

export function getReviewSectionHeadings(locale: ReviewDocumentLocale): {
  scope: string;
  summary: string;
  findings: string;
  milestones: string;
  finalConclusion: string;
  snapshot: string;
} {
  const sections = getReviewDocumentMessages(locale).sections;
  return {
    scope: `## ${sections.scope}`,
    summary: `## ${sections.summary}`,
    findings: `## ${sections.findings}`,
    milestones: `## ${sections.milestones}`,
    finalConclusion: `## ${sections.finalConclusion}`,
    snapshot: `## ${sections.snapshot}`
  };
}

export function inferReviewDocumentLocaleFromSnapshotHeading(heading: string): ReviewDocumentLocale | undefined {
  const normalized = normalizeHeadingToken(heading);
  for (const locale of REVIEW_DOCUMENT_LOCALES) {
    const snapshotHeading = getReviewSectionHeadings(locale).snapshot.replace(/^##\s+/, '');
    if (normalizeHeadingToken(snapshotHeading) === normalized) {
      return locale;
    }
  }
  return undefined;
}

export function isSnapshotHeading(heading: string): boolean {
  const normalized = normalizeHeadingToken(heading);
  return REVIEW_DOCUMENT_LOCALES.some((locale) => {
    const snapshotHeading = getReviewSectionHeadings(locale).snapshot.replace(/^##\s+/, '');
    return normalizeHeadingToken(snapshotHeading) === normalized;
  });
}

export function formatCurrentProgress(snapshot: ReviewSnapshotV4, locale: ReviewDocumentLocale): string {
  const messages = getReviewDocumentMessages(locale);
  if (snapshot.stats.totalMilestones > 0) {
    return applyTemplate(messages.templates.currentProgressWithLatest, {
      count: snapshot.stats.totalMilestones,
      latestId: snapshot.milestones[snapshot.milestones.length - 1]?.id || ''
    });
  }
  return messages.templates.currentProgressEmpty;
}

export function formatEvidenceRefText(ref: ReviewEvidenceRef): string {
  const path = normalizeSingleLineText(ref.path);
  if (!path) return '';
  const lineStart = ref.lineStart;
  const lineEnd = ref.lineEnd;
  const linePart = lineStart
    ? `:${lineStart}${lineEnd && lineEnd !== lineStart ? `-${lineEnd}` : ''}`
    : '';
  const symbol = normalizeSingleLineText(ref.symbol);
  const symbolPart = symbol ? `#${symbol}` : '';
  return `${path}${linePart}${symbolPart}`;
}

export function getV4BodySectionOrder(locale: ReviewDocumentLocale): string[] {
  const headings = getReviewSectionHeadings(locale);
  return [
    headings.scope,
    headings.summary,
    headings.findings,
    headings.milestones,
    headings.finalConclusion,
    headings.snapshot
  ];
}

export function getDisplayMilestoneStatus(status: ReviewMilestoneStatus, locale: ReviewDocumentLocale): string {
  const values = getReviewDocumentMessages(locale).values.milestoneStatus;
  return status === 'completed' ? values.completed : values.inProgress;
}

export function getDisplayOverallDecision(
  decision: ReviewOverallDecision | null | undefined,
  locale: ReviewDocumentLocale
): string {
  const values = getReviewDocumentMessages(locale).values.overallDecision;
  if (!decision) return values.pending;
  switch (decision) {
    case 'accepted':
      return values.accepted;
    case 'conditionally_accepted':
      return values.conditionallyAccepted;
    case 'rejected':
      return values.rejected;
    case 'needs_follow_up':
      return values.needsFollowUp;
    default:
      return values.pending;
  }
}

export function getDisplaySeverity(severity: ReviewFindingSeverity, locale: ReviewDocumentLocale): string {
  return getReviewDocumentMessages(locale).values.severity[severity];
}

export function getDisplayCategory(category: ReviewFindingCategory, locale: ReviewDocumentLocale): string {
  return getReviewDocumentMessages(locale).values.category[category];
}

export function getDisplayTrackingStatus(status: ReviewFindingTrackingStatus, locale: ReviewDocumentLocale): string {
  const values = getReviewDocumentMessages(locale).values.trackingStatus;
  switch (status) {
    case 'accepted_risk':
      return values.acceptedRisk;
    case 'fixed':
      return values.fixed;
    case 'wont_fix':
      return values.wontFix;
    case 'duplicate':
      return values.duplicate;
    default:
      return values.open;
  }
}

function getPendingText(locale: ReviewDocumentLocale): string {
  return getReviewDocumentMessages(locale).values.pending;
}

export function getLocalizedDefaultReviewScope(locale: ReviewDocumentLocale): string {
  return getReviewDocumentMessages(locale).placeholders.defaultReviewScope;
}

export function getLocalizedDefaultFinalConclusion(locale: ReviewDocumentLocale): string {
  return getReviewDocumentMessages(locale).placeholders.defaultFinalConclusion;
}

export function getLocalizedNoFindingsPlaceholder(locale: ReviewDocumentLocale): string {
  const placeholder = getReviewDocumentMessages(locale).placeholders.noFindings;
  return placeholder || NO_FINDINGS_PLACEHOLDER;
}

export function getLocalizedNoMilestonesPlaceholder(locale: ReviewDocumentLocale): string {
  const placeholder = getReviewDocumentMessages(locale).placeholders.noMilestones;
  return placeholder || NO_MILESTONES_PLACEHOLDER;
}

export function formatFindingsBySeverity(counts: Record<ReviewFindingSeverity, number>, locale: ReviewDocumentLocale): string {
  return applyTemplate(getReviewDocumentMessages(locale).templates.findingsBySeverity, {
    high: counts.high,
    medium: counts.medium,
    low: counts.low
  });
}

export function joinDisplayList(items: string[], locale: ReviewDocumentLocale): string {
  return items.length > 0 ? items.join(', ') : getPendingText(locale);
}

export function formatSingleLineValue(value: string | null | undefined, locale: ReviewDocumentLocale): string {
  return normalizeSingleLineText(value) || getPendingText(locale);
}

export function formatFindingSummaryText(input: ReviewFindingInput, locale?: ReviewDocumentLocale): string {
  const title = normalizeSingleLineText(input.title);
  const severity = normalizeFindingSeverity(input.severity);
  const category = normalizeFindingCategory(input.category);
  if (locale) {
    return `[${getDisplaySeverity(severity, locale)}] ${getDisplayCategory(category, locale)}: ${title}`;
  }
  return `[${severity}] ${category}: ${title}`;
}
