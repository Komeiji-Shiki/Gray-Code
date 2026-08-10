/**
 * Design / Review / Plan 审批确认消息处理器
 *
 * 拆分自 FileHandlers.ts 域 K：pendingApprovalGate 的 UI 桥，
 * 与"文件"主题无关，独立成文件。
 * - design.confirmPlanGeneration / review.confirmPlanGeneration：文档确认后生成计划
 * - plan.confirmExecution：计划确认后开始实现
 * - plan.getSourceStatus：计划源工件状态查询
 */

import * as vscode from 'vscode';
import type { HandlerContext, MessageHandler } from '../types';
import { resolveUriWithInfo } from '../../backend/tools/utils';
import { extractPlanTodoListFromContent } from '../../backend/tools/plan/todoListSection';
import { getPlanSourceStatusFromContent, type PlanSourceStatusResult } from '../../backend/tools/plan/sourceArtifactSection';
import {
  getPendingApprovalGate,
  getPendingApprovalGateMismatchReason,
  type PendingApprovalGateExpectation
} from '../../backend/modules/conversation/pendingApprovalGate';

// ========== Design 生成计划确认 ==========

function buildPlanGenerationPrompt(artifactType: 'design' | 'review', modified: boolean): string {
  const artifactLabel = artifactType === 'design' ? 'design' : 'review';
  const sourceInstruction = modified
    ? `The user modified the ${artifactLabel} and confirmed the latest version. Use the latest version above as the source of truth.`
    : `Use the confirmed ${artifactLabel} content above as the source of truth.`;

  return [
    `User confirmed the ${artifactLabel} and asked you to generate the implementation plan now.`,
    '',
    sourceInstruction,
    'You are no longer reviewing whether this document is ready.',
    'Do not ask for another confirmation.',
    `Do not restate that the ${artifactLabel} is ready for review.`,
    `When you call create_plan, include sourceArtifact that points to the confirmed ${artifactLabel} document.`,
    'Create the implementation plan immediately by using create_plan.'
  ].join('\n');
}

function buildPlanExecutionPrompt(modified: boolean): string {
  return [
    'User confirmed the plan and asked you to begin implementation now.',
    '',
    modified ? 'The user modified the plan and confirmed the latest version. Use the latest version above as the source of truth.' : 'Use the confirmed plan content above as the source of truth.',
    'You are no longer drafting or reviewing the plan.',
    'Do not say that the plan is ready for review.',
    'Do not create another plan unless the user explicitly asks to revise it.',
    'Start implementation immediately.',
    'Use todo_update to track progress as you work.',
    'Use update_progress and record_progress_milestone to keep .graycode/progress.md current at the project level when progress changes in a meaningful way.',
    "When TODO status changes in a meaningful way, call update_plan with updateMode: 'progress_sync' to sync the latest TODO snapshot back to the plan document.",
    "When calling update_plan with updateMode: 'progress_sync', never pass sourceArtifact. Only send path, todos, updateMode, and optional changeSummary."
  ].join('\n');
}

async function readWorkspaceTextContent(filePath: string): Promise<string | null> {
  const { uri } = resolveUriWithInfo(filePath);
  if (!uri) return null;

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return null;
  }
}

async function resolvePlanSourceStatus(planContent: string): Promise<PlanSourceStatusResult> {
  return getPlanSourceStatusFromContent(planContent, readWorkspaceTextContent);
}

function buildPlanSourceBlockedError(sourceStatus: PlanSourceStatusResult): string {
  if (sourceStatus.sourceStatus === 'mismatched') {
    const label = sourceStatus.sourceArtifactType || 'source';
    const suffix = sourceStatus.sourcePath ? `: ${sourceStatus.sourcePath}` : '';
    return `The ${label} artifact changed. Please regenerate or revise the plan before execution${suffix}`;
  }

  if (sourceStatus.sourceStatus === 'missing_source') {
    const label = sourceStatus.sourceArtifactType || 'source';
    const suffix = sourceStatus.sourcePath ? `: ${sourceStatus.sourcePath}` : '';
    return `The ${label} artifact is missing or unreadable. Please revise the plan before execution${suffix}`;
  }

  return 'The plan source artifact is not executable in its current state.';
}

async function validatePendingApprovalGateForContinuation(
  ctx: HandlerContext,
  options: {
    conversationId: unknown;
    toolId: unknown;
    expectation: PendingApprovalGateExpectation;
  }
): Promise<{ success: true; approvalId: string } | { success: false; error: string }> {
  const conversationId = typeof options.conversationId === 'string' ? options.conversationId.trim() : '';
  if (!conversationId) {
    return { success: false, error: 'conversationId is required for approval-gated continuation.' };
  }

  const toolId = typeof options.toolId === 'string' ? options.toolId.trim() : '';
  if (!toolId) {
    return { success: false, error: 'toolId is required for approval-gated continuation.' };
  }

  const gate = await getPendingApprovalGate(ctx.conversationManager, conversationId);
  if (!gate) {
    return { success: false, error: 'No pending approval gate exists for this conversation.' };
  }

  const mismatch = getPendingApprovalGateMismatchReason(gate, {
    ...options.expectation,
    sourceToolCallId: toolId
  });

  if (mismatch) {
    return { success: false, error: mismatch };
  }

  return {
    success: true,
    approvalId: gate.id
  };
}

