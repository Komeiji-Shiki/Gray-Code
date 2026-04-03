/**
 * Progress 自动联动辅助函数
 *
 * 用于在 design / plan 文档成功写入后，自动同步 `.limcode/progress.md`。
 * 该同步是 best-effort：失败时只返回 warning，不阻断主工具成功。
 */

import * as vscode from 'vscode';
import { getAllWorkspaces, resolveUriWithInfo } from '../utils';
import { buildProgressDocument, validateProgressDocument } from './documentLayout';
import { ensureParentDir, isProgressModePathAllowedWithMultiRoot } from './pathUtils';
import type { ProgressDocumentMetadataV1, ProgressTodoItem } from './schema';

interface SyncProgressFromDesignArtifactArgs {
  designPath: string;
  title?: string;
}

interface SyncProgressFromPlanArtifactArgs {
  planPath: string;
  title?: string;
  todos?: ProgressTodoItem[];
  updateMode?: 'revision' | 'progress_sync';
}

interface SyncProgressFromReviewArtifactArgs {
  reviewPath: string;
  title?: string;
  latestConclusion?: string;
  nextAction?: string;
  eventMessage?: string;
}

function normalizeSingleLineText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function slugify(input: string): string {
  const source = (input || '').trim().toLowerCase();
  const slug = source
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'project';
}

function getWorkspaceDisplayName(): string | undefined {
  const workspace = getAllWorkspaces()[0];
  return typeof workspace?.name === 'string' && workspace.name.trim()
    ? workspace.name.trim()
    : undefined;
}

function resolveProgressPathForArtifact(artifactPath: string): string {
  const normalized = (artifactPath || '').replace(/\\/g, '/');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    const workspacePrefix = normalized.slice(0, slashIndex);
    const rest = normalized.slice(slashIndex + 1);
    if (
      workspacePrefix !== '.' &&
      workspacePrefix !== '..' &&
      !workspacePrefix.includes(':') &&
      rest.startsWith('.limcode/')
    ) {
      return `${workspacePrefix}/.limcode/progress.md`;
    }
  }
  return '.limcode/progress.md';
}

async function loadExistingProgress(progressPath: string): Promise<{
  metadata?: ProgressDocumentMetadataV1;
  missing: boolean;
  error?: string;
}> {
  const { uri, error } = resolveUriWithInfo(progressPath);
  if (!uri) {
    return { missing: false, error: error || 'No workspace folder open' };
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString('utf-8');
    const validation = validateProgressDocument(content);
    if (!validation.success) {
      return { missing: false, error: 'error' in validation ? validation.error : 'Failed to validate progress document' };
    }
    return { metadata: validation.metadata, missing: false };
  } catch (e: any) {
    const message = String(e?.message || '');
    if (/enoent|not exist|file not found/i.test(message)) {
      return { missing: true };
    }
    return { missing: false, error: message || `Failed to read progress document: ${progressPath}` };
  }
}

