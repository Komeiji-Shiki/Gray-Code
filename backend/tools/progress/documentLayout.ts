/**
 * Progress 文档布局与校验辅助函数
 */

import { createHash } from 'crypto';
import { normalizeLineEndingsToLF } from '../utils';
import {
  MAX_PROGRESS_LOG_ENTRIES,
  PROGRESS_ARTIFACTS_END,
  PROGRESS_ARTIFACTS_SECTION_TITLE,
  PROGRESS_ARTIFACTS_START,
  PROGRESS_DOCUMENT_TITLE,
  PROGRESS_LOG_END,
  PROGRESS_LOG_SECTION_TITLE,
  PROGRESS_LOG_START,
  PROGRESS_METADATA_END,
  PROGRESS_METADATA_START,
  PROGRESS_MILESTONES_END,
  PROGRESS_MILESTONES_SECTION_TITLE,
  PROGRESS_MILESTONES_START,
  PROGRESS_RENDERER_VERSION,
  PROGRESS_RISKS_END,
  PROGRESS_RISKS_SECTION_TITLE,
  PROGRESS_RISKS_START,
  PROGRESS_SUMMARY_END,
  PROGRESS_SUMMARY_SECTION_TITLE,
  PROGRESS_SUMMARY_START,
  PROGRESS_TODOS_END,
  PROGRESS_TODOS_SECTION_TITLE,
  PROGRESS_TODOS_START,
  type ProgressArtifactRef,
  type ProgressDocumentMetadataV1,
  type ProgressLogItem,
  type ProgressLogType,
  type ProgressMilestoneRecord,
  type ProgressMilestoneStatus,
  type ProgressPhase,
  type ProgressRiskItem,
  type ProgressRiskStatus,
  type ProgressStats,
  type ProgressStatus,
  type ProgressTodoItem,
  type ProgressTodoStatus,
  type ProgressValidationIssue,
  type ProgressValidationSummaryV1,
} from './schema';

function normalizeSingleLineText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeMarkdownBlock(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeLineEndingsToLF(value).trim();
  return normalized || null;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  const normalized = normalizeSingleLineText(value);
  return normalized || fallback;
}

function getDuplicateIds(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rawId = (item as Record<string, unknown>).id;
    const id = normalizeSingleLineText(rawId);
    if (!id) continue;
    if (seen.has(id)) {
      duplicates.add(id);
      continue;
    }
    seen.add(id);
  }

  return Array.from(duplicates).map((id) => `${fieldName}:${id}`);
}

function computeHash(content: string): string {
  const normalized = normalizeLineEndingsToLF(content || '').trim();
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function buildInlinePreview(value: string | null | undefined, maxChars = 180): string {
  const normalized = normalizeLineEndingsToLF(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

export function isProgressStatus(value: unknown): value is ProgressStatus {
  return value === 'active' || value === 'blocked' || value === 'completed' || value === 'archived';
}

export function isProgressPhase(value: unknown): value is ProgressPhase {
  return value === 'design' ||
    value === 'plan' ||
    value === 'implementation' ||
    value === 'review' ||
    value === 'maintenance';
}

export function isProgressTodoStatus(value: unknown): value is ProgressTodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled';
}

export function isProgressMilestoneStatus(value: unknown): value is ProgressMilestoneStatus {
  return value === 'in_progress' || value === 'completed';
}

export function isProgressRiskStatus(value: unknown): value is ProgressRiskStatus {
  return value === 'active' || value === 'resolved' || value === 'accepted';
}

export function isProgressLogType(value: unknown): value is ProgressLogType {
  return value === 'created' ||
    value === 'updated' ||
    value === 'milestone_recorded' ||
    value === 'artifact_changed' ||
    value === 'risk_changed';
}

export function normalizeOptionalProgressText(value: unknown): string | null {
  return normalizeMarkdownBlock(value);
}

export function normalizeOptionalProgressSingleLineText(value: unknown): string | null {
  const normalized = normalizeSingleLineText(value);
  return normalized || null;
}

export function validateProgressTodosInput(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'todos must be an array';
  }

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return 'each todo must be an object';
    }
    const id = normalizeSingleLineText((item as Record<string, unknown>).id);
    const content = normalizeSingleLineText((item as Record<string, unknown>).content);
    const status = (item as Record<string, unknown>).status;
    if (!id) return 'todo.id must be a non-empty string';
    if (!content) return 'todo.content must be a non-empty string';
    if (!isProgressTodoStatus(status)) {
      return 'todo.status must be one of: pending, in_progress, completed, cancelled';
    }
  }

  const duplicates = getDuplicateIds(value, 'todo');
  if (duplicates.length > 0) {
    return `duplicate todo ids are not allowed: ${duplicates.join(', ')}`;
  }

  return null;
}