export const designConfirmPlanGeneration: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: designPathRaw, originalContent, conversationId, toolId } = data || {};
    const designPath = typeof designPathRaw === 'string' ? designPathRaw.trim() : '';
    const originalText = typeof originalContent === 'string' ? originalContent : '';
    const confirmedPrompt = buildPlanGenerationPrompt('design', false);
    const modifiedPrompt = buildPlanGenerationPrompt('design', true);

    const gateCheck = await validatePendingApprovalGateForContinuation(ctx, {
      conversationId,
      toolId,
      expectation: {
        kind: 'generate_plan',
        continuationIntent: 'generate_plan_now',
        sourceArtifactType: 'design',
        sourcePath: designPath || undefined
      }
    });
    if (gateCheck.success === false) {
      ctx.sendResponse(requestId, { success: false, error: gateCheck.error });
      return;
    }

    const replyWithDesign = async (prompt: string, designContent: string) => {
      ctx.sendResponse(requestId, {
        success: true,
        approvalId: gateCheck.approvalId,
        prompt,
        designContent,
        designPath
      });
    };

    if (!designPath) {
      await replyWithDesign(confirmedPrompt, originalText);
      return;
    }

    const { uri } = resolveUriWithInfo(designPath);
    if (!uri) {
      await replyWithDesign(confirmedPrompt, originalText);
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const currentContent = Buffer.from(bytes).toString('utf-8');

      const currentTrimmed = (currentContent || '').trim();
      const originalTrimmed = originalText.trim();

      if (currentTrimmed !== originalTrimmed) {
        await replyWithDesign(modifiedPrompt, currentContent);
      } else {
        await replyWithDesign(
          confirmedPrompt,
          originalText || currentContent || ''
        );
      }
    } catch {
      // File read failed, fallback to original content
      await replyWithDesign(confirmedPrompt, originalText);
    }
  } catch (error: any) {
    ctx.sendError(requestId, 'DESIGN_CONFIRM_PLAN_GENERATION_ERROR', error.message || 'Failed to confirm design plan generation');
  }
};

export const reviewConfirmPlanGeneration: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: reviewPathRaw, originalContent, conversationId, toolId } = data || {};
    const reviewPath = typeof reviewPathRaw === 'string' ? reviewPathRaw.trim() : '';
    const originalText = typeof originalContent === 'string' ? originalContent : '';
    const confirmedPrompt = buildPlanGenerationPrompt('review', false);
    const modifiedPrompt = buildPlanGenerationPrompt('review', true);

    const gateCheck = await validatePendingApprovalGateForContinuation(ctx, {
      conversationId,
      toolId,
      expectation: {
        kind: 'generate_plan',
        continuationIntent: 'generate_plan_now',
        sourceArtifactType: 'review',
        sourcePath: reviewPath || undefined
      }
    });
    if (gateCheck.success === false) {
      ctx.sendResponse(requestId, { success: false, error: gateCheck.error });
      return;
    }

    const replyWithReview = async (prompt: string, reviewContent: string) => {
      ctx.sendResponse(requestId, {
        success: true,
        approvalId: gateCheck.approvalId,
        prompt,
        reviewContent,
        reviewPath
      });
    };

    if (!reviewPath) {
      await replyWithReview(confirmedPrompt, originalText);
      return;
    }

    const { uri } = resolveUriWithInfo(reviewPath);
    if (!uri) {
      await replyWithReview(confirmedPrompt, originalText);
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const currentContent = Buffer.from(bytes).toString('utf-8');

      const currentTrimmed = (currentContent || '').trim();
      const originalTrimmed = originalText.trim();

      if (currentTrimmed !== originalTrimmed) {
        await replyWithReview(modifiedPrompt, currentContent);
      } else {
        await replyWithReview(
          confirmedPrompt,
          originalText || currentContent || ''
        );
      }
    } catch {
      await replyWithReview(confirmedPrompt, originalText);
    }
  } catch (error: any) {
    ctx.sendError(requestId, 'REVIEW_CONFIRM_PLAN_GENERATION_ERROR', error.message || 'Failed to confirm review plan generation');
  }
};

