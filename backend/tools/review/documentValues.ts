/** 审查条目、证据与标识的归一化；不依赖文档渲染。 */

import { normalizeLineEndingsToLF as normalizeLineEndings, normalizeSingleLineText } from '../shared/textUtils';
import {
  type ReviewMilestoneStatus,
  type ReviewFindingSeverity,
  type ReviewFindingCategory,
  type ReviewFindingTrackingStatus,
  type ReviewOverallDecision,
  type ReviewEvidenceRef,
  type ReviewFindingInput,
  type ReviewFindingRecord,
  type ReviewFindingRecordV4
} from './schema';
import { createHash } from 'crypto';

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeMarkdownText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return normalizeLineEndings(input).trim();
}

export function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of input) {
    const value = normalizeSingleLineText(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeSingleLineText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export function normalizeMilestoneStatus(value: unknown): ReviewMilestoneStatus {
  return value === 'completed' ? 'completed' : 'in_progress';
}

export function normalizeFindingSeverity(value: unknown): ReviewFindingSeverity {
  return value === 'high' || value === 'medium' ? value : 'low';
}

export function normalizeFindingCategory(value: unknown): ReviewFindingCategory {
  const normalized = normalizeSingleLineText(value).toLowerCase();
  switch (normalized) {
    case 'html':
    case 'css':
    case 'javascript':
    case 'js':
      return normalized === 'js' ? 'javascript' : (normalized as ReviewFindingCategory);
    case 'accessibility':
    case 'performance':
    case 'maintainability':
    case 'docs':
    case 'test':
      return normalized as ReviewFindingCategory;
    default:
      return 'other';
  }
}

export function normalizeFindingTrackingStatus(value: unknown): ReviewFindingTrackingStatus {
  return value === 'accepted_risk'
    || value === 'fixed'
    || value === 'wont_fix'
    || value === 'duplicate'
    ? value
    : 'open';
}

export function normalizeOverallDecision(value: unknown): ReviewOverallDecision | undefined {
  return value === 'accepted'
    || value === 'conditionally_accepted'
    || value === 'rejected'
    || value === 'needs_follow_up'
    ? value
    : undefined;
}

export function normalizeNullableMarkdown(value: unknown): string | null {
  const normalized = normalizeMarkdownText(value);
  return normalized || null;
}

export function formatDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function formatDateTime(date: Date = new Date()): string {
  return date.toISOString();
}

export function parseDateToIsoStart(dateText: string): string {
  const value = normalizeSingleLineText(dateText);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00.000Z`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? formatDateTime() : parsed.toISOString();
}

function sanitizeIdFragment(input: string, fallback: string): string {
  const normalized = normalizeSingleLineText(input)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return normalized || fallback;
}

function normalizeComparableReviewText(value: string): string {
  return normalizeSingleLineText(value)
    .replace(/[`*_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isFindingTitleNotConcise(title: string): boolean {
  const normalized = normalizeSingleLineText(title);
  if (!normalized) return false;

  const hasFileReference = /`[^`]+\.[^`]*:\d[^`]*`/.test(normalized)
    || /(?:^|\s)[^`\s]+?\.[a-z0-9_-]+:\d[\d,-]*/i.test(normalized);
  const hasClauseSeparator = /[，；]|,\s|;\s|:\s|：/.test(normalized);
  const hasRecommendationCue = /(建议|应统一|应改|需要|推荐|recommend|recommended|should|needs to|follow-up|べき|必要)/i.test(normalized);

  return (hasFileReference && (normalized.length > 24 || hasClauseSeparator || hasRecommendationCue))
    || (normalized.length > 64 && (hasClauseSeparator || hasRecommendationCue));
}

export function isFindingTitleRepeatingDescription(title: string, description?: string | null): boolean {
  const normalizedTitle = normalizeComparableReviewText(title).replace(/[。.!?]+$/g, '');
  const normalizedDescription = normalizeComparableReviewText(description || '').replace(/[。.!?]+$/g, '');
  if (!normalizedTitle || !normalizedDescription || normalizedTitle.length < 24) {
    return false;
  }
  return normalizedTitle === normalizedDescription
    || normalizedDescription.startsWith(normalizedTitle)
    || normalizedTitle.startsWith(normalizedDescription);
}

function buildFindingIdBase(preferredTitle: string, category: ReviewFindingCategory, indexHint: number): string {
  const titleBase = sanitizeIdFragment(preferredTitle, '');
  const categoryBase = sanitizeIdFragment(category, 'finding');
  if (!titleBase || titleBase.length > 32 || isFindingTitleNotConcise(preferredTitle)) {
    return `${categoryBase}-${indexHint}`;
  }
  return titleBase;
}

export function nextFindingId(existingIds: Set<string>, preferredTitle: string, category: ReviewFindingCategory, indexHint: number): string {
  const base = buildFindingIdBase(preferredTitle, category, indexHint);
  let candidate = `F-${base}`;
  let cursor = 2;
  while (existingIds.has(candidate)) {
    candidate = `F-${base}-${cursor}`;
    cursor += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

export function nextMilestoneId(existingIds: Set<string>, indexHint: number): string {
  let candidate = `M${indexHint}`;
  let cursor = indexHint + 1;
  while (existingIds.has(candidate)) {
    candidate = `M${cursor}`;
    cursor += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function parseOptionalInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const int = Math.trunc(value);
    return int > 0 ? int : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function serializeEvidenceRefKey(ref: ReviewEvidenceRef): string {
  return [
    normalizeSingleLineText(ref.path),
    ref.lineStart ?? '',
    ref.lineEnd ?? '',
    normalizeSingleLineText(ref.symbol),
    normalizeSingleLineText(ref.excerptHash)
  ].join('|');
}

export function normalizeEvidenceRefs(input: unknown): ReviewEvidenceRef[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: ReviewEvidenceRef[] = [];

  for (const item of input) {
    if (typeof item === 'string') {
      const path = normalizeSingleLineText(item);
      if (!path) continue;
      const ref: ReviewEvidenceRef = { path };
      const key = serializeEvidenceRefKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(ref);
      continue;
    }

    const record = asRecord(item);
    if (!record) continue;
    const path = normalizeSingleLineText(record.path);
    if (!path) continue;
    const ref: ReviewEvidenceRef = {
      path,
      lineStart: parseOptionalInt(record.lineStart),
      lineEnd: parseOptionalInt(record.lineEnd),
      symbol: normalizeSingleLineText(record.symbol) || undefined,
      excerptHash: normalizeSingleLineText(record.excerptHash) || undefined
    };
    const key = serializeEvidenceRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }

  return result;
}

export function mergeEvidenceRefs(existing: ReviewEvidenceRef[], incoming: ReviewEvidenceRef[]): ReviewEvidenceRef[] {
  return normalizeEvidenceRefs([...existing, ...incoming]);
}

export function evidenceFilesToRefs(evidenceFiles: unknown): ReviewEvidenceRef[] {
  return normalizeEvidenceRefs(normalizeStringList(evidenceFiles));
}

export function evidenceRefsToFiles(evidence: ReviewEvidenceRef[]): string[] {
  return uniqueStrings(evidence.map((item) => item.path));
}

export function normalizeFindingInput(
  input: ReviewFindingInput,
  fallbackMilestoneId?: string,
  fallbackEvidenceFiles?: string[]
): ReviewFindingInput {
  const fallbackEvidence = evidenceFilesToRefs(fallbackEvidenceFiles);
  const evidence = mergeEvidenceRefs(normalizeEvidenceRefs(input.evidence), fallbackEvidence);
  const evidenceFiles = uniqueStrings([
    ...normalizeStringList(input.evidenceFiles),
    ...evidenceRefsToFiles(normalizeEvidenceRefs(input.evidence)),
    ...evidenceRefsToFiles(fallbackEvidence),
    ...normalizeStringList(fallbackEvidenceFiles)
  ]);
  const relatedMilestoneIds = uniqueStrings([
    ...normalizeStringList(input.relatedMilestoneIds),
    ...(fallbackMilestoneId ? [fallbackMilestoneId] : [])
  ]);

  return {
    id: normalizeSingleLineText(input.id),
    severity: normalizeFindingSeverity(input.severity),
    category: normalizeFindingCategory(input.category),
    title: normalizeSingleLineText(input.title),
    description: normalizeMarkdownText(input.description),
    evidenceFiles,
    evidence,
    relatedMilestoneIds,
    recommendation: normalizeMarkdownText(input.recommendation),
    trackingStatus: normalizeFindingTrackingStatus(input.trackingStatus)
  };
}

export function convertLegacyFindingToStructured(
  text: string,
  milestoneId?: string,
  evidenceFiles?: string[]
): ReviewFindingInput {
  return normalizeFindingInput(
    {
      title: normalizeSingleLineText(text),
      severity: 'low',
      category: 'other',
      trackingStatus: 'open'
    },
    milestoneId,
    evidenceFiles
  );
}

function metadataFindingToInput(record: ReviewFindingRecord): ReviewFindingInput {
  return {
    id: record.id,
    severity: record.severity,
    category: record.category,
    title: record.title,
    description: record.description || undefined,
    evidenceFiles: [...record.evidenceFiles],
    evidence: evidenceFilesToRefs(record.evidenceFiles),
    relatedMilestoneIds: [...record.relatedMilestoneIds],
    recommendation: record.recommendation || undefined,
    trackingStatus: 'open'
  };
}

export function snapshotFindingToInput(record: ReviewFindingRecordV4): ReviewFindingInput {
  return {
    id: record.id,
    severity: record.severity,
    category: record.category,
    title: record.title,
    description: record.descriptionMarkdown || undefined,
    evidenceFiles: evidenceRefsToFiles(record.evidence),
    evidence: [...record.evidence],
    relatedMilestoneIds: [...record.relatedMilestoneIds],
    recommendation: record.recommendationMarkdown || undefined,
    trackingStatus: record.trackingStatus
  };
}

function getFindingMergeKey(input: ReviewFindingInput): string {
  const id = normalizeSingleLineText(input.id);
  if (id) return `id:${id}`;
  return [
    normalizeFindingSeverity(input.severity),
    normalizeFindingCategory(input.category),
    normalizeSingleLineText(input.title).toLowerCase()
  ].join('|');
}

function normalizeFindingRecordV4(
  input: ReviewFindingInput,
  existingIds: Set<string>,
  preferredId?: string,
  indexHint: number = existingIds.size + 1
): ReviewFindingRecordV4 {
  const normalized = normalizeFindingInput(input);
  const category = normalizeFindingCategory(normalized.category);
  const requestedId = normalizeSingleLineText(preferredId || normalized.id);
  const id = requestedId || nextFindingId(existingIds, normalized.title, category, indexHint);
  existingIds.add(id);

  return {
    id,
    severity: normalizeFindingSeverity(normalized.severity),
    category,
    title: normalizeSingleLineText(normalized.title),
    descriptionMarkdown: normalizeNullableMarkdown(normalized.description),
    recommendationMarkdown: normalizeNullableMarkdown(normalized.recommendation),
    evidence: mergeEvidenceRefs(normalizeEvidenceRefs(normalized.evidence), evidenceFilesToRefs(normalized.evidenceFiles)),
    relatedMilestoneIds: normalizeStringList(normalized.relatedMilestoneIds),
    trackingStatus: normalizeFindingTrackingStatus(normalized.trackingStatus)
  };
}

export function mergeFindingRecords(
  existing: ReviewFindingRecordV4[],
  incoming: ReviewFindingInput[]
): { findings: ReviewFindingRecordV4[]; addedFindingIds: string[] } {
  const merged = new Map<string, ReviewFindingInput>();
  const existingByKey = new Map<string, ReviewFindingRecordV4>();

  for (const current of existing) {
    const input = snapshotFindingToInput(current);
    const key = getFindingMergeKey(input);
    merged.set(key, input);
    existingByKey.set(key, current);
  }

  for (const item of incoming) {
    const normalized = normalizeFindingInput(item);
    if (!normalized.title) continue;

    const key = getFindingMergeKey(normalized);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, normalized);
      continue;
    }

    merged.set(key, {
      id: current.id || normalized.id,
      severity: current.severity || normalized.severity,
      category: current.category || normalized.category,
      title: current.title || normalized.title,
      description: (normalized.description || '').length > (current.description || '').length
        ? normalized.description
        : current.description,
      evidenceFiles: uniqueStrings([...(current.evidenceFiles || []), ...(normalized.evidenceFiles || [])]),
      evidence: mergeEvidenceRefs(normalizeEvidenceRefs(current.evidence), normalizeEvidenceRefs(normalized.evidence)),
      relatedMilestoneIds: uniqueStrings([...(current.relatedMilestoneIds || []), ...(normalized.relatedMilestoneIds || [])]),
      recommendation: current.recommendation || normalized.recommendation,
      trackingStatus: current.trackingStatus || normalized.trackingStatus || 'open'
    });
  }

  const usedIds = new Set<string>();
  const addedFindingIds: string[] = [];
  const findings = Array.from(merged.entries()).map(([key, input], index) => {
    const matchedExisting = existingByKey.get(key)
      || existing.find((current) => current.id === normalizeSingleLineText(input.id));
    const record = normalizeFindingRecordV4(input, usedIds, matchedExisting?.id || input.id, index + 1);
    if (!matchedExisting) {
      addedFindingIds.push(record.id);
    }
    return record;
  });

  return { findings, addedFindingIds };
}

export function countFindingsBySeverity(findings: Array<ReviewFindingInput | ReviewFindingRecord | ReviewFindingRecordV4>): Record<ReviewFindingSeverity, number> {
  const counts: Record<ReviewFindingSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0
  };

  for (const finding of findings) {
    counts[normalizeFindingSeverity((finding as ReviewFindingInput).severity)] += 1;
  }

  return counts;
}

export function normalizeHeadingToken(heading: string): string {
  return normalizeSingleLineText(heading)
    .toLowerCase()
    .replace(/[\s\-_:：，,.()（）\[\]【】'"`]+/g, '');
}
