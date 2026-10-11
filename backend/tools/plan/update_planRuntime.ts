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
import { TODO_ITEM_SCHEMA } from '../shared/todoSchema';
import type { PlanTodoItem } from './todoListSection';

export type PlanUpdateMode = 'revision' | 'progress_sync';

export interface UpdatePlanArgs {
  path: string;
  plan?: string;
  todos?: PlanTodoItem[];
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
      '修改 .graycode/plans/**.md 中已有计划。默认 revision 重写正文并要求用户重新确认。' +
      'progress_sync 只更新 TODO 状态，保留正文，只传 path、todos、updateMode 和可选的 changeSummary；' +
      'sourceArtifact 会被忽略并给出警告，schema 外字段会导致调用失败。',
    category: 'plan',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '已有计划文档的路径，位于 .graycode/plans/**.md 下。请沿用已批准计划的路径。'
        },
        title: { type: 'string', description: '可选的新标题。' },
        overview: { type: 'string', description: '可选的新的一行概述。' },
        plan: { type: 'string', description: '修改后的完整计划内容，使用 Markdown。revision 模式下必填，progress_sync 模式下不使用。' },
        todos: {
          type: 'array',
          description: '完整 TODO 清单，替换原有清单。',
          items: TODO_ITEM_SCHEMA
        },
        updateMode: {
          type: 'string',
          description: '默认 revision 重写正文；progress_sync 仅同步 TODO 状态。',
          enum: ['revision', 'progress_sync']
        },
        sourceArtifact: {
          type: 'object',
          description: 'revision 下可更新关联的已确认来源文档，省略时保留原关联。',
          properties: {
            type: { description: '来源文档类型。', type: 'string', enum: ['design', 'review'] },
            path: { description: '来源文档路径。', type: 'string' }
          },
          required: ['type', 'path']
        },
        changeSummary: {
          type: 'string',
          description: '可选的本次修改摘要。'
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
