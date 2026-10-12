import type { PetChatInput, PetChatResult, PetInbox, PetInteractionRequest, PlatformConversation } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { isChatConversation, requireOwnChatConversation } from '../conversations/ownChat';

export function createPetChat(app: PlatformApplication, client: ClientSession): Promise<PlatformConversation> {
  app.requireOwner(client.actorId);
  return app.createConversation(client.actorId, '陪伴对话', undefined, { platformMode: 'chat' }, [], { automaticWorkspace: true });
}

export async function sendPetChat(app: PlatformApplication, client: ClientSession, input: PetChatInput): Promise<PetChatResult> {
  const conversation = await requireOwnChatConversation(app, client.actorId, input.conversationId);
  if (!input.message.trim()) throw new Error('请输入消息。');
  return await app.productUi.call(client, 'chatStream', {
    conversationId: conversation.id,
    configId: input.configId,
    modelOverride: input.modelOverride,
    streamId: input.streamId,
    message: input.message,
    attachments: input.attachments,
  }) as PetChatResult;
}

export async function petInbox(app: PlatformApplication, client: ClientSession, input: { conversationId?: string }): Promise<PetInbox> {
  app.requireOwner(client.actorId);
  const candidate = input.conversationId ? await app.storage.getConversation(input.conversationId) : undefined;
  if (candidate && candidate.actorId !== client.actorId) throw new Error('请选择当前账号自己的普通对话。');
  // 收件箱仍需展示可用对话和草稿，原对话切换模式或被删除时只取消选中。
  const selected = candidate && isChatConversation(candidate) ? candidate : undefined;
  // 列表摘要已带归属账号与对话模式，不再逐个读取完整元数据。
  const recent = (await app.storage.listConversations({ limit: 80 })).items;
  const conversations = recent.filter(item => item.actorId === client.actorId && !item.botPlatform
    && (item.platformMode ?? 'chat') === 'chat');
  const runs = await app.storage.listRuns({ actorId: client.actorId, limit: 30 });
  const approvals = app.runtime.pendingApprovals().filter(item => item.actorId === client.actorId);
  const questions = app.runtime.pendingQuestions().filter(item => item.actorId === client.actorId);
  const missing = [...new Set([...approvals, ...questions].map(item => item.runId))].filter(id => !runs.some(run => run.id === id));
  const pendingRuns = await Promise.all(missing.map(id => app.storage.getRun(id)));
  for (const run of pendingRuns) if (run?.actorId === client.actorId) runs.push(run);
  // 任务标题优先取自已读取的列表，只有不在最近列表里的对话才单独读取。
  const titles = new Map(recent.map(item => [item.id, item.title ?? item.id]));
  await Promise.all([...new Set(runs.map(run => run.conversationId))].filter(id => !titles.has(id)).map(async id => {
    titles.set(id, (await app.storage.getConversation(id))?.title ?? id);
  }));
  const history = selected ? (await app.storage.readHistory(selected.id, { limit: 12 })).messages : [];
  const custom = selected?.custom as { inputModelConfig?: PetInbox['selection'] } | undefined;
  return {
    conversations: conversations.map(item => ({ id: item.id, title: item.title })),
    selectedConversationId: selected?.id,
    selection: custom?.inputModelConfig,
    providers: app.settings.read('providers').providers.map(provider => ({
      id: provider.id, name: provider.name, model: provider.model, models: provider.models,
    })),
    history: history.map(message => ({
      id: message.id,
      role: message.role,
      text: message.parts.filter(part => !part.thought && typeof part.text === 'string')
        .map(part => part.text).join('').slice(0, 12000),
    })).filter(message => message.text),
    runs: runs.map(run => ({ ...run, title: titles.get(run.conversationId) ?? run.conversationId })),
    approvals,
    questions,
  };
}

/** 旧统一入口在传输校验后分派；具体业务方法的参数与结果都有 contracts 类型。 */
export function petInteraction(app: PlatformApplication, client: ClientSession, method: string, input: unknown): Promise<unknown> {
  const request = { method, input } as PetInteractionRequest;
  switch (request.method) {
    case 'pets.chat.create': return createPetChat(app, client);
    case 'pets.chat.send': return sendPetChat(app, client, request.input);
    case 'pets.inbox': return petInbox(app, client, request.input);
    default: throw new Error('未知桌宠交互操作。');
  }
}
