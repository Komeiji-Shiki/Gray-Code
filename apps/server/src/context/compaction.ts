import { randomUUID } from 'node:crypto';
import type { PlatformConversation, PlatformMessage, BotAutoSummarySettings } from '@graycode/contracts';
import type { Content } from '../../../../backend/modules/conversation/types';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import { repairParentChainAfterInsert } from '../../../../backend/modules/conversation/TranscriptMutation';
import { formatHistoryForAPI } from '../../../../backend/modules/conversation/manager/historyFormatting';
import { MessageBuilderService } from '../../../../backend/modules/api/chat/services/MessageBuilderService';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import { SummaryAlgorithms, MIN_SUMMARY_LENGTH } from '../../../../backend/modules/api/chat/services/SummaryAlgorithms';
import { DEFAULT_CONTEXT_MANAGEMENT_METHOD, DEFAULT_USER_MESSAGE_RETENTION, type ContextManagementMethod, type ContextUserMessageRetention } from '../../../../shared/contextManagement';
import { isHistoricalUserInput, retainedUserIds } from './retention';
import { getModelCompletionStatus } from '../../../../shared/modelCompletion';
import { clampSummarizeMaxInputRatio } from '../../../../backend/modules/settings/types/summarizeTypes';
import { MANUAL_SUMMARY_MAX_INPUT_RATIO } from '../../../../backend/modules/api/chat/services/SummaryAlgorithms';
import { botProfile } from '../bots/config';
import type { CapturedBotEnvironment } from '../bots/prompt';
import { PlatformPromptService } from '../prompt/service';
import type { PlatformApplication } from '../application';
import { CapturedContext } from './captured';
import { configuredAgent } from '../settings/agent';
import { readModelPrefix, type ModelPrefix } from './prefix';
import { extractSummaryText } from './summaryText';
import { memoryReferences, type MemoryRecordReference } from '../memory/longTerm/history';

export { captureModelPrefix, type ModelPrefix } from './prefix';
export interface ContextBoundaryResult {
  summaryContent: Content;
  insertIndex: number;
  removedCount: number;
  consumedMessageIds?: string[];
  sourceTokens?: number;
  resultTokens?: number;
}
export interface ContextBoundaryOptions {
  consumedMessageIds?: ReadonlySet<string>;
  insertAtConsumedEnd?: boolean;
  retainedUserTokenBudget?: number;
  estimateTokens?: (message: PlatformMessage) => number;
}

function contextBoundaryPositions(messages: PlatformMessage[]): Map<string, number> {
  const positions = new Map<string, number>();
  const byId = new Map(messages.map((message, index) => [message.id!, { message, index }]));
  const position = (id: string): number => {
    const cached = positions.get(id);
    if (cached !== undefined) return cached;
    const entry = byId.get(id);
    if (!entry) return -1;
    const anchor = entry.message.contextBoundaryAfterMessageId;
    const ids = entry.message.isSummary ? entry.message.summarizedMessageIds as string[] | undefined : undefined;
    let result = entry.index;
    if (typeof anchor === 'string') result = position(anchor);
    else if (ids?.length) {
      result = -1;
      for (const sourceId of ids) result = Math.max(result, position(sourceId));
    }
    positions.set(id, result);
    return result;
  };
  for (const message of messages) if (message.id) position(message.id);
  return positions;
}

export function conversationContextSettings(app: PlatformApplication, conversation: PlatformConversation,
  automaticChannel?: Pick<ChannelConfig, 'autoSummarizeMethod'>): { method: ContextManagementMethod; bot?: BotAutoSummarySettings; userMessageRetention?: ContextUserMessageRetention } {
  const environment = (conversation.custom as Record<string, unknown> | undefined)?.botEnvironment as CapturedBotEnvironment | undefined;
  const channel = environment?.version === 1 ? environment.channel : undefined;
  const bot = channel && typeof channel.channelId === 'string' ? botProfile(app.settings.snapshot().settings,
    channel.platform === 'discord' ? 'discord' : 'onebot', { channelId: channel.channelId, direct: channel.direct === true }).autoSummary : undefined;
  const automaticMethod = automaticChannel?.autoSummarizeMethod;
  if (automaticMethod !== undefined && automaticMethod !== 'summary' && automaticMethod !== 'notes') throw new Error('当前渠道的自动总结方式无效，请重新选择。');
  // 自动和手动操作共用渠道方式，未单独设置的渠道沿用全局值；Bot 的显式选择仍优先。
  const settings = app.product.runtimeSettings().getSummarizeConfig();
  return { method: bot?.method && bot.method !== 'time' ? bot.method
    : automaticMethod ?? settings.method ?? DEFAULT_CONTEXT_MANAGEMENT_METHOD, bot,
    userMessageRetention: channel ? undefined : settings.userMessageRetention ?? DEFAULT_USER_MESSAGE_RETENTION };
}

