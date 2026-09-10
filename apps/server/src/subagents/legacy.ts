import { createHash, randomUUID } from 'node:crypto';
import type { PlatformMessage, RecordMutation } from '@graycode/contracts';
import type { Content } from '../../../../backend/modules/conversation/types';
import { truncateFrom } from '../../../../backend/modules/conversation/TranscriptMutation';
import { buildLastSentHistoryProjection, restoreLastSentHistory } from '../../../../backend/tools/subagents/eventBus/transcript';
import { ensureSubAgentTranscriptTracking, getSubAgentSummaryCoverage, getSubAgentTranscriptIndex } from '../../../../backend/tools/subagents/executor/historyMetadata';
import type { PlatformApplication } from '../application';
import { configuredAgent } from '../settings/agent';
import { createSubagentRecord } from './profile';
import { legacySubagentSnapshot, readLegacySubagent } from './legacySource';
import type { PlatformSubagent, SubagentLaunchContext } from './types';
import type { SubagentExecutionService } from './service';

type LegacySource = Awaited<ReturnType<typeof readLegacySubagent>>;
const linkNamespace = 'legacy-subagent-links';
const invocation = (content: Content) => content.role === 'user' && content.parts.length === 1 && typeof content.parts[0].text === 'string'
  && /^# SubAgent Invocation\n+## Agent System Prompt\n/.test(content.parts[0].text);

