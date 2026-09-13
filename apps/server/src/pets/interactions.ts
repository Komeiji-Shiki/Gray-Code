import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';

/** 桌宠仅增加一个交互入口，对话、审批与问题继续由原有运行器持有。 */
export async function petInteraction(app: PlatformApplication, client: ClientSession, method: string, input: Record<string, any>) {
  app.requireOwner(client.actorId);
  if (method === 'pets.chat.create') return app.createConversation(client.actorId, '陪伴对话', undefined, { platformMode: 'chat' }, [], { automaticWorkspace: true });
  if (method === 'pets.chat.send') {
    const conversation = await app.conversation(client.actorId, input.conversationId);
    if (conversation.actorId !== client.actorId || (conversation.custom as any)?.platformMode !== 'chat') throw new Error('请选择自己的普通对话。');
    if (typeof input.message !== 'string' || !input.message.trim() || typeof input.streamId !== 'string') throw new Error('请输入消息。');
    return app.productUi.call(client, 'chatStream', { conversationId: conversation.id, configId: input.configId, modelOverride: input.modelOverride,
      streamId: input.streamId, message: input.message, attachments: input.attachments });
  }
  if (method !== 'pets.inbox') throw new Error('未知桌宠交互操作。');
  const conversations = (await Promise.all((await app.storage.listConversations({ limit: 80 })).items.map(item => app.storage.getConversation(item.id))))
    .filter(item => item?.actorId === client.actorId && (item.custom as any)?.platformMode === 'chat');
  const runs = await app.storage.listRuns({ limit: 30 });
  const approvals = app.runtime.pendingApprovals(), questions = app.runtime.pendingQuestions();
  for (const pending of [...approvals, ...questions]) if (!runs.some(run => run.id === pending.runId)) { const run = await app.storage.getRun(pending.runId); if (run) runs.push(run); }
  const titles = Object.fromEntries(await Promise.all([...new Set(runs.map(run => run.conversationId))].map(async id => [id, (await app.storage.getConversation(id))?.title ?? id])));
  const candidate = input.conversationId ? await app.storage.getConversation(input.conversationId) : undefined;
  if (candidate && candidate.actorId !== client.actorId) throw new Error('请选择自己的普通对话。');
  const selected = (candidate?.custom as any)?.platformMode === 'chat' ? candidate : undefined;
  const history = selected ? (await app.storage.readHistory(selected.id, { limit: 12 })).messages : [];
  return { conversations: conversations.map(item => ({ id: item!.id, title: item!.title })),
    selectedConversationId: selected?.id, selection: (selected?.custom as any)?.inputModelConfig,
    providers: app.settings.snapshot().settings.providers.map(provider => ({ id: provider.id, name: provider.name, model: provider.model, models: provider.models })),
    history: history.map(message => ({ id: message.id, role: message.role, text: message.parts.filter(part => !part.thought).map(part => part.text ?? '').join('').slice(0, 12000) })).filter(message => message.text),
    runs: runs.map(run => ({ ...run, title: titles[run.conversationId] })), approvals, questions };
}
