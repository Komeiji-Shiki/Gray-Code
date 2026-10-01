/**
 * record_review_milestone 工具
 *
 * 目标：向现有 review 文档追加一个里程碑，并同步摘要区与问题汇总区。
 */

import { documentReadFile, documentWriteFile, documentStat } from '../shared/artifactHost';
import type { Tool, ToolContext, ToolDeclaration, ToolResult } from '../types';
import { parseArgs } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../shared/artifactHost';
import { REVIEW_PATH_SCOPE_LABEL, buildPathRejectedError } from '../shared/artifactHost';
import { isProgressArtifactPathAllowedWithMultiRoot } from '../progress/pathUtilsRuntime';
import {
  appendReviewMilestone,
  getCurrentReviewDocumentLocale,
  type ReviewEvidenceRef,
  type ReviewFindingInput
} from './reviewDocumentSection';
import { projectReviewToolResultData } from './resultProjection';
import { ensureMatchingActiveReviewSession, saveReviewSessionState } from './sessionState';
import { syncProgressFromReviewArtifact } from '../progress/autoSyncRuntime';
import { withProgressWriteLock } from '../progress/progressWriteLock';

export interface RecordReviewMilestoneArgs {
  path: string;
  milestoneId?: string;
  milestoneTitle: string;
  summary: string;
  status?: 'in_progress' | 'completed';
  conclusion?: string;
  evidenceFiles?: string[];
  evidence?: ReviewEvidenceRef[];
  findings?: string[];
  structuredFindings?: ReviewFindingInput[];
  reviewedModules?: string[];
  recommendedNextAction?: string;
}

export function createRecordReviewMilestoneToolDeclaration(): ToolDeclaration {
  return {
    name: 'record_review_milestone',
    description:
      'Add a milestone to the review in progress and update the summary, findings and statistics of its document under .graycode/review/**.md. path must be the document of the review currently in progress in this conversation. After finalize_review, milestones can no longer be recorded unless the review is reopened with reopen_review.',
    category: 'review',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the review document, under .graycode/review/**.md.' },
        milestoneId: { type: 'string', description: 'Optional milestone ID. Generated automatically if omitted.' },
        milestoneTitle: { type: 'string', description: 'Milestone title.' },
        summary: { type: 'string', description: 'Milestone summary in Markdown.' },
        status: { type: 'string', enum: ['in_progress', 'completed'], description: 'Milestone status.' },
        conclusion: { type: 'string', description: 'Optional latest conclusion to show in the review summary.' },
        evidenceFiles: {
          type: 'array',
          description: 'Optional file paths that serve as evidence. Use them when you cannot point to specific lines.',
          items: { type: 'string' }
        },
        evidence: {
          type: 'array',
          description: 'Optional evidence references, each with a file path and optional lines, symbol or excerpt hash.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              lineStart: { type: 'number' },
              lineEnd: { type: 'number' },
              symbol: { type: 'string' },
              excerptHash: { type: 'string' }
            },
            required: ['path']
          }
        },
        findings: {
          type: 'array',
          description: 'Optional findings as plain text, merged into the findings section. Prefer structuredFindings.',
          items: { type: 'string' }
        },
        structuredFindings: {
          type: 'array',
          description: 'Optional structured findings, merged into the findings section. Keep each title short and put the explanation in description.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Optional short, stable finding ID. Leave it out unless you already have one.' },
              severity: { type: 'string', enum: ['high', 'medium', 'low'] },
              category: {
                type: 'string',
                enum: ['html', 'css', 'javascript', 'accessibility', 'performance', 'maintainability', 'docs', 'test', 'other']
              },
              title: { type: 'string', description: 'Short label for the issue, not a full sentence, file path or recommendation.' },
              description: { type: 'string', description: 'Detailed explanation of the finding, including reasoning, impact and context.' },
              evidenceFiles: { type: 'array', description: 'Optional file paths that serve as evidence for this finding.', items: { type: 'string' } },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    lineStart: { type: 'number' },
                    lineEnd: { type: 'number' },
                    symbol: { type: 'string' },
                    excerptHash: { type: 'string' }
                  },
                  required: ['path']
                }
              },
              relatedMilestoneIds: { type: 'array', description: 'Optional IDs of related milestones.', items: { type: 'string' } },
              recommendation: { type: 'string', description: 'Optional suggestion for fixing or handling the finding.' },
              trackingStatus: { type: 'string', enum: ['open', 'accepted_risk', 'fixed', 'wont_fix', 'duplicate'] }
            },
            required: ['title']
          }
        },
        reviewedModules: {
          type: 'array',
          description: 'Optional modules covered by the review, merged into the review summary.',
          items: { type: 'string' }
        },
        recommendedNextAction: {
          type: 'string',
          description: 'Optional recommended next step to show in the review summary.'
        }
      },
      required: ['path', 'milestoneTitle', 'summary']
    }
  };
}

export function createRecordReviewMilestoneTool(): Tool {
  return {
    declaration: createRecordReviewMilestoneToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> => {
      const args = parseArgs<RecordReviewMilestoneArgs>(rawArgs);
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      const milestoneTitle = typeof args.milestoneTitle === 'string' ? args.milestoneTitle : '';
      const summary = typeof args.summary === 'string' ? args.summary : '';

      if (!path) {
        return { success: false, error: 'path is required and must be a non-empty string' };
      }
      if (!milestoneTitle.trim()) {
        return { success: false, error: 'milestoneTitle is required and must be a non-empty string' };
      }
      if (!summary.trim()) {
        return { success: false, error: 'summary is required and must be a non-empty string' };
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
        const next = await withProgressWriteLock(path, async () => {
          const contentBytes = await documentReadFile(uri);
          const originalContent = normalizeLineEndingsToLF(new TextDecoder().decode(contentBytes));
          const locale = getCurrentReviewDocumentLocale();
          const result = appendReviewMilestone(originalContent, {
            milestoneId: typeof args.milestoneId === 'string' ? args.milestoneId : '',
            milestoneTitle,
            summary,
            status: args.status,
            conclusion: typeof args.conclusion === 'string' ? args.conclusion : '',
            evidenceFiles: Array.isArray(args.evidenceFiles) ? args.evidenceFiles : [],
            evidence: Array.isArray(args.evidence) ? args.evidence : [],
            findings: Array.isArray(args.findings) ? args.findings : [],
            structuredFindings: Array.isArray(args.structuredFindings) ? args.structuredFindings : [],
            reviewedModules: Array.isArray(args.reviewedModules) ? args.reviewedModules : [],
            recommendedNextAction: typeof args.recommendedNextAction === 'string' ? args.recommendedNextAction : ''
          }, locale);
          await documentWriteFile(uri, new TextEncoder().encode(result.content));
          return result;
        });
        const progressWarnings = await syncProgressFromReviewArtifact({
          reviewPath: path,
          title: next.reviewSnapshot.header.title,
          latestConclusion: next.reviewSnapshot.summary.latestConclusion || undefined,
          nextAction: next.reviewSnapshot.summary.recommendedNextAction || undefined,
          eventMessage: `同步审查里程碑：${next.milestoneId}`
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
              type: 'milestone_recorded',
              milestoneId: next.milestoneId,
              addedFindingIds: next.addedFindingIds,
              changedFields: ['milestones', 'findings', 'summary', 'stats', 'reviewSnapshot', 'reviewSession']
            },
            extra: {
              milestoneId: next.milestoneId,
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

export function registerRecordReviewMilestone(): Tool {
  return createRecordReviewMilestoneTool();
}
