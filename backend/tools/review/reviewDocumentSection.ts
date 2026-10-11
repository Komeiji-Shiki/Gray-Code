/** 审查文档的校验、格式识别与生命周期操作。 */

import {
  type ReviewSnapshotV4,
  type ReviewDocumentFormat,
  REVIEW_SCOPE_SECTION_TITLE,
  REVIEW_SUMMARY_SECTION_TITLE,
  REVIEW_FINDINGS_SECTION_TITLE,
  REVIEW_MILESTONES_SECTION_TITLE,
  REVIEW_FINAL_CONCLUSION_SECTION_TITLE,
  REVIEW_SNAPSHOT_SECTION_TITLE,
  type ReviewDocumentMetadataV3,
  type ReviewValidationIssue,
  type ReviewValidationResult,
  type ReviewDocumentTemplateInput,
  type ReviewDocumentLocale,
  REVIEW_SNAPSHOT_RENDERER_VERSION,
  REVIEW_METADATA_START,
  REVIEW_METADATA_END,
  REVIEW_SUMMARY_START,
  type ReviewDocumentSummarySnapshot,
  type ReviewMilestoneInput,
  type ReviewFindingInput,
  type ReviewFinalizeInput,
  type ReviewOverallDecision
} from './schema';
import { normalizeLineEndingsToLF as normalizeLineEndings, normalizeSingleLineText } from '../shared/textUtils';
import {
  isSnapshotHeading,
  inferReviewDocumentLocaleFromSnapshotHeading,
  resolveReviewDocumentLocale,
  getV4BodySectionOrder,
  getLocalizedDefaultReviewScope,
  REVIEW_DOCUMENT_LOCALES,
  getReviewSectionHeadings,
  formatFindingSummaryText
} from './documentLocale';
import {
  parseHeaderMetadata,
  extractInitialReviewScope,
  loadReviewDocumentV3State,
  migrateLegacyDocumentToV3,
  detectSectionOrder
} from './documentLegacy';
import { normalizeReviewSnapshot, convertV3StateToSnapshot, snapshotToMetadataCompat } from './documentSnapshot';
import { renderReviewDocumentBody, buildSummaryFromSnapshot, buildReviewDocument } from './documentRender';
import {
  hashText,
  isFindingTitleNotConcise,
  isFindingTitleRepeatingDescription,
  normalizeMarkdownText,
  formatDate,
  parseDateToIsoStart,
  asRecord,
  nextMilestoneId,
  normalizeStringList,
  mergeEvidenceRefs,
  normalizeEvidenceRefs,
  evidenceFilesToRefs,
  normalizeNullableMarkdown,
  formatDateTime,
  convertLegacyFindingToStructured,
  normalizeFindingInput,
  mergeFindingRecords,
  uniqueStrings,
  normalizeMilestoneStatus,
  snapshotFindingToInput,
  normalizeOverallDecision
} from './documentValues';
import { generateReviewRunId } from '../shared/idGen';

export {
  DEFAULT_FINAL_CONCLUSION,
  DEFAULT_REVIEW_SCOPE,
  NO_FINDINGS_PLACEHOLDER,
  NO_MILESTONES_PLACEHOLDER,
  REVIEW_FINAL_CONCLUSION_SECTION_TITLE,
  REVIEW_FINDINGS_END,
  REVIEW_FINDINGS_SECTION_TITLE,
  REVIEW_FINDINGS_START,
  REVIEW_METADATA_END,
  REVIEW_METADATA_START,
  REVIEW_MILESTONES_END,
  REVIEW_MILESTONES_SECTION_TITLE,
  REVIEW_MILESTONES_START,
  REVIEW_SCOPE_SECTION_TITLE,
  REVIEW_SNAPSHOT_RENDERER_VERSION,
  REVIEW_SNAPSHOT_SECTION_TITLE,
  REVIEW_SUMMARY_END,
  REVIEW_SUMMARY_SECTION_TITLE,
  REVIEW_SUMMARY_START
} from './schema';

