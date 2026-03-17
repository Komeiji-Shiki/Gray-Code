/**
 * Review 文档固定区块处理工具
 */

export type ReviewMilestoneStatus = 'in_progress' | 'completed';
export type ReviewFindingSeverity = 'high' | 'medium' | 'low';
export type ReviewFindingCategory =
  | 'html'
  | 'css'
  | 'javascript'
  | 'accessibility'
  | 'performance'
  | 'maintainability'
  | 'docs'
  | 'test'
  | 'other';
export type ReviewOverallDecision = 'accepted' | 'conditionally_accepted' | 'rejected' | 'needs_follow_up';
export type ReviewDocumentFormat = 'unknown' | 'v2' | 'v3';

export interface ReviewFindingInput {
  id?: string;
  severity?: ReviewFindingSeverity;
  category?: ReviewFindingCategory;
  title: string;
  description?: string;
  evidenceFiles?: string[];
  relatedMilestoneIds?: string[];
  recommendation?: string;
}

export interface ReviewMilestoneInput {
  milestoneId?: string;
  milestoneTitle: string;
  summary: string;
  status?: ReviewMilestoneStatus;
  conclusion?: string;
  evidenceFiles?: string[];
  findings?: string[];
  structuredFindings?: ReviewFindingInput[];
  reviewedModules?: string[];
  recommendedNextAction?: string;
  recordedAt?: string;
}

export interface ReviewFinalizeInput {
  conclusion: string;
  overallDecision?: ReviewOverallDecision;
  recommendedNextAction?: string;
  reviewedModules?: string[];
}

export interface ReviewDocumentTemplateInput {
  title?: string;
  overview?: string;
  review: string;
  date?: string;
}

export interface ReviewSummarySectionInput {
  currentStatus?: ReviewMilestoneStatus;
  reviewedModules?: string[];
  currentProgress?: string;
  totalMilestones?: number;
  completedMilestones?: number;
  totalFindings?: number;
  findingsBySeverity?: Partial<Record<ReviewFindingSeverity, number>>;
  latestConclusion?: string;
  recommendedNextAction?: string;
  overallDecision?: ReviewOverallDecision;
}

interface ReviewHeaderMetadata {
  title: string;
  date: string;
  overview: string;
  status: ReviewMilestoneStatus;
  overallDecision?: ReviewOverallDecision;
}

interface ParsedSection {
  heading: string;
  body: string;
}

interface ParsedReviewSummary {
  currentStatus?: ReviewMilestoneStatus;
  reviewedModules: string[];
  currentProgress?: string;
  totalMilestones?: number;
  completedMilestones?: number;
  totalFindings?: number;
  findingsBySeverity?: Partial<Record<ReviewFindingSeverity, number>>;
  latestConclusion?: string;
  recommendedNextAction?: string;
  overallDecision?: ReviewOverallDecision;
}

export interface ReviewMilestoneRecord {
  id: string;
  title: string;
  summary: string;
  status: ReviewMilestoneStatus;
  conclusion: string | null;
  evidenceFiles: string[];
  reviewedModules: string[];
  recommendedNextAction: string | null;
  recordedAt: string;
  findingIds: string[];
}

export interface ReviewFindingRecord {
  id: string;
  severity: ReviewFindingSeverity;
  category: ReviewFindingCategory;
  title: string;
  description: string | null;
  evidenceFiles: string[];
  relatedMilestoneIds: string[];
  recommendation: string | null;
}

export interface ReviewDocumentMetadataV3 {
  formatVersion: 3;
  reviewRunId: string;
  createdAt: string;
  finalizedAt: string | null;
  status: ReviewMilestoneStatus;
  overallDecision: ReviewOverallDecision | null;
  latestConclusion: string | null;
  recommendedNextAction: string | null;
  reviewedModules: string[];
  milestones: ReviewMilestoneRecord[];
  findings: ReviewFindingRecord[];
}

export interface ReviewValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ReviewValidationResult {
  detectedFormat: ReviewDocumentFormat;
  formatVersion: number | null;
  isValid: boolean;
  canAutoUpgrade: boolean;
  issues: ReviewValidationIssue[];
  metadata?: ReviewDocumentMetadataV3;
}

export interface ReviewDocumentSummarySnapshot {
  title: string;
  date: string;
  overview: string;
  status: ReviewMilestoneStatus;
  overallDecision: ReviewOverallDecision | null;
  totalMilestones: number;
  completedMilestones: number;
  currentProgress: string;
  reviewedModules: string[];
  totalFindings: number;
  findingsBySeverity: Record<ReviewFindingSeverity, number>;
  latestConclusion: string | null;
  recommendedNextAction: string | null;
}

interface ReviewDocumentV3State {
  header: ReviewHeaderMetadata;
  scope: string;
  metadata: ReviewDocumentMetadataV3;
  detectedFormat: ReviewDocumentFormat;
}

interface ParsedLegacyMilestone {
  id: string;
  title: string;
  summary: string;
  status: ReviewMilestoneStatus;
  conclusion: string | null;
  evidenceFiles: string[];
  reviewedModules: string[];
  recommendedNextAction: string | null;
  recordedAt: string;
  findingTexts: string[];
}

export const REVIEW_SCOPE_SECTION_TITLE = '## Review Scope';
export const REVIEW_SUMMARY_SECTION_TITLE = '## Review Summary';
export const REVIEW_SUMMARY_START = '<!-- LIMCODE_REVIEW_SUMMARY_START -->';
export const REVIEW_SUMMARY_END = '<!-- LIMCODE_REVIEW_SUMMARY_END -->';

export const REVIEW_FINDINGS_SECTION_TITLE = '## Review Findings';
export const REVIEW_FINDINGS_START = '<!-- LIMCODE_REVIEW_FINDINGS_START -->';
export const REVIEW_FINDINGS_END = '<!-- LIMCODE_REVIEW_FINDINGS_END -->';

export const REVIEW_MILESTONES_SECTION_TITLE = '## Review Milestones';
export const REVIEW_MILESTONES_START = '<!-- LIMCODE_REVIEW_MILESTONES_START -->';
export const REVIEW_MILESTONES_END = '<!-- LIMCODE_REVIEW_MILESTONES_END -->';

export const REVIEW_METADATA_START = '<!-- LIMCODE_REVIEW_METADATA_START -->';
export const REVIEW_METADATA_END = '<!-- LIMCODE_REVIEW_METADATA_END -->';

const NO_MILESTONES_PLACEHOLDER = '<!-- no milestones -->';
const NO_FINDINGS_PLACEHOLDER = '<!-- no findings -->';
const DEFAULT_REVIEW_SCOPE = '_Review scope not provided._';
const REVIEW_MILESTONE_HEADING_REGEX = /^###\s+([^\s]+)\s+·\s+(.+)$/gm;
const CANONICAL_SECTION_ORDER = [
  REVIEW_SCOPE_SECTION_TITLE,
  REVIEW_SUMMARY_SECTION_TITLE,
  REVIEW_FINDINGS_SECTION_TITLE,
  REVIEW_MILESTONES_SECTION_TITLE
];

function normalizeLineEndings(text: string): string {
  return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSingleLineText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeMarkdownText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return normalizeLineEndings(input).trim();
}

