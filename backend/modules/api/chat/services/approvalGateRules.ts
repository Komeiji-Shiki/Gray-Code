import type { HiddenFunctionResponseData } from '../types';
import type { FunctionCallInfo } from '../utils';
import type { PendingApprovalGateContinuationIntent } from '../../../conversation/types';
import type { PendingApprovalGateSeed } from '../../../conversation/pendingApprovalGate';

const REVIEW_TOOL_NAMES = new Set([
  'create_review',
  'record_review_milestone',
  'finalize_review',
  'reopen_review',
  'validate_review_document',
  'compare_review_documents'
]);

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as LooseRecord
    : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizePath(value: unknown): string | undefined {
  const normalized = asString(value);
  return normalized ? normalized.replace(/\\/g, '/') : undefined;
}

function hasMeaningfulValue(value: unknown): boolean {
  return typeof value === 'string'
    ? value.trim().length > 0
    : value !== undefined && value !== null;
}

function getResultData(result: unknown): LooseRecord | null {
  const record = asRecord(result);
  return asRecord(record?.data);
}

function normalizePlanUpdateMode(result: unknown, args: unknown): 'revision' | 'progress_sync' {
  const resultRecord = asRecord(result);
  const data = getResultData(result);
  const argsRecord = asRecord(args);
  return data?.updateMode === 'progress_sync'
    || resultRecord?.updateMode === 'progress_sync'
    || argsRecord?.updateMode === 'progress_sync'
    ? 'progress_sync'
    : 'revision';
}

function getSourcePath(result: unknown, args: unknown): string | undefined {
  const resultRecord = asRecord(result);
  const data = getResultData(result);
  const argsRecord = asRecord(args);
  return normalizePath(data?.path)
    || normalizePath(resultRecord?.path)
    || normalizePath(argsRecord?.path);
}

function getReviewStatus(result: unknown): string | undefined {
  const data = getResultData(result);
  const reviewSnapshot = asRecord(data?.reviewSnapshot);
  return asString(reviewSnapshot?.status)
    || asString(data?.status)
    || asString(data?.currentStatus);
}

function hasLegacyPlanGenerationFields(record: LooseRecord): boolean {
  return hasMeaningfulValue(record.planGenerationPrompt)
    || hasMeaningfulValue(record.designPath)
    || hasMeaningfulValue(record.designContent)
    || hasMeaningfulValue(record.reviewPath)
    || hasMeaningfulValue(record.reviewContent);
}

function hasLegacyPlanExecutionFields(record: LooseRecord): boolean {
  return hasMeaningfulValue(record.planExecutionPrompt)
    || hasMeaningfulValue(record.planPath)
    || hasMeaningfulValue(record.planContent);
}

export function isCoveredContinuationIntent(value: unknown): value is PendingApprovalGateContinuationIntent {
  return value === 'generate_plan_now' || value === 'implement_now';
}

export function getCoveredContinuationIntentFromResponse(
  response: unknown
): PendingApprovalGateContinuationIntent | null {
  const record = asRecord(response);
  if (!record) return null;

  if (record.continuationApproved === true && isCoveredContinuationIntent(record.continuationIntent)) {
    return record.continuationIntent;
  }

  if (hasLegacyPlanExecutionFields(record)) {
    return 'implement_now';
  }

  if (hasLegacyPlanGenerationFields(record)) {
    return 'generate_plan_now';
  }

  return null;
}

export function getHiddenContinuationApprovalRequirement(
  hiddenFunctionResponse: HiddenFunctionResponseData | undefined
): { intent: PendingApprovalGateContinuationIntent; approvalId?: string } | null {
  if (!hiddenFunctionResponse) return null;

  const intent = getCoveredContinuationIntentFromResponse(hiddenFunctionResponse.response);
  if (!intent) return null;

  const approvalId = asString(hiddenFunctionResponse.approvalId);
  return {
    intent,
    approvalId
  };
}

export function classifyApprovalGateForToolResult(
  call: Pick<FunctionCallInfo, 'id' | 'name' | 'args'>,
  result: Record<string, unknown>
): PendingApprovalGateSeed | null {
  if (!call.id || !call.name || result.success !== true) {
    return null;
  }

  const sourcePath = getSourcePath(result, call.args);

  if (call.name === 'create_design' || call.name === 'update_design') {
    if (result.requiresUserConfirmation !== true) return null;
    return {
      kind: 'generate_plan',
      continuationIntent: 'generate_plan_now',
      sourceToolCallId: call.id,
      sourceToolName: call.name,
      sourceArtifactType: 'design',
      sourcePath
    };
  }

  if (call.name === 'create_plan') {
    if (result.requiresUserConfirmation !== true) return null;
    return {
      kind: 'execute_plan',
      continuationIntent: 'implement_now',
      sourceToolCallId: call.id,
      sourceToolName: call.name,
      sourceArtifactType: 'plan',
      sourcePath
    };
  }

  if (call.name === 'update_plan') {
    if (normalizePlanUpdateMode(result, call.args) === 'progress_sync') {
      return null;
    }
    if (result.requiresUserConfirmation !== true) return null;
    return {
      kind: 'execute_plan',
      continuationIntent: 'implement_now',
      sourceToolCallId: call.id,
      sourceToolName: call.name,
      sourceArtifactType: 'plan',
      sourcePath
    };
  }

  if (REVIEW_TOOL_NAMES.has(call.name) && getReviewStatus(result) === 'completed') {
    return {
      kind: 'generate_plan',
      continuationIntent: 'generate_plan_now',
      sourceToolCallId: call.id,
      sourceToolName: call.name,
      sourceArtifactType: 'review',
      sourcePath
    };
  }

  return null;
}
