import { createHash } from 'node:crypto';
import type { RunRecord, ToolOutcome } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { formatAgentMessagesForModel, incrementAgentThreadDepth, MAIN_AGENT_NAME, MAIN_SESSION_RUN_ID,
  prepareAgentMessage, type AgentSendMessageResult } from '../../../../backend/core/services/agentMessages';
import type { AgentMessageCardInfo } from '../../../../backend/modules/conversation/types';
import type { PlatformApplication } from '../application';
import type { SubagentExecutionService } from './service';
import type { PendingFeedback } from './feedback';
import type { PlatformSubagent } from './types';

interface SendReceipt { fingerprint: string; result: AgentSendMessageResult }
const textArgument = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const finished = (run: RunRecord) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);

/** 每个主对话串行接收并确认结束，消息与回执共用现有存储事务。 */
export class PlatformAgentMessages {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly app: PlatformApplication, private readonly agents: SubagentExecutionService) {}

  private serialize<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(conversationId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(conversationId, next);
    void next.finally(() => { if (this.queues.get(conversationId) === next) this.queues.delete(conversationId); }).catch(() => {});
    return next;
  }

  /** 正常结束前检查尚未领取的消息；失败和取消不因收到消息而自动重试。 */
  settle(record: PlatformSubagent, completed: boolean): Promise<boolean> {
    return this.serialize(this.agents.rootConversationId(record.conversationId), async () => {
      if (completed && this.agents.acceptsMessages(record.id) && (await this.agents.feedback.pendingIds(record.conversationId)).length) return true;
      this.agents.stopAcceptingMessages(record.id);
      return false;
    });
  }

  async send(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const run = await this.app.storage.getRun(context.runId);
    if (!run || run.actorId !== context.actorId || run.conversationId !== context.conversationId || !context.toolCallId)
      throw new Error('代理消息缺少经过认证的当前任务和工具调用。');
    await this.app.conversation(context.actorId, run.conversationId);
    const rootId = this.agents.rootConversationId(run.conversationId);
    await this.app.conversation(context.actorId, rootId);
    const sender = this.agents.recordForRun(run);
    if (this.agents.isChildConversation(run.conversationId) && !sender) throw new Error('此任务不属于当前子代理。');
    const normalized = { message: textArgument(args.message), targetRunId: textArgument(args.targetRunId),
      targetAgentName: textArgument(args.targetAgentName), threadId: textArgument(args.threadId) };
    const fingerprint = JSON.stringify(normalized);
    const receiptId = createHash('sha256').update(JSON.stringify([run.id, context.iteration ?? run.iteration, context.toolCallId])).digest('hex');
    const result = await this.serialize(rootId, async () => {
      const receipt = await this.app.storage.getRecord('agent-message-receipts', receiptId) as SendReceipt | null;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error('同一次工具调用不能改写已保存的代理消息。');
        return receipt.result;
      }
      context.signal.throwIfAborted();
      if (finished(run) || sender && !this.agents.acceptsMessages(sender.id)) throw new Error('发送任务已经结束。');
      const peers = this.agents.messageParticipants(context.actorId, rootId);
      const depthsRecord = await this.app.storage.getVersionedRecord('agent-message-threads', rootId);
      const depths = new Map(depthsRecord.value as Array<[string, number]> | null ?? []);
      const recipientId = normalized.targetRunId || (normalized.targetAgentName === MAIN_AGENT_NAME ? MAIN_SESSION_RUN_ID
        : peers.filter(peer => peer.agentName === normalized.targetAgentName).at(-1)?.id);
      const recipient = peers.find(peer => peer.id === recipientId);
      const recipientConversationId = recipient?.conversationId ?? rootId;
      if (recipient) await this.app.conversation(context.actorId, recipient.conversationId);
      const pendingCount = (await this.agents.feedback.pendingIds(recipientConversationId)).filter(id => id.startsWith('agentmsg-')).length;
      let changedDepth = false;
      const prepared = prepareAgentMessage({ conversationId: rootId, fromRunId: sender?.id ?? MAIN_SESSION_RUN_ID,
        fromAgentName: sender?.agentName ?? MAIN_AGENT_NAME, targetRunId: normalized.targetRunId, targetAgentName: normalized.targetAgentName,
        text: normalized.message, threadId: normalized.threadId }, {
        knownRuns: peers.map(peer => ({ runId: peer.id, agentName: peer.agentName })), pendingCount: () => pendingCount,
        nextHopDepth: threadId => { changedDepth = true; return incrementAgentThreadDepth(depths, threadId); },
      });
      const receiptResult: AgentSendMessageResult = prepared.success ? { success: true, data: prepared.data } : prepared;
      const pending: PendingFeedback[] = [];
      if (prepared.success) {
        const message = prepared.message;
        const id = `agentmsg-${message.id}`;
        const card: AgentMessageCardInfo = { messageId: message.id, fromRunId: message.fromRunId, fromAgentName: message.fromAgentName,
          toRunId: message.toRunId, toAgentName: recipient?.agentName ?? MAIN_AGENT_NAME, threadId: message.threadId, hopDepth: message.hopDepth,
          text: message.text, createdAt: message.createdAt };
        pending.push({ id, conversationId: recipientConversationId, actorId: context.actorId,
          sourceRunId: sender ? this.agents.rootParentRunId(sender) : run.id,
          parentConfiguration: sender ? this.agents.rootParentConfiguration(sender) : undefined,
          message: { id, role: 'user', parts: [{ text: formatAgentMessagesForModel([message]) }], timestamp: message.createdAt,
            actorId: context.actorId, isUserInput: false, source: 'agent_message', agentMessage: card } });
        if (recipient) {
          const cardId = `agentcard-${message.id}`;
          pending.push({ id: cardId, conversationId: rootId, actorId: context.actorId, displayOnly: true,
            message: { id: cardId, role: 'user', parts: [], timestamp: message.createdAt, isUserInput: false, source: 'agent_message', agentMessage: card } });
        }
      }
      await this.agents.feedback.enqueueMessages(pending, [
        { namespace: 'agent-message-receipts', id: receiptId, ownerId: rootId, value: { fingerprint, result: receiptResult } satisfies SendReceipt },
        ...(changedDepth ? [{ namespace: 'agent-message-threads', id: rootId, ownerId: rootId, expectedRevision: depthsRecord.revision, value: [...depths] }] : []),
      ]);
      return receiptResult;
    });
    if (result.success) {
      try {
        if (result.data.toRunId === MAIN_SESSION_RUN_ID && sender) await this.agents.detachToMain(sender);
        const recipient = this.agents.messageParticipants(context.actorId, rootId).find(peer => peer.id === result.data.toRunId);
        await this.agents.feedback.flush(recipient?.conversationId ?? rootId);
        if (recipient) await this.agents.feedback.flush(rootId);
      } catch (error) {
        // 保存已经完成，展示或即时唤醒失败不改变已接收回执，也不重复投递。
        this.app.publish({ type: 'notification', severity: 'error', message: `代理消息已保存，等待后续交付：${String(error)}` });
      }
    }
    return result;
  }
}
