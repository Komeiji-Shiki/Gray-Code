import type { PlatformMessage, RunEvent } from '@graycode/contracts';
import type { ModelRequestContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { Content, ContentPart } from '../../../../backend/modules/conversation/types';
import { isRealUserMessage } from '../../../../backend/modules/conversation/helpers';
import { resolveContextManagementPolicy } from '../../../../backend/modules/api/chat/services/contextTrim/policy';
import { clampMaxAutoSummarizeAttempts } from '../../../../backend/modules/settings/types/summarizeTypes';
import { CONTEXT_NOTES_REMINDER, CONTEXT_TOOL_NAMES } from '../../../../shared/contextManagement';
import { randomUUID } from 'node:crypto';
import { CapturedContext } from './captured';
import { activeContextHistory, captureModelPrefix, conversationContextSettings, notesWindowBoundary, summarizeFullContext } from './compaction';
import { readModelPrefix, rememberModelPrefix } from './prefix';
import { captureRequestView } from './requestView';
import { createContextBudget } from './budget';
import { contextTurnState, decideContextAction, type TurnContextState } from './decision';
import { trimContextRequest } from './requestTrim';

interface PreparationOptions {
  preview?: boolean;
  modelView?: boolean;
  additionalContextText?: string;
  filterHistory?: (messages: PlatformMessage[]) => PlatformMessage[];
  commit: (frame: CapturedContext, snapshot?: boolean) => Promise<void>;
  event: (type: RunEvent['type'], payload: Record<string, unknown>) => Promise<void>;
}

export async function prepareContextRequest(app: PlatformApplication, context: ModelRequestContext, options: PreparationOptions) {
  const { input, run } = context;
  const preview = options.preview === true;
  input.signal.throwIfAborted();
  let config = await app.product.channel(input.providerId, { includeCredential: false });
  if (!config) return { history: context.history, messages: input.messages, notices: [] as string[] };
  const management = conversationContextSettings(app, context.history.metadata, config);
  const capturedMethod = input.turnContext?.contextManagementMethod;
  if (capturedMethod === 'summary' || capturedMethod === 'notes') management.method = capturedMethod;
  const capturedRetention = input.turnContext?.contextUserMessageRetention;
  if (management.userMessageRetention !== undefined && (capturedRetention === 'first' || capturedRetention === 'all'))
    management.userMessageRetention = capturedRetention;
  if (management.bot?.method && management.bot.method !== 'time') config = { ...config,
    contextManagementEnabled: management.bot.enabled, contextManagementMode: 'summarize' };
  const frame = new CapturedContext(context.history);
  const notices: string[] = [];
  const settings = app.product.runtimeSettings().getSummarizeConfig();
  const policy = resolveContextManagementPolicy(config);
  const pendingIds = input.pendingToolCallIds?.length ? new Set(input.pendingToolCallIds) : undefined;
  const custom = frame.state.metadata.custom as Record<string, unknown> | undefined;
  const turnId = frame.state.history.messages.findLast(message => isRealUserMessage({ ...message, isSummarized: false } as Content)
    && !message.userFeedback)?.id ?? run.id;
  const old = custom?.platformContext as TurnContextState | undefined;
  const commit = (snapshot = false) => preview ? Promise.resolve() : options.commit(frame, snapshot);
  const event = (type: RunEvent['type'], payload: Record<string, unknown>) => preview ? Promise.resolve() : options.event(type, payload);
  const assemble = options.modelView
    ? await captureRequestView(app, context, config, preview)
    : async (state: typeof frame.state) => activeContextHistory(options.filterHistory?.(state.history.messages) ?? state.history.messages, config!, pendingIds);
  const view = (candidate: CapturedContext) => assemble(candidate.state);
  let messages = await view(frame);
  // 注入记忆可能更新回合依赖，捕获前缀必须位于最终视图组装之后。
  const prefix = captureModelPrefix({ ...input, modelOverride: input.modelOverride ?? config.model });
  if (!preview) {
    const previous = await readModelPrefix(app, frame.state.metadata);
    const previousRef = custom?.contextRequestPrefixRef;
    const stable = typeof previousRef === 'string' && previousRef.startsWith(`${run.id}:`)
      && previous?.providerId === prefix.providerId && previous.modelOverride === prefix.modelOverride
      && previous.systemPrompt === prefix.systemPrompt && previous.reasoningEffort === prefix.reasoningEffort
      && previous.tools === prefix.tools && previous.promptContext === prefix.promptContext
      && previous.taskContext?.actor.id === prefix.taskContext?.actor.id
      && previous.taskContext?.actor.role === prefix.taskContext?.actor.role
      && previous.taskContext?.workspace === prefix.taskContext?.workspace;
    const requestRef = stable ? previousRef : `${run.id}:${context.iteration}`;
    rememberModelPrefix(app, requestRef, prefix);
    if (custom?.contextRequestPrefixRef !== requestRef || custom?.contextRequestPrefix !== undefined) {
      frame.updateCustom('contextRequestPrefix', undefined);
      frame.updateCustom('contextRequestPrefixRef', requestRef);
    }
  }
  const counter = createContextBudget(input, config, settings.autoSummarizeTokenLimit, options.additionalContextText);
  let budget = counter.evaluate(messages);
  const turn = contextTurnState(old, turnId, { providerId: input.providerId, modelId: input.modelOverride ?? config.model,
    boundaryId: messages.findLast(message => message.isSummary)?.id, retention: management.userMessageRetention,
    fixedTokens: budget.fixedTokens, maxInputTokens: budget.maxInputTokens, softLimitTokens: budget.softLimitTokens });
  const pending = custom?.pendingContextWindow as { runId?: string; toolCallId?: string } | undefined;
  const switchRequested = !pendingIds && pending?.runId === run.id && frame.state.history.messages.some(message =>
    (message.parts as ContentPart[]).some(part => part.functionResponse && part.functionResponse.id === pending.toolCallId));
  const persistTurn = () => frame.store.setCustomMetadata(run.conversationId, 'platformContext', turn);
  const switchNotes = async (reason: 'model_requested' | 'input_budget_exceeded') => {
    await event('context.summary.started', { method: 'notes' });
    const result = await notesWindowBoundary(app, frame, true, config.type, management.userMessageRetention, reason,
      { retainedUserTokenBudget: Math.max(0, budget.maxInputTokens - budget.fixedTokens), estimateTokens: counter.estimateMessage });
    turn.fallback = false;
    turn.fallbackStartId = undefined;
    turn.fallbackStart = undefined;
    await persistTurn();
    await commit(true);
    await event('context.summary.completed', { ...result });
    messages = await view(frame);
    budget = counter.evaluate(messages);
  };
  const decide = () => decideContextAction({ budget, messages, retention: management.userMessageRetention,
    enabled: policy.enabled, method: management.method, frozen: !!pendingIds,
    hasNewModelHistory: messages.some(message => !message.isSummary && (message.role === 'model' || message.parts.some(part => part.functionResponse))),
    lastMessageId: messages.at(-1)?.id, maxAttempts: clampMaxAutoSummarizeAttempts(settings.maxAutoSummarizeAttemptsPerTurn), turn });
  if (preview) {
    const action = decide();
    if (action === 'summarize') notices.push('当前内容预计触发自动总结；这里展示总结前的请求，总结完成后实际历史会变化。');
    if (action === 'notes-switch' || switchRequested && management.method === 'notes')
      notices.push('正式发送前将切换到笔记窗口；这里展示切换前的原始内容。');
    if (budget.exceedsInputLimit || turn.fallbackStartId)
      notices.push('当前内容需要在正式发送时按输入预算处理；预览保留原始内容，不执行请求裁剪。');
    input.signal.throwIfAborted();
    return { history: frame.state, messages, notices };
  }
  if (switchRequested && management.method === 'notes') await switchNotes('model_requested');
  const action = decide();
  if (action === 'notes-switch' || action === 'notes-reminder') {
    if (!CONTEXT_TOOL_NAMES.every(name => input.tools.some(tool => tool.name === name)))
      throw new Error('笔记管理需要启用 context_notes、context_history 和 new_context 工具，请启用后重试。');
    if (action === 'notes-switch') {
      await switchNotes('input_budget_exceeded');
    } else {
      const windowId = frame.state.history.messages.findLast(message => message.contextWindowId)?.contextWindowId ?? 'initial';
      if (custom?.contextReminderWindowId !== windowId) {
        const reminder: PlatformMessage = { id: randomUUID(), role: 'user', contextControl: 'reminder', parts: [{ text: CONTEXT_NOTES_REMINDER }],
          parentId: frame.state.history.messages.at(-1)?.id ?? null, timestamp: Date.now(), index: frame.state.history.messages.length };
        frame.state.history.messages.push(reminder);
        frame.appendMessages.push(reminder);
        await frame.store.setCustomMetadata(run.conversationId, 'contextReminderWindowId', windowId);
        messages = await view(frame);
        budget = counter.evaluate(messages);
      }
    }
  }
  if (action === 'summarize') {
    turn.summaryAttempts++;
    turn.lastAttemptMessageId = messages.at(-1)?.id;
    await persistTurn();
    await commit();
    await event('context.summary.started', { attempt: turn.summaryAttempts });
    try {
      const before = budget.inputTokens;
      let candidateMessages = messages;
      let candidateBudget = budget;
      const result = await summarizeFullContext(app, frame, prefix, input.signal, true, {
        messages, maxHistoryTokens: Math.max(0, budget.maxInputTokens - budget.fixedTokens),
        retainedUserTokenBudget: Math.max(0, budget.maxInputTokens - budget.fixedTokens), estimateTokens: counter.estimateMessage,
        validateCandidate: async candidate => {
          candidateMessages = await view(candidate);
          candidateBudget = counter.evaluate(candidateMessages);
          if (candidateBudget.inputTokens >= before) throw Object.assign(new Error('总结没有减少本次模型请求，保留原上下文。'), { code: 'SUMMARY_NO_GAIN' });
        },
      });
      input.signal.throwIfAborted();
      messages = candidateMessages;
      budget = candidateBudget;
      turn.lastSummaryInputTokens = budget.inputTokens;
      turn.lastSummarySavedTokens = before - budget.inputTokens;
      turn.lastSummaryCoveredCount = result.removedCount;
      turn.summaryBasis = { ...turn.summaryBasis!, boundaryId: result.summaryContent.id };
      turn.summaryBlocked = false;
      turn.fallback = false;
      turn.fallbackStartId = undefined;
      turn.fallbackStart = undefined;
      await persistTurn();
      await commit(true);
      await event('context.summary.completed', { ...result, inputTokensBefore: before, inputTokensAfter: budget.inputTokens,
        savedTokens: turn.lastSummarySavedTokens });
    } catch (error) {
      input.signal.throwIfAborted();
      if (['REVISION_CONFLICT', 'STORAGE_BUSY'].includes((error as { code?: string }).code ?? '')) throw error;
      turn.summaryBlocked = true;
      await persistTurn();
      await event('context.summary.failed', { message: (error as Error).message, attempt: turn.summaryAttempts });
    }
  }
  // 软阈值失败可以继续；硬上限始终约束最终请求，异步等待也不例外。
  if (budget.exceedsInputLimit || turn.fallbackStartId) {
    const trimmed = trimContextRequest(messages, budget, counter, pendingIds, turn.fallbackStartId);
    messages = trimmed.messages;
    budget = trimmed.budget;
    if (turn.fallbackStartId !== trimmed.startId || turn.fallback !== !!trimmed.startId) {
      turn.fallback = !!trimmed.startId;
      turn.fallbackStartId = trimmed.startId;
      turn.fallbackStart = trimmed.startId ? frame.state.history.messages.findIndex(message => message.id === trimmed.startId) : undefined;
      await persistTurn();
    }
    await event('context.fallback', { trimStartId: trimmed.startId, inputTokens: budget.inputTokens, inputTokenLimit: budget.maxInputTokens,
      truncatedMessageIds: trimmed.truncatedMessageIds });
  }
  await commit();
  input.signal.throwIfAborted();
  return { history: frame.state, messages, notices };
}