export type {
  ReviewDocumentFormat,
  ReviewDocumentMetadataV3,
  ReviewDocumentSummarySnapshot,
  ReviewDocumentTemplateInput,
  ReviewEvidenceRef,
  ReviewFinalizeInput,
  ReviewFindingCategory,
  ReviewFindingInput,
  ReviewFindingRecord,
  ReviewFindingRecordV4,
  ReviewFindingSeverity,
  ReviewFindingTrackingStatus,
  ReviewMilestoneInput,
  ReviewMilestoneRecord,
  ReviewMilestoneRecordV4,
  ReviewMilestoneStatus,
  ReviewOverallDecision,
  ReviewSnapshotV4,
  ReviewDocumentLocale,
  ReviewValidationIssue,
  ReviewValidationResult
} from './schema';

export { resolveReviewDocumentLocale, getCurrentReviewDocumentLocale } from './documentLocale';

export { extractReviewSectionBody, extractInitialReviewScope } from './documentLegacy';

export { buildSummaryFromSnapshot } from './documentRender';

interface ReviewDocumentV4State {
  snapshot: ReviewSnapshotV4;
  body: string;
  detectedFormat: ReviewDocumentFormat;
}

const V4_BODY_SECTION_ORDER = [
  REVIEW_SCOPE_SECTION_TITLE,
  REVIEW_SUMMARY_SECTION_TITLE,
  REVIEW_FINDINGS_SECTION_TITLE,
  REVIEW_MILESTONES_SECTION_TITLE,
  REVIEW_FINAL_CONCLUSION_SECTION_TITLE,
  REVIEW_SNAPSHOT_SECTION_TITLE
];

const AUTO_FIXABLE_V4_CODES = new Set([
  'body_out_of_sync_with_snapshot',
  'stats_out_of_sync',
  'body_hash_mismatch'
]);

/**
 * 返回代码围栏（行首 ``` 至行首 ``` 之间）之外的 H2 heading 匹配。
 * 正文/代码块里出现的字面 "## ..." 行不计入，避免误报
 * snapshot_section_count 或误定位 Snapshot 区。
 * heading 语义与 parseH2Sections 一致（## 后空白 + 至少一个非空字符）。
 */
function findH2HeadingsOutsideFences(content: string): Array<{ index: number; heading: string }> {
  const normalized = normalizeLineEndings(content);
  const results: Array<{ index: number; heading: string }> = [];
  let inFence = false;
  let offset = 0;
  for (const line of normalized.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const headingMatch = /^##\s+(.+)$/.exec(line);
      if (headingMatch) {
        results.push({ index: offset, heading: normalizeSingleLineText(headingMatch[1]) });
      }
    }
    offset += line.length + 1;
  }
  return results;
}

function countSnapshotSectionHeadings(content: string): number {
  return findH2HeadingsOutsideFences(content).filter((match) => isSnapshotHeading(match.heading)).length;
}

interface SnapshotSectionLocation {
  headingStart: number;
  bodyStart: number;
  end: number;
  heading: string;
  body: string;
}

/**
 * 定位最后一个 Review Snapshot 区段（heading + body 在原文中的位置）。
 * 用于把 json 围栏校验/解析限定在 Snapshot 区内，避免正文里出现的
 * ```json 代码块干扰计数或导致正则提前命中。
 * heading 匹配跳过代码围栏内的字面 "## Review Snapshot" 行
 * （正文代码块中的示例文本不会误定位 Snapshot 区）。
 */
function findLastSnapshotSectionRange(content: string): SnapshotSectionLocation | null {
  const normalized = normalizeLineEndings(content);
  const matches = findH2HeadingsOutsideFences(normalized);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const heading = matches[i].heading;
    if (!isSnapshotHeading(heading)) continue;
    const start = matches[i].index;
    const nextMatch = matches[i + 1];
    const end = nextMatch?.index ?? normalized.length;
    const lineEnd = normalized.indexOf('\n', start);
    const bodyStart = lineEnd >= 0 ? lineEnd + 1 : end;
    return {
      headingStart: start,
      bodyStart,
      end,
      heading,
      body: normalized.slice(bodyStart, end).trim()
    };
  }
  return null;
}