export function validateProgressRisksInput(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'risks must be an array';
  }

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return 'each risk must be an object';
    }
    const id = normalizeSingleLineText((item as Record<string, unknown>).id);
    const title = normalizeSingleLineText((item as Record<string, unknown>).title);
    const description = normalizeSingleLineText((item as Record<string, unknown>).description);
    const status = (item as Record<string, unknown>).status;
    if (!id) return 'risk.id must be a non-empty string';
    if (!title) return 'risk.title must be a non-empty string';
    if (!description) return 'risk.description must be a non-empty string';
    if (!isProgressRiskStatus(status)) {
      return 'risk.status must be one of: active, resolved, accepted';
    }
  }

  const duplicates = getDuplicateIds(value, 'risk');
  if (duplicates.length > 0) {
    return `duplicate risk ids are not allowed: ${duplicates.join(', ')}`;
  }

  return null;
}

export function validateProgressLogAppendInput(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'appendLog must be an array';
  }

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return 'each appendLog entry must be an object';
    }

    const type = (item as Record<string, unknown>).type;
    const message = normalizeSingleLineText((item as Record<string, unknown>).message);
    const refId = (item as Record<string, unknown>).refId;

    if (!isProgressLogType(type)) {
      return 'appendLog.type must be one of: created, updated, milestone_recorded, artifact_changed, risk_changed';
    }
    if (!message) {
      return 'appendLog.message must be a non-empty string';
    }
    if (refId !== undefined && typeof refId !== 'string') {
      return 'appendLog.refId must be a string when provided';
    }
  }

  return null;
}

export function normalizeProgressTodos(value: unknown): ProgressTodoItem[] {
  if (!Array.isArray(value)) return [];

  const byId = new Map<string, ProgressTodoItem>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const id = normalizeSingleLineText((item as Record<string, unknown>).id);
    const content = normalizeSingleLineText((item as Record<string, unknown>).content);
    const status = (item as Record<string, unknown>).status;
    if (!id || !content || !isProgressTodoStatus(status)) continue;

    byId.set(id, { id, content, status });
  }

  return Array.from(byId.values());
}

export function normalizeProgressRisks(value: unknown): ProgressRiskItem[] {
  if (!Array.isArray(value)) return [];

  const byId = new Map<string, ProgressRiskItem>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const id = normalizeSingleLineText((item as Record<string, unknown>).id);
    const title = normalizeSingleLineText((item as Record<string, unknown>).title);
    const description = normalizeSingleLineText((item as Record<string, unknown>).description);
    const status = (item as Record<string, unknown>).status;
    if (!id || !title || !description || !isProgressRiskStatus(status)) continue;

    byId.set(id, { id, title, description, status });
  }

  return Array.from(byId.values());
}

export function normalizeProgressLogEntries(value: unknown): ProgressLogItem[] {
  if (!Array.isArray(value)) return [];

  const entries: ProgressLogItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const at = normalizeSingleLineText((item as Record<string, unknown>).at);
    const type = (item as Record<string, unknown>).type;
    const refId = normalizeSingleLineText((item as Record<string, unknown>).refId) || undefined;
    const message = normalizeSingleLineText((item as Record<string, unknown>).message);
    if (!at || !message || !isProgressLogType(type)) continue;

    entries.push({ at, type, refId, message });
  }

  return entries.slice(-MAX_PROGRESS_LOG_ENTRIES);
}