function normalizeStringList(input: unknown): string[] {
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

function uniqueStrings(values: string[]): string[] {
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

function normalizeMilestoneStatus(value: unknown): ReviewMilestoneStatus {
  return value === 'completed' ? 'completed' : 'in_progress';
}

function normalizeFindingSeverity(value: unknown): ReviewFindingSeverity {
  return value === 'high' || value === 'medium' ? value : 'low';
}

function normalizeFindingCategory(value: unknown): ReviewFindingCategory {
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

function normalizeOverallDecision(value: unknown): ReviewOverallDecision | undefined {
  return value === 'accepted' || value === 'conditionally_accepted' || value === 'rejected' || value === 'needs_follow_up'
    ? value
    : undefined;
}

function formatDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function formatDateTime(date: Date = new Date()): string {
  return date.toISOString();
}

function createReviewRunId(date: Date = new Date()): string {
  return `review-${date.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSection(title: string, startMarker: string, endMarker: string, body: string): string {
  return [title, startMarker, body || '', endMarker].join('\n');
}

function findSectionRange(content: string, startMarker: string, endMarker: string): { start: number; bodyStart: number; endStart: number; end: number } | null {
  const start = content.indexOf(startMarker);
  const endStart = start >= 0 ? content.indexOf(endMarker, start + startMarker.length) : -1;
  if (start < 0 || endStart < 0 || endStart < start) return null;

  return {
    start,
    bodyStart: start + startMarker.length,
    endStart,
    end: endStart + endMarker.length
  };
}

function extractSectionBlock(content: string, title: string, startMarker: string, endMarker: string): string {
  const normalized = normalizeLineEndings(content);
  const titlePattern = new RegExp(`^${escapeRegExp(title)}\\s*$`, 'm');
  const titleMatch = titlePattern.exec(normalized);
  if (!titleMatch || typeof titleMatch.index !== 'number') return '';

  const range = findSectionRange(normalized, startMarker, endMarker);
  if (!range) return '';

  return normalized.slice(titleMatch.index, range.end).trim();
}

function parseH2Sections(content: string): ParsedSection[] {
  const normalized = normalizeLineEndings(content);
  const matches = Array.from(normalized.matchAll(/^##\s+(.+)$/gm));
  if (matches.length === 0) return [];

  const sections: ParsedSection[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const nextMatch = matches[i + 1];
    const start = match.index ?? 0;
    const end = nextMatch?.index ?? normalized.length;
    const heading = normalizeSingleLineText(match[1]);
    const lineEnd = normalized.indexOf('\n', start);
    const bodyStart = lineEnd >= 0 ? lineEnd + 1 : end;
    const body = normalized.slice(bodyStart, end).trim();
    sections.push({ heading, body });
  }

  return sections;
}

function normalizeHeadingToken(heading: string): string {
  return normalizeSingleLineText(heading).toLowerCase().replace(/[\s\-_:：，,.()（）\[\]【】'"`]+/g, '');
}

function isScopeHeading(heading: string): boolean {
  const token = normalizeHeadingToken(heading);
  return [
    'reviewscope',
    'scope',
    'reviewplan',
    'plan',
    '审查范围',
    '评审范围',
    '审查计划',
    '评审计划'
  ].includes(token);
}

function isSummaryHeading(heading: string): boolean {
  const token = normalizeHeadingToken(heading);
  return ['reviewsummary', 'summary', '审查摘要', '评审摘要', '总结'].includes(token);
}

function isFindingsHeading(heading: string): boolean {
  const token = normalizeHeadingToken(heading);
  return ['reviewfindings', 'findings', '审查发现', '评审发现', '问题', '发现'].includes(token);
}

function isMilestonesHeading(heading: string): boolean {
  const token = normalizeHeadingToken(heading);
  return ['reviewmilestones', 'milestones', '审查里程碑', '评审里程碑', '里程碑'].includes(token);
}

function demoteSectionIntoScope(heading: string, body: string): string {
  const normalizedHeading = normalizeSingleLineText(heading);
  const normalizedBody = normalizeMarkdownText(body);
  if (!normalizedHeading) return normalizedBody;
  if (!normalizedBody) return `### ${normalizedHeading}`;
  return `### ${normalizedHeading}\n${normalizedBody}`;
}

function isChineseText(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function formatScopeStatusValue(label: string, status: ReviewMilestoneStatus): string {
  if (isChineseText(label)) {
    return status === 'completed' ? '已完成' : '进行中';
  }

  return status;
}

function formatScopeConclusionText(heading: string, metadata: ReviewDocumentMetadataV3): string {
  if (metadata.latestConclusion) {
    return metadata.latestConclusion;
  }

  if (isChineseText(heading)) {
    return '尚在评审中，待完成各模块检查后汇总结论。';
  }

  return 'Review is still in progress. Final conclusion will be added after all reviewed modules are checked.';
}

function isSyncableScopeConclusionHeading(line: string): boolean {
  const match = /^#{1,6}\s+(.+)$/.exec(line.trim());
  if (!match) return false;

  return ['初始结论', '当前结论', 'reviewconclusion', 'currentconclusion'].includes(normalizeHeadingToken(match[1]));
}

function synchronizeReviewScope(scope: string, metadata: ReviewDocumentMetadataV3): string {
  const normalized = normalizeMarkdownText(scope) || DEFAULT_REVIEW_SCOPE;
  let next = normalized.replace(/^(\s*-\s*)(Status|状态)\s*([:：])\s*.*$/gm, (_match, prefix: string, label: string, delimiter: string) => {
    const spacing = delimiter === '：' ? '' : ' ';
    return `${prefix}${label}${delimiter}${spacing}${formatScopeStatusValue(label, metadata.status)}`;
  });

  const lines = next.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!isSyncableScopeConclusionHeading(lines[index])) {
      continue;
    }

    let bodyStart = index + 1;
    while (bodyStart < lines.length && !lines[bodyStart].trim()) {
      bodyStart += 1;
    }

    let bodyEnd = bodyStart;
    while (bodyEnd < lines.length && !/^#{1,6}\s+/.test(lines[bodyEnd].trim())) {
      bodyEnd += 1;
    }

    const replacement = formatScopeConclusionText(lines[index], metadata);
    lines.splice(index + 1, bodyEnd - (index + 1), ...(replacement ? [replacement] : []));
    next = lines.join('\n');
    break;
  }

  return normalizeMarkdownText(next) || DEFAULT_REVIEW_SCOPE;
}

function parseHeaderMetadata(content: string): ReviewHeaderMetadata {
  const normalized = normalizeLineEndings(content);
  const titleMatch = /^#\s+(.+)$/m.exec(normalized);
  const dateMatch = /^- Date:\s*(.+)$/m.exec(normalized);
  const overviewMatch = /^- Overview:\s*(.+)$/m.exec(normalized);
  const statusMatch = /^- Status:\s*(.+)$/m.exec(normalized);
  const overallDecisionMatch = /^- Overall decision:\s*(.+)$/mi.exec(normalized);

  return {
    title: normalizeSingleLineText(titleMatch?.[1]) || 'Review',
    date: normalizeSingleLineText(dateMatch?.[1]) || formatDate(),
    overview: normalizeSingleLineText(overviewMatch?.[1]) || 'Workspace review',
    status: normalizeMilestoneStatus(statusMatch?.[1]),
    overallDecision: normalizeOverallDecision(overallDecisionMatch?.[1])
  };
}

function extractLooseHeaderContent(content: string): string {
  const normalized = normalizeLineEndings(content).replace(
    new RegExp(`${escapeRegExp(REVIEW_METADATA_START)}[\\s\\S]*?${escapeRegExp(REVIEW_METADATA_END)}\\s*`, 'g'),
    ''
  );
  const firstSectionMatch = /^##\s+/m.exec(normalized);
  const headerBlock = firstSectionMatch ? normalized.slice(0, firstSectionMatch.index).trim() : normalized.trim();
  if (!headerBlock) return '';

  const cleanedLines = headerBlock
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^#\s+/.test(trimmed)) return false;
      if (/^- Date:\s*/.test(trimmed)) return false;
      if (/^- Overview:\s*/.test(trimmed)) return false;
      if (/^- Status:\s*/.test(trimmed)) return false;
      if (/^- Overall decision:\s*/i.test(trimmed)) return false;
      return true;
    });

  return cleanedLines.join('\n').trim();
}

function extractLegacyFindingStrings(body: string): string[] {
  return normalizeLineEndings(body)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => normalizeSingleLineText(line.replace(/^[-*]\s+/, '')))
    .filter(Boolean);
}

function extractLegacySummaryBody(content: string): string {
  const sections = parseH2Sections(content);
  const section = sections.find((item) => isSummaryHeading(item.heading));
  return normalizeMarkdownText(section?.body || '');
}

function extractLegacyFindings(content: string): string[] {
  const sections = parseH2Sections(content);
  const findings: string[] = [];
  for (const section of sections) {
    if (!isFindingsHeading(section.heading)) continue;
    findings.push(...extractLegacyFindingStrings(section.body));
  }
  return uniqueStrings(findings);
}

