/**
 * create_progress 工具
 */

import * as vscode from 'vscode';
import type { Tool, ToolDeclaration, ToolResult } from '../types';
import { getAllWorkspaces, resolveUriWithInfo } from '../utils';
import {
  buildProgressDocument,
  isProgressPhase,
  isProgressStatus,
  validateProgressRisksInput,
  validateProgressTodosInput,
  validateProgressDocument,
} from './documentLayout';
import { ensureParentDir, isProgressModePathAllowedWithMultiRoot, normalizeProgressArtifactRef, validateProgressArtifactRefInput } from './pathUtils';
import { projectProgressToolResultData } from './resultProjection';
import type { ProgressArtifactRef, ProgressPhase, ProgressRiskItem, ProgressStatus, ProgressTodoItem } from './schema';

export interface CreateProgressArgs {
  path?: string;
  projectName?: string;
  projectId?: string;
  status?: ProgressStatus;
  phase?: ProgressPhase;
  currentFocus?: string;
  latestConclusion?: string;
  currentBlocker?: string;
  nextAction?: string;
  activeArtifacts?: ProgressArtifactRef;
  todos?: ProgressTodoItem[];
  risks?: ProgressRiskItem[];
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

function getDefaultProjectName(): string | undefined {
  const workspace = getAllWorkspaces()[0];
  return typeof workspace?.name === 'string' && workspace.name.trim()
    ? workspace.name.trim()
    : undefined;
}

export function createCreateProgressToolDeclaration(): ToolDeclaration {
  return {
    name: 'create_progress',
    strict: true,
    description:
      'Create the project progress document at .limcode/progress.md. This initializes the project-level status ledger and returns a lightweight progress snapshot instead of the full markdown body.',
    category: 'progress',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional output path. Must be .limcode/progress.md (or multi-root: workspace/.limcode/progress.md).'
        },
        projectName: { type: 'string', description: 'Optional human-readable project name.' },
        projectId: { type: 'string', description: 'Optional stable project id. Defaults to a slug from the project name.' },
        status: { type: 'string', enum: ['active', 'blocked', 'completed', 'archived'] },
        phase: { type: 'string', enum: ['design', 'plan', 'implementation', 'review', 'maintenance'] },
        currentFocus: { type: 'string' },
        latestConclusion: { type: 'string' },
        currentBlocker: { type: 'string' },
        nextAction: { type: 'string' },
        activeArtifacts: {
          type: 'object',
          properties: {
            design: { type: 'string' },
            plan: { type: 'string' },
            review: { type: 'string' }
          }
        },
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
            },
            required: ['id', 'content', 'status']
          }
        },
        risks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string', enum: ['active', 'resolved', 'accepted'] },
              description: { type: 'string' }
            },
            required: ['id', 'title', 'status', 'description']
          }
        }
      }
    }
  };
}

export function createCreateProgressTool(): Tool {
  return {
    declaration: createCreateProgressToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = rawArgs as unknown as CreateProgressArgs;
      const outPath = typeof args.path === 'string' && args.path.trim()
        ? args.path.trim()
        : '.limcode/progress.md';

      if (!isProgressModePathAllowedWithMultiRoot(outPath)) {
        return { success: false, error: `Invalid progress path. Only ".limcode/progress.md" is allowed. Rejected path: ${outPath}` };
      }

      if (Object.prototype.hasOwnProperty.call(rawArgs, 'status') && !isProgressStatus(args.status)) {
        return { success: false, error: 'status must be one of: active, blocked, completed, archived' };
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'phase') && !isProgressPhase(args.phase)) {
        return { success: false, error: 'phase must be one of: design, plan, implementation, review, maintenance' };
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'todos')) {
        const todosError = validateProgressTodosInput(args.todos);
        if (todosError) return { success: false, error: todosError };
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'risks')) {
        const risksError = validateProgressRisksInput(args.risks);
        if (risksError) return { success: false, error: risksError };
      }
      const artifactsError = validateProgressArtifactRefInput(args.activeArtifacts, {
        fieldName: 'activeArtifacts',
        allowEmptyString: true,
      });
      if (artifactsError) {
        return { success: false, error: artifactsError };
      }

      const { uri, error } = resolveUriWithInfo(outPath);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      try {
        const existingBytes = await vscode.workspace.fs.readFile(uri);
        const existingContent = Buffer.from(existingBytes).toString('utf-8');
        const validation = validateProgressDocument(existingContent);
        if (!validation.success) {
          return {
            success: false,
            error: `Progress document already exists but is invalid: ${'error' in validation ? validation.error : outPath}`
          };
        }

        return {
          success: true,
          data: projectProgressToolResultData({
            path: outPath,
            metadata: validation.metadata,
            delta: { type: 'updated', changedFields: [] },
            warnings: [`Progress document already exists at ${outPath}. Returned the existing snapshot instead of creating a second file.`]
          })
        };
      } catch (readError: any) {
        // file does not exist, continue
      }

      const now = new Date().toISOString();
      const projectName = typeof args.projectName === 'string' && args.projectName.trim()
        ? args.projectName.trim()
        : getDefaultProjectName();
      const projectId = typeof args.projectId === 'string' && args.projectId.trim()
        ? args.projectId.trim()
        : slugify(projectName || getDefaultProjectName() || 'project');

      try {
        await ensureParentDir(uri.fsPath);

        const { metadata, content } = buildProgressDocument({
          projectId,
          projectName,
          createdAt: now,
          updatedAt: now,
          status: isProgressStatus(args.status) ? args.status : 'active',
          phase: isProgressPhase(args.phase) ? args.phase : 'implementation',
          currentFocus: args.currentFocus,
          latestConclusion: args.latestConclusion,
          currentBlocker: args.currentBlocker,
          nextAction: args.nextAction,
          activeArtifacts: normalizeProgressArtifactRef(args.activeArtifacts),
          todos: args.todos,
          milestones: [],
          risks: args.risks,
          log: [{ at: now, type: 'created', message: '初始化项目进度' }],
        }, { generatedAt: now });

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

        return {
          success: true,
          data: projectProgressToolResultData({
            path: outPath,
            metadata,
            delta: {
              type: 'created',
              changedFields: ['header', 'summary', 'artifacts', 'todos', 'risks', 'log']
            }
          })
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerCreateProgress(): Tool {
  return createCreateProgressTool();
}