function normalizeProgressArtifactRef(value: unknown): ProgressArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const next: ProgressArtifactRef = {};
  const design = normalizeSingleLineText((value as Record<string, unknown>).design);
  const plan = normalizeSingleLineText((value as Record<string, unknown>).plan);
  const review = normalizeSingleLineText((value as Record<string, unknown>).review);
  if (design) next.design = design;
  if (plan) next.plan = plan;
  if (review) next.review = review;
  return next;
}

function normalizeProgressMilestones(value: unknown): ProgressMilestoneRecord[] {
  if (!Array.isArray(value)) return [];

  const byId = new Map<string, ProgressMilestoneRecord>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const id = normalizeSingleLineText((item as Record<string, unknown>).id);
    const title = normalizeSingleLineText((item as Record<string, unknown>).title);
    const summary = normalizeMarkdownBlock((item as Record<string, unknown>).summary);
    const status = (item as Record<string, unknown>).status;
    const recordedAt = normalizeSingleLineText((item as Record<string, unknown>).recordedAt);
    if (!id || !title || !summary || !recordedAt || !isProgressMilestoneStatus(status)) continue;

    const rawRelatedTodoIds = (item as Record<string, unknown>).relatedTodoIds;
    const relatedTodoIds = Array.isArray(rawRelatedTodoIds)
      ? rawRelatedTodoIds
        .map((entry: unknown) => normalizeSingleLineText(entry))
        .filter(Boolean)
      : [];

    const rawRelatedReviewMilestoneIds = (item as Record<string, unknown>).relatedReviewMilestoneIds;
    const relatedReviewMilestoneIds = Array.isArray(rawRelatedReviewMilestoneIds)
      ? rawRelatedReviewMilestoneIds
        .map((entry: unknown) => normalizeSingleLineText(entry))
        .filter(Boolean)
      : [];

    byId.set(id, {
      id,
      title,
      status,
      summary,
      relatedTodoIds,
      relatedReviewMilestoneIds,
      relatedArtifacts: normalizeProgressArtifactRef((item as Record<string, unknown>).relatedArtifacts),
      startedAt: normalizeOptionalProgressSingleLineText((item as Record<string, unknown>).startedAt) || undefined,
      completedAt: normalizeOptionalProgressSingleLineText((item as Record<string, unknown>).completedAt) || undefined,
      recordedAt,
      nextAction: normalizeOptionalProgressText((item as Record<string, unknown>).nextAction)
    });
  }

  return Array.from(byId.values());
}

function computeProgressStats(
  todos: ProgressTodoItem[],
  milestones: ProgressMilestoneRecord[],
  risks: ProgressRiskItem[]
): ProgressStats {
  let todosCompleted = 0;
  let todosInProgress = 0;
  let todosCancelled = 0;
  for (const todo of todos) {
    if (todo.status === 'completed') todosCompleted++;
    if (todo.status === 'in_progress') todosInProgress++;
    if (todo.status === 'cancelled') todosCancelled++;
  }

  return {
    milestonesTotal: milestones.length,
    milestonesCompleted: milestones.filter((item) => item.status === 'completed').length,
    todosTotal: todos.length,
    todosCompleted,
    todosInProgress,
    todosCancelled,
    activeRisks: risks.filter((item) => item.status === 'active').length,
  };
}

