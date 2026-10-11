/** 旧审查文档的章节解析与元数据迁移。 */

import {
  type ReviewMilestoneStatus,
  type ReviewOverallDecision,
  type ReviewDocumentMetadataV3,
  REVIEW_SCOPE_SECTION_TITLE,
  REVIEW_SUMMARY_SECTION_TITLE,
  REVIEW_FINDINGS_SECTION_TITLE,
  REVIEW_MILESTONES_SECTION_TITLE,
  REVIEW_METADATA_START,
  REVIEW_METADATA_END,
  REVIEW_SUMMARY_START,
  REVIEW_SUMMARY_END,
  REVIEW_FINDINGS_START,
  REVIEW_FINDINGS_END,
  REVIEW_MILESTONES_START,
  REVIEW_MILESTONES_END,
  DEFAULT_REVIEW_SCOPE,
  type ReviewFindingInput,
  NO_FINDINGS_PLACEHOLDER,
  NO_MILESTONES_PLACEHOLDER,
  type ReviewMilestoneRecord,
  type ReviewFindingRecord
} from './schema';
import { normalizeLineEndingsToLF as normalizeLineEndings, normalizeSingleLineText, escapeRegExp } from '../shared/textUtils';
import {
  normalizeHeadingToken,
  normalizeMarkdownText,
  uniqueStrings,
  formatDate,
  normalizeMilestoneStatus,
  normalizeOverallDecision,
  convertLegacyFindingToStructured,
  normalizeFindingSeverity,
  normalizeFindingCategory,
  normalizeFindingTrackingStatus,
  normalizeFindingInput,
  formatDateTime,
  asRecord,
  nextMilestoneId,
  normalizeNullableMarkdown,
  normalizeStringList,
  nextFindingId,
  parseDateToIsoStart,
  mergeFindingRecords,
  evidenceRefsToFiles
} from './documentValues';
import { generateReviewRunId } from '../shared/idGen';

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
  reviewedModules: string[];
  latestConclusion?: string;
  recommendedNextAction?: string;
  overallDecision?: ReviewOverallDecision;
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

export interface ReviewDocumentV3State {
  header: ReviewHeaderMetadata;
  scope: string;
  metadata: ReviewDocumentMetadataV3;
  detectedFormat: 'v2' | 'v3';
}

const REVIEW_MILESTONE_HEADING_REGEX = /^###\s+([^\s]+)\s+·\s+(.+)$/gm;

const REVIEW_FINDING_HEADING_REGEX = /^###\s+([^\s]+)\s+·\s+(.+)$/gm;

const LEGACY_CANONICAL_SECTION_ORDER = [
  REVIEW_SCOPE_SECTION_TITLE,
  REVIEW_SUMMARY_SECTION_TITLE,
  REVIEW_FINDINGS_SECTION_TITLE,
  REVIEW_MILESTONES_SECTION_TITLE
];

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
    '评审计划',
    'レビュー範囲',
    'レビュー計画'
  ].includes(token);
}

function isSummaryHeading(heading: string): boolean {
  const token = normalizeHeadingToken(heading);
  return ['reviewsummary', 'summary', '审查摘要', '评审摘要', '总结', 'レビュー要約', '要約'].includes(token);
}

function isFindingsHeading(heading: string): boolean {
  const token = normalizeHeadingToken(heading);
  return ['reviewfindings', 'findings', '审查发现', '评审发现', '问题', '发现', 'レビュー所見', '指摘'].includes(token);
}

function isMilestonesHeading(heading: string): boolean {
  const token = normalizeHeadingToken(heading);
  return ['reviewmilestones', 'milestones', '审查里程碑', '评审里程碑', '里程碑', 'レビューマイルストーン', 'マイルストーン'].includes(token);
}

function demoteSectionIntoScope(heading: string, body: string): string {
  const normalizedHeading = normalizeSingleLineText(heading);
  const normalizedBody = normalizeMarkdownText(body);
  if (!normalizedHeading) return normalizedBody;
  if (!normalizedBody) return `### ${normalizedHeading}`;
  return `### ${normalizedHeading}\n${normalizedBody}`;
}

