import { randomUUID } from 'node:crypto';
import type { ModelInput, PlatformConversation, PlatformMessage, BotAutoSummarySettings } from '@graycode/contracts';
import type { Content } from '../../../../backend/modules/conversation/types';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import { isRealUserMessage } from '../../../../backend/modules/conversation/helpers';
import { repairParentChainAfterInsert } from '../../../../backend/modules/conversation/TranscriptMutation';
import { formatHistoryForAPI } from '../../../../backend/modules/conversation/manager/historyFormatting';
import { MessageBuilderService } from '../../../../backend/modules/api/chat/services/MessageBuilderService';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import { SummaryAlgorithms, MIN_SUMMARY_LENGTH } from '../../../../backend/modules/api/chat/services/SummaryAlgorithms';
import { DEFAULT_CONTEXT_MANAGEMENT_METHOD, type ContextManagementMethod } from '../../../../shared/contextManagement';
import { botProfile } from '../bots/config';
import type { CapturedBotEnvironment } from '../bots/prompt';
import { PlatformPromptService } from '../prompt/service';
import type { PlatformApplication } from '../application';
import type { CapturedContext } from './captured';

export type ModelPrefix = Pick<ModelInput, 'conversationId' | 'providerId' | 'modelOverride' | 'reasoningEffort' | 'systemPrompt' | 'tools' | 'promptContext' | 'taskContext' | 'turnContext'>;
export interface ContextBoundaryResult { summaryContent: Content; insertIndex: number; removedCount: number }

export function captureModelPrefix(input: ModelInput): ModelPrefix {
  return structuredClone({ conversationId: input.conversationId, providerId: input.providerId, modelOverride: input.modelOverride,
    reasoningEffort: input.reasoningEffort, systemPrompt: input.systemPrompt, tools: input.tools, promptContext: input.promptContext,
    taskContext: input.taskContext, turnContext: input.turnContext });
}

export function conversationContextSettings(app: PlatformApplication, conversation: PlatformConversation,
  automaticChannel?: Pick<ChannelConfig, 'autoSummarizeMethod'>): { method: ContextManagementMethod; bot?: BotAutoSummarySettings } {
  const environment = (conversation.custom as Record<string, unknown> | undefined)?.botEnvironment as CapturedBotEnvironment | undefined;
  const channel = environment?.version === 1 ? environment.channel : undefined;
  const bot = channel && typeof channel.channelId === 'string' ? botProfile(app.settings.snapshot().settings,
    channel.platform === 'discord' ? 'discord' : 'onebot', { channelId: channel.channelId, direct: channel.direct === true }).autoSummary : undefined;
  const automaticMethod = automaticChannel?.autoSummarizeMethod;
  if (automaticMethod !== undefined && automaticMethod !== 'summary' && automaticMethod !== 'notes') throw new Error('当前渠道的自动总结方式无效，请重新选择。');
  // 未传渠道时读取手动方式；Bot 的显式选择仍优先于渠道自动设置。
  return { method: bot?.method && bot.method !== 'time' ? bot.method
    : automaticMethod ?? app.product.runtimeSettings().getSummarizeConfig().method ?? DEFAULT_CONTEXT_MANAGEMENT_METHOD, bot };
}

/** 摘要边界以前仅保留首条真实用户消息，已经覆盖的历史仍在原存储中。 */
export function activeContextHistory(messages: PlatformMessage[], config: ChannelConfig): PlatformMessage[] {
  const first = messages.find(message => isRealUserMessage(message as Content));
  const last = messages.findLastIndex(message => message.isSummary && !message.isSummarized);
  const active = messages.filter((message, index) => !message.isSummarized && (last < 0 || index >= last || message === first));
  return formatHistoryForAPI(active as Content[], { ...new MessageBuilderService().buildHistoryOptions(config), includeTurnDynamicContext: true }) as PlatformMessage[];
}