function normalizeProgressMetadataInput(
  value: Partial<ProgressDocumentMetadataV1>,
  now: string
): ProgressDocumentMetadataV1 {
  const todos = normalizeProgressTodos(value.todos);
  const milestones = normalizeProgressMilestones(value.milestones);
  const risks = normalizeProgressRisks(value.risks);
  const log = normalizeProgressLogEntries(value.log);

  return {
    formatVersion: 1,
    kind: 'limcode.progress',
    projectId: normalizeSingleLineText(value.projectId) || 'project',
    projectName: normalizeOptionalProgressSingleLineText(value.projectName) || undefined,
    createdAt: normalizeTimestamp(value.createdAt, now),
    updatedAt: normalizeTimestamp(value.updatedAt, now),
    status: isProgressStatus(value.status) ? value.status : 'active',
    phase: isProgressPhase(value.phase) ? value.phase : 'implementation',
    currentFocus: normalizeOptionalProgressSingleLineText(value.currentFocus),
    latestConclusion: normalizeOptionalProgressText(value.latestConclusion),
    currentBlocker: normalizeOptionalProgressText(value.currentBlocker),
    nextAction: normalizeOptionalProgressText(value.nextAction),
    activeArtifacts: normalizeProgressArtifactRef(value.activeArtifacts),
    todos,
    milestones,
    risks,
    log,
    stats: computeProgressStats(todos, milestones, risks),
    render: {
      rendererVersion: PROGRESS_RENDERER_VERSION,
      generatedAt: normalizeTimestamp(value.render?.generatedAt, now),
      bodyHash: normalizeSingleLineText(value.render?.bodyHash),
    },
  };
}

export function getLatestProgressMilestone(
  metadata: ProgressDocumentMetadataV1
): ProgressMilestoneRecord | null {
  return metadata.milestones.length > 0
    ? metadata.milestones[metadata.milestones.length - 1]
    : null;
}

export function buildCurrentProgressText(metadata: ProgressDocumentMetadataV1): string {
  if (metadata.stats.milestonesTotal <= 0) {
    return '尚无里程碑记录';
  }

  const latestMilestone = getLatestProgressMilestone(metadata);
  return `${metadata.stats.milestonesCompleted}/${metadata.stats.milestonesTotal} 个里程碑已完成${latestMilestone ? `；最新：${latestMilestone.id}` : ''}`;
}

function renderSummarySection(metadata: ProgressDocumentMetadataV1): string {
  const lines: string[] = [
    `- 当前进度：${buildCurrentProgressText(metadata)}`,
  ];

  if (metadata.currentFocus) {
    lines.push(`- 当前焦点：${buildInlinePreview(metadata.currentFocus, 120)}`);
  }
  if (metadata.latestConclusion) {
    lines.push(`- 最新结论：${buildInlinePreview(metadata.latestConclusion, 180)}`);
  }
  if (metadata.currentBlocker) {
    lines.push(`- 当前阻塞：${buildInlinePreview(metadata.currentBlocker, 180)}`);
  }
  if (metadata.nextAction) {
    lines.push(`- 下一步：${buildInlinePreview(metadata.nextAction, 180)}`);
  }

  return [
    PROGRESS_SUMMARY_SECTION_TITLE,
    '',
    PROGRESS_SUMMARY_START,
    lines.join('\n'),
    PROGRESS_SUMMARY_END,
  ].join('\n');
}

function renderArtifactsSection(metadata: ProgressDocumentMetadataV1): string {
  const lines: string[] = [];
  if (metadata.activeArtifacts.design) lines.push(`- 设计：\`${metadata.activeArtifacts.design}\``);
  if (metadata.activeArtifacts.plan) lines.push(`- 计划：\`${metadata.activeArtifacts.plan}\``);
  if (metadata.activeArtifacts.review) lines.push(`- 审查：\`${metadata.activeArtifacts.review}\``);

  return [
    PROGRESS_ARTIFACTS_SECTION_TITLE,
    '',
    PROGRESS_ARTIFACTS_START,
    lines.length > 0 ? lines.join('\n') : '<!-- 暂无关联文档 -->',
    PROGRESS_ARTIFACTS_END,
  ].join('\n');
}

function renderTodoLine(todo: ProgressTodoItem): string {
  const checkbox = todo.status === 'completed' ? 'x' : ' ';
  const suffix = todo.status === 'in_progress'
    ? ' (in_progress)'
    : todo.status === 'cancelled'
      ? ' (cancelled)'
      : '';
  return `- [${checkbox}] ${todo.content}  \`#${todo.id}\`${suffix}`;
}

