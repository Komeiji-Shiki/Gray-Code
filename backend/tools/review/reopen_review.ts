/**
 * reopen_review 工具
 *
 * 目标：重新打开一个已完成的 review 文档，使其重新进入 in_progress 状态。
 */

import * as vscode from 'vscode';
import type { Tool, ToolContext, ToolDeclaration, ToolResult } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../utils';
import { isProgressArtifactPathAllowedWithMultiRoot } from '../progress/pathUtils';
import {
  getCurrentReviewDocumentLocale,
  reopenReviewDocument
} from './reviewDocumentSection';
import { projectReviewToolResultData } from './resultProjection';
import { loadReviewSessionState, saveReviewSessionState } from './sessionState';
import { syncProgressFromReviewArtifact } from '../progress/autoSync';

export interface ReopenReviewArgs {
  path: string;
}

export function createReopenReviewToolDeclaration(): ToolDeclaration {
  return {
    name: 'reopen_review',
    description:
      'Reopen a finalized review document under .graycode/review/**.md so the same review run can continue recording milestones.',
    category: 'review',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target finalized review document path under .graycode/review/**.md' }
      },
      required: ['path']
    }
  };
}

export function createReopenReviewTool(): Tool {
  return {
    declaration: createReopenReviewToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> => {
      const args = rawArgs as unknown as ReopenReviewArgs;
      const path = typeof args.path === 'string' ? args.path.trim() : '';

      if (!path) {
        return { success: false, error: 'path is required and must be a non-empty string' };
      }

      if (!isProgressArtifactPathAllowedWithMultiRoot('review', path)) {
        return { success: false, error: `Invalid review path. Only ".graycode/review/**.md" is allowed. Rejected path: ${path}` };
      }

      const session = await loadReviewSessionState(context);
      if (session?.status === 'in_progress') {
        if (session.reviewPath === path) {
          return { success: false, error: `The review session is already active for path: ${path}` };
        }
        return { success: false, error: `Another active review session already exists for this conversation: ${session.reviewPath}` };
      }

      const { uri, error } = resolveUriWithInfo(path);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      try {
        const contentBytes = await vscode.workspace.fs.readFile(uri);
        const originalContent = normalizeLineEndingsToLF(new TextDecoder().decode(contentBytes));
        const locale = getCurrentReviewDocumentLocale();
        const next = reopenReviewDocument(originalContent, locale);

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next.content));
        const progressWarnings = await syncProgressFromReviewArtifact({
          reviewPath: path,
          title: next.reviewSnapshot.header.title,
          eventMessage: `重新打开审查：${path}`
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
              type: 'reopened',
              changedFields: ['status', 'overallDecision', 'finalizedAt', 'reviewSnapshot', 'reviewSession']
            },
            extra: {
              findings: next.findings,
              structuredFindings: next.structuredFindings,
              ...(progressWarnings.length > 0 ? { warnings: progressWarnings } : {})
            }
          })
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerReopenReview(): Tool {
  return createReopenReviewTool();
}
