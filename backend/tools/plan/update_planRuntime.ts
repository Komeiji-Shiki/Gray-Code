/**
 * update_plan 工具
 *
 * 目标：正式回写既有 plan 文档，并保持 TODO LIST 区块与当前计划内容一致。
 */

import { documentReadFile, documentWriteFile, documentStat } from '../shared/artifactHost';
import type { Tool, ToolDeclaration, ToolResult } from '../types';
import { parseArgs } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../shared/artifactHost';
import { PLAN_PATH_SCOPE_LABEL, buildPathRejectedError } from '../shared/artifactHost';
import { buildPlanDocument, extractPlanBodyContent } from './documentLayout';
import { ensureParentDir, isPlanModePathAllowedWithMultiRoot } from './pathUtilsRuntime';
import {
  buildTrackedPlanSourceArtifact,
  extractPlanSourceArtifactSection,
  renderPlanSourceArtifactSection,
  type PlanSourceArtifactInput
} from './sourceArtifactSectionRuntime';
import { syncProgressFromPlanArtifact } from '../progress/autoSyncRuntime';
import { withProgressWriteLock } from '../progress/progressWriteLock';

export type PlanUpdateMode = 'revision' | 'progress_sync';

export interface UpdatePlanArgs {
  path: string;
  plan?: string;
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>;
  title?: string;
  overview?: string;
  changeSummary?: string;
  updateMode?: PlanUpdateMode;
  sourceArtifact?: PlanSourceArtifactInput;
}

const PROGRESS_SYNC_SOURCE_ARTIFACT_WARNING =
  'sourceArtifact was provided in progress_sync mode and has been ignored. Use updateMode: \'revision\' if you need to change the plan source.';
function normalizeUpdateMode(value: unknown): PlanUpdateMode {
  return value === 'progress_sync' ? 'progress_sync' : 'revision';
}