function renderTodosSection(metadata: ProgressDocumentMetadataV1): string {
  const lines = metadata.todos.map((todo) => renderTodoLine(todo));
  return [
    PROGRESS_TODOS_SECTION_TITLE,
    '',
    PROGRESS_TODOS_START,
    lines.length > 0 ? lines.join('\n') : '<!-- 暂无 TODO -->',
    PROGRESS_TODOS_END,
  ].join('\n');
}

function renderMilestone(metadata: ProgressMilestoneRecord): string {
  const lines: string[] = [
    `### ${metadata.id} · ${metadata.title}`,
    `- 状态：${metadata.status}`,
    `- 记录时间：${metadata.recordedAt}`,
  ];

  if (metadata.startedAt) {
    lines.push(`- 开始时间：${metadata.startedAt}`);
  }
  if (metadata.completedAt) {
    lines.push(`- 完成时间：${metadata.completedAt}`);
  }
  if (metadata.relatedTodoIds.length > 0) {
    lines.push(`- 关联 TODO：${metadata.relatedTodoIds.join(', ')}`);
  }
  if (metadata.relatedReviewMilestoneIds.length > 0) {
    lines.push(`- 关联审查里程碑：${metadata.relatedReviewMilestoneIds.join(', ')}`);
  }
  if (metadata.relatedArtifacts && Object.keys(metadata.relatedArtifacts).length > 0) {
    lines.push('- 关联文档：');
    if (metadata.relatedArtifacts.design) {
      lines.push(`  - 设计：\`${metadata.relatedArtifacts.design}\``);
    }
    if (metadata.relatedArtifacts.plan) {
      lines.push(`  - 计划：\`${metadata.relatedArtifacts.plan}\``);
    }
    if (metadata.relatedArtifacts.review) {
      lines.push(`  - 审查：\`${metadata.relatedArtifacts.review}\``);
    }
  }

  lines.push('- 摘要:');
  lines.push(metadata.summary);

  if (metadata.nextAction) {
    lines.push(`- 下一步：${buildInlinePreview(metadata.nextAction, 180)}`);
  }

  return lines.join('\n');
}

function renderMilestonesSection(metadata: ProgressDocumentMetadataV1): string {
  const body = metadata.milestones.length > 0
    ? metadata.milestones.map((item) => renderMilestone(item)).join('\n\n')
    : '<!-- 暂无里程碑 -->';

  return [
    PROGRESS_MILESTONES_SECTION_TITLE,
    '',
    PROGRESS_MILESTONES_START,
    body,
    PROGRESS_MILESTONES_END,
  ].join('\n');
}

function renderRisksSection(metadata: ProgressDocumentMetadataV1): string {
  const lines = metadata.risks.map((risk) => `- ${risk.id} | ${risk.status} | ${risk.title}：${risk.description}`);
  return [
    PROGRESS_RISKS_SECTION_TITLE,
    '',
    PROGRESS_RISKS_START,
    lines.length > 0 ? lines.join('\n') : '<!-- 暂无风险 -->',
    PROGRESS_RISKS_END,
  ].join('\n');
}

function renderLogSection(metadata: ProgressDocumentMetadataV1): string {
  const lines = metadata.log.map((item) => {
    const refPart = item.refId ? ` | ${item.refId}` : '';
    return `- ${item.at} | ${item.type}${refPart} | ${item.message}`;
  });

  return [
    PROGRESS_LOG_SECTION_TITLE,
    '',
    PROGRESS_LOG_START,
    lines.length > 0 ? lines.join('\n') : '<!-- 暂无更新 -->',
    PROGRESS_LOG_END,
  ].join('\n');
}

function renderMetadataSection(metadata: ProgressDocumentMetadataV1): string {
  return [
    PROGRESS_METADATA_START,
    JSON.stringify(metadata, null, 2),
    PROGRESS_METADATA_END,
  ].join('\n');
}