export function extractInitialReviewScope(content: string): string {
  const normalized = normalizeLineEndings(content);
  const sections = parseH2Sections(normalized);
  const hasSummaryMarkers = !!findSectionRange(normalized, REVIEW_SUMMARY_START, REVIEW_SUMMARY_END);
  const hasFindingsMarkers = !!findSectionRange(normalized, REVIEW_FINDINGS_START, REVIEW_FINDINGS_END);
  const hasMilestoneMarkers = !!findSectionRange(normalized, REVIEW_MILESTONES_START, REVIEW_MILESTONES_END);

  const scopeParts: string[] = [];
  const looseHeader = extractLooseHeaderContent(normalized);
  if (looseHeader) {
    scopeParts.push(looseHeader);
  }

  for (const section of sections) {
    if (isScopeHeading(section.heading)) {
      const body = normalizeMarkdownText(section.body);
      if (body) scopeParts.push(body);
      continue;
    }

    if (isSummaryHeading(section.heading)) {
      if (!hasSummaryMarkers) {
        const body = normalizeMarkdownText(section.body);
        if (body) scopeParts.push(demoteSectionIntoScope(section.heading, body));
      }
      continue;
    }

    if (isFindingsHeading(section.heading)) {
      if (!hasFindingsMarkers) {
        const body = normalizeMarkdownText(section.body);
        if (body && extractLegacyFindingStrings(body).length === 0) {
          scopeParts.push(demoteSectionIntoScope(section.heading, body));
        }
      }
      continue;
    }

    if (isMilestonesHeading(section.heading)) {
      if (!hasMilestoneMarkers) {
        const body = normalizeMarkdownText(section.body);
        if (body) scopeParts.push(demoteSectionIntoScope(section.heading, body));
      }
      continue;
    }

    const body = normalizeMarkdownText(section.body);
    if (body || section.heading) {
      scopeParts.push(demoteSectionIntoScope(section.heading, body));
    }
  }

  const scope = scopeParts.filter(Boolean).join('\n\n').trim();
  return scope || DEFAULT_REVIEW_SCOPE;
}

function countOccurrences(content: string, token: string): number {
  return Array.from(content.matchAll(new RegExp(escapeRegExp(token), 'g'))).length;
}

function detectCanonicalSectionOrder(content: string): boolean {
  const indices = CANONICAL_SECTION_ORDER.map((title) => content.indexOf(title));
  if (indices.some((index) => index < 0)) return false;
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] <= indices[i - 1]) return false;
  }
  return true;
}

