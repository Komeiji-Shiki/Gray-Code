/**
 * create_progress 工具
 */

import * as vscode from 'vscode';
import type { Tool, ToolDeclaration, ToolResult } from '../types';
import { parseArgs } from '../types';
import { getAllWorkspaces, resolveUriWithInfo } from '../utils';
import { slugify } from '../shared/slugify';
import { PROGRESS_PATH_SCOPE_LABEL, buildPathRejectedError } from '../shared/pathPolicy';
import {
  buildProgressDocument,
  isProgressPhase,
  isProgressStatus,
  validateProgressRisksInput,
  validateProgressTodosInput,
  validateProgressDocument,
} from './documentLayout';
import { ensureParentDir, isProgressModePathAllowedWithMultiRoot, normalizeProgressArtifactRef, validateProgressArtifactRefInput } from './pathUtils';
import { withProgressWriteLock } from './progressWriteLock';
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
      'Create the project progress document at .graycode/progress.md. This initializes the project-level status ledger and returns a lightweight progress snapshot instead of the full markdown body.',
    category: 'progress',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional output path. Must be .graycode/progress.md (or multi-root: workspace/.graycode/progress.md).'
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
      const args = parseArgs<CreateProgressArgs>(rawArgs);
      const outPath = typeof args.path === 'string' && args.path.trim()
        ? args.path.trim()
        : '.graycode/progress.md';

      if (!isProgressModePathAllowedWithMultiRoot(outPath)) {
        return { success: false, error: buildPathRejectedError('progress', PROGRESS_PATH_SCOPE_LABEL, outPath) };
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

      // 修改原因：create 的「检查已存在 → 构建 → 写入」此前无锁，并发 create 与
      //          autoSync/update_progress 交错时存在小窗口覆盖风险（create 基于 ENOENT
      //          判断后写入，可能覆盖并发 autoSync 刚写入的盘面）。
      // 修改方式：把整段「读（存在性检查）→ 写」放进 per-path 写锁（progressWriteLock），
      //          与 update_progress/record_progress_milestone/autoSync 落在同一队列。
      // 修改目的：保持「不存在才创建」语义不变的同时，消除检查-写入竞态窗口。
      return withProgressWriteLock(outPath, async (): Promise<ToolResult> => {
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
          // 区分 ENOENT 与其它读取错误：只有文件不存在时才继续创建，
          // EACCES/IO 等异常应显式失败而不是被当作“文件不存在”。
          const readMessage = String(readError?.message || '');
          if (!/enoent|not exist|file not found/i.test(readMessage)) {
            return {
              success: false,
              error: `Failed to check existing progress document: ${readMessage || outPath}`
            };
          }
          // file does not exist, continue
        }

        const now = new Date().toISOString();
        const projectName = typeof args.projectName === 'string' && args.projectName.trim()
          ? args.projectName.trim()
          : getDefaultProjectName();
        const projectId = typeof args.projectId === 'string' && args.projectId.trim()
          ? args.projectId.trim()
          : slugify(projectName || getDefaultProjectName() || 'project', 'project');

        try {
          await ensureParentDir(uri.fsPath);

          const { metadata, content } = buildProgressDocument({
            projectId,
            projectName,
            createdAt: now,
            updatedAt: now,
            status: isProgressStatus(args.status) ? args.status : 'active',
            // 默认 phase 与 autoSync.buildInitialProgressMetadata 保持一致（项目创建初期处于设计阶段）
            phase: isProgressPhase(args.phase) ? args.phase : 'design',
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
      });
    }
  };
}

export function registerCreateProgress(): Tool {
  return createCreateProgressTool();
}
