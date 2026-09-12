import { randomUUID } from 'node:crypto';
import type { BotAutoSummarySettings, PlatformConversation, PlatformMessage, RunEvent } from '@graycode/contracts';
import type { ModelRequestContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import { CapturedContext } from './captured';
import { Logger } from '../../../../backend/core/logger';
import type { Content } from '../../../../backend/modules/conversation/types';
import { isRealUserMessage } from '../../../../backend/modules/conversation/helpers';
import { repairParentChainAfterInsert, restoreSummarizedRange } from '../../../../backend/modules/conversation/TranscriptMutation';
import { MessageBuilderService } from '../../../../backend/modules/api/chat/services/MessageBuilderService';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import { TokenEstimationService } from '../../../../backend/modules/api/chat/services/TokenEstimationService';
import { TokenCountService } from '../../../../backend/modules/channel/TokenCountService';
import { SummaryAlgorithms, BUILTIN_SUMMARIZE_SYSTEM_PROMPT, MIN_SUMMARY_LENGTH, MANUAL_SUMMARY_MAX_INPUT_RATIO,
  extractSummaryAnchorText } from '../../../../backend/modules/api/chat/services/SummaryAlgorithms';
import { getHistoryWithContextTrimInfo } from '../../../../backend/modules/api/chat/services/contextTrim/contextTrimInfo';
import { getHistoryWithGranularFallback } from '../../../../backend/modules/api/chat/services/contextTrim/granularFallback';
import { findLastSummaryIndex, calculateContextThreshold } from '../../../../backend/modules/api/chat/services/contextTrim/roundDetection';
import { resolveContextManagementPolicy } from '../../../../backend/modules/api/chat/services/contextTrim/policy';
import { resolveMaxContextTokensForConfig } from '../../../../backend/modules/api/chat/services/contextTrim/contextWindowResolution';
import { planAutoSummarizeMessages, planSummarizeMessages, planIntraRoundSplit, resolveKeepRecentTokenBudget } from '../../../../backend/modules/api/chat/services/summarizeRangePlanner';
import { clampSummarizeMaxInputRatio } from '../../../../backend/modules/settings/types/summarizeTypes';
import { branchMutation, groupMessages, readBranches } from '../conversations/branches';
import { rebaseActivePathFromHistory } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { CONTEXT_NOTES_REMINDER, CONTEXT_TOOL_NAMES } from '../../../../shared/contextManagement';
import { activeContextHistory, captureModelPrefix, conversationContextSettings, manualSummaryPrefix, notesWindowBoundary, summarizeFullContext } from './compaction';

interface TurnContextState { turnId: string; summaryAttempts: number; fallbackStart?: number; fallback?: boolean }
interface SummaryResult { summaryContent: Content; insertIndex: number; removedCount: number }

export class PlatformContextService {
  private readonly log = Logger.get('PlatformContext');
  private readonly builder = new MessageBuilderService();
  private readonly localTokens = new MessageTokenEstimator();
  private readonly summaries = new SummaryAlgorithms(this.localTokens);
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
    const result = await this.app.storage.commitConversation({ conversationId: state.metadata.id,
      expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken, activeRunId: runId,
      messages: state.history.messages, metadata: state.metadata,
      ...(snapshot ? { snapshot: { id: randomUUID(), conversationId: state.metadata.id, timestamp: Date.now(), name: '总结变更前', kind: 'context-summary' } } : {}) });
    state.history.revision = result.revision; state.history.total = result.total; state.metadataToken = result.metadataToken;
    frame.dirty = false;
    this.app.productUi.conversations.clearMetadataCache();
  }
  async prepare(context: ModelRequestContext, preview = false) {
    const { run, input } = context;
    let config = await this.app.product.channel(input.providerId);
    if (!config) return { history: context.history, messages: input.messages };
    const management = this.configuration(context.history.metadata, config);
    // 工具目录和总结方式在回合开始时一同捕获，设置变更不破坏正在运行的前缀。
    const capturedMethod = input.turnContext?.contextManagementMethod;
    if (capturedMethod === 'summary' || capturedMethod === 'notes') management.method = capturedMethod;
    if (management.bot?.method && management.bot.method !== 'time') config = { ...config,
      contextManagementEnabled: management.bot.enabled, contextManagementMode: 'summarize' };
    const settings = this.app.product.runtimeSettings();
    const frame = new CapturedContext(context.history);
    const notices: string[] = [];
    const commit = (snapshot = false) => preview ? Promise.resolve() : this.commit(frame, run.id, snapshot);
    const event = (type: RunEvent['type'], payload: Record<string, unknown>) => preview ? Promise.resolve() : this.event(run.id, type, payload);
    const prefix = captureModelPrefix({ ...input, modelOverride: input.modelOverride ?? config.model });
    const custom = frame.state.metadata.custom as Record<string, unknown> | undefined;
    if (JSON.stringify(custom?.contextRequestPrefix) !== JSON.stringify(prefix)) await frame.store.setCustomMetadata(run.conversationId, 'contextRequestPrefix', prefix);
    const pending = custom?.pendingContextWindow as { runId?: string; toolCallId?: string } | undefined;
    const switchRequested = pending?.runId === run.id && frame.state.history.messages.some(message => message.parts.some(part =>
      part.functionResponse && (part.functionResponse as { id?: string }).id === pending.toolCallId));
    if (switchRequested && management.method === 'notes') {
      await event('context.summary.started', { method: 'notes' });
      const result = await notesWindowBoundary(this.app, frame, true, config.type);
      await commit(true);
      await event('context.summary.completed', { ...result });
    }
    // 预览只在独立快照内估算，不发起远程 Token 计数或更新已保存的历史。
    const estimator = new TokenEstimationService(frame.store, new TokenCountService(settings.getEffectiveProxyUrl()), preview ? undefined : settings);
    const options = this.builder.buildHistoryOptions(config);
    const promptText = [...input.promptContext?.beforeHistoryMessages ?? [], ...input.promptContext?.afterHistoryMessages ?? []]
      .flatMap(message => message.parts.map(part => part.text ?? '')).join('\n');
    const fixedSystem = [input.systemPrompt, JSON.stringify(input.tools), JSON.stringify(input.taskContext ?? {})].join('\n');
    const evaluate = (advance: boolean) => getHistoryWithContextTrimInfo({ conversationManager: frame.store,
      promptManager: { getSystemPrompt: () => fixedSystem, getDynamicContextText: () => promptText },
      messageBuilderService: this.builder, tokenEstimationService: estimator, log: this.log },
    run.conversationId, config, options, promptText, undefined, input.modelOverride, 'preserve', { allowStateAdvance: advance });
    let info = await evaluate(context.iteration === 1);
    const turnId = [...frame.state.history.messages].reverse().find(message => isRealUserMessage({ ...message, isSummarized: false } as Content) && !message.userFeedback)?.id ?? run.id;
    const old = custom?.platformContext as TurnContextState | undefined;
    const turn: TurnContextState = old?.turnId === turnId ? { ...old } : { turnId, summaryAttempts: 0 };
    const fixedTokens = info.fixedPromptTokens ?? this.localTokens.estimateMessageTokens({ role: 'user', parts: [{ text: fixedSystem + promptText }] });
    const overflow = info.history.reduce((total, message) => total + this.localTokens.estimateMessageTokens(message), fixedTokens) > resolveMaxContextTokensForConfig(config, input.modelOverride).maxInputTokens;
    if (!resolveContextManagementPolicy(config).enabled) { turn.fallback = false; turn.fallbackStart = undefined; }
    if (overflow && resolveContextManagementPolicy(config).enabled && context.iteration > 1) info = await evaluate(true);
    const policy = resolveContextManagementPolicy(config);
    const active = () => activeContextHistory(frame.state.history.messages, config);
    const activeTokens = active().reduce((total, message) => total + this.localTokens.estimateMessageTokens(message as Content), fixedTokens);
    const threshold = calculateContextThreshold(config.contextThreshold ?? '80%', resolveMaxContextTokensForConfig(config, input.modelOverride).maxInputTokens);
    const shouldCompact = policy.enabled && policy.mode === 'summarize' && (info.needsAutoSummarize || activeTokens > threshold);
    if (management.method === 'notes' && shouldCompact && !switchRequested) {
      if (!CONTEXT_TOOL_NAMES.every(name => input.tools.some(tool => tool.name === name))) throw new Error('笔记换窗口需要启用上下文笔记、历史读取和换窗口工具，请在启用工具后重试。');
      if (overflow) {
        await event('context.summary.started', { method: 'notes' });
        const result = await notesWindowBoundary(this.app, frame, true, config.type);
        await commit(true);
        await event('context.summary.completed', { ...result });
        if (preview) notices.push('当前内容预计超过上下文容量，发送前将切换到笔记窗口；这里展示切换后的内容。');
      } else {
        const windowId = [...frame.state.history.messages].reverse().find(message => message.contextWindowId)?.contextWindowId ?? 'initial';
        if (custom?.contextReminderWindowId !== windowId) {
          frame.state.history.messages.push({ id: randomUUID(), role: 'user', contextControl: 'reminder', parts: [{ text: CONTEXT_NOTES_REMINDER }],
            parentId: frame.state.history.messages.at(-1)?.id ?? null, timestamp: Date.now(), index: frame.state.history.messages.length });
          await frame.store.setCustomMetadata(run.conversationId, 'contextReminderWindowId', windowId);
        }
      }
      await commit();
      return { history: frame.state, messages: active(), notices };
    }
    const latestBoundary = frame.state.history.messages.findLastIndex(message => message.isSummary && !message.isSummarized);
    const hasNewModelHistory = frame.state.history.messages.slice(latestBoundary + 1).some(message => message.role === 'model' && !message.isSummarized);
    if (management.method === 'summary' && shouldCompact && hasNewModelHistory) {
      if (preview) return { history: frame.state, messages: active(), notices: [
        '当前内容预计触发自动总结。这里展示总结前的完整提示词；总结生成后，实际发送的历史会随之变化。'] };
      turn.summaryAttempts++;
      await frame.store.setCustomMetadata(run.conversationId, 'platformContext', turn);
      await commit();
      await event('context.summary.started', { attempt: turn.summaryAttempts });
      try {
        const result = await summarizeFullContext(this.app, frame, prefix, input.signal, true);
        await commit(true);
        turn.fallback = false; turn.fallbackStart = undefined;
        await event('context.summary.completed', { ...result });
        info = await evaluate(true);
      } catch (error) {
        input.signal.throwIfAborted();
        if (['REVISION_CONFLICT', 'STORAGE_BUSY'].includes((error as { code?: string }).code ?? '')) throw error;
        await event('context.summary.failed', { message: (error as Error).message });
        throw error;
      }
    }
    if (policy.mode === 'trim' && (info.needsContextFallback || turn.fallback)) {
      info = await getHistoryWithGranularFallback({ conversationManager: frame.store, tokenEstimationService: estimator, log: this.log },
        run.conversationId, config, options, input.modelOverride, 'preserve', turn.fallbackStart, fixedTokens);
      turn.fallback = true; turn.fallbackStart = info.trimStartIndex;
      await event('context.fallback', { trimStartIndex: info.trimStartIndex });
    }
    if (turn.summaryAttempts || turn.fallback) await frame.store.setCustomMetadata(run.conversationId, 'platformContext', turn);
    await commit();
    input.signal.throwIfAborted();
    return { history: frame.state, messages: policy.mode === 'trim' ? info.history as PlatformMessage[] : active(), notices };
  }

  private async summarizeTimed(frame: CapturedContext, providerId: string, modelOverride: string | undefined, signal: AbortSignal, mode: 'auto' | 'manual', override?: BotAutoSummarySettings): Promise<SummaryResult> {
    signal.throwIfAborted();
    const settings = this.app.product.runtimeSettings().getSummarizeConfig();
    const full = frame.state.history.messages as Content[];
    const lastSummary = findLastSummaryIndex(full);
    const start = lastSummary + 1;
    const candidates = full.slice(start).filter(message => !message.isSummarized);
    const main = await this.app.product.channel(providerId);
    if (!main) throw new Error('总结使用的主渠道不存在。');
    const tokens = candidates.map(message => this.summaries.estimateMessageTokensForBudget(message, main.type));
    const keep = resolveKeepRecentTokenBudget(override ? `${100 - override.percent}%` : settings.keepRecentTokens, tokens.reduce((sum, item) => sum + item, 0));
    const args = { messages: candidates, messageTokens: tokens, keepBudgetTokens: keep, minKeepRounds: override ? 1 : settings.keepRecentRounds };
    const plan = mode === 'auto' ? planAutoSummarizeMessages(args) : planSummarizeMessages({ ...args, mode });
    const split = plan ?? (lastSummary >= 0 && !candidates.some(isRealUserMessage) ? planIntraRoundSplit(args) : null);
    if (!split || split.cutIndex < 1) throw new Error('没有足够的完整历史可总结，最近的用户回合会继续保留。');
    let end = full.findIndex(message => message.id === candidates[split.cutIndex]?.id);
    if (end < 1) throw new Error('总结范围边界不可用。');
    const actualProvider = settings.useSeparateModel && settings.summarizeChannelId ? settings.summarizeChannelId : providerId;
    const actualModel = settings.useSeparateModel && settings.summarizeChannelId ? settings.summarizeModelId || undefined : modelOverride;
    const config = await this.app.product.channel(actualProvider);
    if (!config?.enabled) throw new Error('总结渠道不存在或已禁用。');
    const basePrompt = override?.prompt.trim() || (mode === 'auto' ? settings.autoSummarizePrompt : settings.summarizePrompt);
    const prompt = this.summaries.buildDetailedSummaryPrompt(basePrompt, extractSummaryAnchorText(full, end));
    const budget = this.summaries.resolveSummaryInputBudget(config, actualModel,
      mode === 'auto' ? clampSummarizeMaxInputRatio(settings.summarizeMaxInputRatio) : MANUAL_SUMMARY_MAX_INPUT_RATIO, prompt);
    const source = full.slice(Math.max(0, lastSummary), end).filter(message => !message.isSummarized);
    const fitted = this.summaries.fitSummaryHistoryPrefixToBudget(source, budget.maxHistoryTokens, config.type);
    if (!fitted) throw new Error('没有完整消息范围能放入总结模型的输入预算。');
    end = full.findIndex(message => message.id === fitted.messages.at(-1)?.id) + 1;
    if (end <= start) throw new Error('缩小范围后没有可总结的新消息。');
    const cleaned = this.summaries.cleanMessagesForSummarize(fitted.messages, config);
    if (!cleaned.length || this.summaries.estimateMessagesTokens(cleaned, config.type) > budget.maxHistoryTokens) throw new Error('总结请求仍然超过输入预算。');
    const response = await this.app.models.generate({ conversationId: `summary-${randomUUID()}`, providerId: actualProvider,
      modelOverride: actualModel, systemPrompt: BUILTIN_SUMMARIZE_SYSTEM_PROMPT, tools: [], signal,
      messages: [...cleaned, { role: 'user', parts: [{ text: this.summaries.buildDetailedSummaryPrompt(basePrompt, extractSummaryAnchorText(full, end)) }] }] as unknown as PlatformMessage[] });
    signal.throwIfAborted();
    const text = response.parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n').trim();
    if (text.length < MIN_SUMMARY_LENGTH || response.parts.some(part => part.functionCall)) throw new Error('总结内容过短或格式不完整，原文没有被覆盖。');
    const firstUser = full.findIndex(isRealUserMessage);
    const markStart = Math.max(start, firstUser + 1);
    if (markStart >= end) throw new Error('总结范围没有可标记的新消息。');
    const sourceIds = full.slice(markStart, end).map(message => message.id!);
    const summary: Content = { id: randomUUID(), role: 'user', parts: [{ text }], timestamp: Date.now(),
      parentId: full[end - 1]?.id ?? null, isSummary: true, isAutoSummary: mode === 'auto',
      summarizedMessageCount: this.summaries.resolvePreviousSummarizedCount(full, lastSummary) + sourceIds.length,
      summaryTokenStats: this.summaries.buildSummaryTokenStats({ fullHistory: full, messagesToSummarize: fitted.messages,
        summaryText: text, channelType: config.type }), index: end };
    const messages = structuredClone(full);
    for (let index = markStart; index < end; index++) messages[index].isSummarized = true;
    messages.splice(end, 0, summary);
    repairParentChainAfterInsert(messages, end, summary.parentId ?? null, summary.id!);
    frame.state.history.messages = messages.map((message, index) => ({ ...message, index })) as unknown as PlatformMessage[];
    (frame.state.history.messages[end] as PlatformMessage).summarizedMessageIds = sourceIds;
    frame.dirty = true;
    await frame.store.setCustomMetadata(frame.state.metadata.id, 'trimState', null);
    return { summaryContent: frame.state.history.messages[end] as Content, insertIndex: end, removedCount: sourceIds.length };
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
      custom: { ...state.metadata.custom as Record<string, unknown>, trimState: null } }, records: [branchMutation(state, branches)],
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
        const method = this.configuration(state.metadata).method;
        const result = botSchedule && (!botSchedule.method || botSchedule.method === 'time')
          ? await this.summarizeTimed(frame, providerId, modelOverride, controller.signal, 'auto', botSchedule)
          : method === 'notes' ? await notesWindowBoundary(this.app, frame, false, (await this.app.product.channel(providerId))?.type ?? 'openai')
            : await summarizeFullContext(this.app, frame, await manualSummaryPrefix(this.app, frame, actorId, providerId, modelOverride), controller.signal, false);
        controller.signal.throwIfAborted();
        await this.commit(frame, undefined, true);
        return { success: true, ...result, summarizedMessageCount: result.removedCount };
      } catch (error) { return { success: false, error: { code: controller.signal.aborted ? 'CANCELLED' : 'SUMMARY_FAILED', message: (error as Error).message } }; }
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
            const isLocal = preciseMethod === 'local' ||
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
      const text = Array.isArray(message.parts) ? message.parts
        .filter(part => typeof (part as { text?: unknown }).text === 'string' && !(part as { thought?: unknown }).thought)
        .map(part => (part as { text: string }).text).join('\n') : '';
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
    const text = Array.isArray(message.parts) ? message.parts
      .filter(part => typeof (part as { text?: unknown }).text === 'string' && !(part as { thought?: unknown }).thought)
      .map(part => (part as { text: string }).text).join('\n') : '';
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