function buildVisibleContent(metadata: ProgressDocumentMetadataV1): string {
  const header = [
    PROGRESS_DOCUMENT_TITLE,
    `- Project: ${metadata.projectName || metadata.projectId}`,
    `- Updated At: ${metadata.updatedAt}`,
    `- Status: ${metadata.status}`,
    `- Phase: ${metadata.phase}`,
  ].join('\n');

  return [
    header,
    renderSummarySection(metadata),
    renderArtifactsSection(metadata),
    renderTodosSection(metadata),
    renderMilestonesSection(metadata),
    renderRisksSection(metadata),
    renderLogSection(metadata),
  ].join('\n\n').trimEnd();
}

export function buildProgressDocument(
  metadataInput: Partial<ProgressDocumentMetadataV1>,
  options: { generatedAt?: string } = {}
): { metadata: ProgressDocumentMetadataV1; content: string } {
  const now = normalizeSingleLineText(options.generatedAt) || new Date().toISOString();
  const baseMetadata = normalizeProgressMetadataInput(metadataInput, now);
  const visibleContent = buildVisibleContent(baseMetadata);
  const finalizedMetadata: ProgressDocumentMetadataV1 = {
    ...baseMetadata,
    render: {
      rendererVersion: PROGRESS_RENDERER_VERSION,
      generatedAt: now,
      bodyHash: computeHash(visibleContent),
    },
  };

  const content = `${buildVisibleContent(finalizedMetadata)}\n\n${renderMetadataSection(finalizedMetadata)}\n`;
  return { metadata: finalizedMetadata, content };
}

function extractMetadataPayload(content: string): string | null {
  const normalized = normalizeLineEndingsToLF(content || '');
  const start = normalized.indexOf(PROGRESS_METADATA_START);
  const end = start >= 0
    ? normalized.indexOf(PROGRESS_METADATA_END, start + PROGRESS_METADATA_START.length)
    : -1;

  if (start < 0 || end < 0 || end < start) {
    return null;
  }

  const payload = normalized
    .slice(start + PROGRESS_METADATA_START.length, end)
    .trim();
  return payload || null;
}

export function extractProgressMetadata(content: string): ProgressDocumentMetadataV1 | null {
  const payload = extractMetadataPayload(content);
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload) as Partial<ProgressDocumentMetadataV1>;
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeProgressMetadataInput(parsed, new Date().toISOString());
  } catch {
    return null;
  }
}

function ensureUniqueMarker(content: string, marker: string): { ok: true; index: number } | { ok: false; error: string } {
  const firstIndex = content.indexOf(marker);
  if (firstIndex < 0) {
    return { ok: false, error: `Missing marker: ${marker}` };
  }
  const lastIndex = content.lastIndexOf(marker);
  if (firstIndex !== lastIndex) {
    return { ok: false, error: `Marker must appear exactly once: ${marker}` };
  }
  return { ok: true, index: firstIndex };
}

function validateRawMetadata(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Progress metadata must be a JSON object';
  }

  const record = value as Record<string, unknown>;
  if (record.formatVersion !== 1) {
    return 'Progress metadata formatVersion must be 1';
  }
  if (record.kind !== 'limcode.progress') {
    return 'Progress metadata kind must be "limcode.progress"';
  }

  const duplicateTodoIds = getDuplicateIds(record.todos, 'todo');
  if (duplicateTodoIds.length > 0) {
    return `Duplicate todo ids detected: ${duplicateTodoIds.join(', ')}`;
  }

  const duplicateMilestoneIds = getDuplicateIds(record.milestones, 'milestone');
  if (duplicateMilestoneIds.length > 0) {
    return `Duplicate milestone ids detected: ${duplicateMilestoneIds.join(', ')}`;
  }

  const duplicateRiskIds = getDuplicateIds(record.risks, 'risk');
  if (duplicateRiskIds.length > 0) {
    return `Duplicate risk ids detected: ${duplicateRiskIds.join(', ')}`;
  }

  return null;
}

