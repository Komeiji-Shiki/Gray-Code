/**
 * validate_review_document 工具
 *
 * 目标：只读校验 review 文档的格式、元数据和生命周期一致性。
 */

import * as vscode from 'vscode';
import type { Tool, ToolContext, ToolDeclaration, ToolResult } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../utils';
import { isProgressArtifactPathAllowedWithMultiRoot } from '../progress/pathUtils';
import {
  summarizeReviewDocument,
  validateReviewDocument
} from './reviewDocumentSection';
import { buildReviewValidationSummary } from './resultProjection';

export interface ValidateReviewDocumentArgs {
  path: string;
}

export function createValidateReviewDocumentToolDeclaration(): ToolDeclaration {
  return {
    name: 'validate_review_document',
    description:
      'Validate an existing review document under .graycode/review/**.md without modifying it. Reports format, metadata health, and invariant issues.',
    category: 'review',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target review document path under .graycode/review/**.md' }
      },
      required: ['path']
    }
  };
}

export function createValidateReviewDocumentTool(): Tool {
  return {
    declaration: createValidateReviewDocumentToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> => {
      const args = rawArgs as unknown as ValidateReviewDocumentArgs;
      const path = typeof args.path === 'string' ? args.path.trim() : '';

      if (!path) {
        return { success: false, error: 'path is required and must be a non-empty string' };
      }

      if (!isProgressArtifactPathAllowedWithMultiRoot('review', path)) {
        return { success: false, error: `Invalid review path. Only ".graycode/review/**.md" is allowed. Rejected path: ${path}` };
      }

      const { uri, error } = resolveUriWithInfo(path, context?.activeWorkspaceUri);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      try {
        const contentBytes = await vscode.workspace.fs.readFile(uri);
        const content = normalizeLineEndingsToLF(new TextDecoder().decode(contentBytes));
        const validation = validateReviewDocument(content);
        let summary: ReturnType<typeof summarizeReviewDocument> | undefined;

        try {
          if (validation.detectedFormat !== 'unknown') {
            summary = summarizeReviewDocument(content);
          }
        } catch {
          summary = undefined;
        }

        const reviewValidation = buildReviewValidationSummary(content);

        return {
          success: true,
          data: {
            path,
            ...validation,
            reviewSnapshot: validation.reviewSnapshot,
            reviewValidation,
            reviewDelta: {
              type: 'validated',
              changedFields: []
            },
            metadata: validation.metadata,
            title: summary?.title,
            date: summary?.date,
            status: summary?.status,
            currentStatus: summary?.status,
            overallDecision: summary?.overallDecision,
            milestoneCount: summary?.totalMilestones,
            totalMilestones: summary?.totalMilestones,
            completedMilestones: summary?.completedMilestones,
            currentProgress: summary?.currentProgress,
            totalFindings: summary?.totalFindings,
            findingsBySeverity: summary?.findingsBySeverity,
            latestConclusion: summary?.latestConclusion,
            recommendedNextAction: summary?.recommendedNextAction,
            reviewedModules: summary?.reviewedModules,
            issueCount: reviewValidation.issueCount,
            errorCount: reviewValidation.errorCount,
            warningCount: reviewValidation.warningCount
          }
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerValidateReviewDocument(): Tool {
  return createValidateReviewDocumentTool();
}
