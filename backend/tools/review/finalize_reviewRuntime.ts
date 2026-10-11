/**
 * finalize_review 工具
 *
 * 目标：结束当前 review 文档，更新最终摘要，不创建新文档。
 */

import { documentReadFile, documentWriteFile, documentStat } from '../shared/artifactHost';
import type { Tool, ToolContext, ToolDeclaration, ToolResult } from '../types';
import { parseArgs } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../shared/artifactHost';
import { REVIEW_PATH_SCOPE_LABEL, buildPathRejectedError } from '../shared/artifactHost';
import { isProgressArtifactPathAllowedWithMultiRoot } from '../progress/pathUtilsRuntime';
import {
  finalizeReviewDocument,
  getCurrentReviewDocumentLocale,
  type ReviewOverallDecision
} from './reviewDocumentSection';
import { projectReviewToolResultData } from './resultProjection';
import { ensureMatchingActiveReviewSession, saveReviewSessionState } from './sessionState';
import { syncProgressFromReviewArtifact } from '../progress/autoSyncRuntime';
import { withProgressWriteLock } from '../progress/progressWriteLock';

export interface FinalizeReviewArgs {
  path: string;
  conclusion: string;
  overallDecision?: ReviewOverallDecision;
  recommendedNextAction?: string;
  reviewedModules?: string[];
}

export function createFinalizeReviewToolDeclaration(): ToolDeclaration {
  return {
    name: 'finalize_review',
    description:
      '结束当前会话进行中的审查，写入最终结论与决定，整理文档并更新摘要。path 必须指向当前审查；之后须先用 reopen_review 才能继续记录里程碑。',
    category: 'review',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '审查文档路径，位于 .graycode/review/**.md 下。' },
        conclusion: { type: 'string', description: '审查的最终结论。' },
        overallDecision: {
          type: 'string',
          enum: ['accepted', 'conditionally_accepted', 'rejected', 'needs_follow_up'],
          description: '可选的总体决定。'
        },
        recommendedNextAction: {
          type: 'string',
          description: '可选，要显示在摘要中的建议下一步。'
        },
        reviewedModules: {
          type: 'array',
          description: '可选，本次审查覆盖的模块数组，会合并到摘要。',
          items: { type: 'string' }
        }
      },
      required: ['path', 'conclusion']
    }
  };
}

export function createFinalizeReviewTool(): Tool {
  return {
    declaration: createFinalizeReviewToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> => {
      const args = parseArgs<FinalizeReviewArgs>(rawArgs);
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      const conclusion = typeof args.conclusion === 'string' ? args.conclusion : '';

      if (!path) {
        return { success: false, error: 'path is required and must be a non-empty string' };
      }
      if (!conclusion.trim()) {
        return { success: false, error: 'conclusion is required and must be a non-empty string' };
      }

      if (!isProgressArtifactPathAllowedWithMultiRoot('review', path)) {
        return { success: false, error: buildPathRejectedError('review', REVIEW_PATH_SCOPE_LABEL, path) };
      }

      const sessionCheck = await ensureMatchingActiveReviewSession(context, path);
      if (sessionCheck.ok === false) {
        return { success: false, error: sessionCheck.error };
      }

      const { uri, error } = resolveUriWithInfo(path);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      try {
        // 读改写整体进 per-path 写锁：并行子代理不会基于同一份旧盘面互相覆盖
        return await withProgressWriteLock(path, async (): Promise<ToolResult> => {
          const contentBytes = await documentReadFile(uri);
          const originalContent = normalizeLineEndingsToLF(new TextDecoder().decode(contentBytes));
          const locale = getCurrentReviewDocumentLocale();
          const next = finalizeReviewDocument(originalContent, {
            conclusion,
            overallDecision: args.overallDecision,
            recommendedNextAction: typeof args.recommendedNextAction === 'string' ? args.recommendedNextAction : '',
            reviewedModules: Array.isArray(args.reviewedModules) ? args.reviewedModules : []
          }, locale);

          await documentWriteFile(uri, new TextEncoder().encode(next.content));
          const progressWarnings = await syncProgressFromReviewArtifact({
            reviewPath: path,
            title: next.reviewSnapshot.header.title,
            latestConclusion: next.reviewSnapshot.summary.latestConclusion || undefined,
            nextAction: next.reviewSnapshot.summary.recommendedNextAction || undefined,
            eventMessage: `同步审查结论：${path}`
          });

          await saveReviewSessionState(context, {
            reviewRunId: next.reviewSnapshot.reviewRunId,
            reviewPath: path,
            status: next.reviewSnapshot.status,
            createdAt: next.reviewSnapshot.createdAt,
            finalizedAt: next.reviewSnapshot.finalizedAt
          });

          return {
            success: true,
            data: projectReviewToolResultData({
              path,
              content: next.content,
              delta: {
                type: 'finalized',
                changedFields: ['status', 'overallDecision', 'finalizedAt', 'summary', 'reviewSnapshot', 'reviewSession']
              },
              extra: {
                findings: next.findings,
                structuredFindings: next.structuredFindings,
                ...(progressWarnings.length > 0 ? { warnings: progressWarnings } : {})
              }
            })
          };
        });
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerFinalizeReview(): Tool {
  return createFinalizeReviewTool();
}
