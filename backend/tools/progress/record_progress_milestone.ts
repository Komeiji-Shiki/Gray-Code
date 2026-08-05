/**
 * record_progress_milestone 工具
 */

import * as vscode from 'vscode';
import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { resolveUriWithInfo } from '../utils';
import {
  buildProgressDocument,
  isProgressMilestoneStatus,
  normalizeOptionalProgressSingleLineText,
  validateProgressDocument,
} from './documentLayout';
import {
  ensureParentDir,
  isProgressModePathAllowedWithMultiRoot,
  normalizeProgressArtifactRef,
  validateProgressArtifactRefInput,
} from './pathUtils';
import { withProgressWriteLock } from './progressWriteLock';
import { projectProgressToolResultData } from './resultProjection';
import type {
  ProgressArtifactRef,
  ProgressMilestoneRecord,
  ProgressMilestoneStatus,
} from './schema';

export interface RecordProgressMilestoneArgs {
  path?: string;
  milestoneId?: string;
  title: string;
  status?: ProgressMilestoneStatus;
  summary: string;
  relatedTodoIds?: string[];
  relatedReviewMilestoneIds?: string[];
  relatedArtifacts?: Partial<ProgressArtifactRef>;
  startedAt?: string;
  completedAt?: string;
  nextAction?: string;
  latestConclusion?: string;
  currentBlocker?: string;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

function validateStringList(value: unknown, fieldName: string): string | null {
  if (!Array.isArray(value)) {
    return `${fieldName} must be an array`;
  }
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return `${fieldName} entries must be non-empty strings`;
    }
  }
  return null;
}

function generateNextMilestoneId(existing: ProgressMilestoneRecord[]): string {
  const existingIds = new Set(existing.map((item) => item.id.toLowerCase()));
  let max = 0;
  for (const milestone of existing) {
    const match = /^PG(\d+)$/i.exec(milestone.id);
    if (!match) continue;
    const numeric = Number(match[1]);
    if (Number.isFinite(numeric)) {
      max = Math.max(max, numeric);
    }
  }
  // 已有自定义 id（如 "M1"）时按 existing.length+1 起始可能撞车：
  // 从起点向上循环探测空闲编号，而不是一次性失败。
  let candidate = max > 0 ? max + 1 : existing.length + 1;
  while (existingIds.has(`pg${candidate}`)) {
    candidate++;
  }
  return `PG${candidate}`;
}

export function createRecordProgressMilestoneToolDeclaration(): ToolDeclaration {
  return {
    name: 'record_progress_milestone',
    strict: true,
    description:
      'Record a project milestone into .graycode/progress.md and refresh the latest progress snapshot. This is for project-level progress nodes, not for full review findings or plan documents.',
    category: 'progress',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional target path. Must be .graycode/progress.md (or multi-root: workspace/.graycode/progress.md).'
        },
        milestoneId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'completed'] },
        summary: { type: 'string' },
        relatedTodoIds: { type: 'array', items: { type: 'string' } },
        relatedReviewMilestoneIds: { type: 'array', items: { type: 'string' } },
        relatedArtifacts: {
          type: 'object',
          properties: {
            design: { type: 'string' },
            plan: { type: 'string' },
            review: { type: 'string' }
          }
        },
        startedAt: { type: 'string' },
        completedAt: { type: 'string' },
        nextAction: { type: 'string' },
        latestConclusion: { type: 'string' },
        currentBlocker: { type: 'string' }
      },
      required: ['title', 'summary']
    }
  };
}

