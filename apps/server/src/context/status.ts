import type { ToolContext } from '@graycode/core';
import { resolveContextManagementPolicy } from '../../../../backend/modules/api/chat/services/contextTrim/policy';
import type { PlatformApplication } from '../application';
import { conversationContextSettings } from './compaction';
import { readModelPrefix, type ModelPrefix } from './prefix';
import { captureSummaryView } from './requestView';
import { createContextBudget } from './budget';

/** 仅由显式工具调用读取；不推进总结状态、写入历史或调用供应商计数接口。 */
export async function contextStatus(app: PlatformApplication, context: ToolContext, id: string) {
  const state = await app.conversations.read(context.actorId, id);
  const custom = state.metadata.custom as Record<string, unknown> | undefined;
  const prefix = await readModelPrefix(app, state.metadata);
  const providerId = context.modelSelection?.providerId ?? prefix?.providerId;
  const modelOverride = context.modelSelection?.modelOverride ?? prefix?.modelOverride;
  if (!providerId) throw new Error('当前运行没有已捕获的模型渠道。');
  const config = await app.product.channel(providerId, { includeCredential: false });
  if (!config) throw new Error('当前运行的模型渠道不可用，无法查询上下文预算。');
  const input: ModelPrefix = { conversationId: id, systemPrompt: '', tools: [], ...prefix, providerId, modelOverride };
  const view = await captureSummaryView(app, state, input, config, context.signal);
  const history = await view(state);
  const counter = createContextBudget(input, config, app.product.runtimeSettings().getSummarizeConfig().autoSummarizeTokenLimit);
  const budget = counter.evaluate(history);
  const fixedPromptTokens = budget.fixedTokens;
  const historyTokens = budget.historyTokens;
  const estimatedInputTokens = budget.inputTokens;
  const resolution = counter.resolution;
  const thresholdTokens = budget.softLimitTokens;
  const policy = resolveContextManagementPolicy(config);
  const management = conversationContextSettings(app, state.metadata, config);
  const captured = prefix?.turnContext;
  const boundary = state.history.messages.findLast(message => message.isSummary && !message.isSummarized);
  context.signal.throwIfAborted();
  return { success: true, data: {
    measuredAt: Date.now(), windowId: boundary?.contextWindowId ?? 'initial',
    source: 'local-estimate', tokenizer: counter.tokenizer, prefixAvailable: !!prefix, includesCurrentToolResult: false,
    estimatedInputTokens, fixedPromptTokens, historyTokens,
    maxContextTokens: resolution.maxContextTokens, maxInputTokens: resolution.maxInputTokens,
    reservedOutputTokens: resolution.contextWindowIncludesOutput ? resolution.maxOutputTokens ?? 0 : 0,
    budgetSource: resolution.source, outputBudgetSource: resolution.outputTokenSource,
    threshold: config.contextThreshold ?? '80%', thresholdTokens,
    remainingInputTokens: Math.max(0, resolution.maxInputTokens - estimatedInputTokens),
    inputUsagePercent: Math.round(estimatedInputTokens / resolution.maxInputTokens * 10000) / 100,
    overThreshold: estimatedInputTokens > thresholdTokens, exceedsInputBudget: estimatedInputTokens > resolution.maxInputTokens,
    managementEnabled: policy.enabled, mode: policy.mode,
    method: captured?.contextManagementMethod ?? management.method,
    userMessageRetention: management.userMessageRetention === undefined ? 'bot-managed' : captured?.contextUserMessageRetention ?? management.userMessageRetention,
    pendingWindowSwitch: !!custom?.pendingContextWindow,
    lastSwitchReason: boundary?.contextSwitchReason,
    messageCount: history.length,
    note: '本地估算：系统提示、工具定义与当前历史消息的合计用量，供容量规划参考。',
  } };
}