/** 活跃边界记录保留的用户原文，避免按索引裁掉位于摘要以前的最新要求。 */
export function activeContextHistory(messages: PlatformMessage[], config: ChannelConfig, pendingAsyncCallIds?: ReadonlySet<string>): PlatformMessage[] {
  const summaries = messages.filter(message => message.isSummary && !message.isSummarized && Array.isArray(message.summarizedMessageIds));
  const positions = summaries.length ? contextBoundaryPositions(messages) : undefined;
  const legacyIndex = messages.findLastIndex(message => message.isSummary && !message.isSummarized
    && !Array.isArray(message.summarizedMessageIds));
  const legacyRetained = new Set((messages[legacyIndex]?.retainedUserMessageIds as string[] | undefined) ?? []);
  const firstUser = messages.find(isHistoricalUserInput);
  const boundaries = new Map<number, PlatformMessage[]>();
  const moved = new Set<string>();
  for (const message of summaries) {
    const end = positions!.get(message.id!) ?? -1;
    if (end < 0) continue;
    const entries = boundaries.get(end) ?? [];
    entries.push(message);
    boundaries.set(end, entries);
    moved.add(message.id!);
  }
  // 普通摘要存档在末尾，模型视图仍放回实际消费边界，未总结的后缀继续按原顺序发送。
  const active: PlatformMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message.isSummarized && !moved.has(message.id!)
      && (legacyIndex < 0 || index >= legacyIndex || message === firstUser || legacyRetained.has(message.id!))) active.push(message);
    active.push(...boundaries.get(index) ?? []);
  }
  return formatHistoryForAPI(active as Content[], { ...new MessageBuilderService().buildHistoryOptions(config), includeTurnDynamicContext: true,
    ...(pendingAsyncCallIds ? { pendingAsyncCallIds } : {}) }) as PlatformMessage[];
}

/** 摘要和窗口切换共用可恢复边界，重复切换也只覆盖本次仍活跃的消息。 */
export async function applyContextBoundary(frame: CapturedContext, text: string, method: ContextManagementMethod, automatic: boolean,
  channelType: string, policy?: ContextUserMessageRetention,
  reason: Content['contextSwitchReason'] = automatic ? 'threshold' : 'manual', options: ContextBoundaryOptions = {}): Promise<ContextBoundaryResult> {
  const full = frame.state.history.messages as Content[];
  const estimateTokens = options.estimateTokens ?? ((message: PlatformMessage) => new MessageTokenEstimator().estimateMessageTokens(message as Content));
  const retained = retainedUserIds(frame.state.history.messages, policy, options.retainedUserTokenBudget === undefined ? undefined
    : { maxTokens: options.retainedUserTokenBudget, estimateTokens: message => options.consumedMessageIds
      && !options.consumedMessageIds.has(message.id!) && !message.isSummarized ? 0 : estimateTokens(message) });
  const covered = full.filter(message => !retained.has(message.id!) && !message.isSummarized
    && (!options.consumedMessageIds || options.consumedMessageIds.has(message.id!)));
  if (!covered.length) throw new Error('当前没有可替换的历史内容。');
  const ids = new Set(covered.map(message => message.id!));
  const algorithms = new SummaryAlgorithms({ estimateMessageTokens: message => estimateTokens(message as PlatformMessage) });
  const positions = contextBoundaryPositions(frame.state.history.messages);
  let consumedEnd = -1;
  let lastConsumedMessageId: string | undefined;
  for (const message of full) {
    if (options.consumedMessageIds && !options.consumedMessageIds.has(message.id!)) continue;
    const position = positions.get(message.id!) ?? -1;
    if (position >= consumedEnd) { consumedEnd = position; lastConsumedMessageId = message.id; }
  }
  let insertIndex = full.length;
  if (options.insertAtConsumedEnd && options.consumedMessageIds) {
    insertIndex = consumedEnd + 1;
  }
  const summary: Content = { id: randomUUID(), role: 'user', parts: [{ text }], timestamp: Date.now(),
    parentId: full[insertIndex - 1]?.id ?? null, isSummary: true, isAutoSummary: automatic, contextMethod: method,
    contextWindowId: randomUUID(), contextSwitchReason: reason, summarizedMessageIds: [...ids],
    ...(policy ? { retainedUserMessageIds: [...retained] } : {}),
    summarizedMessageCount: covered.reduce((count, message) => count + (message.isSummary ? message.summarizedMessageCount ?? 0 : 1), 0),
    summaryTokenStats: algorithms.buildSummaryTokenStats({ fullHistory: full.filter(message => !message.isSummarized),
      messagesToSummarize: covered, summaryText: text, channelType }), index: insertIndex };
  (summary as PlatformMessage).contextBoundaryAfterMessageId = lastConsumedMessageId;
  if(method==='notes')(summary as PlatformMessage).longMemoryInputIds=[];
  for (let index = 0; index < full.length; index++) {
    if (ids.has(full[index].id!)) await frame.store.updateMessage(frame.state.metadata.id, index, { isSummarized: true });
    else if (retained.has(full[index].id!) && full[index].isSummarized)
      await frame.store.updateMessage(frame.state.metadata.id, index, { isSummarized: false });
  }
  if (insertIndex === full.length) {
    frame.state.history.messages.push(summary as PlatformMessage);
    frame.appendMessages.push(summary as PlatformMessage);
  } else {
    const messages = frame.state.history.messages.map(message => ({ ...message })) as Content[];
    messages.splice(insertIndex, 0, summary);
    repairParentChainAfterInsert(messages, insertIndex, summary.parentId ?? null, summary.id!);
    frame.state.history.messages = messages.map((message, index) => ({ ...message, index })) as PlatformMessage[];
    frame.historyReplaced = true;
  }
  frame.dirty = true;
  await frame.store.setCustomMetadata(frame.state.metadata.id, 'trimState', null);
  await frame.store.setCustomMetadata(frame.state.metadata.id, 'pendingContextWindow', null);
  await frame.store.setCustomMetadata(frame.state.metadata.id, 'contextReminderWindowId', null);
  return { summaryContent: summary, insertIndex, removedCount: covered.length };
}

