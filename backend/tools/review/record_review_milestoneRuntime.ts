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
      '为当前会话进行中的审查追加里程碑，更新文档摘要、发现与统计。path 必须指向当前审查；结束后须先用 reopen_review 重新打开。',
    category: 'review',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '审查文档路径，位于 .graycode/review/**.md 下。' },
        milestoneId: { type: 'string', description: '可选的里程碑 ID，不传时自动生成。' },
        milestoneTitle: { type: 'string', description: '里程碑标题。' },
        summary: { type: 'string', description: '里程碑摘要，使用 Markdown。' },
        status: { type: 'string', enum: ['in_progress', 'completed'], description: '里程碑状态。' },
        conclusion: { type: 'string', description: '可选，要显示在审查摘要中的最新结论。' },
        evidenceFiles: {
          type: 'array',
          description: '可选的证据文件路径数组。无法指出具体行号时使用。',
          items: { type: 'string' }
        },
        evidence: {
          type: 'array',
          description: '可选的证据引用数组，每项包含文件路径，以及可选的行号、符号或片段哈希。',
          items: {
            type: 'object',
            properties: {
              path: { description: '证据文件路径。', type: 'string' },
              lineStart: { description: '可选的起始行号，从 1 开始。', type: 'number' },
              lineEnd: { description: '可选的结束行号，从 1 开始。', type: 'number' },
              symbol: { description: '可选的符号名。', type: 'string' },
              excerptHash: { description: '可选的证据片段哈希。', type: 'string' }
            },
            required: ['path']
          }
        },
        findings: {
          type: 'array',
          description: '可选的纯文本问题数组，会合并到问题区。优先使用 structuredFindings。',
          items: { type: 'string' }
        },
        structuredFindings: {
          type: 'array',
          description: '可选的结构化问题数组，会合并到问题区。标题保持简短，详细说明写在 description 中。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '可选的简短、稳定的问题 ID。没有现成的 ID 时省略。' },
              severity: { description: '严重程度。', type: 'string', enum: ['high', 'medium', 'low'] },
              category: {
                type: 'string',
                description: '问题类别。',
                enum: ['html', 'css', 'javascript', 'accessibility', 'performance', 'maintainability', 'docs', 'test', 'other']
              },
              title: { type: 'string', description: '简短的问题标签，不要写成完整句子、文件路径或建议。' },
              description: { type: 'string', description: '问题的详细说明，包括推理过程、影响和背景。' },
              evidenceFiles: { type: 'array', description: '可选，作为该问题证据的文件路径数组。', items: { type: 'string' } },
              evidence: {
                type: 'array',
                description: '可选，该问题的证据引用数组。',
                items: {
                  type: 'object',
                  properties: {
                    path: { description: '证据文件路径。', type: 'string' },
                    lineStart: { description: '可选的起始行号，从 1 开始。', type: 'number' },
                    lineEnd: { description: '可选的结束行号，从 1 开始。', type: 'number' },
                    symbol: { description: '可选的符号名。', type: 'string' },
                    excerptHash: { description: '可选的证据片段哈希。', type: 'string' }
                  },
                  required: ['path']
                }
              },
              relatedMilestoneIds: { type: 'array', description: '可选，相关里程碑的 ID 数组。', items: { type: 'string' } },
              recommendation: { type: 'string', description: '可选的修复或处理建议。' },
              trackingStatus: { description: '跟踪状态。', type: 'string', enum: ['open', 'accepted_risk', 'fixed', 'wont_fix', 'duplicate'] }
            },
            required: ['title']
          }
        },
        reviewedModules: {
          type: 'array',
          description: '可选，本次审查覆盖的模块数组，会合并到审查摘要。',
          items: { type: 'string' }
        },
        recommendedNextAction: {
          type: 'string',
          description: '可选，要显示在审查摘要中的建议下一步。'
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