function findSectionRange(
  content: string,
  startMarker: string,
  endMarker: string
): { start: number; bodyStart: number; endStart: number; end: number } | null {
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

export function extractReviewSectionBody(content: string, startMarker: string, endMarker: string): string {
  const normalized = normalizeLineEndings(content);
  const range = findSectionRange(normalized, startMarker, endMarker);
  if (!range) return '';
  return normalized.slice(range.bodyStart, range.endStart).trim();
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

export function detectSectionOrder(content: string, sectionTitles: string[]): boolean {
  const indices = sectionTitles.map((title) => content.indexOf(title));
  if (indices.some((index) => index < 0)) return false;
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] <= indices[i - 1]) return false;
  }
  return true;
}

export function parseHeaderMetadata(content: string): ReviewHeaderMetadata {
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

function parseReviewSummarySection(body: string): ParsedReviewSummary {
  const normalized = normalizeMarkdownText(body);
  if (!normalized) {
    return { reviewedModules: [] };
  }

  const getLineValue = (label: string): string => {
    const match = new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, 'mi').exec(normalized);
    return normalizeSingleLineText(match?.[1]);
  };

  return {
    reviewedModules: getLineValue('Reviewed modules') && getLineValue('Reviewed modules') !== 'pending'
      ? getLineValue('Reviewed modules').split(',').map((item) => normalizeSingleLineText(item)).filter(Boolean)
      : [],
    latestConclusion: getLineValue('Latest conclusion'),
    recommendedNextAction: getLineValue('Recommended next action'),
    overallDecision: normalizeOverallDecision(getLineValue('Overall decision'))
  };
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
    relatedMilestoneIds: [],
    trackingStatus: 'open'
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
      finding.description = normalizeMarkdownText(trimmed.replace(/^- Description:\s+/i, ''));
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
      finding.recommendation = normalizeMarkdownText(trimmed.replace(/^- Recommendation:\s+/i, ''));
      readingEvidenceFiles = false;
      continue;
    }

    if (/^- Tracking Status:\s+/i.test(trimmed)) {
      finding.trackingStatus = normalizeFindingTrackingStatus(trimmed.replace(/^- Tracking Status:\s+/i, ''));
      readingEvidenceFiles = false;
      continue;
    }

    readingEvidenceFiles = false;
  }

  return normalizeFindingInput(finding);
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
      record.summary = summaryLines.join('\n').trim();
      continue;
    }

    if (/^- Conclusion:\s+/i.test(trimmed)) {
      record.conclusion = normalizeMarkdownText(trimmed.replace(/^- Conclusion:\s+/i, '')) || null;
      index += 1;
      continue;
    }

    if (/^- Evidence Files:\s*$/i.test(trimmed)) {
      index += 1;
      record.evidenceFiles = uniqueStrings([...record.evidenceFiles, ...readIndentedList()]);
      continue;
    }

    if (/^- Recommended Next Action:\s+/i.test(trimmed)) {
      record.recommendedNextAction = normalizeMarkdownText(trimmed.replace(/^- Recommended Next Action:\s+/i, '')) || null;
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
  const source = asRecord(raw) || {};
  const milestoneIds = new Set<string>();
  const normalizedMilestones: ReviewMilestoneRecord[] = Array.isArray(source.milestones)
    ? source.milestones
        .map((item, index) => {
          const milestone = asRecord(item) || {};
          const requestedId = normalizeSingleLineText(milestone.id);
          const id = requestedId || nextMilestoneId(milestoneIds, index + 1);
          milestoneIds.add(id);
          return {
            id,
            title: normalizeSingleLineText(milestone.title) || id,
            summary: normalizeMarkdownText(milestone.summary) || normalizeSingleLineText(milestone.title) || id,
            status: normalizeMilestoneStatus(milestone.status),
            conclusion: normalizeNullableMarkdown(milestone.conclusion),
            evidenceFiles: normalizeStringList(milestone.evidenceFiles),
            reviewedModules: normalizeStringList(milestone.reviewedModules),
            recommendedNextAction: normalizeNullableMarkdown(milestone.recommendedNextAction),
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
            description: normalizeNullableMarkdown(finding.description),
            evidenceFiles: normalizeStringList(finding.evidenceFiles),
            relatedMilestoneIds: normalizeStringList(finding.relatedMilestoneIds),
            recommendation: normalizeNullableMarkdown(finding.recommendation)
          };
        })
        .filter((item) => !!item.title)
    : [];

  const reviewedModules = uniqueStrings([
    ...normalizeStringList(source.reviewedModules),
    ...normalizedMilestones.flatMap((item) => item.reviewedModules)
  ]);

  return reconcileMetadataRelations({
    formatVersion: 3,
    reviewRunId: normalizeSingleLineText(source.reviewRunId) || generateReviewRunId(),
    createdAt: normalizeSingleLineText(source.createdAt) || parseDateToIsoStart(header?.date || formatDate()),
    finalizedAt: normalizeSingleLineText(source.finalizedAt) || null,
    status: normalizeMilestoneStatus(source.status),
    overallDecision: normalizeOverallDecision(source.overallDecision) || null,
    latestConclusion: normalizeNullableMarkdown(source.latestConclusion),
    recommendedNextAction: normalizeNullableMarkdown(source.recommendedNextAction),
    reviewedModules,
    milestones: normalizedMilestones,
    findings: normalizedFindings
  });
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

function reconcileMetadataRelations(metadata: ReviewDocumentMetadataV3): ReviewDocumentMetadataV3 {
  const findingMap = new Map(metadata.findings.map((item) => [item.id, { ...item }]));
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

export function migrateLegacyDocumentToV3(content: string): ReviewDocumentV3State {
  const normalized = normalizeLineEndings(content).trim();
  const header = parseHeaderMetadata(normalized);
  const scope = extractInitialReviewScope(normalized);
  const summary = parseReviewSummarySection(
    extractReviewSectionBody(normalized, REVIEW_SUMMARY_START, REVIEW_SUMMARY_END) || extractLegacySummaryBody(normalized)
  );
  const findingsSectionBody = extractReviewSectionBody(normalized, REVIEW_FINDINGS_START, REVIEW_FINDINGS_END);
  const milestoneSectionBody = extractReviewSectionBody(normalized, REVIEW_MILESTONES_START, REVIEW_MILESTONES_END) || NO_MILESTONES_PLACEHOLDER;
  const parsedMilestones = parseLegacyMilestones(milestoneSectionBody);
  const legacyFindings = (
    findingsSectionBody ? [] : extractLegacyFindings(normalized).map((item) => convertLegacyFindingToStructured(item))
  ).concat(parseReviewFindingsSection(findingsSectionBody));

  const v4Merged = mergeFindingRecords([], legacyFindings);
  const mergedFindings = v4Merged.findings.map((item) => ({
    id: item.id,
    severity: item.severity,
    category: item.category,
    title: item.title,
    description: item.descriptionMarkdown,
    evidenceFiles: evidenceRefsToFiles(item.evidence),
    relatedMilestoneIds: item.relatedMilestoneIds,
    recommendation: item.recommendationMarkdown
  }));

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
    reviewRunId: generateReviewRunId(),
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

export function loadReviewDocumentV3State(content: string): ReviewDocumentV3State {
  const normalized = normalizeLineEndings(content).trim();
  const header = parseHeaderMetadata(normalized);
  const metadata = reconcileMetadataRelations(parseMetadataFromContent(normalized, header));
  const scope = extractInitialReviewScope(normalized);
  return {
    header: {
      ...header,
      status: metadata.status,
      overallDecision: metadata.overallDecision || undefined
    },
    scope,
    metadata,
    detectedFormat: 'v3'
  };
}
