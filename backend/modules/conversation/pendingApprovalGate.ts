import type {
  PendingApprovalGate,
  PendingApprovalGateContinuationIntent,
  PendingApprovalGateKind,
  PendingApprovalGateSourceArtifactType
} from './types';

export const PENDING_APPROVAL_GATE_KEY = 'pendingApprovalGate';

export interface PendingApprovalGateStore {
  getCustomMetadata(conversationId: string, key: string): Promise<unknown>;
  setCustomMetadata(conversationId: string, key: string, value: unknown): Promise<void>;
}

export interface PendingApprovalGateSeed {
  kind: PendingApprovalGateKind;
  continuationIntent: PendingApprovalGateContinuationIntent;
  sourceToolCallId: string;
  sourceToolName: string;
  sourceArtifactType: PendingApprovalGateSourceArtifactType;
  sourcePath?: string;
}

export interface PendingApprovalGateExpectation {
  kind?: PendingApprovalGateKind;
  continuationIntent?: PendingApprovalGateContinuationIntent;
  sourceToolCallId?: string;
  sourceArtifactType?: PendingApprovalGateSourceArtifactType;
  sourcePath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function normalizePath(value: unknown): string | undefined {
  const normalized = asString(value);
  return normalized ? normalized.replace(/\\/g, '/') : undefined;
}

export function isPendingApprovalGateKind(value: unknown): value is PendingApprovalGateKind {
  return value === 'generate_plan' || value === 'execute_plan';
}

export function isPendingApprovalGateContinuationIntent(value: unknown): value is PendingApprovalGateContinuationIntent {
  return value === 'generate_plan_now' || value === 'implement_now';
}

export function isPendingApprovalGateSourceArtifactType(value: unknown): value is PendingApprovalGateSourceArtifactType {
  return value === 'design' || value === 'review' || value === 'plan';
}

export function normalizePendingApprovalGate(value: unknown): PendingApprovalGate | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = asString(record.id);
  const kind = record.kind;
  const continuationIntent = record.continuationIntent;
  const sourceToolCallId = asString(record.sourceToolCallId);
  const sourceToolName = asString(record.sourceToolName);
  const sourceArtifactType = record.sourceArtifactType;
  const createdAt = asNumber(record.createdAt);

  if (!id || !isPendingApprovalGateKind(kind) || !isPendingApprovalGateContinuationIntent(continuationIntent)) {
    return null;
  }

  if (!sourceToolCallId || !sourceToolName || !isPendingApprovalGateSourceArtifactType(sourceArtifactType) || createdAt === undefined) {
    return null;
  }

  return {
    id,
    kind,
    continuationIntent,
    sourceToolCallId,
    sourceToolName,
    sourceArtifactType,
    sourcePath: normalizePath(record.sourcePath),
    createdAt
  };
}

function createPendingApprovalGateId(): string {
  return `approval_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getPendingApprovalGateKindForContinuationIntent(
  intent: PendingApprovalGateContinuationIntent
): PendingApprovalGateKind {
  return intent === 'implement_now' ? 'execute_plan' : 'generate_plan';
}

export async function getPendingApprovalGate(
  store: PendingApprovalGateStore,
  conversationId: string
): Promise<PendingApprovalGate | null> {
  const raw = await store.getCustomMetadata(conversationId, PENDING_APPROVAL_GATE_KEY);
  return normalizePendingApprovalGate(raw);
}

export async function replacePendingApprovalGate(
  store: PendingApprovalGateStore,
  conversationId: string,
  seed: PendingApprovalGateSeed
): Promise<PendingApprovalGate> {
  const gate: PendingApprovalGate = {
    id: createPendingApprovalGateId(),
    kind: seed.kind,
    continuationIntent: seed.continuationIntent,
    sourceToolCallId: seed.sourceToolCallId,
    sourceToolName: seed.sourceToolName,
    sourceArtifactType: seed.sourceArtifactType,
    sourcePath: normalizePath(seed.sourcePath),
    createdAt: Date.now()
  };

  await store.setCustomMetadata(conversationId, PENDING_APPROVAL_GATE_KEY, gate);
  return gate;
}

export async function clearPendingApprovalGate(
  store: PendingApprovalGateStore,
  conversationId: string
): Promise<void> {
  await store.setCustomMetadata(conversationId, PENDING_APPROVAL_GATE_KEY, null);
}

export function getPendingApprovalGateMismatchReason(
  gate: PendingApprovalGate,
  expected: PendingApprovalGateExpectation
): string | null {
  if (expected.kind && gate.kind !== expected.kind) {
    return `Approval gate kind mismatch. Expected ${expected.kind}, got ${gate.kind}.`;
  }

  if (expected.continuationIntent && gate.continuationIntent !== expected.continuationIntent) {
    return `Approval gate intent mismatch. Expected ${expected.continuationIntent}, got ${gate.continuationIntent}.`;
  }

  if (expected.sourceToolCallId) {
    const expectedToolId = expected.sourceToolCallId.trim();
    if (!expectedToolId) {
      return 'Approval gate validation requires a non-empty toolId.';
    }
    if (gate.sourceToolCallId !== expectedToolId) {
      return `Approval gate tool mismatch. Expected toolId=${expectedToolId}, got ${gate.sourceToolCallId}.`;
    }
  }

  if (expected.sourceArtifactType && gate.sourceArtifactType !== expected.sourceArtifactType) {
    return `Approval gate source artifact mismatch. Expected ${expected.sourceArtifactType}, got ${gate.sourceArtifactType}.`;
  }

  if (typeof expected.sourcePath === 'string') {
    const expectedPath = normalizePath(expected.sourcePath);
    const actualPath = normalizePath(gate.sourcePath);
    if ((expectedPath || '') !== (actualPath || '')) {
      return `Approval gate path mismatch. Expected ${expectedPath || '(empty)'}, got ${actualPath || '(empty)'}.`;
    }
  }

  return null;
}
