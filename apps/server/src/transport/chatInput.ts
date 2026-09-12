import { randomUUID } from 'node:crypto';
import type { PlatformConversation, PlatformMessage } from '@graycode/contracts';
import { MessageBuilderService } from '../../../../backend/modules/api/chat/services/MessageBuilderService';
import type { ProductSettingsDraft } from '../settings/product';
import type { ClientSession } from './router';

/** 输入栏的发送与预览共用正文、附件和会话级模型选择。 */
export function chatUserMessage(data: Record<string, any>, text = data.message): PlatformMessage {
  for (const attachment of data.attachments ?? []) {
    if (typeof attachment.data !== 'string' || typeof attachment.mimeType !== 'string') throw new Error('附件内容无效。');
  }
  return { id: data.messageId || randomUUID(), role: 'user',
    parts: new MessageBuilderService().buildUserMessageParts(text ? String(text) : '', data.attachments).map(part => ({ ...part })),
    ...(typeof data.deepSeekVisionTileSplit === 'boolean' ? { deepSeekVisionTileSplit: data.deepSeekVisionTileSplit } : {}) };
}

export function chatRunInput(client: ClientSession, data: Record<string, any>, preferences: ProductSettingsDraft, conversation: PlatformConversation, requestKey: string) {
  const selection = (conversation.custom as Record<string, any> | undefined)?.inputModelConfig;
  const selectedEffort = selection && selection.configId === data.configId && (!data.modelOverride || selection.modelId === data.modelOverride)
    && typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : undefined;
  return { requestKey, actorId: client.actorId, conversationId: conversation.id, workspaceId: conversation.workspaceId as string | undefined,
    agentId: preferences.app.agents[0]?.id ?? 'default', providerId: data.configId, modelOverride: data.modelOverride,
    reasoningEffort: data.reasoningEffort ?? selectedEffort, promptModeId: data.promptModeId };
}
