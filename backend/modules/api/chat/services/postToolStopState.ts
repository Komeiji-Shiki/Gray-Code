import type { FunctionCallInfo, ToolExecutionResult } from '../utils';
import {
  replacePendingApprovalGate,
  type PendingApprovalGateSeed,
  type PendingApprovalGateStore
} from '../../../conversation/pendingApprovalGate';
import { classifyApprovalGateForToolResult } from './approvalGateRules';

export interface PostToolStopLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
}

export interface PersistPostToolStopOptions {
  logger?: PostToolStopLogger;
  logContext?: Record<string, unknown>;
}

export type PostToolStopReason = 'approval' | 'cancelled' | null;

export interface PostToolStopState {
  shouldStop: boolean;
  reason: PostToolStopReason;
  gateSeed?: PendingApprovalGateSeed;
  matchedToolId?: string;
  matchedToolName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolvePostToolStopState(
  functionCalls: Pick<FunctionCallInfo, 'id' | 'name' | 'args'>[],
  toolResults: ToolExecutionResult[]
): PostToolStopState {
  const callById = new Map<string, Pick<FunctionCallInfo, 'id' | 'name' | 'args'>>();
  for (const call of functionCalls) {
    callById.set(call.id, call);
  }

  for (const toolResult of toolResults) {
    const resultRecord = asRecord(toolResult.result) || {};
    const call = callById.get(toolResult.id) || {
      id: toolResult.id,
      name: toolResult.name,
      args: {}
    };

    const gateSeed = classifyApprovalGateForToolResult(call, resultRecord);
    if (gateSeed) {
      return {
        shouldStop: true,
        reason: 'approval',
        gateSeed,
        matchedToolId: call.id,
        matchedToolName: call.name
      };
    }

    if (resultRecord.requiresUserConfirmation === true) {
      return {
        shouldStop: true,
        reason: 'approval',
        matchedToolId: call.id,
        matchedToolName: call.name
      };
    }

    if (resultRecord.cancelled === true) {
      return {
        shouldStop: true,
        reason: 'cancelled',
        matchedToolId: call.id,
        matchedToolName: call.name
      };
    }
  }

  return {
    shouldStop: false,
    reason: null
  };
}

export async function resolveAndPersistPostToolStopState(
  store: PendingApprovalGateStore,
  conversationId: string,
  functionCalls: Pick<FunctionCallInfo, 'id' | 'name' | 'args'>[],
  toolResults: ToolExecutionResult[],
  options: PersistPostToolStopOptions = {}
): Promise<PostToolStopState> {
  const stopState = resolvePostToolStopState(functionCalls, toolResults);
  const logger = options.logger;
  const logContext = options.logContext ?? {};

  if (stopState.gateSeed) {
    const gate = await replacePendingApprovalGate(store, conversationId, stopState.gateSeed);
    logger?.info('approval_gate.armed', {
      ...logContext,
      conversationId,
      gateId: gate.id,
      gateKind: gate.kind,
      sourceToolId: gate.sourceToolCallId,
      sourceToolName: gate.sourceToolName,
      sourcePath: gate.sourcePath || null
    });
    return stopState;
  }

  if (stopState.shouldStop) {
    logger?.info('tool.post_stop', {
      ...logContext,
      conversationId,
      reason: stopState.reason,
      toolId: stopState.matchedToolId || null,
      toolName: stopState.matchedToolName || null
    });
  }

  return stopState;
}