function parseDateToIsoStart(dateText: string): string {
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

function nextFindingId(existingIds: Set<string>, preferredTitle: string, indexHint: number): string {
  const base = sanitizeIdFragment(preferredTitle, `finding-${indexHint}`);
  let candidate = `F-${base}`;
  let cursor = 2;
  while (existingIds.has(candidate)) {
    candidate = `F-${base}-${cursor}`;
    cursor += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

function metadataFindingToInput(record: ReviewFindingRecord): ReviewFindingInput {
  return {
    id: record.id,
    severity: record.severity,
    category: record.category,
    title: record.title,
    description: record.description || undefined,
    evidenceFiles: [...record.evidenceFiles],
    relatedMilestoneIds: [...record.relatedMilestoneIds],
    recommendation: record.recommendation || undefined
  };
}

function normalizeReviewFinding(input: ReviewFindingInput, fallbackMilestoneId?: string, fallbackEvidenceFiles?: string[]): ReviewFindingInput {
  const evidenceFiles = uniqueStrings([
    ...normalizeStringList(input.evidenceFiles),
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
    description: normalizeSingleLineText(input.description),
    evidenceFiles,
    relatedMilestoneIds,
    recommendation: normalizeSingleLineText(input.recommendation)
  };
}

function convertLegacyFindingToStructured(text: string, milestoneId?: string, evidenceFiles?: string[]): ReviewFindingInput {
  return normalizeReviewFinding(
    {
      title: normalizeSingleLineText(text),
      severity: 'low',
      category: 'other'
    },
    milestoneId,
    evidenceFiles
  );
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

function formatFindingSummaryText(input: ReviewFindingInput): string {
  const title = normalizeSingleLineText(input.title);
  const severity = normalizeFindingSeverity(input.severity);
  const category = normalizeFindingCategory(input.category);
  return `[${severity}] ${category}: ${title}`;
}

function mergeReviewFindings(existing: ReviewFindingInput[], incoming: ReviewFindingInput[]): ReviewFindingInput[] {
  const merged = new Map<string, ReviewFindingInput>();

  for (const item of [...existing, ...incoming]) {
    const normalized = normalizeReviewFinding(item);
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
      description: (normalized.description || '').length > (current.description || '').length ? normalized.description : current.description,
      evidenceFiles: uniqueStrings([...(current.evidenceFiles || []), ...(normalized.evidenceFiles || [])]),
      relatedMilestoneIds: uniqueStrings([...(current.relatedMilestoneIds || []), ...(normalized.relatedMilestoneIds || [])]),
      recommendation: current.recommendation || normalized.recommendation
    });
  }

  return Array.from(merged.values());
}

function parseStructuredFindingBlock(blockLines: string[]): ReviewFindingInput | null {
  const firstLine = blockLines[0]?.trim() || '';
  const structuredMatch = /^- \[(high|medium|low)\]\s+([^:]+):\s+(.+)$/i.exec(firstLine);
  if (!structuredMatch) {
    const legacyText = normalizeSingleLineText(firstLine.replace(/^-\s+/, ''));
    return legacyText ? convertLegacyFindingToStructured(legacyText) : null;
  }

  const finding: ReviewFindingInput = {
    severity: normalizeFindingSeverity(structuredMatch[1].toLowerCase()),
    category: normalizeFindingCategory(structuredMatch[2]),
    title: normalizeSingleLineText(structuredMatch[3]),
    evidenceFiles: [],
    relatedMilestoneIds: []
  };

  let readingEvidenceFiles = false;
  for (let i = 1; i < blockLines.length; i += 1) {
    const trimmed = blockLines[i].trim();
    if (!trimmed) continue;

    if (/^- ID:\s+/i.test(trimmed)) {
      finding.id = normalizeSingleLineText(trimmed.replace(/^- ID:\s+/i, ''));
      readingEvidenceFiles = false;
      continue;
    }

    if (/^- Description:\s+/i.test(trimmed)) {
      finding.description = normalizeSingleLineText(trimmed.replace(/^- Description:\s+/i, ''));
      readingEvidenceFiles = false;
      continue;
    }

    if (/^- Evidence Files:\s*$/i.test(trimmed)) {
      readingEvidenceFiles = true;
      continue;
    }

    if (readingEvidenceFiles && /^-\s+`.+`$/.test(trimmed)) {
      const file = trimmed.replace(/^-\s+`/, '').replace(/`$/, '');
      finding.evidenceFiles = uniqueStrings([...(finding.evidenceFiles || []), file]);
      continue;
    }

    if (/^- Related Milestones:\s+/i.test(trimmed)) {
      finding.relatedMilestoneIds = uniqueStrings(
        trimmed
          .replace(/^- Related Milestones:\s+/i, '')
          .split(',')
          .map((item) => normalizeSingleLineText(item))
      );
      readingEvidenceFiles = false;
      continue;
    }

    if (/^- Recommendation:\s+/i.test(trimmed)) {
      finding.recommendation = normalizeSingleLineText(trimmed.replace(/^- Recommendation:\s+/i, ''));
      readingEvidenceFiles = false;
      continue;
    }

    readingEvidenceFiles = false;
  }

  return normalizeReviewFinding(finding);
}

function parseReviewFindingsSection(body: string): ReviewFindingInput[] {
  const normalized = normalizeMarkdownText(body);
  if (!normalized || normalized === NO_FINDINGS_PLACEHOLDER) return [];

  const lines = normalizeLineEndings(normalized).split('\n');
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
      }
      currentBlock = [line];
      continue;
    }

    if (currentBlock.length > 0) {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  return blocks
    .map((block) => parseStructuredFindingBlock(block))
    .filter((item): item is ReviewFindingInput => !!item && !!item.title);
}

function normalizeFindingRecord(input: ReviewFindingInput, existingIds: Set<string>, preferredId?: string, indexHint: number = existingIds.size + 1): ReviewFindingRecord {
  const normalized = normalizeReviewFinding(input);
  const requestedId = normalizeSingleLineText(preferredId || normalized.id);
  const id = requestedId || nextFindingId(existingIds, normalized.title, indexHint);
  existingIds.add(id);

  return {
    id,
    severity: normalizeFindingSeverity(normalized.severity),
    category: normalizeFindingCategory(normalized.category),
    title: normalizeSingleLineText(normalized.title),
    description: normalizeSingleLineText(normalized.description) || null,
    evidenceFiles: normalizeStringList(normalized.evidenceFiles),
    relatedMilestoneIds: normalizeStringList(normalized.relatedMilestoneIds),
    recommendation: normalizeSingleLineText(normalized.recommendation) || null
  };
}

function countFindingsBySeverity(findings: Array<ReviewFindingInput | ReviewFindingRecord>): Record<ReviewFindingSeverity, number> {
  const counts: Record<ReviewFindingSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0
  };

  for (const finding of findings) {
    counts[normalizeFindingSeverity(finding.severity)] += 1;
  }

  return counts;
}

export function renderReviewSummarySection(input?: ReviewSummarySectionInput): string {
  const findingsBySeverity = input?.findingsBySeverity || {};
  const reviewedModules = normalizeStringList(input?.reviewedModules);
  const currentStatus = normalizeMilestoneStatus(input?.currentStatus);
  const currentProgress = normalizeSingleLineText(input?.currentProgress) || '0 milestones recorded';
  const totalMilestones = typeof input?.totalMilestones === 'number' && input.totalMilestones >= 0
    ? input.totalMilestones
    : 0;
  const completedMilestones = typeof input?.completedMilestones === 'number' && input.completedMilestones >= 0
    ? input.completedMilestones
    : 0;
  const totalFindings = typeof input?.totalFindings === 'number' && input.totalFindings >= 0
    ? input.totalFindings
    : 0;
  const latestConclusion = normalizeSingleLineText(input?.latestConclusion) || 'pending';
  const recommendedNextAction = normalizeSingleLineText(input?.recommendedNextAction) || 'pending';
  const overallDecision = normalizeOverallDecision(input?.overallDecision) || 'pending';

  return [
    `- Current status: ${currentStatus}`,
    `- Reviewed modules: ${reviewedModules.length > 0 ? reviewedModules.join(', ') : 'pending'}`,
    `- Current progress: ${currentProgress}`,
    `- Total milestones: ${totalMilestones}`,
    `- Completed milestones: ${completedMilestones}`,
    `- Total findings: ${totalFindings}`,
    `- Findings by severity: high ${findingsBySeverity.high || 0} / medium ${findingsBySeverity.medium || 0} / low ${findingsBySeverity.low || 0}`,
    `- Latest conclusion: ${latestConclusion}`,
    `- Recommended next action: ${recommendedNextAction}`,
    `- Overall decision: ${overallDecision}`
  ].join('\n');
}

export function renderReviewFindingsSection(findingsInput?: unknown): string {
  const normalizedFindings = Array.isArray(findingsInput)
    ? findingsInput.flatMap((item, index) => {
        if (typeof item === 'string') {
          return [normalizeFindingRecord(convertLegacyFindingToStructured(item), new Set<string>(), undefined, index + 1)];
        }
        if (item && typeof item === 'object') {
          const asInput = 'severity' in item && 'category' in item && 'title' in item
            ? (item as ReviewFindingInput)
            : metadataFindingToInput(item as ReviewFindingRecord);
          return [normalizeFindingRecord(asInput, new Set<string>(), (item as ReviewFindingRecord)?.id, index + 1)];
        }
        return [];
      })
    : [];

  if (normalizedFindings.length === 0) {
    return NO_FINDINGS_PLACEHOLDER;
  }

  const blocks = normalizedFindings.map((item) => {
    const lines = [`- [${normalizeFindingSeverity(item.severity)}] ${normalizeFindingCategory(item.category)}: ${normalizeSingleLineText(item.title)}`];

    if (normalizeSingleLineText(item.id)) {
      lines.push(`  - ID: ${normalizeSingleLineText(item.id)}`);
    }
    if (normalizeSingleLineText(item.description)) {
      lines.push(`  - Description: ${normalizeSingleLineText(item.description)}`);
    }
    if ((item.evidenceFiles || []).length > 0) {
      lines.push('  - Evidence Files:');
      for (const evidenceFile of normalizeStringList(item.evidenceFiles)) {
        lines.push(`    - \`${evidenceFile}\``);
      }
    }
    if ((item.relatedMilestoneIds || []).length > 0) {
      lines.push(`  - Related Milestones: ${normalizeStringList(item.relatedMilestoneIds).join(', ')}`);
    }
    if (normalizeSingleLineText(item.recommendation)) {
      lines.push(`  - Recommendation: ${normalizeSingleLineText(item.recommendation)}`);
    }

    return lines.join('\n');
  });

  return blocks.join('\n\n');
}

export function renderReviewMilestoneBlock(input: ReviewMilestoneInput | ReviewMilestoneRecord, findingsInput?: Array<ReviewFindingInput | ReviewFindingRecord>): string {
  const isRecord = 'id' in input;
  const milestoneId = normalizeSingleLineText(isRecord ? input.id : input.milestoneId) || 'M1';
  const milestoneTitle = normalizeSingleLineText(isRecord ? input.title : input.milestoneTitle) || milestoneId;
  const summary = normalizeMarkdownText(input.summary) || milestoneTitle;
  const status = normalizeMilestoneStatus(input.status);
  const conclusion = normalizeSingleLineText(isRecord ? input.conclusion : input.conclusion);
  const evidenceFiles = normalizeStringList(input.evidenceFiles);
  const reviewedModules = normalizeStringList(input.reviewedModules);
  const recommendedNextAction = normalizeSingleLineText(input.recommendedNextAction);
  const recordedAt = normalizeSingleLineText(input.recordedAt) || formatDateTime();

  const milestoneFindings = Array.isArray(findingsInput)
    ? findingsInput.flatMap((item) => {
        const inputFinding = typeof item === 'string'
          ? convertLegacyFindingToStructured(item)
          : ('title' in item ? item as ReviewFindingInput : metadataFindingToInput(item as ReviewFindingRecord));
        const relatedMilestones = normalizeStringList(inputFinding.relatedMilestoneIds);
        return relatedMilestones.includes(milestoneId) ? [inputFinding] : [];
      })
    : [];

  const lines: string[] = [
    `### ${milestoneId} · ${milestoneTitle}`,
    `- Status: ${status}`,
    `- Recorded At: ${recordedAt}`
  ];

  if (reviewedModules.length > 0) {
    lines.push(`- Reviewed Modules: ${reviewedModules.join(', ')}`);
  }

  lines.push('- Summary:');
  lines.push(summary);

  if (conclusion) {
    lines.push(`- Conclusion: ${conclusion}`);
  }

  if (evidenceFiles.length > 0) {
    lines.push('- Evidence Files:');
    for (const evidenceFile of evidenceFiles) {
      lines.push(`  - \`${evidenceFile}\``);
    }
  }

  if (recommendedNextAction) {
    lines.push(`- Recommended Next Action: ${recommendedNextAction}`);
  }

  if (milestoneFindings.length > 0) {
    lines.push('- Findings:');
    for (const finding of milestoneFindings) {
      lines.push(`  - ${formatFindingSummaryText(finding)}`);
    }
  }

  return lines.join('\n');
}

export function extractReviewSectionBody(content: string, startMarker: string, endMarker: string): string {
  const normalized = normalizeLineEndings(content);
  const range = findSectionRange(normalized, startMarker, endMarker);
  if (!range) return '';
  return normalized.slice(range.bodyStart, range.endStart).trim();
}

function parseReviewSummarySection(body: string): ParsedReviewSummary {
  const normalized = normalizeMarkdownText(body);
  if (!normalized) {
    return { reviewedModules: [] };
  }

  const getLineValue = (label: string): string => {
    const match = new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, 'mi').exec(normalized);
    return normalizeSingleLineText(match?.[1]);
  };

  const findingsBySeverityText = getLineValue('Findings by severity');
  const findingsBySeverityMatch = /high\s+(\d+)\s*\/\s*medium\s+(\d+)\s*\/\s*low\s+(\d+)/i.exec(findingsBySeverityText);

  return {
    currentStatus: normalizeMilestoneStatus(getLineValue('Current status')),
    reviewedModules: getLineValue('Reviewed modules') && getLineValue('Reviewed modules') !== 'pending'
      ? getLineValue('Reviewed modules').split(',').map((item) => normalizeSingleLineText(item)).filter(Boolean)
      : [],
    currentProgress: getLineValue('Current progress'),
    totalMilestones: Number.parseInt(getLineValue('Total milestones') || '0', 10),
    completedMilestones: Number.parseInt(getLineValue('Completed milestones') || '0', 10),
    totalFindings: Number.parseInt(getLineValue('Total findings') || '0', 10),
    findingsBySeverity: findingsBySeverityMatch
      ? {
          high: Number.parseInt(findingsBySeverityMatch[1], 10),
          medium: Number.parseInt(findingsBySeverityMatch[2], 10),
          low: Number.parseInt(findingsBySeverityMatch[3], 10)
        }
      : undefined,
    latestConclusion: getLineValue('Latest conclusion'),
    recommendedNextAction: getLineValue('Recommended next action'),
    overallDecision: normalizeOverallDecision(getLineValue('Overall decision'))
  };
}