export function createRecordProgressMilestoneTool(): Tool {
  return {
    declaration: createRecordProgressMilestoneToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> => {
      const args = rawArgs as unknown as RecordProgressMilestoneArgs;
      const targetPath = typeof args.path === 'string' && args.path.trim()
        ? args.path.trim()
        : '.graycode/progress.md';
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';

      if (!isProgressModePathAllowedWithMultiRoot(targetPath)) {
        return { success: false, error: `Invalid progress path. Only ".graycode/progress.md" is allowed. Rejected path: ${targetPath}` };
      }
      if (!title) {
        return { success: false, error: 'title is required and must be a non-empty string' };
      }
      if (!summary) {
        return { success: false, error: 'summary is required and must be a non-empty string' };
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'status') && !isProgressMilestoneStatus(args.status)) {
        return { success: false, error: 'status must be one of: in_progress, completed' };
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'relatedTodoIds')) {
        const error = validateStringList(args.relatedTodoIds, 'relatedTodoIds');
        if (error) return { success: false, error };
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'relatedReviewMilestoneIds')) {
        const error = validateStringList(args.relatedReviewMilestoneIds, 'relatedReviewMilestoneIds');
        if (error) return { success: false, error };
      }
      const artifactsError = validateProgressArtifactRefInput(args.relatedArtifacts, {
        fieldName: 'relatedArtifacts',
        allowEmptyString: true,
      });
      if (artifactsError) {
        return { success: false, error: artifactsError };
      }

      const { uri, error } = resolveUriWithInfo(targetPath, context?.activeWorkspaceUri);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      // 修改原因：progress.md 的「读 → 改 → 写」无锁，并行子代理同时 record milestone 会互相覆盖，
      //          丢失对方的 milestones/log 更新。
      // 修改方式：把整段读改写放进 per-path 写锁（progressWriteLock），后一个写入总是基于
      //          前一个写回后的盘面重新读取合并。
      // 修改目的：同一文件的写入按调用顺序串行，互不覆盖；不同文件之间互不阻塞。
      return withProgressWriteLock(targetPath, async (): Promise<ToolResult> => {
        let existingContent = '';
        try {
          const existingBytes = await vscode.workspace.fs.readFile(uri);
          existingContent = Buffer.from(existingBytes).toString('utf-8');
        } catch (e: any) {
          return { success: false, error: e?.message || `Progress document does not exist: ${targetPath}` };
        }

        const validation = validateProgressDocument(existingContent);
        if (!validation.success) {
          return { success: false, error: 'error' in validation ? validation.error : 'Failed to validate progress document' };
        }

        const currentMetadata = validation.metadata;
        const requestedMilestoneId = typeof args.milestoneId === 'string' && args.milestoneId.trim()
          ? args.milestoneId.trim()
          : '';
        const milestoneId = requestedMilestoneId || generateNextMilestoneId(currentMetadata.milestones);
        if (currentMetadata.milestones.some((item) => item.id === milestoneId)) {
          return { success: false, error: `Milestone id already exists: ${milestoneId}` };
        }

        const now = new Date().toISOString();
        const milestoneStatus: ProgressMilestoneStatus = isProgressMilestoneStatus(args.status)
          ? args.status
          : 'completed';

        const milestone: ProgressMilestoneRecord = {
          id: milestoneId,
          title,
          status: milestoneStatus,
          summary,
          relatedTodoIds: normalizeStringList(args.relatedTodoIds),
          relatedReviewMilestoneIds: normalizeStringList(args.relatedReviewMilestoneIds),
          relatedArtifacts: normalizeProgressArtifactRef(args.relatedArtifacts),
          startedAt: normalizeOptionalProgressSingleLineText(args.startedAt) || undefined,
          completedAt: milestoneStatus === 'completed'
            ? (normalizeOptionalProgressSingleLineText(args.completedAt) || now)
            : undefined,
          recordedAt: now,
          nextAction: typeof args.nextAction === 'string' && args.nextAction.trim()
            ? args.nextAction.trim()
            : null,
        };

        const nextMetadata = {
          ...currentMetadata,
          updatedAt: now,
          latestConclusion: Object.prototype.hasOwnProperty.call(rawArgs, 'latestConclusion')
            ? args.latestConclusion
            : currentMetadata.latestConclusion,
          currentBlocker: Object.prototype.hasOwnProperty.call(rawArgs, 'currentBlocker')
            ? args.currentBlocker
            : currentMetadata.currentBlocker,
          nextAction: Object.prototype.hasOwnProperty.call(rawArgs, 'nextAction')
            ? args.nextAction
            : currentMetadata.nextAction,
          milestones: [...currentMetadata.milestones, milestone],
          log: [
            ...currentMetadata.log,
            {
              at: now,
              type: 'milestone_recorded' as const,
              refId: milestoneId,
              message: `记录里程碑：${title}`,
            } satisfies import('./schema').ProgressLogItem
          ],
        };

        try {
          await ensureParentDir(uri.fsPath);
          const { metadata, content } = buildProgressDocument(nextMetadata, { generatedAt: now });
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

          return {
            success: true,
            data: projectProgressToolResultData({
              path: targetPath,
              metadata,
              delta: {
                type: 'milestone_recorded',
                milestoneId,
                changedFields: ['milestones', 'summary', 'log']
              }
            })
          };
        } catch (e: any) {
          return { success: false, error: e?.message || String(e) };
        }
      });
    }
  };
}

export function registerRecordProgressMilestone(): Tool {
  return createRecordProgressMilestoneTool();
}
