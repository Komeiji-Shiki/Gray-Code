import type { ContextBudget } from './budget';
import type { PlatformMessage } from '@graycode/contracts';
import type { ContextUserMessageRetention } from '../../../../shared/contextManagement';
import { evaluateAutoSummaryNeed } from '../../../../backend/modules/api/chat/services/contextTrim/autoSummaryDecision';
import { retainedUserIds } from './retention';

export interface ContextCompressionBasis {
  providerId: string;
  modelId?: string;
  boundaryId?: string;
  retention?: ContextUserMessageRetention;
  fixedTokens: number;
  maxInputTokens: number;
  softLimitTokens: number;
}

export interface TurnContextState {
  turnId: string;
  summaryAttempts: number;
  fallback?: boolean;
  fallbackStart?: number;
  fallbackStartId?: string;
  lastAttemptMessageId?: string;
  lastSummaryInputTokens?: number;
  lastSummarySavedTokens?: number;
  lastSummaryCoveredCount?: number;
  summaryBasis?: ContextCompressionBasis;
  summaryBlocked?: boolean;
}

/** 尝试额度属于用户回合，压缩进度属于仍在使用的模型窗口。 */
export function contextTurnState(previous: TurnContextState | undefined, turnId: string, basis: ContextCompressionBasis): TurnContextState {
  const oldBasis = previous?.summaryBasis;
  const sameBasis = oldBasis !== undefined && oldBasis.providerId === basis.providerId && oldBasis.modelId === basis.modelId
    && oldBasis.boundaryId === basis.boundaryId && oldBasis.retention === basis.retention
    && oldBasis.fixedTokens === basis.fixedTokens && oldBasis.maxInputTokens === basis.maxInputTokens
    && oldBasis.softLimitTokens === basis.softLimitTokens;
  const turn: TurnContextState = previous && previous.turnId === turnId ? { ...previous } : { turnId, summaryAttempts: 0 };
  turn.summaryBasis = basis;
  if (sameBasis) {
    turn.lastSummaryInputTokens = previous?.lastSummaryInputTokens;
    turn.lastSummarySavedTokens = previous?.lastSummarySavedTokens;
    turn.lastSummaryCoveredCount = previous?.lastSummaryCoveredCount;
  } else {
    delete turn.lastSummaryInputTokens;
    delete turn.lastSummarySavedTokens;
    delete turn.lastSummaryCoveredCount;
  }
  return turn;
}

/** 复用同一份逐消息预算，保留原文及其记忆不算可压缩收益，旧摘要也不算新增内容。 */
function compressionFloor(messages: PlatformMessage[], budget: ContextBudget, retention?: ContextUserMessageRetention): number {
  const tokensById = new Map(messages.flatMap((message, index) => message.id ? [[message.id, budget.messageTokens[index]] as const] : []));
  const retained = retainedUserIds(messages.filter(message => !message.memoryContext), retention, {
    maxTokens: Math.max(0, budget.maxInputTokens - budget.fixedTokens),
    estimateTokens: message => (tokensById.get(message.id!) ?? 0) + (tokensById.get(`long-memory:${message.id}`) ?? 0),
  });
  return messages.reduce((tokens, message, index) => tokens + (message.isSummary || retained.has(message.id!)
    || message.memoryContext && message.id?.startsWith('long-memory:') && retained.has(message.id.slice('long-memory:'.length))
    ? budget.messageTokens[index] : 0), budget.fixedTokens);
}

export type ContextAction = 'send' | 'summarize' | 'trim' | 'notes-switch' | 'notes-reminder';

/** 决策只消费同一预算结果；执行、事件与提交留在服务层。 */
export function decideContextAction(input: {
  budget: ContextBudget;
  messages: PlatformMessage[];
  retention?: ContextUserMessageRetention;
  enabled: boolean;
  method: 'summary' | 'notes';
  frozen: boolean;
  hasNewModelHistory: boolean;
  lastMessageId?: string;
  maxAttempts: number;
  turn: TurnContextState;
}): ContextAction {
  const { budget, turn } = input;
  if (!input.enabled || input.frozen) return budget.exceedsInputLimit ? 'trim' : 'send';
  if (!budget.exceedsSoftLimit) return 'send';
  if (input.method === 'notes') return budget.exceedsInputLimit ? 'notes-switch' : 'notes-reminder';
  const useful = evaluateAutoSummaryNeed({ estimatedTotalTokens: budget.inputTokens, thresholdTokens: budget.softLimitTokens,
    fixedPromptTokens: compressionFloor(input.messages, budget, input.retention), maxInputTokens: budget.maxInputTokens,
    hardInputTokenLimit: budget.maxInputTokens });
  if (!useful.needsAutoSummarize) return useful.needsContextFallback ? 'trim' : 'send';
  const canAttempt = input.hasNewModelHistory && !turn.summaryBlocked && turn.summaryAttempts < input.maxAttempts
    && (!turn.lastAttemptMessageId || input.lastMessageId !== turn.lastAttemptMessageId);
  // 有效压缩即使仍高于软阈值，也等新增内容消耗完本次节省量后再压缩。
  const enoughGrowth = turn.lastSummaryInputTokens === undefined
    || budget.inputTokens >= turn.lastSummaryInputTokens + (turn.lastSummarySavedTokens ?? 0);
  if (canAttempt && (budget.exceedsInputLimit || enoughGrowth)) return 'summarize';
  return budget.exceedsInputLimit ? 'trim' : 'send';
}
