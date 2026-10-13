import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import { extractMessageTokens } from '../../../../backend/modules/conversation/usageStats';
import type { Content } from '../../../../backend/modules/conversation/types';

const estimator = new MessageTokenEstimator();
const FIXED_COUNT_ENTRIES = 8;
const FIXED_COUNT_CHARACTERS = 1_048_576;
const fixedPrefixCounts: { system: string; tools: string; task: string; characters: number; tokens: number }[] = [];
let fixedPrefixCharacters = 0;

function fixedInputTokens(input: ModelInput): number {
  // usage 的拼接边界和默认 tokenizer 与上下文预算不同，保留原口径；缓存比较完整序列化内容。
  const system = input.systemPrompt;
  const tools = JSON.stringify(input.tools);
  const task = input.promptContext?.taskContextEmbedded ? '' : JSON.stringify(input.taskContext) ?? '';
  const index = fixedPrefixCounts.findIndex(entry => entry.system === system && entry.tools === tools && entry.task === task);
  if (index >= 0) {
    const [cached] = fixedPrefixCounts.splice(index, 1);
    fixedPrefixCounts.push(cached!);
    return cached!.tokens;
  }
  const fixed = [system, tools, task].filter(Boolean).join('\n');
  const tokens = estimator.estimateMessageTokens({ role: 'user', parts: [{ text: fixed }] });
  const characters = system.length + tools.length + task.length;
  if (characters <= FIXED_COUNT_CHARACTERS) {
    while (fixedPrefixCounts.length >= FIXED_COUNT_ENTRIES || fixedPrefixCharacters + characters > FIXED_COUNT_CHARACTERS) {
      fixedPrefixCharacters -= fixedPrefixCounts.shift()!.characters;
    }
    fixedPrefixCounts.push({ system, tools, task, characters, tokens });
    fixedPrefixCharacters += characters;
  }
  return tokens;
}

export function estimateModelInputTokens(input: ModelInput): number {
  let tokens = fixedInputTokens(input);
  for (const message of input.messages) tokens += estimator.estimateMessageTokens(message as Content);
  for (const message of input.promptContext?.beforeHistoryMessages ?? []) tokens += estimator.estimateMessageTokens(message as Content);
  for (const message of input.promptContext?.afterHistoryMessages ?? []) tokens += estimator.estimateMessageTokens(message as Content);
  return tokens;
}
export function modelUsage(input: ModelInput, message: PlatformMessage) {
  const usage = extractMessageTokens(message as Content);
  const hasInput = !message.usageMetadataPartial && Number.isFinite((message.usageMetadata as Content['usageMetadata'])?.promptTokenCount);
  const hasOutput = !message.usageMetadataPartial && Number.isFinite((message.usageMetadata as Content['usageMetadata'])?.candidatesTokenCount ?? message.candidatesTokenCount);
  return { inputTokens: hasInput ? usage?.prompt ?? 0 : estimateModelInputTokens(input),
    outputTokens: hasOutput ? (usage?.candidates ?? 0) + (usage?.thoughts ?? 0) : estimator.estimateMessageTokens(message as Content),
    cachedInputTokens: hasInput ? usage?.cacheRead ?? 0 : 0, requests: 1, estimatedRequests: hasInput && hasOutput ? 0 : 1, unknownRequests: 0 };
}