/** 只在明确接续或重试时转换为独立任务，旧记录继续作为原始历史查看。 */
export class LegacySubagents {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly app: PlatformApplication, private readonly agents: SubagentExecutionService) {}
  serialize<T>(conversationId: string, runId: string, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([conversationId, runId]);
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(key, result);
    void result.finally(() => { if (this.queues.get(key) === result) this.queues.delete(key); }).catch(() => {});
    return result;
  }
  async continue(runId: string, args: Record<string, unknown>, context: SubagentLaunchContext, depth: number): Promise<PlatformSubagent> {
    return this.serialize(context.conversationId, runId, async () => {
      const source = await readLegacySubagent(this.app, context.actorId, runId, context.conversationId);
      const record = await this.materialize(source, args, context, depth);
      if (this.agents.activeIds().includes(record.id)) throw new Error('此旧记录已经在独立核心中继续执行。');
      return record;
    });
  }

  private async materialize(source: LegacySource, args: Record<string, unknown>, context: SubagentLaunchContext, depth: number): Promise<PlatformSubagent> {
    const link = await this.app.storage.getRecord(linkNamespace, source.key) as { runId: string } | null;
    if (link) {
      const record = await this.agents.get(context.actorId, link.runId);
      if (!record || record.parentConversationId !== source.conversationId) throw new Error('旧运行的接续对应记录不可用，原始历史仍保留。');
      return record;
    }
    const snapshot = legacySubagentSnapshot(source.run, source.conversationId, source.transcript);
    const name = snapshot.agentName?.trim() || args.agentName;
    if (typeof name !== 'string' || !name) throw new Error('旧记录缺少代理名称，请通过主任务明确选择后继续。');
    const record = createSubagentRecord(this.app, { ...args, agentName: name }, context, depth);
    record.legacyOrigin = { conversationId: source.conversationId, runId: source.run.runId };
    // 转换成功尚不等于开始执行；中途退出时不把旧终态当成新后台任务完成。
    record.status = 'interrupted'; record.background = false;
    const history = this.initialHistory(source);
    const messages = this.nativeHistory(record.id, history);
    record.contentCount = messages.length + 1;
    const records: RecordMutation[] = [{ namespace: linkNamespace, id: source.key, ownerId: source.conversationId,
      expectedRevision: null, value: { runId: record.id } }];
    await this.agents.adopt(record, messages, records);
    return record;
  }

  private initialHistory(source: LegacySource): Content[] {
    const contents = source.transcript?.contents ?? source.run.contents ?? [];
    const restored = this.savedHistory(source);
    if (!restored) return this.transcriptPrefix(source, contents.length);
    // 最后一次模型请求之后的回答和工具结果同样属于已经完成的历史。
    const lastIndex = Math.max(-1, ...restored.flatMap(content => {
      const index = getSubAgentTranscriptIndex(content); const coverage = getSubAgentSummaryCoverage(content);
      return [...(index === undefined ? [] : [index]), ...(coverage ? [coverage.sourceEndIndex - 1] : [])];
    }));
    const tail = lastIndex >= 0 ? contents.slice(lastIndex + 1)
      : restored.length && restored.every(content => content.role === 'user' && !content.parts.some(part => part.functionResponse)) ? contents : [];
    return [...restored, ...tail].filter(content => !invocation(content));
  }

  private savedHistory(source: LegacySource): Content[] | undefined {
    const contents = source.transcript?.contents ?? source.run.contents ?? [];
    const saved = source.transcript ? restoreLastSentHistory(source.transcript) ?? source.run.lastSentHistory : source.run.lastSentHistory;
    if (source.transcript?.lastSentHistoryProjection && !saved) throw new Error('旧模型历史的索引引用不完整，请先修复或重新迁入该记录。');
    return saved ? restoreLastSentHistory({ contents, lastSentHistoryProjection: buildLastSentHistoryProjection(contents, saved.map(ensureSubAgentTranscriptTracking)) }) : undefined;
  }

  private transcriptPrefix(source: LegacySource, end: number): Content[] {
    const contents = source.transcript?.contents ?? source.run.contents ?? [];
    const saved = this.savedHistory(source) ?? [];
    const calls = source.state.history.messages.flatMap(message => message.parts).flatMap(part => {
      const call = part.functionCall as { id?: string; name: string; args?: Record<string, unknown> } | undefined;
      if (call?.name !== 'subagents' || typeof call.args?.prompt !== 'string') return [];
      const allocated = call.id ? `subagent_run_${call.id.trim().replace(/[^A-Za-z0-9_-]/g, '_')}` : undefined;
      return call.args.continueFromRunId === source.run.runId || allocated === source.run.runId ? [call.args] : [];
    });
    let invocationIndex = 0;
    return truncateFrom(contents, end).flatMap((content, index) => {
      if (!invocation(content)) return [content];
      // 原调用说明只用于显示；真正输入在 provider 历史中指向同一 transcriptIndex。
      const mapped = saved.find(item => getSubAgentTranscriptIndex(item) === index && item.role === 'user' && !invocation(item));
      const args = calls[invocationIndex++];
      if (mapped) return [mapped];
      if (!args) return [];
      const text = args.context ? `Context:\n${args.context}\n\nTask:\n${args.prompt}` : String(args.prompt);
      return [{ role: 'user', parts: [{ text }], isUserInput: true, timestamp: content.timestamp } as Content];
    });
  }

  private nativeHistory(runId: string, contents: Content[]): PlatformMessage[] {
    const messages: PlatformMessage[] = [];
    const pending = new Map<string, { id: string; name: string }>();
    for (const [index, content] of contents.entries()) {
      if (invocation(content)) continue;
      const id = createHash('sha256').update(JSON.stringify([runId, index, content.id, content.role, content.parts])).digest('hex');
      messages.push({ ...structuredClone(content), parts: content.parts.map(part => ({ ...structuredClone(part) })), id, parentId: messages.at(-1)?.id ?? null,
        ...(content.id ? { legacyMessageId: content.id } : {}), isFunctionResponse: content.parts.some(part => !!part.functionResponse) || content.isFunctionResponse });
      for (const part of content.parts) {
        if (part.functionCall?.id) pending.set(part.functionCall.id, { id: part.functionCall.id, name: part.functionCall.name });
        if (part.functionResponse?.id) pending.delete(part.functionResponse.id);
      }
    }
    // 只结算中断留下的未配对调用，绝不执行旧工具或声称其副作用没有发生。
    for (const call of pending.values()) messages.push({ id: randomUUID(), parentId: messages.at(-1)?.id ?? null, role: 'user', isFunctionResponse: true,
      parts: [{ functionResponse: { id: call.id, name: call.name, response: { success: false, code: 'INTERRUPTED', error: '旧运行在工具结果保存前结束；实际副作用未知，本次接续不会自动重放该调用。' } } }] });
    return messages;
  }

  private async manualContext(actorId: string, source: LegacySource): Promise<SubagentLaunchContext> {
    this.app.requireOwner(actorId);
    const appSettings = this.app.settings.snapshot().settings;
    const preferences = this.app.product.runtimeSettings();
    const custom = source.state.metadata.custom as Record<string, any> | undefined;
    const selected = custom?.inputModelConfig as { configId?: string; modelId?: string } | undefined;
    const provider = appSettings.providers.find(item => item.id === selected?.configId);
    if (!provider || !(selected?.modelId?.trim() || provider.model?.trim())) throw new Error('旧记录未保存完整执行配置，请先在所属主对话选择渠道和模型，再重试。');
    const base = appSettings.agents[0]; if (!base) throw new Error('请先配置主 Agent。');
    const agent = configuredAgent(this.app, base);
    const profile = appSettings.modeProfiles?.[custom?.platformMode as 'chat' | 'code' | 'character'];
    const promptModeId = custom?.promptModeConfig?.modeId ?? profile?.promptModeId ?? agent.promptModeId;
    const mode = preferences.resolvePromptMode(promptModeId);
    agent.toolNames = agent.toolNames.filter(name => (!mode.toolPolicy || mode.toolPolicy.includes(name)) && (!profile?.toolNames || profile.toolNames.includes(name)));
    const workspaceId = source.state.metadata.workspaceId;
    const workspace = typeof workspaceId === 'string' ? this.app.workspace(actorId, workspaceId, []) : undefined;
    const modelSelection = { providerId: provider.id, modelOverride: selected?.modelId || undefined };
    return { actorId, conversationId: source.conversationId, agent, modelSelection, workspace,
      parentConfiguration: { agentId: agent.id, configuration: { ...modelSelection, promptModeId: mode.id, workspace: workspace ?? null } } };
  }

  async retry(actorId: string, runId: string, conversationId: string | undefined, index: number, messageId?: string, revision?: number) {
    const source = await readLegacySubagent(this.app, actorId, runId, conversationId);
    return this.serialize(source.conversationId, runId, async () => {
      const current = await readLegacySubagent(this.app, actorId, runId, source.conversationId);
      const snapshot = legacySubagentSnapshot(current.run, current.conversationId, current.transcript);
      const target = snapshot.contents[index];
      if (!Number.isSafeInteger(index) || !target || invocation(target) || messageId && messageId !== (target.id ?? `${runId}_${index}`)
        || revision !== undefined && revision !== snapshot.contentRevision) throw new Error('旧子代理消息已变化，或选中了调用说明，请刷新后重试。');
      const prefix = this.transcriptPrefix(current, index);
      if (!prefix.length) throw new Error('此位置之前没有真实输入，请从后续模型回复重试。');
      const context = await this.manualContext(actorId, current);
      const record = await this.materialize(current, { agentName: snapshot.agentName, background: true, prompt: '从所选历史位置重试' }, context, 1);
      if (this.agents.activeIds().includes(record.id)) throw new Error('请先停止已经接续的子代理，再重试旧记录。');
      await this.agents.retryLegacy(record, this.nativeHistory(record.id, prefix), context);
      return this.agents.window(actorId, record.id);
    });
  }
}