function splitLegacyMilestoneBlocks(body: string): string[] {
  const normalized = normalizeMarkdownText(body);
  if (!normalized || normalized === NO_MILESTONES_PLACEHOLDER) return [];

  const matches = Array.from(normalized.matchAll(REVIEW_MILESTONE_HEADING_REGEX));
  if (matches.length === 0) return [];

  const blocks: string[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index ?? 0;
    const end = matches[i + 1]?.index ?? normalized.length;
    blocks.push(normalized.slice(start, end).trim());
  }

  return blocks;
}

function parseLegacyMilestoneBlock(block: string): ParsedLegacyMilestone | null {
  const lines = normalizeLineEndings(block).split('\n');
  const headingMatch = /^###\s+([^\s]+)\s+·\s+(.+)$/.exec(lines[0]?.trim() || '');
  if (!headingMatch) return null;

  let index = 1;
  let summary = '';
  const record: ParsedLegacyMilestone = {
    id: normalizeSingleLineText(headingMatch[1]),
    title: normalizeSingleLineText(headingMatch[2]),
    summary: '',
    status: 'in_progress',
    conclusion: null,
    evidenceFiles: [],
    reviewedModules: [],
    recommendedNextAction: null,
    recordedAt: formatDateTime(),
    findingTexts: []
  };

  const readIndentedList = (): string[] => {
    const items: string[] = [];
    while (index < lines.length) {
      const line = lines[index];
      if (!/^\s+-\s+/.test(line)) break;
      items.push(normalizeSingleLineText(line.replace(/^\s+-\s+/, '').replace(/^`/, '').replace(/`$/, '')));
      index += 1;
    }
    return items.filter(Boolean);
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (/^- Status:\s+/i.test(trimmed)) {
      record.status = normalizeMilestoneStatus(trimmed.replace(/^- Status:\s+/i, ''));
      index += 1;
      continue;
    }

    if (/^- Recorded At:\s+/i.test(trimmed)) {
      const value = normalizeSingleLineText(trimmed.replace(/^- Recorded At:\s+/i, ''));
      record.recordedAt = value || record.recordedAt;
      index += 1;
      continue;
    }

    if (/^- Reviewed Modules:\s+/i.test(trimmed)) {
      record.reviewedModules = uniqueStrings(
        trimmed
          .replace(/^- Reviewed Modules:\s+/i, '')
          .split(',')
          .map((item) => normalizeSingleLineText(item))
      );
      index += 1;
      continue;
    }

    if (/^- Summary:\s*$/i.test(trimmed)) {
      index += 1;
      const summaryLines: string[] = [];
      while (index < lines.length) {
        const nextLine = lines[index];
        if (/^- (Conclusion|Evidence Files|Recommended Next Action|Findings):/i.test(nextLine.trim())) {
          break;
        }
        summaryLines.push(nextLine);
        index += 1;
      }
      summary = summaryLines.join('\n').trim();
      record.summary = summary;
      continue;
    }

    if (/^- Conclusion:\s+/i.test(trimmed)) {
      record.conclusion = normalizeSingleLineText(trimmed.replace(/^- Conclusion:\s+/i, '')) || null;
      index += 1;
      continue;
    }

    if (/^- Evidence Files:\s*$/i.test(trimmed)) {
      index += 1;
      record.evidenceFiles = uniqueStrings([...record.evidenceFiles, ...readIndentedList()]);
      continue;
    }

    if (/^- Recommended Next Action:\s+/i.test(trimmed)) {
      record.recommendedNextAction = normalizeSingleLineText(trimmed.replace(/^- Recommended Next Action:\s+/i, '')) || null;
      index += 1;
      continue;
    }

    if (/^- Findings:\s*$/i.test(trimmed)) {
      index += 1;
      record.findingTexts = uniqueStrings([...record.findingTexts, ...readIndentedList()]);
      continue;
    }

    index += 1;
  }

  record.summary = normalizeMarkdownText(record.summary) || record.title;
  record.conclusion = record.conclusion || normalizeSingleLineText(record.summary) || record.title;
  return record;
}

function parseLegacyMilestones(body: string): ParsedLegacyMilestone[] {
  return splitLegacyMilestoneBlocks(body)
    .map((block) => parseLegacyMilestoneBlock(block))
    .filter((item): item is ParsedLegacyMilestone => !!item && !!item.id);
}

function normalizeMetadataV3(raw: unknown, header?: ReviewHeaderMetadata): ReviewDocumentMetadataV3 {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const milestoneIds = new Set<string>();
  const normalizedMilestones: ReviewMilestoneRecord[] = Array.isArray(source.milestones)
    ? source.milestones
        .map((item, index) => {
          const milestone = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const requestedId = normalizeSingleLineText(milestone.id);
          const baseId = requestedId || `M${index + 1}`;
          let id = baseId;
          let cursor = 2;
          while (milestoneIds.has(id)) {
            id = `${baseId}-${cursor}`;
            cursor += 1;
          }
          milestoneIds.add(id);
          return {
            id,
            title: normalizeSingleLineText(milestone.title) || id,
            summary: normalizeMarkdownText(milestone.summary) || normalizeSingleLineText(milestone.title) || id,
            status: normalizeMilestoneStatus(milestone.status),
            conclusion: normalizeSingleLineText(milestone.conclusion) || null,
            evidenceFiles: normalizeStringList(milestone.evidenceFiles),
            reviewedModules: normalizeStringList(milestone.reviewedModules),
            recommendedNextAction: normalizeSingleLineText(milestone.recommendedNextAction) || null,
            recordedAt: normalizeSingleLineText(milestone.recordedAt) || formatDateTime(),
            findingIds: normalizeStringList(milestone.findingIds)
          };
        })
        .filter((item) => !!item.id)
    : [];

  const findingIds = new Set<string>();
  const normalizedFindings: ReviewFindingRecord[] = Array.isArray(source.findings)
    ? source.findings
        .map((item, index) => {
          const finding = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const requestedId = normalizeSingleLineText(finding.id);
          const id = requestedId || nextFindingId(findingIds, normalizeSingleLineText(finding.title), index + 1);
          findingIds.add(id);
          return {
            id,
            severity: normalizeFindingSeverity(finding.severity),
            category: normalizeFindingCategory(finding.category),
            title: normalizeSingleLineText(finding.title),
            description: normalizeSingleLineText(finding.description) || null,
            evidenceFiles: normalizeStringList(finding.evidenceFiles),
            relatedMilestoneIds: normalizeStringList(finding.relatedMilestoneIds),
            recommendation: normalizeSingleLineText(finding.recommendation) || null
          };
        })
        .filter((item) => !!item.title)
    : [];

  const reviewedModules = uniqueStrings([
    ...normalizeStringList(source.reviewedModules),
    ...normalizedMilestones.flatMap((item) => item.reviewedModules)
  ]);

  return {
    formatVersion: 3,
    reviewRunId: normalizeSingleLineText(source.reviewRunId) || createReviewRunId(),
    createdAt: normalizeSingleLineText(source.createdAt) || parseDateToIsoStart(header?.date || formatDate()),
    finalizedAt: normalizeSingleLineText(source.finalizedAt) || null,
    status: normalizeMilestoneStatus(source.status),
    overallDecision: normalizeOverallDecision(source.overallDecision) || null,
    latestConclusion: normalizeSingleLineText(source.latestConclusion) || null,
    recommendedNextAction: normalizeSingleLineText(source.recommendedNextAction) || null,
    reviewedModules,
    milestones: normalizedMilestones,
    findings: normalizedFindings
  };
}

