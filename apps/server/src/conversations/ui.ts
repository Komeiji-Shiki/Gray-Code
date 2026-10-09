import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { chatUserMessage } from '../transport/chatInput';
import { USER_INTERRUPT_MIN_INTERVAL_MS, AGENT_INBOX_MAX_MESSAGES } from '../../../../backend/core/services/agentMailbox';
import type { PendingUserInput } from '@graycode/contracts';
import type { PendingFeedback } from '../subagents/feedback';
import { PUSH_MESSAGE_NAMES } from '../../../../shared/protocol';

interface InterruptReceipt { success: true; queued: true; messageId: string; runId: string }
interface SavedInterruptReceipt { fingerprint: string; receipt: InterruptReceipt; withdrawn?: boolean }
const interruptQueues = new WeakMap<PlatformApplication, Map<string, Promise<unknown>>>();

function inputFingerprint(message: PendingFeedback['message']): string {
  return createHash('sha256').update(JSON.stringify({ parts: message.parts, deepSeekVisionTileSplit: message.deepSeekVisionTileSplit })).digest('hex');
}

function notifyPendingUserInputs(app: PlatformApplication, conversationId: string): void {
  app.publish({ type: 'ui.message', message: { type: PUSH_MESSAGE_NAMES.command,
    command: PUSH_MESSAGE_NAMES['chat.pendingUserInputsChanged'], data: { conversationId } } });
}

async function pendingUserInputs(app: PlatformApplication, client: ClientSession, conversationId: string): Promise<PendingUserInput[]> {
  app.requireOwner(client.actorId); await app.conversation(client.actorId, conversationId);
  return app.subagents.feedback.serialize(conversationId, async () => {
    const values: Array<{ input: PendingUserInput; sequence: number }> = [];
    for (const id of await app.subagents.feedback.pendingIds(conversationId)) {
      const record = await app.storage.getVersionedRecord('subagent-feedback', id);
      const value = record.value as PendingFeedback | null;
      if (!value || value.actorId !== client.actorId || value.message.source !== 'user' || value.modelReceived) continue;
      values.push({ input: { id, conversationId, revision: record.revision!, message: value.message }, sequence: value.sequence ?? 0 });
    }
    return values.sort((a, b) => a.sequence - b.sequence).map(value => value.input);
  });
}

async function changePendingUserInput(app: PlatformApplication, client: ClientSession, data: Record<string, any>, withdraw: boolean) {
  app.requireOwner(client.actorId); await app.conversation(client.actorId, data.conversationId);
  if (typeof data.id !== 'string' || !Number.isSafeInteger(data.revision)) throw new Error('待处理消息标识或版本无效。');
  if (!withdraw && (typeof data.text !== 'string' || data.attachments !== undefined && !Array.isArray(data.attachments)
    || !data.text.trim() && !data.attachments?.length)) throw new Error('请输入消息或添加附件。');
  // 原生连接的接收决定先完成，再与本地模型边界争用同一交付队列。
  await serializeInterrupt(app, data.conversationId, () => app.subagents.feedback.serialize(data.conversationId, async () => {
    const record = await app.storage.getVersionedRecord('subagent-feedback', data.id);
    const value = record.value as PendingFeedback | null;
    if (!value || value.conversationId !== data.conversationId || value.actorId !== client.actorId
      || value.message.source !== 'user' || value.modelReceived) throw new Error('消息已经交付，无法再修改或撤回。');
    if (record.revision !== data.revision) throw new Error('消息已在其他窗口修改，请重新打开后再编辑。');
    const saved = await app.storage.getVersionedRecord('user-interrupt-receipts', data.id);
    const receipt = saved.value as SavedInterruptReceipt | null;
    if (!receipt || receipt.withdrawn) throw new Error('待处理消息已撤回。');
    const message = withdraw ? value.message : { ...value.message, ...chatUserMessage({ ...data, messageId: value.id }, data.text),
      ...(data.deepSeekVisionTileSplit === undefined ? { deepSeekVisionTileSplit: value.message.deepSeekVisionTileSplit } : {}) };
    await app.storage.commitRecords([
      withdraw ? { namespace: 'subagent-feedback', id: value.id, expectedRevision: record.revision, delete: true }
        : { namespace: 'subagent-feedback', id: value.id, ownerId: data.conversationId, expectedRevision: record.revision, value: { ...value, message } },
      { namespace: 'user-interrupt-receipts', id: value.id, ownerId: data.conversationId, expectedRevision: saved.revision,
        value: { ...receipt, ...(withdraw ? { withdrawn: true } : { fingerprint: inputFingerprint(message) }) } },
    ]);
  }));
  notifyPendingUserInputs(app, data.conversationId);
  return { success: true };
}

