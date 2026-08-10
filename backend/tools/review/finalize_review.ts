/**
 * finalize_review 工具
 *
 * 目标：结束当前 review 文档，更新最终摘要，不创建新文档。
 */

import * as vscode from 'vscode';
import type { Tool, ToolContext, ToolDeclaration, ToolResult } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../utils';
import { REVIEW_PATH_SCOPE_LABEL, buildPathRejectedError } from '../shared/pathPolicy';
import { isProgressArtifactPathAllowedWithMultiRoot } from '../progress/pathUtils';
import {
  finalizeReviewDocument,
  getCurrentReviewDocumentLocale,
  type ReviewOverallDecision
} from './reviewDocumentSection';
import { projectReviewToolResultData } from './resultProjection';
import { ensureMatchingActiveReviewSession, saveReviewSessionState } from './sessionState';
import { syncProgressFromReviewArtifact } from '../progress/autoSync';
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
      'Finalize an existing review document under .graycode/review/**.md, normalize its structure, and update the final review summary.',
    category: 'review',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target review document path under .graycode/review/**.md' },
        conclusion: { type: 'string', description: 'Final review conclusion' },
        overallDecision: {
          type: 'string',
          enum: ['accepted', 'conditionally_accepted', 'rejected', 'needs_follow_up'],
          description: 'Optional overall review decision'
        },
        recommendedNextAction: {
          type: 'string',
          description: 'Optional recommended next action for the summary section'
        },
        reviewedModules: {
          type: 'array',
          description: 'Optional reviewed modules to merge into the summary section',
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
      const args = rawArgs as unknown as FinalizeReviewArgs;
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
          const contentBytes = await vscode.workspace.fs.readFile(uri);
          const originalContent = normalizeLineEndingsToLF(new TextDecoder().decode(contentBytes));
          const locale = getCurrentReviewDocumentLocale();
          const next = finalizeReviewDocument(originalContent, {
            conclusion,
            overallDecision: args.overallDecision,
            recommendedNextAction: typeof args.recommendedNextAction === 'string' ? args.recommendedNextAction : '',
            reviewedModules: Array.isArray(args.reviewedModules) ? args.reviewedModules : []
          }, locale);

          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next.content));
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