function serializeMetadataBlock(metadata: ReviewDocumentMetadataV3): string {
  return [REVIEW_METADATA_START, JSON.stringify(metadata, null, 2), REVIEW_METADATA_END].join('\n');
}

function buildSummaryFromMetadata(metadata: ReviewDocumentMetadataV3): ReviewSummarySectionInput {
  const milestoneCount = metadata.milestones.length;
  const completedMilestones = metadata.milestones.filter((item) => item.status === 'completed').length;
  const latestMilestone = metadata.milestones[metadata.milestones.length - 1];

  return {
    currentStatus: metadata.status,
    reviewedModules: metadata.reviewedModules,
    currentProgress: milestoneCount > 0
      ? `${milestoneCount} milestones recorded; latest: ${latestMilestone?.id || metadata.milestones[milestoneCount - 1]?.id || ''}`
      : '0 milestones recorded',
    totalMilestones: milestoneCount,
    completedMilestones,
    totalFindings: metadata.findings.length,
    findingsBySeverity: countFindingsBySeverity(metadata.findings),
    latestConclusion: metadata.latestConclusion || latestMilestone?.conclusion || undefined,
    recommendedNextAction: metadata.recommendedNextAction || latestMilestone?.recommendedNextAction || undefined,
    overallDecision: metadata.overallDecision || undefined
  };
}

function buildReviewDocument(input: {
  header: ReviewHeaderMetadata;
  scope: string;
  metadata: ReviewDocumentMetadataV3;
}): string {
  const metadata = normalizeMetadataV3(input.metadata, input.header);
  const summaryBody = renderReviewSummarySection(buildSummaryFromMetadata(metadata));
  const findingsBody = renderReviewFindingsSection(metadata.findings);
  const milestonesBody = metadata.milestones.length > 0
    ? metadata.milestones.map((item) => renderReviewMilestoneBlock(item, metadata.findings)).join('\n\n')
    : NO_MILESTONES_PLACEHOLDER;

  const sections = [
    `# ${input.header.title}`,
    `- Date: ${input.header.date}`,
    `- Overview: ${input.header.overview}`,
    `- Status: ${metadata.status}`,
    ...(metadata.overallDecision ? [`- Overall decision: ${metadata.overallDecision}`] : []),
    '',
    REVIEW_SCOPE_SECTION_TITLE,
    synchronizeReviewScope(input.scope, metadata),
    '',
    buildSection(REVIEW_SUMMARY_SECTION_TITLE, REVIEW_SUMMARY_START, REVIEW_SUMMARY_END, summaryBody),
    '',
    buildSection(REVIEW_FINDINGS_SECTION_TITLE, REVIEW_FINDINGS_START, REVIEW_FINDINGS_END, findingsBody),
    '',
    buildSection(REVIEW_MILESTONES_SECTION_TITLE, REVIEW_MILESTONES_START, REVIEW_MILESTONES_END, milestonesBody),
    '',
    serializeMetadataBlock(metadata)
  ];

  return `${sections.join('\n').trimEnd()}\n`;
}

function parseMetadataFromContent(content: string, header: ReviewHeaderMetadata): ReviewDocumentMetadataV3 {
  const normalized = normalizeLineEndings(content);
  const range = findSectionRange(normalized, REVIEW_METADATA_START, REVIEW_METADATA_END);
  if (!range) {
    throw new Error('Missing review metadata block.');
  }

  const rawBody = normalized.slice(range.bodyStart, range.endStart).trim();
  if (!rawBody) {
    throw new Error('Empty review metadata block.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error: any) {
    throw new Error(`Invalid review metadata JSON: ${error?.message || String(error)}`);
  }

  return normalizeMetadataV3(parsed, header);
}

function createInitialMetadata(input: ReviewDocumentTemplateInput, date: string): ReviewDocumentMetadataV3 {
  return {
    formatVersion: 3,
    reviewRunId: createReviewRunId(),
    createdAt: parseDateToIsoStart(date),
    finalizedAt: null,
    status: 'in_progress',
    overallDecision: null,
    latestConclusion: null,
    recommendedNextAction: null,
    reviewedModules: [],
    milestones: [],
    findings: []
  };
}

function mergeFindingRecords(existing: ReviewFindingRecord[], incoming: ReviewFindingInput[]): ReviewFindingRecord[] {
  const mergedInputs = mergeReviewFindings(
    existing.map((item) => metadataFindingToInput(item)),
    incoming
  );

  const existingIds = new Set<string>();
  return mergedInputs.map((item, index) => {
    const matchedExisting = existing.find((current) => current.id === item.id)
      || existing.find((current) => {
        const currentInput = metadataFindingToInput(current);
        return getFindingMergeKey(currentInput) === getFindingMergeKey(item);
      });
    return normalizeFindingRecord(item, existingIds, matchedExisting?.id || item.id, index + 1);
  });
}

function reconcileMetadataRelations(metadata: ReviewDocumentMetadataV3): ReviewDocumentMetadataV3 {
  const findingMap = new Map(metadata.findings.map((item) => [item.id, { ...item }])) ;
  const milestones = metadata.milestones.map((milestone) => ({ ...milestone, findingIds: uniqueStrings(milestone.findingIds) }));

  for (const finding of findingMap.values()) {
    finding.relatedMilestoneIds = uniqueStrings(
      finding.relatedMilestoneIds.filter((id) => milestones.some((milestone) => milestone.id === id))
    );
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

  return {
    ...metadata,
    reviewedModules: uniqueStrings([...metadata.reviewedModules, ...milestones.flatMap((item) => item.reviewedModules)]),
    milestones,
    findings: Array.from(findingMap.values())
  };
}

function migrateLegacyDocumentToV3(content: string): ReviewDocumentV3State {
  const normalized = normalizeLineEndings(content).trim();
  const header = parseHeaderMetadata(normalized);
  const scope = extractInitialReviewScope(normalized);
  const summary = parseReviewSummarySection(
    extractReviewSectionBody(normalized, REVIEW_SUMMARY_START, REVIEW_SUMMARY_END) || extractLegacySummaryBody(normalized)
  );
  const findingsSectionBody = extractReviewSectionBody(normalized, REVIEW_FINDINGS_START, REVIEW_FINDINGS_END);
  const milestoneSectionBody = extractReviewSectionBody(normalized, REVIEW_MILESTONES_START, REVIEW_MILESTONES_END) || NO_MILESTONES_PLACEHOLDER;
  const parsedMilestones = parseLegacyMilestones(milestoneSectionBody);
  const legacyFindings = mergeReviewFindings(
    findingsSectionBody ? [] : extractLegacyFindings(normalized).map((item) => convertLegacyFindingToStructured(item)),
    parseReviewFindingsSection(findingsSectionBody)
  );

  const findingIdSet = new Set<string>();
  const findings = legacyFindings.map((item, index) => normalizeFindingRecord(item, findingIdSet, item.id, index + 1));
  const milestoneFindingTexts = parsedMilestones.flatMap((milestone) => milestone.findingTexts.map((text) => ({ milestoneId: milestone.id, text })));

  let mergedFindings = findings;
  if (milestoneFindingTexts.length > 0) {
    mergedFindings = mergeFindingRecords(
      mergedFindings,
      milestoneFindingTexts.map((item) => convertLegacyFindingToStructured(item.text, item.milestoneId))
    );
  }

  const milestoneFindingIdMap = new Map<string, string[]>();
  for (const milestone of parsedMilestones) {
    milestoneFindingIdMap.set(milestone.id, []);
  }
  for (const finding of mergedFindings) {
    for (const milestoneId of finding.relatedMilestoneIds) {
      milestoneFindingIdMap.set(milestoneId, uniqueStrings([...(milestoneFindingIdMap.get(milestoneId) || []), finding.id]));
    }
  }

  const milestones: ReviewMilestoneRecord[] = parsedMilestones.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    status: item.status,
    conclusion: item.conclusion,
    evidenceFiles: item.evidenceFiles,
    reviewedModules: item.reviewedModules,
    recommendedNextAction: item.recommendedNextAction,
    recordedAt: item.recordedAt,
    findingIds: milestoneFindingIdMap.get(item.id) || []
  }));

  const createdAt = parseDateToIsoStart(header.date);
  const finalizedAt = header.status === 'completed'
    ? milestones[milestones.length - 1]?.recordedAt || createdAt
    : null;

  const metadata = reconcileMetadataRelations({
    formatVersion: 3,
    reviewRunId: createReviewRunId(),
    createdAt,
    finalizedAt,
    status: header.status === 'completed' ? 'completed' : 'in_progress',
    overallDecision: summary.overallDecision || header.overallDecision || null,
    latestConclusion: summary.latestConclusion || milestones[milestones.length - 1]?.conclusion || null,
    recommendedNextAction: summary.recommendedNextAction || milestones[milestones.length - 1]?.recommendedNextAction || null,
    reviewedModules: uniqueStrings([
      ...summary.reviewedModules,
      ...milestones.flatMap((item) => item.reviewedModules)
    ]),
    milestones,
    findings: mergedFindings
  });

  return {
    header: {
      ...header,
      status: metadata.status,
      overallDecision: metadata.overallDecision || undefined
    },
    scope,
    metadata,
    detectedFormat: 'v2'
  };
}

