/**
 * finalize_review 工具
 *
 * 目标：结束当前 review 文档，更新最终摘要，不创建新文档。
 */

import * as vscode from 'vscode';
import type { Tool, ToolDeclaration, ToolResult } from '../types';
import { getAllWorkspaces, normalizeLineEndingsToLF, resolveUriWithInfo } from '../utils';
import { isReviewPathAllowed } from '../../modules/settings/modeToolsPolicy';
import {
  finalizeReviewDocument,
  summarizeReviewDocument,
  type ReviewOverallDecision
} from './reviewDocumentSection';

export interface FinalizeReviewArgs {
  path: string;
  conclusion: string;
  overallDecision?: ReviewOverallDecision;
  recommendedNextAction?: string;
  reviewedModules?: string[];
}

function isReviewModePathAllowedWithMultiRoot(pathStr: string): boolean {
  if (isReviewPathAllowed(pathStr)) return true;

  const workspaces = getAllWorkspaces();
  if (workspaces.length <= 1) return false;

  const normalized = (pathStr || '').replace(/\\/g, '/');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0) return false;

  const workspacePrefix = normalized.slice(0, slashIndex);
  if (workspacePrefix === '.' || workspacePrefix === '..') return false;
  if (workspacePrefix.includes(':')) return false;

  const rest = normalized.slice(slashIndex + 1);
  return isReviewPathAllowed(rest);
}

export function createFinalizeReviewToolDeclaration(): ToolDeclaration {
  return {
    name: 'finalize_review',
    description:
      'Finalize an existing review document under .limcode/review/**.md, normalize its structure, and update the final review summary.',
    category: 'review',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target review document path under .limcode/review/**.md' },
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
    handler: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = rawArgs as unknown as FinalizeReviewArgs;
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      const conclusion = typeof args.conclusion === 'string' ? args.conclusion : '';

      if (!path) {
        return { success: false, error: 'path is required and must be a non-empty string' };
      }
      if (!conclusion.trim()) {
        return { success: false, error: 'conclusion is required and must be a non-empty string' };
      }

      if (!isReviewModePathAllowedWithMultiRoot(path)) {
        return { success: false, error: `Invalid review path. Only ".limcode/review/**.md" is allowed. Rejected path: ${path}` };
      }

      const { uri, error } = resolveUriWithInfo(path);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      try {
        const contentBytes = await vscode.workspace.fs.readFile(uri);
        const originalContent = normalizeLineEndingsToLF(new TextDecoder().decode(contentBytes));
        const next = finalizeReviewDocument(originalContent, {
          conclusion,
          overallDecision: args.overallDecision,
          recommendedNextAction: typeof args.recommendedNextAction === 'string' ? args.recommendedNextAction : '',
          reviewedModules: Array.isArray(args.reviewedModules) ? args.reviewedModules : []
        });

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next.content));
        const summaryData = summarizeReviewDocument(next.content);

        return {
          success: true,
          data: {
            path,
            content: next.content,
            milestoneCount: next.milestoneCount,
            completedMilestones: next.completedMilestones,
            findings: next.findings,
            structuredFindings: next.structuredFindings,
            reviewedModules: summaryData.reviewedModules,
            title: summaryData.title,
            date: summaryData.date,
            status: summaryData.status,
            currentStatus: summaryData.status,
            overallDecision: summaryData.overallDecision,
            totalMilestones: summaryData.totalMilestones,
            currentProgress: summaryData.currentProgress,
            totalFindings: summaryData.totalFindings,
            findingsBySeverity: summaryData.findingsBySeverity,
            latestConclusion: summaryData.latestConclusion,
            recommendedNextAction: summaryData.recommendedNextAction
          }
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerFinalizeReview(): Tool {
  return createFinalizeReviewTool();
}