export async function notesWindowBoundary(app: PlatformApplication, frame: CapturedContext, automatic: boolean, channelType: string,
  policy = conversationContextSettings(app, frame.state.metadata).userMessageRetention,
  reason: Content['contextSwitchReason'] = automatic ? 'threshold' : 'manual', options: ContextBoundaryOptions = {}): Promise<ContextBoundaryResult> {
  const id = frame.state.metadata.id;
  const names = (await app.storage.listRecords('context-notes', id)).map(key => JSON.parse(key)[1] as string);
  const latestUser = [...frame.state.history.messages].reverse().find(isHistoricalUserInput);
  const text = [`A new context window has started for the same task. Earlier messages and tool results remain available through context_history.`,
    `Read working notes with context_notes before continuing. Available note names: ${names.length ? names.join(', ') : '(none yet; recover the current task from history)'}.`,
    `Recorded notes and dependencies remain in history: use context_notes action=recall with the current intent or taskId; token usage is estimated automatically.`,
    latestUser ? `The latest real user message has ID ${latestUser.id}. Read it and any relevant preceding history to recover the current request and constraints.` : '',
    `This is a context transition, not a new user request or task completion. Continue the unfinished work.`].filter(Boolean).join('\n');
  const estimateTokens = options.estimateTokens ?? ((message: PlatformMessage) => new MessageTokenEstimator().estimateMessageTokens(message as Content));
  const retainedUserTokenBudget = options.retainedUserTokenBudget === undefined ? undefined
    : Math.max(0, options.retainedUserTokenBudget - estimateTokens({ role: 'user', parts: [{ text }] }));
  return applyContextBoundary(frame, text, 'notes', automatic, channelType, policy, reason, { ...options, retainedUserTokenBudget });
}

