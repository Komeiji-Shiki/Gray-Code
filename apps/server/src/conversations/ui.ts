import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { USER_INTERRUPT_MAX_LENGTH, USER_INTERRUPT_MIN_INTERVAL_MS, AGENT_INBOX_MAX_MESSAGES } from '../../../../backend/core/services/agentMailbox';

export function conversationUiHandlers(app: PlatformApplication, client: ClientSession) {
  return {
    'conversation.loadConversationForView': async (data: Record<string, any>) => {
      await app.conversation(client.actorId, data.conversationId);
      const [metadata, result, checkpoints] = await Promise.all([
        app.productUi.conversations.getMetadata(data.conversationId),
        app.productUi.conversations.getMessagesPaged(data.conversationId, { beforeIndex: data.beforeIndex, offset: data.offset, limit: data.limit }),
        app.checkpoints.summaries(client.actorId, data.conversationId),
      ]);
      const custom = metadata?.custom ?? {};
      return { metadata, messages: result.messages, totalMessages: result.total, checkpoints: checkpoints.checkpoints,
        modelConfig: custom.inputModelConfig, promptMode: custom.promptModeConfig, activeBuild: custom.activeBuild ?? null };
    },
    'conversation.createBranchConversation': (data: Record<string, any>) => app.conversations.fork(client.actorId, data.sourceConversationId, data.branchAtIndex, data),
    'conversation.setWorkspaceUri': async (data: Record<string, any>) => {
      const state = await app.conversations.read(client.actorId, data.conversationId);
      const workspace = app.settings.snapshot().settings.workspaces.find(item => pathToFileURL(item.directory).toString() === data.workspaceUri);
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
    'chat.sendInterruptMessage': async (data: Record<string, any>) => {
      app.requireOwner(client.actorId); await app.conversation(client.actorId, data.conversationId);
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text || text.length > USER_INTERRUPT_MAX_LENGTH) throw new Error(`追加消息需要 1 至 ${USER_INTERRUPT_MAX_LENGTH} 个字符。`);
      const run = (await app.storage.listRuns({ conversationId: data.conversationId, activeOnly: true, limit: 1 }))[0];
      if (!run) return { success: false, error: { code: 'CONVERSATION_IDLE', message: '当前任务已经结束，请直接发送。' } };
      const rate = await app.storage.getVersionedRecord('user-interrupt-rate', data.conversationId);
      const lastAt = Number((rate.value as { timestamp?: number } | null)?.timestamp ?? 0);
      if (Date.now() - lastAt < USER_INTERRUPT_MIN_INTERVAL_MS) throw new Error('追加消息过于频繁，请稍后再发。');
      if ((await app.storage.listRecords('subagent-feedback', data.conversationId)).length >= AGENT_INBOX_MAX_MESSAGES) throw new Error('待处理消息已达到上限，请等待当前任务处理。');
      const id = `interrupt-${randomUUID()}`; const timestamp = Date.now();
      await app.subagents.feedback.enqueueMessage({ id, conversationId: data.conversationId, actorId: client.actorId, sourceRunId: run.id,
        message: { id, role: 'user', parts: [{ text }], timestamp, actorId: client.actorId, isUserInput: true, userFeedback: { kind: 'interrupt' } } },
        [{ namespace: 'user-interrupt-rate', id: data.conversationId, ownerId: data.conversationId, expectedRevision: rate.revision, value: { timestamp } }]);
      return { success: true };
    },
  };
}
