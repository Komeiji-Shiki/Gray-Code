import { randomUUID } from 'node:crypto';
import type { BotAutoSummarySettings, PlatformConversation, PlatformMessage, RunEvent } from '@graycode/contracts';
import type { ModelRequestContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import { CapturedContext } from './captured';
import type { Content } from '../../../../backend/modules/conversation/types';
import { isRealUserMessage } from '../../../../backend/modules/conversation/helpers';
import { restoreSummarizedRange } from '../../../../backend/modules/conversation/TranscriptMutation';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import { TokenCountService } from '../../../../backend/modules/channel/TokenCountService';
import { BUILTIN_SUMMARIZE_SYSTEM_PROMPT } from '../../../../backend/modules/api/chat/services/SummaryAlgorithms';
import { findLastSummaryIndex } from '../../../../backend/modules/api/chat/services/contextTrim/roundDetection';
import { resolveContextManagementPolicy } from '../../../../backend/modules/api/chat/services/contextTrim/policy';
import { resolveMaxContextTokensForConfig } from '../../../../backend/modules/api/chat/services/contextTrim/contextWindowResolution';
import { planAutoSummarizeMessages, planSummarizeMessages, planIntraRoundSplit, resolveKeepRecentTokenBudget } from '../../../../backend/modules/api/chat/services/summarizeRangePlanner';
import { branchMutation, groupMessages, readBranches } from '../conversations/branches';
import { rebaseActivePathFromHistory } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { conversationContextSettings, manualSummaryPrefix, notesWindowBoundary, summarizeFullContext } from './compaction';
import { prepareContextRequest } from './prepare';
import { createContextBudget } from './budget';
import { captureSummaryView } from './requestView';
import { extractSummaryText } from './summaryText';
import type { TurnContextState } from './decision';

interface SummaryResult { summaryContent: Content; insertIndex: number; removedCount: number }

export class PlatformContextService {
  private readonly localTokens = new MessageTokenEstimator();
  private readonly manual = new Map<string, { actorId: string; controller: AbortController; done: Promise<unknown> }>();
  constructor(private readonly app: PlatformApplication) {}
  configuration(conversation: PlatformConversation, automaticChannel?: Parameters<typeof conversationContextSettings>[2]) {
    return conversationContextSettings(this.app, conversation, automaticChannel);
  }

  private async event(runId: string, type: RunEvent['type'], payload: Record<string, unknown>): Promise<void> {
    const event = await this.app.storage.appendRunEvent({ runId, type, payload });
    this.app.publish({ type: 'event', event });
  }
  private async commit(frame: CapturedContext, runId?: string, snapshot = false): Promise<void> {
    if (!frame.dirty) return;
    const state = frame.state;
    const buildMutation = () => ({ conversationId: state.metadata.id,
      expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken, activeRunId: runId,
      ...(frame.historyReplaced ? { messages: state.history.messages } : {
        ...(frame.messageUpdates.size ? { messageUpdates: [...frame.messageUpdates].map(([index, message]) => ({ index, message })) } : {}),
        ...(frame.appendMessages.length ? { appendMessages: frame.appendMessages } : {}),
      }),
      metadata: state.metadata,
      ...(snapshot ? { snapshot: { id: randomUUID(), conversationId: state.metadata.id, timestamp: Date.now(), name: '总结变更前', kind: 'context-summary' as const } } : {}) });
    let result;
    try {
      result = await this.app.storage.commitConversation(buildMutation());
    } catch (error) {
      if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error;
      const latest = await this.app.storage.getConversationInfo(state.metadata.id);
      if (!latest || latest.historyRevision !== state.history.revision || latest.metadataToken === state.metadataToken) throw error;
      // 运行期间仅外部元数据（如标题、思考强度或列表预览）被并发修改时，保留外部修改，只重放本轮改过的自定义键。
      const frameCustom = (state.metadata.custom ?? {}) as Record<string, unknown>;
      const latestCustom = { ...((latest.metadata.custom ?? {}) as Record<string, unknown>) };
      for (const key of frame.customChanges) {
        if (Object.hasOwn(frameCustom, key)) latestCustom[key] = frameCustom[key];
        else delete latestCustom[key];
      }
      state.metadata = { ...latest.metadata, custom: latestCustom };
      state.metadataToken = latest.metadataToken;
      result = await this.app.storage.commitConversation(buildMutation());
    }
    state.history.revision = result.revision; state.history.total = result.total; state.metadataToken = result.metadataToken;
    frame.dirty = false; frame.historyReplaced = false; frame.messageUpdates.clear(); frame.appendMessages.length = 0;
    frame.customChanges.clear();
  }
  /** 正式请求和预览共享最终视图、预算和动作决策。 */
  async prepareModel(context: ModelRequestContext, preview = false) {
    return prepareContextRequest(this.app, context, { preview, modelView: true,
      commit: (frame, snapshot) => this.commit(frame, context.run.id, snapshot),
      event: (type, payload) => this.event(context.run.id, type, payload) });
  }
  async prepare(context: ModelRequestContext, preview = false, additionalContextText = '',
    filterHistory?: (messages: PlatformMessage[]) => PlatformMessage[]) {
    return prepareContextRequest(this.app, context, { preview, additionalContextText, filterHistory,
      commit: (frame, snapshot) => this.commit(frame, context.run.id, snapshot),
      event: (type, payload) => this.event(context.run.id, type, payload) });
  }

  private async summarizeTimed(frame: CapturedContext, providerId: string, modelOverride: string | undefined,
    signal: AbortSignal, mode: 'auto' | 'manual', override?: BotAutoSummarySettings): Promise<SummaryResult> {
    signal.throwIfAborted();
    const settings = this.app.product.runtimeSettings().getSummarizeConfig();
    const main = await this.app.product.channel(providerId, { includeCredential: false });
    if (!main) throw new Error('总结使用的主渠道不存在。');
    const prefix = await manualSummaryPrefix(this.app, frame, String(frame.state.metadata.actorId), providerId, modelOverride);
    const assemble = await captureSummaryView(this.app, frame.state, prefix, main, signal);
    const full = await assemble(frame.state);
    const counter = createContextBudget(prefix, main, settings.autoSummarizeTokenLimit);
    const lastSummary = findLastSummaryIndex(full as Content[]);
    const candidates = full.slice(lastSummary + 1);
    const tokens = candidates.map(counter.estimateMessage);
    const keep = resolveKeepRecentTokenBudget(override ? `${100 - override.percent}%` : settings.keepRecentTokens,
      tokens.reduce((sum, item) => sum + item, 0));
    const args = { messages: candidates as Content[], messageTokens: tokens, keepBudgetTokens: keep,
      minKeepRounds: override ? 1 : settings.keepRecentRounds };
    const plan = mode === 'auto' ? planAutoSummarizeMessages(args) : planSummarizeMessages({ ...args, mode });
    const split = plan ?? (lastSummary >= 0 && !candidates.some(message => isRealUserMessage(message as Content))
      ? planIntraRoundSplit(args) : null);
    if (!split || split.cutIndex < 1) throw new Error('没有足够的完整历史可总结，最近的用户回合会继续保留。');
    const source = full.slice(0, lastSummary + 1 + split.cutIndex);
    const actualProvider = settings.useSeparateModel && settings.summarizeChannelId ? settings.summarizeChannelId : providerId;
    const actualModel = settings.useSeparateModel && settings.summarizeChannelId ? settings.summarizeModelId || undefined : modelOverride;
    const config = await this.app.product.channel(actualProvider, { includeCredential: false });
    if (!config?.enabled) throw new Error('总结渠道不存在或已禁用。');
    // 定时整理有独立的保留范围与提示词，即使沿用主渠道也不携带执行任务的工具目录。
    const summaryPrefix = { conversationId: `summary-${randomUUID()}`, providerId: actualProvider,
      modelOverride: actualModel, systemPrompt: BUILTIN_SUMMARIZE_SYSTEM_PROMPT, tools: [] };
    const summaryBudget = createContextBudget(summaryPrefix, config);
    const before = counter.evaluate(full);
    return summarizeFullContext(this.app, frame, summaryPrefix, signal, mode === 'auto', {
      messages: source, consumedMessageIds: new Set(source.flatMap(message => message.id ? [message.id] : [])),
      insertAtConsumedEnd: true, cleanHistory: true,
      maxHistoryTokens: Math.max(0, summaryBudget.maxInputTokens - summaryBudget.fixedTokens),
      retainedUserTokenBudget: Math.max(0, before.maxInputTokens - before.fixedTokens
        - (before.historyTokens - counter.evaluate(source).historyTokens)), estimateTokens: summaryBudget.estimateMessage,
      prompt: override?.prompt.trim() || (mode === 'auto' ? settings.autoSummarizePrompt : settings.summarizePrompt),
      validateCandidate: async candidate => {
        const after = counter.evaluate(await assemble(candidate.state));
        if (after.inputTokens >= before.inputTokens) throw new Error('总结没有减少本次模型请求，原历史保持不变。');
      },
    });
  }

  private async summarizePrepared(frame: CapturedContext, providerId: string, modelOverride: string | undefined,
    signal: AbortSignal, automatic: boolean) {
    const config = await this.app.product.channel(providerId, { includeCredential: false });
    if (!config?.enabled) throw new Error('当前会话的模型渠道不存在或已禁用。');
    const prefix = await manualSummaryPrefix(this.app, frame, String(frame.state.metadata.actorId), providerId, modelOverride);
    const assemble = await captureSummaryView(this.app, frame.state, prefix, config, signal);
    const messages = await assemble(frame.state);
    const counter = createContextBudget(prefix, config);
    const before = counter.evaluate(messages);
    return summarizeFullContext(this.app, frame, prefix, signal, automatic, {
      messages, maxHistoryTokens: Math.max(0, before.maxInputTokens - before.fixedTokens),
      retainedUserTokenBudget: Math.max(0, before.maxInputTokens - before.fixedTokens), estimateTokens: counter.estimateMessage,
      validateCandidate: async candidate => {
        if (counter.evaluate(await assemble(candidate.state)).inputTokens >= before.inputTokens)
          throw new Error('总结没有减少本次模型请求，原历史保持不变。');
      },
    });
  }

  isSummarizing(id: string): boolean { return this.manual.has(id); }
  /** 修改摘要只替换正文，保留覆盖范围与原文，并与旧版本快照一起提交。 */
  async editSummary(actorId: string, id: string, messageId: string, text: string, expectedText: string) {
    await this.app.manageConversation(actorId, id);
    if (typeof text !== 'string' || !text.trim() || text.length > 1000000 || typeof expectedText !== 'string') throw new Error('摘要正文不能为空，且不能超过一百万字符。');
    const state = await this.app.conversations.read(actorId, id);
    if (this.isSummarizing(id) || (await this.app.storage.listRuns({ conversationId: id, activeOnly: true })).length)
      throw new Error('当前会话正在运行或总结，请等待完成后保存摘要。');
    const index = state.history.messages.findIndex(message => message.id === messageId);
    const previous = state.history.messages[index];
    if (!previous?.isSummary) throw new Error('摘要已经变化或被恢复，请刷新后重试。');
    const original = previous.parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
    if (original !== expectedText) throw new Error('这条摘要已被其他操作修改，请重新打开编辑后合并内容。');
    const messages = structuredClone(state.history.messages);
    const message: PlatformMessage = messages[index] = { ...previous, parts: [{ text: text.trim() }], summaryEditedAt: Date.now() };
    const statistics = previous.summaryTokenStats as import('../../../../shared/protocol').SummaryTokenStats | undefined;
    if (statistics) {
      const summaryTokenCount = this.localTokens.estimateMessageTokens(message as Content);
      message.summaryTokenStats = { sourceTokenCount: statistics.sourceTokenCount, summaryTokenCount,
        estimatedTokensSaved: Math.max(0, statistics.sourceTokenCount - summaryTokenCount) };
    }
    const branches = readBranches(state);
    branches.graph = rebaseActivePathFromHistory(branches.graph, messages as Content[], { allowRootChange: true });
    Object.assign(branches.groups, groupMessages(messages));
    await this.app.conversations.commit({ state, commit: { messages, metadata: { ...state.metadata,
      custom: { ...state.metadata.custom as Record<string, unknown>, trimState: null } }, records: [branchMutation(state, branches, messages)],
      snapshot: { id: randomUUID(), conversationId: id, timestamp: Date.now(), name: '编辑摘要前', kind: 'context-summary-edit', sourceRevision: state.history.revision, conversationMetadata: state.metadata } } }, true);
    return { success: true, message };
  }
  async summarizeManually(actorId: string, id: string, providerId: string, modelOverride?: string, botSchedule?: BotAutoSummarySettings) {
    this.app.requireOwner(actorId);
    if (this.manual.has(id)) throw new Error('当前对话已经在总结。');
    const controller = new AbortController();
    const done = (async () => {
      try {
        const state = await this.app.conversations.read(actorId, id);
        if ((await this.app.storage.listRuns({ conversationId: id, activeOnly: true })).length) throw new Error('请等待当前任务完成后再手动总结。');
        const frame = new CapturedContext(state);
        const channel = await this.app.product.channel(providerId, { includeCredential: false });
        const method = botSchedule?.method === 'summary' || botSchedule?.method === 'notes'
          ? botSchedule.method : this.configuration(state.metadata, channel ?? undefined).method;
        const result = botSchedule && (!botSchedule.method || botSchedule.method === 'time')
          ? await this.summarizeTimed(frame, providerId, modelOverride, controller.signal, 'auto', botSchedule)
          : method === 'notes' ? await notesWindowBoundary(this.app, frame, !!botSchedule, channel?.type ?? 'openai')
            : await this.summarizePrepared(frame, providerId, modelOverride, controller.signal, !!botSchedule);
        controller.signal.throwIfAborted();
        await this.commit(frame, undefined, true);
        return { success: true, ...result, summarizedMessageCount: result.removedCount };
      } catch (error) { return { success: false, error: { code: controller.signal.aborted ? 'ABORTED' : 'SUMMARY_FAILED', message: (error as Error).message } }; }
    })().finally(() => this.manual.delete(id));
    this.manual.set(id, { actorId, controller, done });
    return done;
  }
  async cancelSummary(actorId: string, id: string) {
    await this.app.conversation(actorId, id);
    const pending = this.manual.get(id);
    if (pending && (this.app.actor(actorId)?.role === 'owner' || pending.actorId === actorId)) pending.controller.abort(new Error('总结已取消。'));
    return { success: true };
  }
  async restoreSummary(actorId: string, id: string, messageId: string) {
    const state = await this.app.conversations.read(actorId, id);
    const index = state.history.messages.findIndex(message => message.id === messageId);
    if (!Number.isSafeInteger(index) || !state.history.messages[index]?.isSummary) throw new Error('总结消息已变化。');
    const restored = restoreSummarizedRange(state.history.messages as Content[], index);
    await this.app.conversations.remove(actorId, id, index, messageId, true);
    return { success: true, restoredCount: restored.restoredCount };
  }
  /**
   * C3 只读上下文统计与状态展示。
   *
   * 只读取已保存历史、元数据与渠道配置，不推进裁剪状态、不发起总结、不提交、不发事件。
   * Token 口径与原前端 InputArea/computed.ts 一致：优先最后一条助手消息的
   * usageMetadata.totalTokenCount（供应商精确计数），总结更新且时间戳不早于该用量时
   * 使用 summaryTokenStats.estimatedContextTokenCountAfter（估算）。本地估算只标为估算，
   * 精确计数只在 TokenCountService 返回非本地方法成功时才标为精确。
   */
  async describeConversation(actorId: string, id: string, options: { providerId?: string; modelOverride?: string } = {}) {
    if (!id || typeof id !== 'string') throw new Error('需要提供对话 ID。');
    const state = await this.app.conversations.read(actorId, id);
    const messages = state.history.messages as unknown as Content[];
    const custom = state.metadata.custom as Record<string, unknown> | undefined;
    const platformContext = custom?.platformContext as TurnContextState | undefined;
    const trimState = custom?.trimState as { trimStartIndex?: unknown } | null | undefined;
    const lastSummaryIndex = findLastSummaryIndex(messages);
    const summarizedCount = messages.filter(message => message.isSummarized).length;
    const summaryEntries = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.isSummary);
    let lastAssistant: { timestamp: number; total: number } | undefined;
    let latestEstimate: { timestamp: number; tokens: number } | undefined;
    for (const entry of summaryEntries) {
      const estimated = (entry.message as Content).summaryTokenStats?.estimatedContextTokenCountAfter;
      const timestamp = typeof entry.message.timestamp === 'number' ? entry.message.timestamp : 0;
      if (typeof estimated === 'number' && Number.isFinite(estimated)) {
        if (!latestEstimate || timestamp >= latestEstimate.timestamp) latestEstimate = { timestamp, tokens: Math.max(0, estimated) };
      }
    }
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== 'model' || !message.usageMetadata) continue;
      const total = (message.usageMetadata as { totalTokenCount?: unknown }).totalTokenCount;
      if (typeof total === 'number' && Number.isFinite(total)) {
        lastAssistant = { timestamp: typeof message.timestamp === 'number' ? message.timestamp : 0, total: Math.max(0, total) };
        break;
      }
    }
    let usedTokens = 0;
    let usedSource: 'provider-usage' | 'summary-estimate' | 'none' = 'none';
    if (lastAssistant && (!latestEstimate || latestEstimate.timestamp < lastAssistant.timestamp)) {
      usedTokens = lastAssistant.total; usedSource = 'provider-usage';
    } else if (latestEstimate && lastAssistant && latestEstimate.timestamp >= lastAssistant.timestamp) {
      usedTokens = latestEstimate.tokens; usedSource = 'summary-estimate';
    } else if (latestEstimate && !lastAssistant) {
      usedTokens = latestEstimate.tokens; usedSource = 'summary-estimate';
    } else if (lastAssistant) {
      usedTokens = lastAssistant.total; usedSource = 'provider-usage';
    }
    const visible = messages.filter(message => !message.isSummarized);
    const localEstimate = visible.reduce((total, message) => total + this.localTokens.estimateMessageTokens(message), 0);
    let maxContextTokens: number | undefined;
    let maxInputTokens: number | undefined;
    let contextSource: string | undefined;
    let policyEnabled: boolean | undefined;
    let preciseTokens: number | undefined;
    let preciseAvailable = false;
    let preciseIsProviderCount = false;
    let preciseMethod: string | undefined;
    let preciseError: string | undefined;
    if (options.providerId) {
      const channel = await this.app.product.channel(options.providerId) as unknown as Record<string, unknown> | null;
      if (channel) {
        const resolution = resolveMaxContextTokensForConfig(channel as never, options.modelOverride);
        maxContextTokens = resolution.maxContextTokens; maxInputTokens = resolution.maxInputTokens; contextSource = resolution.source;
        try { policyEnabled = resolveContextManagementPolicy(channel as never).enabled; } catch { policyEnabled = undefined; }
        preciseMethod = typeof channel.tokenCountMethod === 'string' ? channel.tokenCountMethod as string : 'channel_default';
        try {
          const proxyUrl = this.app.product.runtimeSettings().getEffectiveProxyUrl();
          const counter = new TokenCountService(proxyUrl);
          const result = await counter.countTokensWithChannelConfig(channel as never, visible, proxyUrl);
          if (result.success && typeof result.totalTokens === 'number') {
            preciseTokens = Math.max(0, result.totalTokens); preciseAvailable = true;
            const channelType = typeof channel.type === 'string' ? channel.type as string : '';
            const isLocal = !!result.source || !!result.encoding || preciseMethod === 'local' ||
              ((preciseMethod === 'channel_default' || !preciseMethod) && (channelType === 'openai' || !channelType));
            preciseIsProviderCount = !isLocal;
          } else preciseError = result.error ?? '精确计数不可用。';
        } catch (error) { preciseError = (error as Error).message; }
      }
    }
    const tokenUsagePercent = maxContextTokens ? Math.min(100, (usedTokens / maxContextTokens) * 100) : undefined;
    const trimStartIndex = trimState && typeof trimState.trimStartIndex === 'number' ? trimState.trimStartIndex
      : (typeof platformContext?.fallbackStart === 'number' ? platformContext.fallbackStart : undefined);
    const summaries = summaryEntries.map(({ message, index }) => {
      const text = extractSummaryText(message as PlatformMessage);
      const platform = message as unknown as { summarizedMessageIds?: unknown; isAutoSummary?: unknown; summarizedMessageCount?: unknown };
      return {
        id: message.id, index, timestamp: message.timestamp,
        isAutoSummary: platform.isAutoSummary === true,
        summarizedMessageCount: typeof platform.summarizedMessageCount === 'number' ? platform.summarizedMessageCount : undefined,
        summarizedMessageIds: Array.isArray(platform.summarizedMessageIds) ? platform.summarizedMessageIds as string[] : undefined,
        summaryTokenStats: (message as Content).summaryTokenStats,
        preview: text.slice(0, 200),
      };
    });
    return {
      success: true,
      conversationId: id,
      revision: state.history.revision,
      tokens: {
        usedTokens, source: usedSource, precise: usedSource === 'provider-usage',
        maxContextTokens, maxInputTokens, contextSource, tokenUsagePercent,
        localEstimate, localEstimateLabel: 'estimate' as const,
        preciseTokens, preciseAvailable, preciseIsProviderCount, preciseMethod, preciseError,
      },
      range: {
        total: messages.length, visibleCount: visible.length, lastSummaryIndex,
        summarizedCount, summaryCount: summaryEntries.length,
        fallbackActive: platformContext?.fallback === true,
        trimStartIndex, policyEnabled,
      },
      summaries,
    };
  }
  /** 只读总结详情：返回已保存总结的压缩统计与覆盖范围，不发起新的总结。 */
  async getSummaryDetail(actorId: string, id: string, messageId: string) {
    if (!messageId || typeof messageId !== 'string') throw new Error('需要提供总结消息 ID。');
    const state = await this.app.conversations.read(actorId, id);
    const messages = state.history.messages as unknown as Content[];
    const index = messages.findIndex(message => message.id === messageId);
    if (index < 0 || !messages[index]?.isSummary) throw new Error('总结消息已变化。');
    const message = messages[index];
    const platform = message as unknown as { summarizedMessageIds?: unknown; isAutoSummary?: unknown; summarizedMessageCount?: unknown };
    const text = extractSummaryText(message as PlatformMessage);
    return {
      success: true,
      conversationId: id,
      summary: {
        id: message.id, index, timestamp: message.timestamp,
        isAutoSummary: platform.isAutoSummary === true,
        summarizedMessageCount: typeof platform.summarizedMessageCount === 'number' ? platform.summarizedMessageCount : undefined,
        summarizedMessageIds: Array.isArray(platform.summarizedMessageIds) ? platform.summarizedMessageIds as string[] : undefined,
        summaryTokenStats: message.summaryTokenStats,
        preview: text.slice(0, 500),
      },
    };
  }
  async close(): Promise<void> {
    for (const operation of this.manual.values()) operation.controller.abort(new Error('应用正在关闭。'));
    await Promise.allSettled([...this.manual.values()].map(operation => operation.done));
  }
}