function loadReviewDocumentState(content: string): ReviewDocumentV3State {
  const normalized = normalizeLineEndings(content).trim();
  const detectedFormat = detectReviewDocumentFormat(normalized);

  if (detectedFormat === 'v3') {
    const header = parseHeaderMetadata(normalized);
    const scope = extractInitialReviewScope(normalized);
    const metadata = reconcileMetadataRelations(parseMetadataFromContent(normalized, header));
    return {
      header: {
        ...header,
        status: metadata.status,
        overallDecision: metadata.overallDecision || undefined
      },
      scope,
      metadata,
      detectedFormat
    };
  }

  return migrateLegacyDocumentToV3(normalized);
}

function countMilestoneBlocks(milestonesBody: string): number {
  const matches = Array.from(milestonesBody.matchAll(REVIEW_MILESTONE_HEADING_REGEX));
  return matches.length;
}

function countCompletedMilestones(milestonesBody: string): number {
  const matches = milestonesBody.match(/^- Status:\s+completed\s*$/gm);
  return matches ? matches.length : 0;
}

function getLatestMilestoneId(milestonesBody: string): string {
  const matches = Array.from(milestonesBody.matchAll(REVIEW_MILESTONE_HEADING_REGEX));
  const latest = matches[matches.length - 1];
  return normalizeSingleLineText(latest?.[1]);
}

function isMetadataBlockAtDocumentEnd(content: string): boolean {
  const range = findSectionRange(content, REVIEW_METADATA_START, REVIEW_METADATA_END);
  if (!range) return false;
  return content.slice(range.end).trim().length === 0;
}

function validateMetadataObject(metadata: ReviewDocumentMetadataV3): ReviewValidationIssue[] {
  const issues: ReviewValidationIssue[] = [];
  const milestoneIds = metadata.milestones.map((item) => normalizeSingleLineText(item.id)).filter(Boolean);
  const findingIds = metadata.findings.map((item) => normalizeSingleLineText(item.id)).filter(Boolean);

  if (new Set(milestoneIds).size !== milestoneIds.length) {
    issues.push({ severity: 'error', code: 'duplicate_milestone_ids', message: 'Review metadata contains duplicate milestone ids.' });
  }

  if (new Set(findingIds).size !== findingIds.length) {
    issues.push({ severity: 'error', code: 'duplicate_finding_ids', message: 'Review metadata contains duplicate finding ids.' });
  }

  if (metadata.status === 'completed' && !metadata.finalizedAt) {
    issues.push({ severity: 'error', code: 'missing_finalized_at', message: 'Completed review metadata must include finalizedAt.' });
  }

  const milestoneIdSet = new Set(milestoneIds);
  const findingIdSet = new Set(findingIds);

  for (const milestone of metadata.milestones) {
    for (const findingId of milestone.findingIds) {
      if (!findingIdSet.has(findingId)) {
        issues.push({
          severity: 'error',
          code: 'missing_linked_finding',
          message: `Milestone "${milestone.id}" references missing finding "${findingId}".`
        });
      }
    }
  }

  for (const finding of metadata.findings) {
    for (const milestoneId of finding.relatedMilestoneIds) {
      if (!milestoneIdSet.has(milestoneId)) {
        issues.push({
          severity: 'error',
          code: 'missing_linked_milestone',
          message: `Finding "${finding.id}" references missing milestone "${milestoneId}".`
        });
      }
    }
  }

  if (metadata.formatVersion !== 3) {
    issues.push({ severity: 'error', code: 'invalid_format_version', message: 'Review metadata formatVersion must be 3.' });
  }

  return issues;
}

export function validateReviewDocument(content: string): ReviewValidationResult {
  const normalized = normalizeLineEndings(content).trim();
  const detectedFormat = detectReviewDocumentFormat(normalized);
  const issues: ReviewValidationIssue[] = [];

  if (detectedFormat !== 'v3') {
    return {
      detectedFormat,
      formatVersion: detectedFormat === 'v2' ? 2 : null,
      isValid: detectedFormat === 'v2',
      canAutoUpgrade: detectedFormat === 'v2',
      issues: detectedFormat === 'v2'
        ? [{ severity: 'warning', code: 'upgrade_required', message: 'Review document is a legacy format and can be upgraded to V3.' }]
        : [{ severity: 'error', code: 'unknown_review_format', message: 'Review document does not match the expected Review format.' }]
    };
  }

  if (countOccurrences(normalized, REVIEW_METADATA_START) !== 1 || countOccurrences(normalized, REVIEW_METADATA_END) !== 1) {
    issues.push({ severity: 'error', code: 'metadata_block_count', message: 'Review document must contain exactly one metadata block.' });
  }

  if (
    countOccurrences(normalized, REVIEW_METADATA_START) === 1
    && countOccurrences(normalized, REVIEW_METADATA_END) === 1
    && !isMetadataBlockAtDocumentEnd(normalized)
  ) {
    issues.push({ severity: 'warning', code: 'metadata_not_at_document_end', message: 'Review metadata block should be located at the end of the document.' });
  }

  if (countOccurrences(normalized, REVIEW_SUMMARY_START) !== 1 || countOccurrences(normalized, REVIEW_SUMMARY_END) !== 1) {
    issues.push({ severity: 'error', code: 'summary_marker_count', message: 'Review Summary markers must appear exactly once.' });
  }

  if (countOccurrences(normalized, REVIEW_FINDINGS_START) !== 1 || countOccurrences(normalized, REVIEW_FINDINGS_END) !== 1) {
    issues.push({ severity: 'error', code: 'findings_marker_count', message: 'Review Findings markers must appear exactly once.' });
  }

  if (countOccurrences(normalized, REVIEW_MILESTONES_START) !== 1 || countOccurrences(normalized, REVIEW_MILESTONES_END) !== 1) {
    issues.push({ severity: 'error', code: 'milestones_marker_count', message: 'Review Milestones markers must appear exactly once.' });
  }

  if (!detectCanonicalSectionOrder(normalized)) {
    issues.push({ severity: 'error', code: 'non_canonical_section_order', message: 'Visible review sections are not in canonical order.' });
  }

  let metadata: ReviewDocumentMetadataV3 | undefined;
  try {
    const state = loadReviewDocumentState(normalized);
    metadata = state.metadata;
    issues.push(...validateMetadataObject(metadata));

    if (normalizeMarkdownText(state.scope) !== synchronizeReviewScope(state.scope, metadata)) {
      issues.push({
        severity: 'warning',
        code: 'scope_state_out_of_sync',
        message: 'Review Scope contains recognized status or conclusion text that is out of sync with metadata-derived review state.'
      });
    }
  } catch (error: any) {
    issues.push({ severity: 'error', code: 'invalid_metadata', message: error?.message || String(error) });
  }

  return {
    detectedFormat,
    formatVersion: metadata?.formatVersion || 3,
    isValid: issues.every((item) => item.severity !== 'error'),
    canAutoUpgrade: issues.some((item) => item.code === 'metadata_not_at_document_end'),
    issues,
    metadata
  };
}