export function buildProgressValidationSummary(content: string): ProgressValidationSummaryV1 {
  const normalized = normalizeLineEndingsToLF(content || '');
  const payload = extractMetadataPayload(normalized);

  let formatVersion: number | null = null;
  if (payload) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      formatVersion = typeof parsed?.formatVersion === 'number' ? parsed.formatVersion : null;
    } catch {
      formatVersion = null;
    }
  }

  const validation = validateProgressDocument(normalized);
  if (validation.success) {
    return {
      isValid: true,
      formatVersion: formatVersion ?? validation.metadata.formatVersion,
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
      issues: [],
      metadata: validation.metadata,
    };
  }

  const issues: ProgressValidationIssue[] = [{ severity: 'error', code: 'progress_document_invalid', message: 'error' in validation ? validation.error : 'Progress document validation failed' }];
  return { isValid: false, formatVersion, issueCount: 1, errorCount: 1, warningCount: 0, issues };
}

export function validateProgressDocument(
  content: string
): { success: true; metadata: ProgressDocumentMetadataV1 } | { success: false; error: string } {
  const normalized = normalizeLineEndingsToLF(content || '');

  const orderedHeadings = [
    PROGRESS_SUMMARY_SECTION_TITLE,
    PROGRESS_ARTIFACTS_SECTION_TITLE,
    PROGRESS_TODOS_SECTION_TITLE,
    PROGRESS_MILESTONES_SECTION_TITLE,
    PROGRESS_RISKS_SECTION_TITLE,
    PROGRESS_LOG_SECTION_TITLE,
  ];

  let lastIndex = -1;
  for (const heading of orderedHeadings) {
    const headingIndex = normalized.indexOf(heading);
    if (headingIndex < 0) {
      return { success: false, error: `Missing section heading: ${heading}` };
    }
    if (headingIndex <= lastIndex) {
      return { success: false, error: `Progress document headings are out of order near: ${heading}` };
    }
    lastIndex = headingIndex;
  }

  const orderedMarkers = [
    PROGRESS_SUMMARY_START,
    PROGRESS_SUMMARY_END,
    PROGRESS_ARTIFACTS_START,
    PROGRESS_ARTIFACTS_END,
    PROGRESS_TODOS_START,
    PROGRESS_TODOS_END,
    PROGRESS_MILESTONES_START,
    PROGRESS_MILESTONES_END,
    PROGRESS_RISKS_START,
    PROGRESS_RISKS_END,
    PROGRESS_LOG_START,
    PROGRESS_LOG_END,
    PROGRESS_METADATA_START,
    PROGRESS_METADATA_END,
  ];

  lastIndex = -1;
  for (const token of orderedMarkers) {
    const markerCheck = ensureUniqueMarker(normalized, token)
    if (!markerCheck.ok) {
      return { success: false, error: 'error' in markerCheck ? markerCheck.error : `Missing marker: ${token}` };
    }
    if (markerCheck.index <= lastIndex) {
      return { success: false, error: `Progress document sections are out of order near token: ${token}` };
    }
    lastIndex = markerCheck.index;
  }

  const metadataPayload = extractMetadataPayload(normalized);
  if (!metadataPayload) {
    return { success: false, error: 'Progress document metadata block is missing or empty' };
  }

  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(metadataPayload);
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to parse progress metadata JSON' };
  }

  const metadataError = validateRawMetadata(rawMetadata);
  if (metadataError) {
    return { success: false, error: metadataError };
  }

  const metadata = normalizeProgressMetadataInput(rawMetadata as Partial<ProgressDocumentMetadataV1>, new Date().toISOString());
  const metadataEndIndex = normalized.indexOf(PROGRESS_METADATA_END);
  const tail = normalized.slice(metadataEndIndex + PROGRESS_METADATA_END.length).trim();
  if (tail) {
    return { success: false, error: 'Progress metadata block must be the last section in the document' };
  }

  return { success: true, metadata };
}