/** 老会话优先读取保存的请求；没有前缀快照时按原回合的提示词模式和动态快照恢复。 */
export async function manualSummaryPrefix(app: PlatformApplication, frame: CapturedContext, actorId: string, providerId: string, modelOverride?: string): Promise<ModelPrefix> {
  const stored = await readModelPrefix(app, frame.state.metadata);
  if (stored) return { ...stored, providerId, modelOverride: modelOverride ?? (stored.providerId === providerId ? stored.modelOverride : undefined) };
  const lastModel = frame.state.history.messages.findLast(message => message.role === 'model' && typeof message.runId === 'string');
  const run = lastModel ? await app.storage.getRun(lastModel.runId as string) : undefined;
  const saved = run ? await app.storage.getRecord('model-requests', `${run.id}:${run.iteration}`) as { prefix?: ModelPrefix } | null : undefined;
  if (saved?.prefix) return { ...saved.prefix, providerId, modelOverride: modelOverride ?? (saved.prefix.providerId === providerId ? saved.prefix.modelOverride : undefined) };
  const { agents } = app.settings.read('agents');
  const storedAgent = agents.find(item => item.id === run?.agentId) ?? agents[0];
  const actor = app.actor(run?.actorId ?? actorId);
  if (!storedAgent || !actor) throw new Error('无法恢复当前会话使用的模型前缀。');
  const agent = configuredAgent(app, storedAgent);
  const previousTurn = frame.state.history.messages.findLast(isHistoricalUserInput);
  const workspace = typeof frame.state.metadata.workspaceId === 'string' ? app.settings.find('workspaces', frame.state.metadata.workspaceId) : undefined;
  const prepared = await new PlatformPromptService(app).prepare({ agent, actor, workspace, conversation: frame.state.metadata,
    history: frame.state.history.messages, previousTurn, request: { actorId: actor.id, agentId: agent.id, conversationId: frame.state.metadata.id,
      requestKey: 'manual-summary', providerId, modelOverride, promptModeId: typeof previousTurn?.promptModeId === 'string' ? previousTurn.promptModeId : undefined,
      message: { id: randomUUID(), role: 'user', parts: [{ text: '' }] } } });
  return { conversationId: frame.state.metadata.id, providerId, modelOverride, systemPrompt: prepared.systemPrompt,
    promptContext: 'promptContext' in prepared ? prepared.promptContext : undefined, turnContext: 'turnContext' in prepared ? prepared.turnContext : undefined,
    taskContext: { actor: { id: actor.id, displayName: actor.displayName, role: actor.role }, workspace }, tools: app.tools.catalog(prepared.toolNames).declarations };
}

export interface SummarizeContextOptions extends ContextBoundaryOptions {
  messages: PlatformMessage[];
  maxHistoryTokens: number;
  prompt?: string;
  validateCandidate?: (candidate: CapturedContext, result: ContextBoundaryResult) => Promise<void> | void;
}

export function buildContextSummaryPrompt(base: string): string {
  return [base.trim(),
    'Pause the task and summarize only the conversation provided above. Do not call tools or continue working.',
    'Write in the language the user has been using. Use exactly these six sections, translating their headings into that language:',
    '1. Current goal. 2. Active constraints and user preferences. 3. Unfinished work. 4. Exact next steps. '
      + '5. Completed work and verified results. 6. Exact paths, identifiers and pending decisions.',
    'Keep the latest user instructions, unresolved questions and required technical details. Mark unverified work clearly. '
      + 'Output only the handoff summary so the same task can continue.'].join('\n\n');
}