async function writeProgress(progressPath: string, metadata: Partial<ProgressDocumentMetadataV1>, now: string): Promise<void> {
  if (!isProgressModePathAllowedWithMultiRoot(progressPath)) {
    throw new Error(`Invalid progress path. Only ".limcode/progress.md" is allowed. Rejected path: ${progressPath}`);
  }

  const { uri, error } = resolveUriWithInfo(progressPath);
  if (!uri) {
    throw new Error(error || 'No workspace folder open');
  }

  await ensureParentDir(uri.fsPath);
  const { content } = buildProgressDocument(metadata, { generatedAt: now });
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

function buildInitialProgressMetadata(now: string, progressPath: string): Partial<ProgressDocumentMetadataV1> {
  const projectName = getWorkspaceDisplayName();
  return {
    projectId: slugify(projectName || progressPath),
    projectName,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    phase: 'design',
    activeArtifacts: {},
    todos: [],
    milestones: [],
    risks: [],
    log: [{
      at: now,
      type: 'created',
      message: '初始化项目进度'
    }]
  };
}

export async function syncProgressFromDesignArtifact(
  args: SyncProgressFromDesignArtifactArgs
): Promise<string[]> {
  const designPath = normalizeSingleLineText(args.designPath);
  if (!designPath) return [];

  const progressPath = resolveProgressPathForArtifact(designPath);
  const now = new Date().toISOString();

  try {
    const loaded = await loadExistingProgress(progressPath);
    if (loaded.error) {
      return [`Failed to auto-sync progress after design write: ${loaded.error}`];
    }

    const base = loaded.missing || !loaded.metadata
      ? buildInitialProgressMetadata(now, progressPath)
      : loaded.metadata;

    const nextMetadata: Partial<ProgressDocumentMetadataV1> = {
      ...base,
      updatedAt: now,
      phase: loaded.missing ? 'design' : base.phase,
      currentFocus: loaded.missing && normalizeSingleLineText(args.title)
        ? normalizeSingleLineText(args.title)
        : base.currentFocus,
      activeArtifacts: {
        ...(base.activeArtifacts || {}),
        design: designPath,
      },
      log: [
        ...(base.log || []),
        {
          at: now,
          type: 'artifact_changed',
          refId: 'design',
          message: `同步设计文档：${designPath}`,
        }
      ]
    };

    await writeProgress(progressPath, nextMetadata, now);
    return [];
  } catch (e: any) {
    return [`Failed to auto-sync progress after design write: ${e?.message || String(e)}`];
  }
}

export async function syncProgressFromPlanArtifact(
  args: SyncProgressFromPlanArtifactArgs
): Promise<string[]> {
  const planPath = normalizeSingleLineText(args.planPath);
  if (!planPath) return [];

  const progressPath = resolveProgressPathForArtifact(planPath);
  const now = new Date().toISOString();
  const updateMode = args.updateMode === 'progress_sync' ? 'progress_sync' : 'revision';

  try {
    const loaded = await loadExistingProgress(progressPath);
    if (loaded.error) {
      return [`Failed to auto-sync progress after plan write: ${loaded.error}`];
    }

    const base = loaded.missing || !loaded.metadata
      ? {
        ...buildInitialProgressMetadata(now, progressPath),
        phase: updateMode === 'progress_sync' ? 'implementation' : 'plan',
      }
      : loaded.metadata;

    const currentPhase = base.phase as ProgressDocumentMetadataV1['phase'] | undefined;
    const nextPhase: ProgressDocumentMetadataV1['phase'] | undefined = loaded.missing
      ? (updateMode === 'progress_sync' ? 'implementation' : 'plan')
      : updateMode === 'progress_sync'
        ? currentPhase
        : (currentPhase === 'design' || currentPhase === 'plan' ? 'plan' : currentPhase);

    const nextMetadata: Partial<ProgressDocumentMetadataV1> = {
      ...base,
      updatedAt: now,
      phase: nextPhase,
      currentFocus: !base.currentFocus && normalizeSingleLineText(args.title)
        ? normalizeSingleLineText(args.title)
        : base.currentFocus,
      activeArtifacts: {
        ...(base.activeArtifacts || {}),
        plan: planPath,
      },
      todos: Array.isArray(args.todos) ? args.todos : base.todos,
      log: [
        ...(base.log || []),
        {
          at: now,
          type: 'artifact_changed',
          refId: 'plan',
          message: updateMode === 'progress_sync'
            ? `同步计划 TODO 快照：${planPath}`
            : `同步计划文档：${planPath}`,
        }
      ]
    };

    await writeProgress(progressPath, nextMetadata, now);
    return [];
  } catch (e: any) {
    return [`Failed to auto-sync progress after plan write: ${e?.message || String(e)}`];
  }
}

export async function syncProgressFromReviewArtifact(
  args: SyncProgressFromReviewArtifactArgs
): Promise<string[]> {
  const reviewPath = normalizeSingleLineText(args.reviewPath);
  if (!reviewPath) return [];

  const progressPath = resolveProgressPathForArtifact(reviewPath);
  const now = new Date().toISOString();

  try {
    const loaded = await loadExistingProgress(progressPath);
    if (loaded.error) {
      return [`Failed to auto-sync progress after review write: ${loaded.error}`];
    }

    const base = loaded.missing || !loaded.metadata
      ? {
        ...buildInitialProgressMetadata(now, progressPath),
        phase: 'review' as const,
      }
      : loaded.metadata;

    const nextMetadata: Partial<ProgressDocumentMetadataV1> = {
      ...base,
      updatedAt: now,
      phase: loaded.missing ? 'review' : base.phase,
      currentFocus: !base.currentFocus && normalizeSingleLineText(args.title)
        ? normalizeSingleLineText(args.title)
        : base.currentFocus,
      latestConclusion: normalizeSingleLineText(args.latestConclusion)
        ? args.latestConclusion
        : base.latestConclusion,
      nextAction: normalizeSingleLineText(args.nextAction)
        ? args.nextAction
        : base.nextAction,
      activeArtifacts: {
        ...(base.activeArtifacts || {}),
        review: reviewPath,
      },
      log: [
        ...(base.log || []),
        {
          at: now,
          type: 'artifact_changed',
          refId: 'review',
          message: args.eventMessage || `同步审查文档：${reviewPath}`,
        }
      ]
    };

    await writeProgress(progressPath, nextMetadata, now);
    return [];
  } catch (e: any) {
    return [`Failed to auto-sync progress after review write: ${e?.message || String(e)}`];
  }
}