export function summarizeReviewDocument(content: string): ReviewDocumentSummarySnapshot {
  const state = loadReviewDocumentState(content);
  const summary = buildSummaryFromMetadata(state.metadata);

  return {
    title: state.header.title,
    date: state.header.date,
    overview: state.header.overview,
    status: state.metadata.status,
    overallDecision: state.metadata.overallDecision,
    totalMilestones: summary.totalMilestones || 0,
    completedMilestones: summary.completedMilestones || 0,
    currentProgress: summary.currentProgress || '0 milestones recorded',
    reviewedModules: state.metadata.reviewedModules,
    totalFindings: summary.totalFindings || 0,
    findingsBySeverity: countFindingsBySeverity(state.metadata.findings),
    latestConclusion: state.metadata.latestConclusion || summary.latestConclusion || null,
    recommendedNextAction: state.metadata.recommendedNextAction || summary.recommendedNextAction || null
  };
}

function ensureValidRenderedDocument(content: string): ReviewValidationResult {
  const validation = validateReviewDocument(content);
  const errors = validation.issues.filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map((item) => item.message).join(' '));
  }
  return validation;
}

export function detectReviewDocumentFormat(content: string): ReviewDocumentFormat {
  const normalized = normalizeLineEndings(content);
  if (normalized.includes(REVIEW_METADATA_START) && normalized.includes(REVIEW_METADATA_END)) {
    return 'v3';
  }
  if (
    /^#\s+/m.test(normalized)
    && (/^- Date:\s+/m.test(normalized) || /^##\s+Review Scope$/m.test(normalized) || normalized.includes(REVIEW_SUMMARY_START))
  ) {
    return 'v2';
  }
  return 'unknown';
}

export function upgradeReviewDocumentToV3(content: string): string {
  const state = loadReviewDocumentState(content);
  return buildReviewDocument(state);
}

export function normalizeReviewDocumentStructure(content: string): string {
  return upgradeReviewDocumentToV3(content);
}

export function ensureReviewDocumentSections(content: string): string {
  return normalizeReviewDocumentStructure(content);
}

export function getNextReviewMilestoneId(content: string): string {
  const state = loadReviewDocumentState(content);
  return `M${state.metadata.milestones.length + 1}`;
}

export function appendReviewMilestone(content: string, input: ReviewMilestoneInput): {
  content: string;
  milestoneId: string;
  milestoneCount: number;
  completedMilestones: number;
  findings: string[];
  structuredFindings: ReviewFindingInput[];
  reviewedModules: string[];
} {
  const state = loadReviewDocumentState(content);

  if (state.metadata.status === 'completed') {
    throw new Error('Cannot record a milestone for a finalized review document.');
  }

  const milestoneId = normalizeSingleLineText(input.milestoneId) || `M${state.metadata.milestones.length + 1}`;
  if (state.metadata.milestones.some((item) => item.id === milestoneId)) {
    throw new Error(`Duplicate milestone id is not allowed: ${milestoneId}`);
  }

  const milestoneTitle = normalizeSingleLineText(input.milestoneTitle) || milestoneId;
  const summary = normalizeMarkdownText(input.summary) || milestoneTitle;
  const conclusion = normalizeSingleLineText(input.conclusion) || normalizeSingleLineText(summary) || milestoneTitle;
  const evidenceFiles = normalizeStringList(input.evidenceFiles);
  const reviewedModules = normalizeStringList(input.reviewedModules);
  const recommendedNextAction = normalizeSingleLineText(input.recommendedNextAction) || null;
  const recordedAt = normalizeSingleLineText(input.recordedAt) || formatDateTime();

  const incomingFindings = mergeReviewFindings(
    [],
    [
      ...normalizeStringList(input.findings).map((item) => convertLegacyFindingToStructured(item, milestoneId, evidenceFiles)),
      ...(Array.isArray(input.structuredFindings)
        ? input.structuredFindings.map((item) => normalizeReviewFinding(item, milestoneId, evidenceFiles))
        : [])
    ]
  );

  const mergedFindings = mergeFindingRecords(state.metadata.findings, incomingFindings);
  const currentFindingIds = new Set(mergedFindings.map((item) => item.id));
  const linkedFindingIds = mergedFindings
    .filter((item) => item.relatedMilestoneIds.includes(milestoneId))
    .map((item) => item.id)
    .filter((id) => currentFindingIds.has(id));

  const nextMetadata = reconcileMetadataRelations({
    ...state.metadata,
    status: 'in_progress',
    overallDecision: state.metadata.overallDecision,
    latestConclusion: conclusion || state.metadata.latestConclusion,
    recommendedNextAction: recommendedNextAction || state.metadata.recommendedNextAction,
    reviewedModules: uniqueStrings([...state.metadata.reviewedModules, ...reviewedModules]),
    milestones: [
      ...state.metadata.milestones,
      {
        id: milestoneId,
        title: milestoneTitle,
        summary,
        status: normalizeMilestoneStatus(input.status),
        conclusion,
        evidenceFiles,
        reviewedModules,
        recommendedNextAction,
        recordedAt,
        findingIds: linkedFindingIds
      }
    ],
    findings: mergedFindings
  });

  const rendered = buildReviewDocument({
    header: {
      ...state.header,
      status: nextMetadata.status,
      overallDecision: nextMetadata.overallDecision || undefined
    },
    scope: state.scope,
    metadata: nextMetadata
  });

  ensureValidRenderedDocument(rendered);

  const milestonesBody = extractReviewSectionBody(rendered, REVIEW_MILESTONES_START, REVIEW_MILESTONES_END);
  const milestoneCount = countMilestoneBlocks(milestonesBody);
  const completedMilestones = countCompletedMilestones(milestonesBody);

  return {
    content: rendered,
    milestoneId,
    milestoneCount,
    completedMilestones,
    findings: nextMetadata.findings.map((item) => formatFindingSummaryText(metadataFindingToInput(item))),
    structuredFindings: nextMetadata.findings.map((item) => metadataFindingToInput(item)),
    reviewedModules: nextMetadata.reviewedModules
  };
}

export function finalizeReviewDocument(content: string, input: ReviewFinalizeInput): {
  content: string;
  milestoneCount: number;
  completedMilestones: number;
  findings: string[];
  structuredFindings: ReviewFindingInput[];
  reviewedModules: string[];
  overallDecision?: ReviewOverallDecision;
} {
  const state = loadReviewDocumentState(content);
  const reviewedModules = normalizeStringList(input.reviewedModules);

  const nextMetadata = reconcileMetadataRelations({
    ...state.metadata,
    status: 'completed',
    finalizedAt: state.metadata.finalizedAt || formatDateTime(),
    overallDecision: normalizeOverallDecision(input.overallDecision) || state.metadata.overallDecision,
    latestConclusion: normalizeSingleLineText(input.conclusion) || state.metadata.latestConclusion,
    recommendedNextAction: normalizeSingleLineText(input.recommendedNextAction) || state.metadata.recommendedNextAction,
    reviewedModules: uniqueStrings([...state.metadata.reviewedModules, ...reviewedModules])
  });

  const rendered = buildReviewDocument({
    header: {
      ...state.header,
      status: nextMetadata.status,
      overallDecision: nextMetadata.overallDecision || undefined
    },
    scope: state.scope,
    metadata: nextMetadata
  });

  ensureValidRenderedDocument(rendered);

  const milestonesBody = extractReviewSectionBody(rendered, REVIEW_MILESTONES_START, REVIEW_MILESTONES_END);
  const milestoneCount = countMilestoneBlocks(milestonesBody);
  const completedMilestones = countCompletedMilestones(milestonesBody);

  return {
    content: rendered,
    milestoneCount,
    completedMilestones,
    findings: nextMetadata.findings.map((item) => formatFindingSummaryText(metadataFindingToInput(item))),
    structuredFindings: nextMetadata.findings.map((item) => metadataFindingToInput(item)),
    reviewedModules: nextMetadata.reviewedModules,
    overallDecision: nextMetadata.overallDecision || undefined
  };
}

export function buildInitialReviewDocument(input: ReviewDocumentTemplateInput): string {
  const title = normalizeSingleLineText(input.title) || 'Review';
  const overview = normalizeSingleLineText(input.overview) || 'Workspace review';
  const review = normalizeMarkdownText(input.review) || DEFAULT_REVIEW_SCOPE;
  const date = normalizeSingleLineText(input.date) || formatDate();

  const content = buildReviewDocument({
    header: {
      title,
      date,
      overview,
      status: 'in_progress'
    },
    scope: review,
    metadata: createInitialMetadata(input, date)
  });

  ensureValidRenderedDocument(content);
  return content;
}
