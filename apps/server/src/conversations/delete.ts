import type { PlatformApplication } from '../application';

/** 界面的单个删除和项目清理共用同一条任务停止、子任务及历史清理路径。 */
export async function deleteConversation(app: PlatformApplication, actorId: string, conversationId: string): Promise<void> {
  app.requireOwner(actorId);
  await app.conversation(actorId, conversationId);
  const runs = await app.storage.listRuns({ conversationId, activeOnly: true });
  for (const run of runs) { await app.runtime.cancel(run.id, actorId); await app.runtime.wait(run.id); }
  await app.subagents.removeParent(actorId, conversationId);
  await app.productUi.conversations.deleteConversation(conversationId);
  app.publish({ type: 'conversation.changed', conversationId, deleted: true });
}