export const planGetSourceStatus: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: planPathRaw, originalContent } = data || {};
    const planPath = typeof planPathRaw === 'string' ? planPathRaw.trim() : '';
    const originalText = typeof originalContent === 'string' ? originalContent : '';

    let planContent = originalText;
    if (planPath) {
      const latestContent = await readWorkspaceTextContent(planPath);
      if (typeof latestContent === 'string') {
        planContent = latestContent;
      }
    }

    const sourceStatus = await resolvePlanSourceStatus(planContent || '');
    const blocked = sourceStatus.sourceStatus === 'mismatched' || sourceStatus.sourceStatus === 'missing_source';

    ctx.sendResponse(requestId, {
      success: true,
      planPath,
      sourceStatus: sourceStatus.sourceStatus,
      sourceArtifactType: sourceStatus.sourceArtifactType,
      sourcePath: sourceStatus.sourcePath,
      blocked,
      blockReason: sourceStatus.sourceStatus === 'mismatched'
        ? 'source_mismatched'
        : sourceStatus.sourceStatus === 'missing_source'
          ? 'source_missing'
          : undefined,
      error: blocked ? buildPlanSourceBlockedError(sourceStatus) : undefined
    });
  } catch (error: any) {
    ctx.sendError(requestId, 'PLAN_GET_SOURCE_STATUS_ERROR', error.message || 'Failed to get plan source status');
  }
};

// ========== Plan 执行确认 ==========

export const planConfirmExecution: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: planPath, originalContent, conversationId, toolId } = data || {};
    const confirmedPrompt = buildPlanExecutionPrompt(false);
    const originalText = typeof originalContent === 'string' ? originalContent : '';
    const modifiedPrompt = buildPlanExecutionPrompt(true);

    const normalizedPlanPath = typeof planPath === 'string' ? planPath.trim() : '';
    const gateCheck = await validatePendingApprovalGateForContinuation(ctx, {
      conversationId,
      toolId,
      expectation: {
        kind: 'execute_plan',
        continuationIntent: 'implement_now',
        sourceArtifactType: 'plan',
        sourcePath: normalizedPlanPath || undefined
      }
    });
    if (gateCheck.success === false) {
      ctx.sendResponse(requestId, { success: false, error: gateCheck.error });
      return;
    }

    let latestSourceStatus: PlanSourceStatusResult = { sourceStatus: 'untracked' };

    const syncTodosFromPlanContent = async (planContent: string) => {
      const todos = extractPlanTodoListFromContent(planContent || '');

      if (typeof conversationId === 'string' && conversationId.trim()) {
        try {
          await ctx.conversationManager.setCustomMetadata(conversationId.trim(), 'todoList', todos);
        } catch (todoError) {
          console.error('[plan.confirmExecution] Failed to sync todos from plan document:', todoError);
        }
      }

      return todos;
    };

    const replyWithPlan = async (prompt: string, planContent: string) => {
      latestSourceStatus = await resolvePlanSourceStatus(planContent);
      if (latestSourceStatus.sourceStatus === 'mismatched' || latestSourceStatus.sourceStatus === 'missing_source') {
        ctx.sendResponse(requestId, {
          success: false,
          blocked: true,
          blockReason: latestSourceStatus.sourceStatus === 'mismatched' ? 'source_mismatched' : 'source_missing',
          sourceStatus: latestSourceStatus.sourceStatus,
          sourceArtifactType: latestSourceStatus.sourceArtifactType,
          sourcePath: latestSourceStatus.sourcePath,
          planPath: typeof planPath === 'string' ? planPath : '',
          error: buildPlanSourceBlockedError(latestSourceStatus)
        });
        return;
      }

      const todos = await syncTodosFromPlanContent(planContent);
      ctx.sendResponse(requestId, {
        success: true,
        approvalId: gateCheck.approvalId,
        prompt,
        planContent,
        todos,
        sourceStatus: latestSourceStatus.sourceStatus,
        sourceArtifactType: latestSourceStatus.sourceArtifactType,
        sourcePath: latestSourceStatus.sourcePath
      });
    };

    if (!planPath || typeof planPath !== 'string') {
      await replyWithPlan(confirmedPrompt, originalText);
      return;
    }

    const { uri } = resolveUriWithInfo(planPath);
    if (!uri) return await replyWithPlan(confirmedPrompt, originalText);

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const currentContent = Buffer.from(bytes).toString('utf-8');

      const currentTrimmed = (currentContent || '').trim();
      const originalTrimmed = originalText.trim();

      if (currentTrimmed !== originalTrimmed) {
        await replyWithPlan(
          modifiedPrompt, currentContent);
      } else {
        // 即使内容未变，也同步一次文档中的 TODO LIST（用户可能仅做了不影响 trim 的微调）
        await replyWithPlan(
          confirmedPrompt,
          originalText || currentContent || ''
        );
      }
    } catch {
      // File read failed, fallback to confirm
      await replyWithPlan(confirmedPrompt, originalText);
    }
  } catch (error: any) {
    ctx.sendError(requestId, 'PLAN_CONFIRM_ERROR', error.message || 'Failed to confirm plan execution');
  }
};

/**
 * 注册审批确认处理器
 */
export function registerPlanApprovalHandlers(registry: Map<string, MessageHandler>): void {
  // Design 生成计划确认
  registry.set('design.confirmPlanGeneration', designConfirmPlanGeneration);

  // Review 生成计划确认
  registry.set('review.confirmPlanGeneration', reviewConfirmPlanGeneration);

  // Plan 执行确认
  registry.set('plan.confirmExecution', planConfirmExecution);
  registry.set('plan.getSourceStatus', planGetSourceStatus);
}