/**
 * 统计 Snapshot 区段内作为「行首围栏」出现的 ```json 行数。
 * 不能用子串计数：Snapshot JSON blob 经 JSON.stringify 后，字符串值里的
 * ```json 会随行内转义出现（不会位于行首），子串计数会把它们误算进去，
 * 导致 finding 描述/里程碑摘要/结论含 ```json 时围栏计数 ≥2 误报。
 * 围栏行尾显式锚定 \n（尾部空白仅 [ \t]）：U+2028/U+2029 行分隔符
 * 不会被 \s 吞入而误判为围栏行（\s 含 U+2028/29）。
 */
function countJsonFenceLines(content: string): number {
  return Array.from(content.matchAll(/(?:^|\n)```json[ \t]*(?=\n|$)/g)).length;
}

/**
 * 从 Snapshot 区段 body 提取 json 围栏内容。
 * 允许 heading 与开头围栏之间存在空白/说明文字（手工编辑场景）；
 * 取最后一个行首 ```json 作为开头围栏（blob 内字符串值经 stringify 后
 * ```json 不会位于行首），并要求区段以 ``` 收尾。
 * 围栏行尾显式锚定 \n（尾部空白仅 [ \t]），与 countJsonFenceLines 一致，
 * 避免 U+2028/U+2029 行分隔符假阳性。
 */
function extractV4SnapshotJson(sectionBody: string): string | undefined {
  const body = normalizeLineEndings(sectionBody).trim();
  if (!body.endsWith('```')) return undefined;
  const fenceMatches = Array.from(body.matchAll(/(?:^|\n)```json[ \t]*(?=\n|$)/g));
  const lastFence = fenceMatches[fenceMatches.length - 1];
  if (!lastFence || lastFence.index === undefined) return undefined;
  const rawJson = body
    .slice(lastFence.index + lastFence[0].length)
    .replace(/\n```[ \t]*$/, '')
    .trim();
  return rawJson || undefined;
}

function parseV4SnapshotSection(content: string): { body: string; snapshot: ReviewSnapshotV4 } {
  const normalized = normalizeLineEndings(content).trim();
  const snapshotSection = findLastSnapshotSectionRange(normalized);
  if (!snapshotSection) {
    throw new Error('Missing or invalid Review Snapshot section.');
  }

  // 解析范围限定在 Snapshot 区内；围栏按行匹配（行首 ```json + 结尾 ```），
  // 避免正文中的 ```json 代码块干扰解析；heading 与围栏之间允许说明文字。
  const body = normalized.slice(0, snapshotSection.headingStart).trimEnd();
  const rawJson = extractV4SnapshotJson(snapshotSection.body);
  if (!rawJson) {
    throw new Error('Empty Review Snapshot json block.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error: any) {
    throw new Error(`Invalid Review Snapshot JSON: ${error?.message || String(error)}`);
  }

  const bodyHeader = parseHeaderMetadata(body);
  const localeFromHeading = inferReviewDocumentLocaleFromSnapshotHeading(snapshotSection.heading);
  const snapshot = normalizeReviewSnapshot(parsed, {
    title: bodyHeader.title,
    date: bodyHeader.date,
    overview: bodyHeader.overview,
    status: bodyHeader.status,
    overallDecision: bodyHeader.overallDecision,
    scopeMarkdown: extractInitialReviewScope(body),
    locale: localeFromHeading
  });

  return { body, snapshot };
}

function loadReviewDocumentState(content: string): ReviewDocumentV4State {
  const normalized = normalizeLineEndings(content).trim();
  const detectedFormat = detectReviewDocumentFormat(normalized);

  if (detectedFormat === 'v4') {
    const parsed = parseV4SnapshotSection(normalized);
    return {
      snapshot: parsed.snapshot,
      body: parsed.body,
      detectedFormat
    };
  }

  if (detectedFormat === 'v3') {
    const v3State = loadReviewDocumentV3State(normalized);
    const snapshot = convertV3StateToSnapshot(v3State);
    return {
      snapshot,
      body: renderReviewDocumentBody(snapshot),
      detectedFormat
    };
  }

  if (detectedFormat === 'v2') {
    const v3State = migrateLegacyDocumentToV3(normalized);
    const snapshot = convertV3StateToSnapshot(v3State);
    return {
      snapshot,
      body: renderReviewDocumentBody(snapshot),
      detectedFormat
    };
  }

  throw new Error('Unknown review document format.');
}

function validateMetadataCompat(metadata: ReviewDocumentMetadataV3): ReviewValidationIssue[] {
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

  return issues;
}

function validateV4Document(content: string): ReviewValidationResult {
  const normalized = normalizeLineEndings(content).trim();
  const issues: ReviewValidationIssue[] = [];

  const snapshotSectionCount = countSnapshotSectionHeadings(normalized);
  if (snapshotSectionCount !== 1) {
    issues.push({ severity: 'error', code: 'snapshot_section_count', message: 'Review document must contain exactly one Review Snapshot section.' });
  }

  // 只统计 Snapshot 区内的 json 围栏数量：正文（里程碑摘要、finding 描述等）
  // 可能包含 ```json 代码块，全文计数会把它们误算进去。
  // 按行统计行首围栏（围栏行尾显式锚定 \n，尾部空白仅 [ \t]，避免
  // U+2028/U+2029 行分隔符假阳性）：Snapshot JSON blob 经 stringify 后
  // 字符串值里的 ```json 不会位于行首，子串计数会把它们误算进去。
  const snapshotSection = findLastSnapshotSectionRange(normalized);
  const jsonFenceCount = snapshotSection
    ? countJsonFenceLines(snapshotSection.body)
    : 0;
  if (jsonFenceCount !== 1) {
    issues.push({ severity: 'error', code: 'snapshot_json_fence_count', message: 'Review document must contain exactly one trailing json code block for Review Snapshot.' });
  }

  let parsed: ReviewDocumentV4State | undefined;
  try {
    parsed = loadReviewDocumentState(normalized);
  } catch (error: any) {
    return {
      detectedFormat: 'v4',
      formatVersion: 4,
      isValid: false,
      canAutoUpgrade: false,
      issues: [
        ...issues,
        { severity: 'error', code: 'invalid_snapshot_json', message: error?.message || String(error) }
      ]
    };
  }

  const compatMetadata = snapshotToMetadataCompat(parsed.snapshot);
  issues.push(...validateMetadataCompat(compatMetadata));

  const locale = resolveReviewDocumentLocale(parsed.snapshot.render.locale, 'en');
  if (!detectSectionOrder(normalized, getV4BodySectionOrder(locale))) {
    issues.push({ severity: 'error', code: 'non_canonical_section_order', message: 'Visible review sections are not in canonical order.' });
  }

  const expectedBody = renderReviewDocumentBody(parsed.snapshot).trim();
  const actualBody = parsed.body.trim();
  if (actualBody !== expectedBody) {
    issues.push({ severity: 'warning', code: 'body_out_of_sync_with_snapshot', message: 'Review document body is out of sync with the trailing Review Snapshot JSON for the stored locale.' });
  }

  if (parsed.snapshot.render.bodyHash !== hashText(renderReviewDocumentBody(parsed.snapshot))) {
    issues.push({ severity: 'warning', code: 'body_hash_mismatch', message: 'Review Snapshot render.bodyHash does not match the rendered document body.' });
  }

  const derivedStats = buildSummaryFromSnapshot(parsed.snapshot);
  if (
    parsed.snapshot.stats.totalMilestones !== derivedStats.totalMilestones
    || parsed.snapshot.stats.completedMilestones !== derivedStats.completedMilestones
    || parsed.snapshot.stats.totalFindings !== derivedStats.totalFindings
    || parsed.snapshot.stats.severity.high !== derivedStats.findingsBySeverity.high
    || parsed.snapshot.stats.severity.medium !== derivedStats.findingsBySeverity.medium
    || parsed.snapshot.stats.severity.low !== derivedStats.findingsBySeverity.low
  ) {
    issues.push({ severity: 'warning', code: 'stats_out_of_sync', message: 'Review Snapshot stats are out of sync with milestones or findings.' });
  }

  for (const finding of parsed.snapshot.findings) {
    if (isFindingTitleNotConcise(finding.title)) {
      issues.push({
        severity: 'warning',
        code: 'finding_title_not_concise',
        message: `Finding \`${finding.id}\` has an overloaded title. Keep the title concise, and move file paths, detailed explanation, and recommendations into description, evidence, or recommendation fields.`
      });
    }
    if (isFindingTitleRepeatingDescription(finding.title, finding.descriptionMarkdown)) {
      issues.push({
        severity: 'warning',
        code: 'finding_title_repeats_description',
        message: `Finding \`${finding.id}\` repeats the same content in title and description. Keep the title short and move detailed text into description.`
      });
    }
  }

  return {
    detectedFormat: 'v4',
    formatVersion: 4,
    isValid: issues.every((item) => item.severity !== 'error'),
    canAutoUpgrade: issues.some((item) => AUTO_FIXABLE_V4_CODES.has(item.code)),
    issues,
    metadata: compatMetadata,
    reviewSnapshot: parsed.snapshot
  };
}

function createInitialSnapshot(input: ReviewDocumentTemplateInput, locale: ReviewDocumentLocale = 'en'): ReviewSnapshotV4 {
  const title = normalizeSingleLineText(input.title) || 'Review';
  const overview = normalizeSingleLineText(input.overview) || 'Workspace review';
  const review = normalizeMarkdownText(input.review) || getLocalizedDefaultReviewScope(resolveReviewDocumentLocale(locale, 'en'));
  const date = normalizeSingleLineText(input.date) || formatDate();
  const createdAt = parseDateToIsoStart(date);
  const renderLocale = resolveReviewDocumentLocale(locale, 'en');

  return normalizeReviewSnapshot({
    formatVersion: 4,
    kind: 'graycode.review',
    reviewRunId: generateReviewRunId(),
    createdAt,
    updatedAt: createdAt,
    finalizedAt: null,
    status: 'in_progress',
    overallDecision: null,
    header: {
      title,
      date,
      overview
    },
    scope: {
      markdown: review
    },
    summary: {
      latestConclusion: null,
      recommendedNextAction: null,
      reviewedModules: []
    },
    milestones: [],
    findings: [],
    render: {
      rendererVersion: REVIEW_SNAPSHOT_RENDERER_VERSION,
      bodyHash: '',
      generatedAt: createdAt,
      locale: renderLocale
    }
  });
}

export function detectReviewDocumentFormat(content: string): ReviewDocumentFormat {
  const normalized = normalizeLineEndings(content);
  // 只在 Snapshot 区内匹配末尾 json 围栏：围栏按行匹配（行首 ```json + 结尾 ```），
  // 正文中的 "## 标题 + ```json" 块不会再导致格式误判；
  // heading 与围栏之间允许空白/说明文字（手工编辑场景）。
  const snapshotSection = findLastSnapshotSectionRange(normalized.trim());
  const v4Json = snapshotSection
    ? extractV4SnapshotJson(snapshotSection.body)
    : undefined;
  if (v4Json) {
    try {
      const parsed = JSON.parse(v4Json.trim());
      const record = asRecord(parsed);
      if (record?.kind === 'graycode.review' && record?.formatVersion === 4) {
        return 'v4';
      }
    } catch {
      // ignore and continue detection
    }
  }
  if (normalized.includes(REVIEW_METADATA_START) && normalized.includes(REVIEW_METADATA_END)) {
    return 'v3';
  }

  const allScopeHeadings = [
    REVIEW_SCOPE_SECTION_TITLE,
    ...REVIEW_DOCUMENT_LOCALES.map((locale) => getReviewSectionHeadings(locale).scope)
  ];
  if (
    /^#\s+/m.test(normalized)
    && (
      /^- Date:\s+/m.test(normalized)
      || allScopeHeadings.some((heading) => normalized.includes(heading))
      || normalized.includes(REVIEW_SUMMARY_START)
    )
  ) {
    return 'v2';
  }
  return 'unknown';
}

export function validateReviewDocument(content: string): ReviewValidationResult {
  const normalized = normalizeLineEndings(content).trim();
  const detectedFormat = detectReviewDocumentFormat(normalized);

  if (detectedFormat === 'v4') {
    return validateV4Document(normalized);
  }

  if (detectedFormat === 'v3') {
    const state = loadReviewDocumentV3State(normalized);
    const snapshot = convertV3StateToSnapshot(state);
    return {
      detectedFormat,
      formatVersion: 3,
      isValid: true,
      canAutoUpgrade: true,
      issues: [{ severity: 'warning', code: 'upgrade_required', message: 'Review document uses legacy V3 format and can be upgraded to V4.' }],
      metadata: state.metadata,
      reviewSnapshot: snapshot
    };
  }

  if (detectedFormat === 'v2') {
    const state = migrateLegacyDocumentToV3(normalized);
    const snapshot = convertV3StateToSnapshot(state);
    return {
      detectedFormat,
      formatVersion: 2,
      isValid: true,
      canAutoUpgrade: true,
      issues: [{ severity: 'warning', code: 'upgrade_required', message: 'Review document is a legacy format and can be upgraded to V4.' }],
      metadata: state.metadata,
      reviewSnapshot: snapshot
    };
  }

  return {
    detectedFormat,
    formatVersion: null,
    isValid: false,
    canAutoUpgrade: false,
    issues: [{ severity: 'error', code: 'unknown_review_format', message: 'Review document does not match the expected Review format.' }]
  };
}

export function summarizeReviewDocument(content: string): ReviewDocumentSummarySnapshot {
  const state = loadReviewDocumentState(content);
  return buildSummaryFromSnapshot(state.snapshot);
}

function ensureValidRenderedDocument(content: string): ReviewValidationResult {
  const validation = validateReviewDocument(content);
  const errors = validation.issues.filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map((item) => item.message).join(' '));
  }
  return validation;
}

export function upgradeReviewDocumentToV4(content: string): string {
  const state = loadReviewDocumentState(content);
  return buildReviewDocument(state.snapshot);
}

export function upgradeReviewDocumentToV3(content: string): string {
  return upgradeReviewDocumentToV4(content);
}

export function normalizeReviewDocumentStructure(content: string): string {
  return upgradeReviewDocumentToV4(content);
}

export function ensureReviewDocumentSections(content: string): string {
  return normalizeReviewDocumentStructure(content);
}

export function getNextReviewMilestoneId(content: string): string {
  const state = loadReviewDocumentState(content);
  // 修改原因：旧实现直接按 milestones.length + 1 生成，文档里已有非连续/手动编号
  //          （如删过里程碑或存在 M3、M5）时会生成重复 id。
  // 修改方式：复用 appendReviewMilestone 的 nextMilestoneId 查重逻辑，
  //          从 indexHint 开始递增直到找到未占用编号。
  const existingMilestoneIds = new Set(state.snapshot.milestones.map((item) => item.id));
  return nextMilestoneId(existingMilestoneIds, state.snapshot.milestones.length + 1);
}

export function buildInitialReviewDocument(input: ReviewDocumentTemplateInput, locale: ReviewDocumentLocale = 'en'): string {
  const snapshot = createInitialSnapshot(input, locale);
  const content = buildReviewDocument(snapshot);
  ensureValidRenderedDocument(content);
  return content;
}

export function appendReviewMilestone(content: string, input: ReviewMilestoneInput, locale?: ReviewDocumentLocale): {
  content: string;
  milestoneId: string;
  milestoneCount: number;
  completedMilestones: number;
  findings: string[];
  structuredFindings: ReviewFindingInput[];
  reviewedModules: string[];
  addedFindingIds: string[];
  reviewSnapshot: ReviewSnapshotV4;
} {
  const state = loadReviewDocumentState(content);

  if (state.snapshot.status === 'completed') {
    throw new Error('Cannot record a milestone for a finalized review document.');
  }

  const existingMilestoneIds = new Set(state.snapshot.milestones.map((item) => item.id));
  const milestoneId = normalizeSingleLineText(input.milestoneId)
    || nextMilestoneId(existingMilestoneIds, state.snapshot.milestones.length + 1);
  if (state.snapshot.milestones.some((item) => item.id === milestoneId)) {
    throw new Error(`Duplicate milestone id is not allowed: ${milestoneId}`);
  }

  const milestoneTitle = normalizeSingleLineText(input.milestoneTitle) || milestoneId;
  const summaryMarkdown = normalizeMarkdownText(input.summary) || milestoneTitle;
  // 无 conclusion 时直接回退到 summaryMarkdown，避免把多行 summary 压成单行
  const conclusionMarkdown = normalizeMarkdownText(input.conclusion)
    || summaryMarkdown
    || milestoneTitle;
  const evidenceFiles = normalizeStringList(input.evidenceFiles);
  const evidence = mergeEvidenceRefs(normalizeEvidenceRefs(input.evidence), evidenceFilesToRefs(evidenceFiles));
  const renderLocale = resolveReviewDocumentLocale(locale ?? state.snapshot.render.locale, 'en');
  const reviewedModules = normalizeStringList(input.reviewedModules);
  const recommendedNextAction = normalizeNullableMarkdown(input.recommendedNextAction);
  const recordedAt = normalizeSingleLineText(input.recordedAt) || formatDateTime();

  const incomingFindings = [
    ...normalizeStringList(input.findings).map((item) => convertLegacyFindingToStructured(item, milestoneId, evidenceFiles)),
    ...(Array.isArray(input.structuredFindings)
      ? input.structuredFindings.map((item) => normalizeFindingInput(item, milestoneId, evidenceFiles))
      : [])
  ];
  const mergedFindingsResult = mergeFindingRecords(state.snapshot.findings, incomingFindings);
  const mergedFindings = mergedFindingsResult.findings;
  const linkedFindingIds = mergedFindings
    .filter((item) => item.relatedMilestoneIds.includes(milestoneId))
    .map((item) => item.id);

  const nextSnapshot = normalizeReviewSnapshot({
    ...state.snapshot,
    updatedAt: recordedAt,
    finalizedAt: null,
    status: 'in_progress',
    summary: {
      ...state.snapshot.summary,
      latestConclusion: conclusionMarkdown || state.snapshot.summary.latestConclusion,
      recommendedNextAction: recommendedNextAction || state.snapshot.summary.recommendedNextAction,
      reviewedModules: uniqueStrings([...state.snapshot.summary.reviewedModules, ...reviewedModules])
    },
    milestones: [
      ...state.snapshot.milestones,
      {
        id: milestoneId,
        title: milestoneTitle,
        status: normalizeMilestoneStatus(input.status),
        recordedAt,
        summaryMarkdown,
        conclusionMarkdown,
        evidence,
        reviewedModules,
        recommendedNextAction,
        findingIds: linkedFindingIds
      }
    ],
    findings: mergedFindings,
    render: {
      ...state.snapshot.render,
      generatedAt: recordedAt,
      locale: renderLocale
    }
  });

  const rendered = buildReviewDocument(nextSnapshot);
  const validation = ensureValidRenderedDocument(rendered);
  const finalSnapshot = validation.reviewSnapshot || nextSnapshot;

  return {
    content: rendered,
    milestoneId,
    milestoneCount: finalSnapshot.stats.totalMilestones,
    completedMilestones: finalSnapshot.stats.completedMilestones,
    findings: finalSnapshot.findings.map((item) => formatFindingSummaryText(snapshotFindingToInput(item))),
    structuredFindings: finalSnapshot.findings.map((item) => snapshotFindingToInput(item)),
    reviewedModules: finalSnapshot.summary.reviewedModules,
    addedFindingIds: mergedFindingsResult.addedFindingIds,
    reviewSnapshot: finalSnapshot
  };
}

export function finalizeReviewDocument(content: string, input: ReviewFinalizeInput, locale?: ReviewDocumentLocale): {
  content: string;
  milestoneCount: number;
  completedMilestones: number;
  findings: string[];
  structuredFindings: ReviewFindingInput[];
  reviewedModules: string[];
  overallDecision?: ReviewOverallDecision;
  reviewSnapshot: ReviewSnapshotV4;
} {
  const state = loadReviewDocumentState(content);
  const reviewedModules = normalizeStringList(input.reviewedModules);
  const finalizedAt = formatDateTime();
  const renderLocale = resolveReviewDocumentLocale(locale ?? state.snapshot.render.locale, 'en');

  const nextSnapshot = normalizeReviewSnapshot({
    ...state.snapshot,
    updatedAt: finalizedAt,
    finalizedAt,
    status: 'completed',
    overallDecision: normalizeOverallDecision(input.overallDecision) || state.snapshot.overallDecision,
    summary: {
      ...state.snapshot.summary,
      latestConclusion: normalizeMarkdownText(input.conclusion) || state.snapshot.summary.latestConclusion,
      recommendedNextAction: normalizeMarkdownText(input.recommendedNextAction) || state.snapshot.summary.recommendedNextAction,
      reviewedModules: uniqueStrings([...state.snapshot.summary.reviewedModules, ...reviewedModules])
    },
    render: {
      ...state.snapshot.render,
      generatedAt: finalizedAt,
      locale: renderLocale
    }
  });

  const rendered = buildReviewDocument(nextSnapshot);
  const validation = ensureValidRenderedDocument(rendered);
  const finalSnapshot = validation.reviewSnapshot || nextSnapshot;

  return {
    content: rendered,
    milestoneCount: finalSnapshot.stats.totalMilestones,
    completedMilestones: finalSnapshot.stats.completedMilestones,
    findings: finalSnapshot.findings.map((item) => formatFindingSummaryText(snapshotFindingToInput(item))),
    structuredFindings: finalSnapshot.findings.map((item) => snapshotFindingToInput(item)),
    reviewedModules: finalSnapshot.summary.reviewedModules,
    overallDecision: finalSnapshot.overallDecision || undefined,
    reviewSnapshot: finalSnapshot
  };
}

export function reopenReviewDocument(content: string, locale?: ReviewDocumentLocale): {
  content: string;
  milestoneCount: number;
  completedMilestones: number;
  findings: string[];
  structuredFindings: ReviewFindingInput[];
  reviewedModules: string[];
  reviewSnapshot: ReviewSnapshotV4;
} {
  const state = loadReviewDocumentState(content);
  if (state.snapshot.status !== 'completed') {
    throw new Error('Cannot reopen a review document that is not finalized.');
  }

  const reopenedAt = formatDateTime();
  const renderLocale = resolveReviewDocumentLocale(locale ?? state.snapshot.render.locale, 'en');
  const nextSnapshot = normalizeReviewSnapshot({
    ...state.snapshot,
    updatedAt: reopenedAt,
    finalizedAt: null,
    status: 'in_progress',
    overallDecision: null,
    render: {
      ...state.snapshot.render,
      generatedAt: reopenedAt,
      locale: renderLocale
    }
  });

  const rendered = buildReviewDocument(nextSnapshot);
  const validation = ensureValidRenderedDocument(rendered);
  const finalSnapshot = validation.reviewSnapshot || nextSnapshot;

  return {
    content: rendered,
    milestoneCount: finalSnapshot.stats.totalMilestones,
    completedMilestones: finalSnapshot.stats.completedMilestones,
    findings: finalSnapshot.findings.map((item) => formatFindingSummaryText(snapshotFindingToInput(item))),
    structuredFindings: finalSnapshot.findings.map((item) => snapshotFindingToInput(item)),
    reviewedModules: finalSnapshot.summary.reviewedModules,
    reviewSnapshot: finalSnapshot
  };
}
