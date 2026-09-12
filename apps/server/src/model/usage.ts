import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import { extractMessageTokens } from '../../../../backend/modules/conversation/usageStats';
import type { Content } from '../../../../backend/modules/conversation/types';

const estimator = new MessageTokenEstimator();
export function estimateModelInputTokens(input: ModelInput): number {
  const fixed = [input.systemPrompt, JSON.stringify(input.tools), input.promptContext?.taskContextEmbedded ? '' : JSON.stringify(input.taskContext)].filter(Boolean).join('\n');
  return [...input.messages, ...input.promptContext?.beforeHistoryMessages ?? [], ...input.promptContext?.afterHistoryMessages ?? [],
    { role: 'user', parts: [{ text: fixed }] }].reduce((sum, message) => sum + estimator.estimateMessageTokens(message as Content), 0);
}
export function modelUsage(input: ModelInput, message: PlatformMessage) {
  const usage = extractMessageTokens(message as Content);
  const hasInput = !message.usageMetadataPartial && Number.isFinite((message.usageMetadata as Content['usageMetadata'])?.promptTokenCount);
  const hasOutput = !message.usageMetadataPartial && Number.isFinite((message.usageMetadata as Content['usageMetadata'])?.candidatesTokenCount ?? message.candidatesTokenCount);
  return { inputTokens: hasInput ? usage?.prompt ?? 0 : estimateModelInputTokens(input),
    outputTokens: hasOutput ? (usage?.candidates ?? 0) + (usage?.thoughts ?? 0) : estimator.estimateMessageTokens(message as Content),
    cachedInputTokens: hasInput ? usage?.cacheRead ?? 0 : 0, requests: 1, estimatedRequests: hasInput && hasOutput ? 0 : 1, unknownRequests: 0 };
}