/** 摘要和窗口切换共用可恢复边界，重复切换也只覆盖本次仍活跃的消息。 */
export async function applyContextBoundary(frame: CapturedContext, text: string, method: ContextManagementMethod, automatic: boolean, channelType: string): Promise<ContextBoundaryResult> {
  const full = frame.state.history.messages as Content[];
  const first = full.find(isRealUserMessage);
  const covered = full.filter(message => message !== first && !message.isSummarized);
  if (!covered.length) throw new Error('当前没有可替换的历史内容。');
  const ids = new Set(covered.map(message => message.id!));
  const algorithms = new SummaryAlgorithms(new MessageTokenEstimator());
  const summary: Content = { id: randomUUID(), role: 'user', parts: [{ text }], timestamp: Date.now(),
    parentId: full.at(-1)?.id ?? null, isSummary: true, isAutoSummary: automatic, contextMethod: method,
    contextWindowId: randomUUID(), summarizedMessageIds: [...ids],
    summarizedMessageCount: full.filter(message => message !== first && !message.isSummary).length,
    summaryTokenStats: algorithms.buildSummaryTokenStats({ fullHistory: full.filter(message => !message.isSummarized),
      messagesToSummarize: covered, summaryText: text, channelType }), index: full.length };
  if(method==='notes')(summary as PlatformMessage).longMemoryInputIds=[];
  const messages = structuredClone(full);
  for (const message of messages) if (ids.has(message.id!)) message.isSummarized = true;
  messages.push(summary);
  repairParentChainAfterInsert(messages, full.length, summary.parentId ?? null, summary.id!);
  frame.state.history.messages = messages.map((message, index) => ({ ...message, index })) as unknown as PlatformMessage[];
  frame.dirty = true; frame.historyReplaced = true;
  await frame.store.setCustomMetadata(frame.state.metadata.id, 'trimState', null);
  await frame.store.setCustomMetadata(frame.state.metadata.id, 'pendingContextWindow', null);
  await frame.store.setCustomMetadata(frame.state.metadata.id, 'contextReminderWindowId', null);
  return { summaryContent: summary, insertIndex: full.length, removedCount: covered.length };
}

export async function notesWindowBoundary(app: PlatformApplication, frame: CapturedContext, automatic: boolean, channelType: string): Promise<ContextBoundaryResult> {
  const id = frame.state.metadata.id;
  const names = (await app.storage.listRecords('context-notes', id)).map(key => JSON.parse(key)[1] as string);
  const latestUser = [...frame.state.history.messages].reverse().find(message => isRealUserMessage(message as Content));
  const text = [`A new context window has started for the same task. Earlier messages and tool results remain available through context_history.`,
    `Read working notes with context_notes before continuing. Available note names: ${names.length ? names.join(', ') : '(none yet; recover the current task from history)'}.`,
    latestUser ? `The latest real user message has ID ${latestUser.id}. Read it and any relevant preceding history to recover the current request and constraints.` : '',
    `This is a context transition, not a new user request or task completion. Continue the unfinished work.`].filter(Boolean).join('\n');
  return applyContextBoundary(frame, text, 'notes', automatic, channelType);
}

