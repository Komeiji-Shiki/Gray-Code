import type { RunEvent } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { Content, ContentPart } from '../../../../backend/modules/conversation/types';
import { isRealUserMessage } from '../../../../backend/modules/conversation/helpers';
import { resolveContextManagementPolicy } from '../../../../backend/modules/api/chat/services/contextTrim/policy';
import { clampMaxAutoSummarizeAttempts } from '../../../../backend/modules/settings/types/summarizeTypes';
import { CapturedContext } from './captured';
import { readModelPrefix } from './prefix';
import { captureSummaryView } from './requestView';
import { createContextBudget } from './budget';
import { contextTurnState, decideContextAction, type TurnContextState } from './decision';
import { conversationContextSettings, summarizeFullContext } from './compaction';

interface BackgroundHooks {
  commit: (frame: CapturedContext, snapshot?: boolean) => Promise<void>;
  event: (runId: string, type: RunEvent['type'], payload: Record<string, unknown>) => Promise<void>;
  isManual: (conversationId: string) => boolean;
}

/** 完成回合只启动一个候选；前台取消它，存储 revision 负责拒绝已经失效的提交。 */
export class ContextBackgroundSummaries {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly scheduling = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly app: PlatformApplication, private readonly hooks: BackgroundHooks) {}

  beforeRun(conversationId: string): void {
    this.active.get(conversationId)?.controller.abort(new Error('前台回合已经开始，取消后台总结。'));
  }
  afterRun(runId: string): void {
    if (this.closed || !this.app.product.runtimeSettings().getSummarizeConfig().autoSummarizeAfterTurn) return;
    const scheduling = (async () => {
      const run = await this.app.storage.getRun(runId);
      if (!run || run.status !== 'completed' || this.closed || this.active.has(run.conversationId) || this.hooks.isManual(run.conversationId)) return;
      const controller = new AbortController();
      const operation = { controller, done: Promise.resolve() };
      this.active.set(run.conversationId, operation);
      operation.done = this.execute(runId, run.actorId, run.conversationId, controller.signal).catch(async error => {
        if (controller.signal.aborted || this.closed) return;
        await this.hooks.event(runId, 'context.summary.failed', { background: true, code: (error as { code?: string }).code,
          message: (error as Error).message });
      }).finally(() => {
        if (this.active.get(run.conversationId) === operation) this.active.delete(run.conversationId);
      });
      await operation.done;
    })();
    this.scheduling.add(scheduling);
    void scheduling.catch(error => this.app.publish({ type: 'context.background.failed', message: (error as Error).message }))
      .finally(() => this.scheduling.delete(scheduling));
  }

  private async execute(runId: string, actorId: string, conversationId: string, signal: AbortSignal): Promise<void> {
    if ((await this.app.storage.listRuns({ conversationId, activeOnly: true })).length) return;
    signal.throwIfAborted();
    const state = await this.app.conversations.read(actorId, conversationId);
    const pendingCalls = new Set<string>();
    for (const message of state.history.messages) {
      if (message.isSummarized) continue;
      for (const part of message.parts as ContentPart[]) {
        if (part.functionCall?.id && part.functionCall.async && !part.functionCall.rejected) pendingCalls.add(part.functionCall.id);
        if (part.functionResponse?.id) pendingCalls.delete(part.functionResponse.id);
      }
    }
    if (pendingCalls.size) return;
    const prefix = await readModelPrefix(this.app, state.metadata);
    if (!prefix) return;
    let config = await this.app.product.channel(prefix.providerId, { includeCredential: false });
    if (!config?.enabled) return;
    const management = conversationContextSettings(this.app, state.metadata, config);
    const method = prefix.turnContext?.contextManagementMethod ?? management.method;
    const retention = prefix.turnContext?.contextUserMessageRetention;
    if (management.userMessageRetention !== undefined && (retention === 'first' || retention === 'all'))
      management.userMessageRetention = retention;
    if (management.bot?.method && management.bot.method !== 'time') config = { ...config,
      contextManagementEnabled: management.bot.enabled, contextManagementMode: 'summarize' };
    if (!resolveContextManagementPolicy(config).enabled || method !== 'summary') return;
    const settings = this.app.product.runtimeSettings().getSummarizeConfig();
    const frame = new CapturedContext(state);
    const assemble = await captureSummaryView(this.app, state, prefix, config, signal);
    const messages = await assemble(state);
    const counter = createContextBudget(prefix, config, settings.autoSummarizeTokenLimit);
    const before = counter.evaluate(messages);
    const custom = state.metadata.custom as Record<string, unknown> | undefined;
    const turnId = state.history.messages.findLast(message => isRealUserMessage({ ...message, isSummarized: false } as Content)
      && !message.userFeedback)?.id ?? runId;
    const stored = custom?.platformContext as TurnContextState | undefined;
    const turn = contextTurnState(stored, turnId, { providerId: prefix.providerId, modelId: prefix.modelOverride ?? config.model,
      boundaryId: messages.findLast(message => message.isSummary)?.id, retention: management.userMessageRetention,
      fixedTokens: before.fixedTokens, maxInputTokens: before.maxInputTokens, softLimitTokens: before.softLimitTokens });
    const action = decideContextAction({ budget: before, messages, retention: management.userMessageRetention,
      enabled: true, method: 'summary', frozen: false,
      hasNewModelHistory: messages.some(message => message.role === 'model' && !message.isSummary),
      lastMessageId: messages.at(-1)?.id, maxAttempts: clampMaxAutoSummarizeAttempts(settings.maxAutoSummarizeAttemptsPerTurn), turn });
    if (action !== 'summarize') return;
    signal.throwIfAborted();
    turn.summaryAttempts++;
    turn.lastAttemptMessageId = messages.at(-1)?.id;
    await frame.store.setCustomMetadata(conversationId, 'platformContext', turn);
    signal.throwIfAborted();
    await this.hooks.commit(frame);
    await this.hooks.event(runId, 'context.summary.started', { background: true, attempt: turn.summaryAttempts });
    let after = before;
    const result = await summarizeFullContext(this.app, frame, prefix, signal, true, {
      messages, maxHistoryTokens: Math.max(0, before.maxInputTokens - before.fixedTokens),
      retainedUserTokenBudget: Math.max(0, before.maxInputTokens - before.fixedTokens), estimateTokens: counter.estimateMessage,
      validateCandidate: async candidate => {
        after = counter.evaluate(await assemble(candidate.state));
        if (after.inputTokens >= before.inputTokens) throw new Error('后台总结没有减少模型请求，保留原上下文。');
      },
    });
    turn.lastSummaryInputTokens = after.inputTokens;
    turn.lastSummarySavedTokens = before.inputTokens - after.inputTokens;
    turn.lastSummaryCoveredCount = result.removedCount;
    turn.summaryBasis = { ...turn.summaryBasis!, boundaryId: result.summaryContent.id };
    turn.summaryBlocked = false; turn.fallback = false; turn.fallbackStartId = undefined; turn.fallbackStart = undefined;
    await frame.store.setCustomMetadata(conversationId, 'platformContext', turn);
    signal.throwIfAborted();
    if ((await this.app.storage.listRuns({ conversationId, activeOnly: true })).length) return;
    signal.throwIfAborted();
    await this.hooks.commit(frame, true);
    await this.hooks.event(runId, 'context.summary.completed', { ...result, background: true,
      inputTokensBefore: before.inputTokens, inputTokensAfter: after.inputTokens, savedTokens: turn.lastSummarySavedTokens });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const operation of this.active.values()) operation.controller.abort(new Error('应用正在关闭。'));
    await Promise.allSettled([...this.scheduling]);
  }
}
