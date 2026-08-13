/**
 * create_review 工具
 *
 * 目标：把 review 文档写入 .graycode/review/**.md（或 multi-root: workspace/.graycode/review/**.md）。
 * 注意：这是 Review 模式专用文档工具，不负责修改业务代码。
 */

import * as vscode from 'vscode';
import type { Tool, ToolContext, ToolDeclaration, ToolResult } from '../types';
import { parseArgs } from '../types';
import { resolveUriWithInfo } from '../utils';
import { slugify } from '../shared/slugify';
import { REVIEW_PATH_SCOPE_LABEL, buildPathRejectedError } from '../shared/pathPolicy';
import { ensureParentDir, isProgressArtifactPathAllowedWithMultiRoot } from '../progress/pathUtils';
import {
  buildInitialReviewDocument,
  getCurrentReviewDocumentLocale,
  summarizeReviewDocument
} from './reviewDocumentSection';
import { projectReviewToolResultData } from './resultProjection';
import { ensureNoActiveReviewSession, saveReviewSessionState } from './sessionState';
import { syncProgressFromReviewArtifact } from '../progress/autoSync';
import { withProgressWriteLock } from '../progress/progressWriteLock';

export interface CreateReviewArgs {
  title?: string;
  overview?: string;
  review: string;
  path?: string;
}

export function createCreateReviewToolDeclaration(): ToolDeclaration {
  return {
    name: 'create_review',
    description:
      'Create a review document (markdown) and write it under .graycode/review/**.md. This tool is for Review mode and must not modify business code.',
    category: 'review',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional review title (used for default filename)' },
        overview: { type: 'string', description: 'Optional one-line review overview' },
        review: { type: 'string', description: 'Initial review content in markdown' },
        path: {
          type: 'string',
          description:
            'Optional output path. Must be under .graycode/review/**.md (or multi-root: workspace/.graycode/review/**.md).'
        }
      },
      required: ['review']
    }
  };
}

export function createCreateReviewTool(): Tool {
  return {
    declaration: createCreateReviewToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> => {
      const args = parseArgs<CreateReviewArgs>(rawArgs);
      const review = typeof args.review === 'string' ? args.review : '';
      if (!review.trim()) {
        return { success: false, error: 'review is required and must be a non-empty string' };
      }

      const title = typeof args.title === 'string' ? args.title : '';
      const defaultPath = `.graycode/review/${slugify(title || 'review', `review-${Date.now()}`)}.md`;
      const outPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : defaultPath;

      if (!isProgressArtifactPathAllowedWithMultiRoot('review', outPath)) {
        return { success: false, error: buildPathRejectedError('review', REVIEW_PATH_SCOPE_LABEL, outPath) };
      }

      const sessionCheck = await ensureNoActiveReviewSession(context, outPath);
      if (sessionCheck.ok === false) {
        return { success: false, error: sessionCheck.error };
      }

      const { uri, error } = resolveUriWithInfo(outPath);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      try {
        return await withProgressWriteLock(outPath, async (): Promise<ToolResult> => {
          try {
            await vscode.workspace.fs.stat(uri);
            return {
              success: false,
              error: `Review document already exists at ${outPath}. Continue it with record_review_milestone or finalize_review, or choose a different path.`
            };
          } catch (e: unknown) {
            if ((e as { code?: string } | null)?.code !== 'FileNotFound') {
              throw e;
            }
          }

          await ensureParentDir(uri.fsPath);
          const locale = getCurrentReviewDocumentLocale();
          const content = buildInitialReviewDocument({
            title,
            overview: typeof args.overview === 'string' ? args.overview : '',
            review
          }, locale);
          const summary = summarizeReviewDocument(content);
          const bytes = new TextEncoder().encode(content);
          await vscode.workspace.fs.writeFile(uri, bytes);
          const progressWarnings = await syncProgressFromReviewArtifact({
            reviewPath: outPath,
            title: summary.title || title || undefined,
            eventMessage: `同步审查文档：${outPath}`
          });

          if (summary.reviewSnapshot) {
            await saveReviewSessionState(context, {
              reviewRunId: summary.reviewSnapshot.reviewRunId,
              reviewPath: outPath,
              status: summary.reviewSnapshot.status,
              createdAt: summary.reviewSnapshot.createdAt,
              finalizedAt: summary.reviewSnapshot.finalizedAt
            });
          }

          return {
            success: true,
            data: projectReviewToolResultData({
              path: outPath,
              content,
              delta: {
                type: 'created',
                changedFields: ['header', 'scope', 'reviewSnapshot', 'reviewSession']
              },
              extra: progressWarnings.length > 0 ? { warnings: progressWarnings } : undefined
            })
          };
        });
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };
}

export function registerCreateReview(): Tool {
  return createCreateReviewTool();
}
