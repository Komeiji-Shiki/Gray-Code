/**
 * update_progress 工具
 */

import * as vscode from 'vscode';
import type { Tool, ToolDeclaration, ToolResult } from '../types';
import { resolveUriWithInfo } from '../utils';
import {
  buildProgressDocument,
  isProgressPhase,
  isProgressStatus,
  normalizeOptionalProgressSingleLineText,
  validateProgressDocument,
  validateProgressLogAppendInput,
  validateProgressRisksInput,
  validateProgressTodosInput,
} from './documentLayout';
import {
  applyProgressArtifactPatch,
  ensureParentDir,
  isProgressModePathAllowedWithMultiRoot,
  validateProgressArtifactRefInput,
} from './pathUtils';
import { projectProgressToolResultData } from './resultProjection';
import type {
  ProgressArtifactRef,
  ProgressLogItem,
  ProgressLogType,
  ProgressPhase,
  ProgressRiskItem,
  ProgressStatus,
  ProgressTodoItem,
} from './schema';

export interface UpdateProgressArgs {
  path?: string;
  status?: ProgressStatus;
  phase?: ProgressPhase;
  currentFocus?: string;
  latestConclusion?: string;
  currentBlocker?: string;
  nextAction?: string;
  activeArtifacts?: ProgressArtifactRef;
  todos?: ProgressTodoItem[];
  risks?: ProgressRiskItem[];
  appendLog?: Array<{ type: ProgressLogType; refId?: string; message: string }>;
}

function buildAppendedLogEntries(
  value: UpdateProgressArgs['appendLog'],
  at: string
): ProgressLogItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    at,
    type: item.type,
    refId: typeof item.refId === 'string' && item.refId.trim() ? item.refId.trim() : undefined,
    message: item.message.trim(),
  }));
}

export function createUpdateProgressToolDeclaration(): ToolDeclaration {
  return {
    name: 'update_progress',
    strict: true,
    description:
      'Update the project progress document at .limcode/progress.md. This refreshes summary fields, artifacts, TODO snapshot, risks, and recent log entries while returning a lightweight progress snapshot.',
    category: 'progress',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional target path. Must be .limcode/progress.md (or multi-root: workspace/.limcode/progress.md).'
        },
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
        },
        appendLog: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['created', 'updated', 'milestone_recorded', 'artifact_changed', 'risk_changed'] },
              refId: { type: 'string' },
              message: { type: 'string' }
            },
            required: ['type', 'message']
          }
        }
      }
    }
  };
}

export function createUpdateProgressTool(): Tool {
  return {
    declaration: createUpdateProgressToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = rawArgs as unknown as UpdateProgressArgs;
      const targetPath = typeof args.path === 'string' && args.path.trim()
        ? args.path.trim()
        : '.limcode/progress.md';

      if (!isProgressModePathAllowedWithMultiRoot(targetPath)) {
        return { success: false, error: `Invalid progress path. Only ".limcode/progress.md" is allowed. Rejected path: ${targetPath}` };
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
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'appendLog')) {
        const logError = validateProgressLogAppendInput(args.appendLog);
        if (logError) return { success: false, error: logError };
      }
      const artifactsError = validateProgressArtifactRefInput(args.activeArtifacts, {
        fieldName: 'activeArtifacts',
        allowEmptyString: true,
      });
      if (artifactsError) {
        return { success: false, error: artifactsError };
      }

      const { uri, error } = resolveUriWithInfo(targetPath);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

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

      const now = new Date().toISOString();
      const currentMetadata = validation.metadata;
      const nextLog = Object.prototype.hasOwnProperty.call(rawArgs, 'appendLog')
        ? [...currentMetadata.log, ...buildAppendedLogEntries(args.appendLog, now)]
        : currentMetadata.log;

      const nextMetadata = {
        ...currentMetadata,
        updatedAt: now,
        status: Object.prototype.hasOwnProperty.call(rawArgs, 'status')
          ? args.status
          : currentMetadata.status,
        phase: Object.prototype.hasOwnProperty.call(rawArgs, 'phase')
          ? args.phase
          : currentMetadata.phase,
        currentFocus: Object.prototype.hasOwnProperty.call(rawArgs, 'currentFocus')
          ? normalizeOptionalProgressSingleLineText(args.currentFocus)
          : currentMetadata.currentFocus,
        latestConclusion: Object.prototype.hasOwnProperty.call(rawArgs, 'latestConclusion')
          ? args.latestConclusion
          : currentMetadata.latestConclusion,
        currentBlocker: Object.prototype.hasOwnProperty.call(rawArgs, 'currentBlocker')
          ? args.currentBlocker
          : currentMetadata.currentBlocker,
        nextAction: Object.prototype.hasOwnProperty.call(rawArgs, 'nextAction')
          ? args.nextAction
          : currentMetadata.nextAction,
        activeArtifacts: Object.prototype.hasOwnProperty.call(rawArgs, 'activeArtifacts')
          ? applyProgressArtifactPatch(currentMetadata.activeArtifacts, args.activeArtifacts)
          : currentMetadata.activeArtifacts,
        todos: Object.prototype.hasOwnProperty.call(rawArgs, 'todos')
          ? args.todos
          : currentMetadata.todos,
        risks: Object.prototype.hasOwnProperty.call(rawArgs, 'risks')
          ? args.risks
          : currentMetadata.risks,
        log: nextLog,
      };

      const changedFields = new Set<string>();
      if (
        Object.prototype.hasOwnProperty.call(rawArgs, 'status') ||
        Object.prototype.hasOwnProperty.call(rawArgs, 'phase')
      ) {
        changedFields.add('header');
      }
      if (
        Object.prototype.hasOwnProperty.call(rawArgs, 'currentFocus') ||
        Object.prototype.hasOwnProperty.call(rawArgs, 'latestConclusion') ||
        Object.prototype.hasOwnProperty.call(rawArgs, 'currentBlocker') ||
        Object.prototype.hasOwnProperty.call(rawArgs, 'nextAction')
      ) {
        changedFields.add('summary');
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'activeArtifacts')) {
        changedFields.add('artifacts');
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'todos')) {
        changedFields.add('todos');
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'risks')) {
        changedFields.add('risks');
      }
      if (Object.prototype.hasOwnProperty.call(rawArgs, 'appendLog')) {
        changedFields.add('log');
      }

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
              type: 'updated',
              changedFields: Array.from(changedFields.values())
            }
          })
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerUpdateProgress(): Tool {
  return createUpdateProgressTool();
}