export function createUpdatePlanToolDeclaration(): ToolDeclaration {
  return {
    name: 'update_plan',
    strict: true,
    description:
      'Update an existing Markdown plan document under .graycode/plans/**.md. revision mode (the default) rewrites the plan, which then needs to be confirmed again. progress_sync only updates TODO status during implementation and leaves the plan body unchanged, so send only path, todos, updateMode and the optional changeSummary. sourceArtifact and other carry-over fields (such as sourcePath, planContent or continuationIntent) only make sense in revision mode and should not be sent with progress_sync; a sourceArtifact sent there is ignored with a warning, and fields outside this schema make the call fail.',
    category: 'plan',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the existing plan document, under .graycode/plans/**.md. Reuse the path of the approved plan.'
        },
        title: { type: 'string', description: 'Optional updated plan title.' },
        overview: { type: 'string', description: 'Optional updated one-line overview.' },
        plan: { type: 'string', description: 'The complete updated plan in Markdown. Required in revision mode and not used in progress_sync.' },
        todos: {
          type: 'array',
          description: 'The complete TODO checklist; it replaces the previous one.',
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
        updateMode: {
          type: 'string',
          description: 'revision (default) rewrites the plan and requires confirmation again. progress_sync only updates TODO status and accepts only path, todos, updateMode and changeSummary.',
          enum: ['revision', 'progress_sync']
        },
        sourceArtifact: {
          type: 'object',
          description: 'Optional confirmed design or review document to link the plan to; if omitted, the existing link is kept. Only used in revision mode, and ignored with a warning in progress_sync.',
          properties: {
            type: { type: 'string', enum: ['design', 'review'] },
            path: { type: 'string' }
          },
          required: ['type', 'path']
        },
        changeSummary: {
          type: 'string',
          description: 'Optional short summary of what changed in this update.'
        }
      },
      required: ['path', 'todos']
    }
  };
}


export function createUpdatePlanTool(): Tool {
  return {
    declaration: createUpdatePlanToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const allowedKeys = new Set([
        'path', 'plan', 'todos', 'title', 'overview', 'changeSummary', 'updateMode', 'sourceArtifact'
      ]);
      const unexpectedKeys = Object.keys(rawArgs).filter(key => !allowedKeys.has(key));
      if (unexpectedKeys.length > 0) {
        return { success: false, error: `Unexpected update_plan fields: ${unexpectedKeys.join(', ')}` };
      }
      const args = parseArgs<UpdatePlanArgs>(rawArgs);
      const targetPath = typeof args.path === 'string' ? args.path.trim() : '';
      const plan = typeof args.plan === 'string' ? args.plan : '';
      const changeSummary = typeof args.changeSummary === 'string' ? args.changeSummary.trim() : '';
      const updateMode = normalizeUpdateMode(args.updateMode);
      const hasSourceArtifactArg = Object.prototype.hasOwnProperty.call(rawArgs, 'sourceArtifact');
      const shouldIgnoreSourceArtifact = updateMode === 'progress_sync' && hasSourceArtifactArg;
      const warnings = shouldIgnoreSourceArtifact ? [PROGRESS_SYNC_SOURCE_ARTIFACT_WARNING] : [];
      const nextSourceArtifact = shouldIgnoreSourceArtifact ? undefined : args.sourceArtifact;

      if (!targetPath) {
        return { success: false, error: 'path is required and must be a non-empty string' };
      }

      if (updateMode === 'revision' && !plan.trim()) {
        return { success: false, error: 'plan is required and must be a non-empty string in revision mode' };
      }

      if (!isPlanModePathAllowedWithMultiRoot(targetPath)) {
        return { success: false, error: buildPathRejectedError('plan', PLAN_PATH_SCOPE_LABEL, targetPath) };
      }

      const { uri, error } = resolveUriWithInfo(targetPath);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      // 修改原因：plan 文档的「读 → 改 → 写」无锁，并行子代理同时 update 同一 plan 会互相覆盖。
      // 修改方式：与 create_plan 一致，把整段读改写放进 per-path 写锁（progressWriteLock），
      //          后一个更新总是基于前一个写回后的盘面重新读取合并。
      // 修改目的：同一 plan 文件的更新按调用顺序串行，互不覆盖。
      return withProgressWriteLock(targetPath, async (): Promise<ToolResult> => {
        let existingContent = '';
        try {
          const existingBytes = await documentReadFile(uri);
          existingContent = Buffer.from(existingBytes).toString('utf-8');
        } catch (e: any) {
          return { success: false, error: e?.message || `Plan document does not exist: ${targetPath}` };
        }

        try {
          await ensureParentDir(uri.fsPath);

          const existingSourceSection = extractPlanSourceArtifactSection(existingContent);
          const sourceSection = nextSourceArtifact
            ? renderPlanSourceArtifactSection(await buildTrackedPlanSourceArtifact(nextSourceArtifact))
            : existingSourceSection;

          const bodyContent = updateMode === 'progress_sync'
            ? extractPlanBodyContent(existingContent)
            : normalizeLineEndingsToLF(plan);

          const { content, todos } = buildPlanDocument(bodyContent, args.todos, sourceSection);
          const bytes = new TextEncoder().encode(content);
          await documentWriteFile(uri, bytes);
          const progressWarnings = await syncProgressFromPlanArtifact({
            planPath: targetPath,
            title: typeof args.title === 'string' ? args.title : undefined,
            todos,
            updateMode,
          });
          const mergedWarnings = [...warnings, ...progressWarnings];

          return {
            success: true,
            requiresUserConfirmation: updateMode === 'revision',
            data: {
              path: targetPath,
              content,
              todos,
              updateMode,
              changeSummary: changeSummary || undefined,
              warnings: mergedWarnings.length > 0 ? mergedWarnings : undefined
            }
          };
        } catch (e: any) {
          return { success: false, error: e?.message || String(e) };
        }
      });
    }
  };
}

export function registerUpdatePlan(): Tool {
  return createUpdatePlanTool();
}
