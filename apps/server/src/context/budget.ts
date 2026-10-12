import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import type { Content } from '../../../../backend/modules/conversation/types';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import { calculateContextThreshold } from '../../../../backend/modules/api/chat/services/contextTrim/roundDetection';
import { resolveMaxContextTokensForConfig } from '../../../../backend/modules/api/chat/services/contextTrim/contextWindowResolution';
import { countTextTokens, countJsonTokens, describeTextTokenizer } from '../../../../packages/core/src/tokenizer';

export interface ContextBudget {
  inputTokens: number;
  historyTokens: number;
  fixedTokens: number;
  maxInputTokens: number;
  softLimitTokens: number;
  messageTokens: number[];
  exceedsSoftLimit: boolean;
  exceedsInputLimit: boolean;
}

/** 只计实际发送的消息；旧 usage 没有请求边界身份，不能拿它替代本轮新增内容。 */
export function createContextBudget(
  input: Pick<ModelInput, 'providerId' | 'modelOverride' | 'systemPrompt' | 'tools' | 'promptContext' | 'taskContext'>,
  config: ChannelConfig,
  absoluteLimit?: number,
  additionalContextText = '',
) {
  const options = { channelType: config.type, model: input.modelOverride ?? config.model };
  const estimator = new MessageTokenEstimator(options);
  const estimateMessage = (message: PlatformMessage) => estimator.estimateMessageTokens(message as Content);
  const resolution = resolveMaxContextTokensForConfig(config, input.modelOverride);
  const configuredThreshold = calculateContextThreshold(config.contextThreshold ?? '80%', resolution.maxInputTokens);
  const softLimitTokens = Math.min(resolution.maxInputTokens, configuredThreshold,
    typeof absoluteLimit === 'number' && absoluteLimit > 0 ? absoluteLimit : Number.POSITIVE_INFINITY);
  const fixedTokens = countTextTokens(input.systemPrompt + additionalContextText, options)
    + countJsonTokens(input.tools, options)
    + [...input.promptContext?.beforeHistoryMessages ?? [], ...input.promptContext?.afterHistoryMessages ?? []]
      .reduce((total, message) => total + estimateMessage(message), 0);
  const evaluate = (messages: PlatformMessage[]): ContextBudget => {
    const messageTokens = messages.map(estimateMessage);
    const historyTokens = messageTokens.reduce((total, tokens) => total + tokens, 0);
    const inputTokens = fixedTokens + historyTokens;
    return { inputTokens, historyTokens, fixedTokens, maxInputTokens: resolution.maxInputTokens, softLimitTokens,
      messageTokens, exceedsSoftLimit: inputTokens > softLimitTokens, exceedsInputLimit: inputTokens > resolution.maxInputTokens };
  };
  return { evaluate, estimateMessage, fixedTokens, maxInputTokens: resolution.maxInputTokens, softLimitTokens,
    tokenizer: describeTextTokenizer(options), resolution };
}

export type ContextBudgetCounter = ReturnType<typeof createContextBudget>;