/** 同一会话的重试先查持久回执，再检查频率；两窗口不能把同一输入各保存一次。 */
function serializeInterrupt<T>(app: PlatformApplication, conversationId: string, operation: () => Promise<T>): Promise<T> {
  let queues = interruptQueues.get(app);
  if (!queues) { queues = new Map(); interruptQueues.set(app, queues); }
  const next = (queues.get(conversationId) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(conversationId, next);
  void next.finally(() => { if (queues.get(conversationId) === next) queues.delete(conversationId); }).catch(() => {});
  return next;
}

/** 模型边界等待已开始的用户入队事务，不等待审批，也不提前写入飞行中请求的历史。 */
export async function settlePendingUserInput(app: PlatformApplication, conversationId: string): Promise<void> {
  for (;;) {
    const pending = interruptQueues.get(app)?.get(conversationId);
    if (!pending) return;
    await pending.catch(() => {}); // 接收失败由原请求报告，不能把它变成模型运行失败。
  }
}

async function sendInterruptMessage(app: PlatformApplication, client: ClientSession, data: Record<string, any>) {
  app.requireOwner(client.actorId); await app.conversation(client.actorId, data.conversationId);
  if (typeof data.text !== 'string') throw new Error('输入正文必须是文本。');
  const text = data.text;
  if (data.attachments !== undefined && !Array.isArray(data.attachments)) throw new Error('附件内容无效。');
  if (!text.trim() && !data.attachments?.length) throw new Error('请输入消息或添加附件。');
  if (data.messageId !== undefined && (typeof data.messageId !== 'string' || !data.messageId)) throw new Error('输入请求标识无效。');
  const input = chatUserMessage(data, text);
  const id = `interrupt-${createHash('sha256').update(JSON.stringify([data.conversationId, client.actorId, data.messageId ?? randomUUID()])).digest('hex')}`;
  const fingerprint = inputFingerprint(input);
  const result = await serializeInterrupt(app, data.conversationId, async () => {
    const saved = await app.storage.getRecord('user-interrupt-receipts', id) as SavedInterruptReceipt | null;
    if (saved) {
      if (saved.withdrawn) return { success: false, error: { code: 'INTERRUPT_WITHDRAWN', message: '这条追加消息已撤回。' } };
      if (saved.fingerprint !== fingerprint) throw new Error('同一输入请求不能改写已保存的消息。');
      return saved.receipt;
    }
    const run = (await app.storage.listRuns({ conversationId: data.conversationId, activeOnly: true, limit: 1 }))[0];
    if (!run) return { success: false, error: { code: 'INTERRUPT_NO_ACTIVE_RUN', message: '当前任务已经结束，请直接发送。' } };
    const rate = await app.storage.getVersionedRecord('user-interrupt-rate', data.conversationId);
    const lastAt = Number((rate.value as { timestamp?: number } | null)?.timestamp ?? 0);
    if (Date.now() - lastAt < USER_INTERRUPT_MIN_INTERVAL_MS) throw new Error('追加消息过于频繁，请稍后再发。');
    if ((await app.storage.listRecords('subagent-feedback', data.conversationId)).length >= AGENT_INBOX_MAX_MESSAGES) throw new Error('待处理消息已达到上限，请等待当前任务处理。');
    const timestamp = Date.now();
    const receipt: InterruptReceipt = { success: true, queued: true, messageId: id, runId: run.id };
    // 与普通发送共用 parts 构建。消息和回执一起保存，历史在模型边界交付；原生连接额外接收 steering。
    await app.subagents.feedback.enqueueMessages([{ id, conversationId: data.conversationId, actorId: client.actorId, sourceRunId: run.id,
      message: { ...input, id, timestamp, source: 'user', actorId: client.actorId, isUserInput: true, userFeedback: { kind: 'interrupt' } } }], [
      { namespace: 'user-interrupt-rate', id: data.conversationId, ownerId: data.conversationId, expectedRevision: rate.revision, value: { timestamp } },
      { namespace: 'user-interrupt-receipts', id, ownerId: data.conversationId, expectedRevision: null, value: { fingerprint, receipt } },
    ]);
    notifyPendingUserInputs(app, data.conversationId);
    // 先持久接收，再尝试原生 steering。边界等待此决定，避免本地交付与上游接收重复。
    let modelReceived = false;
    try { modelReceived = await app.models.steer?.(run.id, { ...input, id, timestamp }) ?? false; }
    catch (error) {
      // 发送结果不确定时不能宣称撤回成功；已保存的正文继续保留到本地交付。
      modelReceived = true;
      app.publish({ type: 'notification', severity: 'error', message: `用户输入已保存，原生连接未能确认接收：${String(error)}` });
    }
    if (modelReceived) {
      await app.subagents.feedback.serialize(data.conversationId, async () => {
        const record = await app.storage.getVersionedRecord('subagent-feedback', id);
        if (record.value) await app.storage.commitRecords([{ namespace: 'subagent-feedback', id, ownerId: data.conversationId,
          expectedRevision: record.revision, value: { ...record.value as PendingFeedback, modelReceived: true } }]);
      });
      notifyPendingUserInputs(app, data.conversationId);
    }
    return receipt;
  });
  // 入队事务先释放边界等待，再尝试空闲交付；不能让两者相互等待。
  if (result.success) {
    try { await app.subagents.feedback.flush(data.conversationId); }
    catch (error) {
      // 持久接收已成功，交付失败不能返回“未发送”让前端以新身份再发一份。
      app.publish({ type: 'notification', severity: 'error', message: `用户输入已保存，等待后续交付：${String(error)}` });
    }
  }
  return result;
}

export function conversationUiHandlers(app: PlatformApplication, client: ClientSession) {
  return {
    'conversation.loadConversationForView': async (data: Record<string, any>) => {
      await app.conversation(client.actorId, data.conversationId);
      const deferCheckpoints = data.deferCheckpoints === true;
      const [metadata, result, checkpoints] = await Promise.all([
        app.productUi.conversations.getMetadata(data.conversationId),
        app.productUi.conversations.getMessagesPaged(data.conversationId, { beforeIndex: data.beforeIndex, offset: data.offset, limit: data.limit }),
        deferCheckpoints ? { checkpoints: [] } : app.checkpoints.summaries(client.actorId, data.conversationId),
      ]);
      const custom = metadata?.custom ?? {};
      return { metadata, messages: result.messages, totalMessages: result.total, checkpoints: checkpoints.checkpoints,
        ...(deferCheckpoints ? { checkpointsDeferred: true } : {}),
        modelConfig: custom.inputModelConfig, promptMode: custom.promptModeConfig, activeBuild: custom.activeBuild ?? null };
    },
    'conversation.createBranchConversation': (data: Record<string, any>) => app.conversations.fork(client.actorId, data.sourceConversationId, data.branchAtIndex, data),
    'conversation.setWorkspaceUri': async (data: Record<string, any>) => {
      const state = await app.conversations.read(client.actorId, data.conversationId);
      const workspace = app.settings.read('workspaces').workspaces.find(item => pathToFileURL(item.directory).toString() === data.workspaceUri);
      if (!workspace) throw new Error('工作区尚未添加到独立平台。');
      app.workspace(client.actorId, workspace.id, ['workspace_read']);
      if (state.metadata.workspaceId && state.metadata.workspaceId !== workspace.id) throw new Error('此对话已绑定其他工作区，请新建代码对话。');
      await app.storage.commitConversation({ conversationId: data.conversationId, expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken,
        metadata: { ...state.metadata, workspaceId: workspace.id, workspaceUri: data.workspaceUri } });
      return { success: true };
    },
    'conversation.rejectToolCalls': (data: Record<string, any>) => app.conversations.settleCancelled(client.actorId, data.conversationId, data.messageIndex,
      Array.isArray(data.toolCallIds) ? data.toolCallIds.filter((id: unknown): id is string => typeof id === 'string') : []),
    'chat.awaitConversationIdle': async (data: Record<string, any>) => {
      await app.conversation(client.actorId, data.conversationId);
      const runs = await app.storage.listRuns({ conversationId: data.conversationId, activeOnly: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all(runs.map(run => app.runtime.wait(run.id))), new Promise(resolve => { timer = setTimeout(resolve, 10_000); })]); }
      finally { if (timer) clearTimeout(timer); }
      return { idle: !(await app.storage.listRuns({ conversationId: data.conversationId, activeOnly: true })).length };
    },
    'chat.sendInterruptMessage': (data: Record<string, any>) => sendInterruptMessage(app, client, data),
    'chat.pendingUserInputs': (data: Record<string, any>) => pendingUserInputs(app, client, data.conversationId),
    'chat.updatePendingUserInput': (data: Record<string, any>) => changePendingUserInput(app, client, data, false),
    'chat.withdrawPendingUserInput': (data: Record<string, any>) => changePendingUserInput(app, client, data, true),
  };
}