/** 老会话优先读取保存的请求；没有前缀快照时按原回合的提示词模式和动态快照恢复。 */
export async function manualSummaryPrefix(app: PlatformApplication, frame: CapturedContext, actorId: string, providerId: string, modelOverride?: string): Promise<ModelPrefix> {
  const custom = frame.state.metadata.custom as Record<string, unknown> | undefined;
  const stored = custom?.contextRequestPrefix as ModelPrefix | undefined;
  if (stored) return { ...structuredClone(stored), providerId, modelOverride: modelOverride ?? (stored.providerId === providerId ? stored.modelOverride : undefined) };
  const lastModel = [...frame.state.history.messages].reverse().find(message => message.role === 'model' && typeof message.runId === 'string');
  const run = lastModel ? await app.storage.getRun(lastModel.runId as string) : undefined;
  const saved = run ? await app.storage.getRecord('model-requests', `${run.id}:${run.iteration}`) as { prefix?: ModelPrefix } | null : undefined;
  if (saved?.prefix) return { ...structuredClone(saved.prefix), providerId, modelOverride: modelOverride ?? (saved.prefix.providerId === providerId ? saved.prefix.modelOverride : undefined) };
  const agent = app.settings.snapshot().settings.agents.find(item => item.id === run?.agentId) ?? app.settings.snapshot().settings.agents[0];
  const actor = app.actor(run?.actorId ?? actorId);
  if (!agent || !actor) throw new Error('无法恢复当前会话使用的模型前缀。');
  const previousTurn = [...frame.state.history.messages].reverse().find(message => isRealUserMessage(message as Content));
  const workspace = frame.state.metadata.workspaceId ? app.settings.snapshot().settings.workspaces.find(item => item.id === frame.state.metadata.workspaceId) : undefined;
  const prepared = await new PlatformPromptService(app).prepare({ agent, actor, workspace, conversation: frame.state.metadata,
    history: frame.state.history.messages, previousTurn, request: { actorId: actor.id, agentId: agent.id, conversationId: frame.state.metadata.id,
      requestKey: 'manual-summary', providerId, modelOverride, promptModeId: typeof previousTurn?.promptModeId === 'string' ? previousTurn.promptModeId : undefined,
      message: { id: randomUUID(), role: 'user', parts: [{ text: '' }] } } });
  return { conversationId: frame.state.metadata.id, providerId, modelOverride, systemPrompt: prepared.systemPrompt,
    promptContext: 'promptContext' in prepared ? prepared.promptContext : undefined, turnContext: 'turnContext' in prepared ? prepared.turnContext : undefined,
    taskContext: { actor: { id: actor.id, displayName: actor.displayName, role: actor.role }, workspace }, tools: app.tools.catalog(prepared.toolNames).declarations };
}

export async function summarizeFullContext(app: PlatformApplication, frame: CapturedContext, prefix: ModelPrefix, signal: AbortSignal, automatic: boolean): Promise<ContextBoundaryResult> {
  const config = await app.product.channel(prefix.providerId);
  if (!config?.enabled) throw new Error('当前会话的模型渠道不存在或已禁用。');
  const settings = app.product.runtimeSettings().getSummarizeConfig();
  const filtered = await app.longMemoryPrompt.history.prepare(prefix.taskContext?.actor.id??String(frame.state.metadata.actorId),frame.state.metadata.id,frame.state.history.messages);
  const source = activeContextHistory(filtered.messages, config);
  if (!source.some(message => message.role === 'model' || message.parts.some(part => part.functionResponse))) throw new Error('当前没有可总结的助手回复或工具结果。');
  const prompt = [(automatic ? settings.autoSummarizePrompt : settings.summarizePrompt).trim(),
    '现在暂停处理任务，仅总结上面的完整对话。保留最新用户要求、所有仍生效的约束、关键事实、已经完成和未完成的工作，以及继续所需的准确路径和标识。',
    '你的总结将替换除首条用户消息之外的全部上下文。直接输出可用于继续任务的总结正文，不调用工具，不把总结请求当作新的任务。'].join('\n\n');
  // 总结指令不构成真实用户回合，避免动态提示词和思考过滤向后移动而破坏原前缀。
  const response = await app.models.generate({ ...prefix, purpose: 'summary', signal,
    messages: [...source, { role: 'user', contextControl: 'summary_request', parts: [{ text: prompt }] }] });
  signal.throwIfAborted();
  const text = response.parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n').trim();
  if (text.length < MIN_SUMMARY_LENGTH || response.parts.some(part => part.functionCall)) throw new Error('总结内容过短或包含工具调用，原上下文保持不变。');
  const result=await applyContextBoundary(frame, text, 'summary', automatic, config.type);
  const summary=frame.state.history.messages.find(message=>message.id===result.summaryContent.id)!;
  summary.longMemoryInputIds=source.filter(message=>!message.memoryRedacted).map(message=>message.id!);
  return result;
}
