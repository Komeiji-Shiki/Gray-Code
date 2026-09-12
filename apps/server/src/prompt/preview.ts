import { randomUUID } from 'node:crypto';
import type { ConversationState, PlatformConversation } from '@graycode/contracts';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import type { Content } from '../../../../backend/modules/conversation/types';
import { withDependencyRuntime } from '../../../../backend/modules/dependencies/runtime';
import type { CharacterTurn } from '../characters/pipeline';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import type { ProductSettingsDraft } from '../settings/product';
import { chatRunInput, chatUserMessage } from '../transport/chatInput';

/** 当前草稿的完整请求投影，不创建对话、不消耗模型额度。 */
export async function previewPrompt(app: PlatformApplication, client: ClientSession, data: Record<string, any>, preferences: ProductSettingsDraft,
  workspaceId?: string, mode: 'chat' | 'code' | 'character' = 'chat') {
  if (!data.configId) throw new Error('请选择渠道和模型。');
  const now = Date.now();
  const conversation: PlatformConversation = data.conversationId ? await app.conversation(client.actorId, data.conversationId)
    : { id: `prompt-preview-${randomUUID()}`, actorId: client.actorId, title: '', createdAt: now, updatedAt: now, workspaceId,
      custom: { platformMode: mode } };
  const state: ConversationState | undefined = data.conversationId ? undefined : { metadata: conversation, metadataToken: '', records: [],
    history: { conversationId: conversation.id, messages: [], total: 0, startIndex: 0, revision: 0 } };
  const request = { ...chatRunInput(client, data, preferences, conversation, `prompt-preview:${randomUUID()}`), message: chatUserMessage(data) };
  const prepared = await app.runtime.preview(request, state ? { state, commit: {} } : undefined, { clientId: client.clientId });
  const projected = await withDependencyRuntime(app.dependencies, () => app.modelAdapter.preview(prepared.input));
  const turn = prepared.input.turnContext?.characterTurn as CharacterTurn | undefined;
  const estimator = new MessageTokenEstimator();
  const input = prepared.input;
  const fixed = [input.systemPrompt, JSON.stringify(input.tools), input.promptContext?.taskContextEmbedded ? '' : JSON.stringify(input.taskContext)].filter(Boolean).join('\n');
  const textTokens = [...input.messages, ...input.promptContext?.beforeHistoryMessages ?? [], ...input.promptContext?.afterHistoryMessages ?? [],
    { role: 'user', parts: [{ text: fixed }] }].reduce((sum, message) => sum + estimator.estimateMessageTokens(message as Content), 0);
  const notices = [...prepared.notices];
  if (!data.conversationId && !workspaceId) notices.push('当前还没有保存对话，发送时自动创建的会话目录会补充到工作区信息中。');
  if (turn) notices.push('角色和世界书按当前输入重新激活；含概率或时效条件的条目，在正式发送时可能变化。');
  return { ...projected, createdAt: now, estimatedTokens: textTokens, notices,
    ...(turn ? { character: { resources: turn.resources, activation: turn.activation } } : {}) };
}