export async function summarizeFullContext(app: PlatformApplication, frame: CapturedContext, prefix: ModelPrefix,
  signal: AbortSignal, automatic: boolean, options: SummarizeContextOptions): Promise<ContextBoundaryResult> {
  const config = await app.product.channel(prefix.providerId, { includeCredential: false });
  if (!config?.enabled) throw new Error('当前会话的模型渠道不存在或已禁用。');
  const settings = app.product.runtimeSettings().getSummarizeConfig();
  const source = options.messages;
  if (!source.some(message => message.role === 'model' || message.parts.some(part => part.functionResponse))) throw new Error('当前没有可总结的助手回复或工具结果。');
  const management = conversationContextSettings(app, frame.state.metadata);
  const capturedRetention = automatic ? prefix.turnContext?.contextUserMessageRetention : undefined;
  const policy = management.userMessageRetention === undefined ? undefined
    : capturedRetention === 'first' || capturedRetention === 'all' ? capturedRetention : management.userMessageRetention;
  const prompt = buildContextSummaryPrompt(options.prompt ?? (automatic ? settings.autoSummarizePrompt : settings.summarizePrompt));
  const estimator = new MessageTokenEstimator();
  const estimateTokens = options.estimateTokens ?? ((message: PlatformMessage) => estimator.estimateMessageTokens(message as Content));
  const algorithms = new SummaryAlgorithms({ estimateMessageTokens: message => estimateTokens(message as PlatformMessage) });
  const promptMessage: PlatformMessage = { role: 'user', contextControl: 'summary_request', parts: [{ text: prompt }] };
  // 预算必须来自最终变换后的消息，不能复用原文或部分流响应留下的旧 token 统计。
  const budgetMessages = source.map(message => {
    const tokens = estimateTokens(message);
    return { ...message, usageMetadata: undefined, usageMetadataPartial: false,
      tokenCountByChannel: { [config.type]: tokens }, estimatedTokenCount: tokens };
  });
  const promptTokens = estimateTokens(promptMessage);
  const completeTokens = budgetMessages.reduce((total, message) => total + message.estimatedTokenCount, 0);
  const ratio = completeTokens + promptTokens <= options.maxHistoryTokens ? 1
    : automatic ? clampSummarizeMaxInputRatio(settings.summarizeMaxInputRatio) : MANUAL_SUMMARY_MAX_INPUT_RATIO;
  const maxHistoryTokens = Math.max(0, Math.floor(options.maxHistoryTokens * ratio) - promptTokens);
  const fitted = algorithms.fitSummaryHistoryPrefixToBudget(budgetMessages as Content[], maxHistoryTokens, config.type);
  if (!fitted) throw new Error('没有完整的消息与工具调用组能放入总结输入预算，原上下文保持不变。');
  const selected = source.slice(0, fitted.consumedMessageCount);
  const consumedMessageIds = new Set(selected.flatMap(message => message.id
    && (!options.consumedMessageIds || options.consumedMessageIds.has(message.id)) ? [message.id] : []));
  if (!selected.some(message => message.role === 'model' && !message.isSummary && consumedMessageIds.has(message.id!)))
    throw new Error('总结范围内没有新的助手消息，原上下文保持不变。');
  // 总结指令不构成真实用户回合，避免动态提示词和思考过滤向后移动而破坏原前缀。
  const response = await app.models.generate({ ...prefix, purpose: 'summary', signal,
    messages: [...selected, promptMessage] });
  signal.throwIfAborted();
  if (getModelCompletionStatus(response) !== 'complete') throw new Error('总结生成未完整结束，原上下文保持不变。');
  const text = extractSummaryText(response).trim();
  if (text.length < MIN_SUMMARY_LENGTH || response.parts.some(part => part.functionCall)) throw new Error('总结内容过短或包含工具调用，原上下文保持不变。');
  const summaryTokens = estimateTokens({ role: 'user', parts: [{ text }] });
  const suffixTokens = source.reduce((total, message) => total + (consumedMessageIds.has(message.id!) ? 0 : estimateTokens(message)), 0);
  const retentionBudget = Math.max(0, (options.retainedUserTokenBudget ?? options.maxHistoryTokens) - suffixTokens - summaryTokens);
  const candidate = new CapturedContext(frame.state);
  candidate.dirty = frame.dirty;
  candidate.historyReplaced = frame.historyReplaced;
  for (const [index, message] of frame.messageUpdates) candidate.messageUpdates.set(index, message);
  candidate.appendMessages.push(...frame.appendMessages);
  const result = await applyContextBoundary(candidate, text, 'summary', automatic, config.type, policy,
    automatic ? 'threshold' : 'manual', { ...options, consumedMessageIds, retainedUserTokenBudget: retentionBudget, estimateTokens });
  const summary = candidate.state.history.messages[result.insertIndex];
  summary.longMemoryInputIds = selected.filter(message => message.id && !message.memoryContext && !message.memoryRedacted)
    .map(message => message.id!);
  // 注入的记忆块没有存档消息节点，摘要必须直接继承它使用的记忆，才能在后续遗忘时一起清理。
  const memoryDependencies = new Map<string, MemoryRecordReference>();
  for (const message of selected) {
    if (message.memoryRedacted) continue;
    for (const reference of memoryReferences(message)) {
      const key = JSON.stringify([reference.scopeId, reference.id]);
      if ((memoryDependencies.get(key)?.version ?? 0) <= reference.version) memoryDependencies.set(key, reference);
    }
  }
  if (memoryDependencies.size) summary.longMemoryReferences = [...memoryDependencies.values()];
  result.consumedMessageIds = [...consumedMessageIds];
  result.sourceTokens = fitted.estimatedTokens;
  result.resultTokens = summaryTokens;
  await options.validateCandidate?.(candidate, result);
  signal.throwIfAborted();
  frame.adopt(candidate);
  return result;
}
