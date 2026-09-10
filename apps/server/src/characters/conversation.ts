import type { CharacterChatConfig } from '@graycode/contracts';
import type { ClientSession } from '../transport/router';
import type { PlatformApplication } from '../application';

export async function characterConversation(app: PlatformApplication, client: ClientSession, type: string, data: Record<string, any>) {
  if (type === 'characters.conversation.get') {
    const state = await app.conversations.read(client.actorId, data.conversationId);
    return { config: (state.metadata.custom as Record<string, unknown> | undefined)?.characterConfig ?? null,
      metadataToken: state.metadataToken, mode: (state.metadata.custom as Record<string, unknown> | undefined)?.platformMode };
  }
  const config = data.config as CharacterChatConfig;
  if (!config || typeof config.userName !== 'string' || typeof config.persona !== 'string') throw new Error('请填写角色对话设置。');
  if (!Number.isSafeInteger(config.scanDepth) || config.scanDepth < 0) throw new Error('关键词扫描范围必须是非负整数。');
  if (config.worldTokenBudget !== undefined && (!Number.isSafeInteger(config.worldTokenBudget) || config.worldTokenBudget < 0)) throw new Error('世界书 Token 上限必须是非负整数。');
  if (config.recursiveScan !== undefined && typeof config.recursiveScan !== 'boolean') throw new Error('递归扫描设置无效。');
  if (config.maxRecursionSteps !== undefined && (!Number.isSafeInteger(config.maxRecursionSteps) || config.maxRecursionSteps < 0)) throw new Error('递归次数必须是非负整数。');
  await app.characters.validateBindings(config.worldbookIds, config.regexIds);
  if (config.characterId && (await app.characters.get(config.characterId)).resource.kind !== 'character') throw new Error('请选择角色卡。');
  const value: CharacterChatConfig = { kind: 'character', characterId: config.characterId, greetingIndex: config.greetingIndex,
    userName: config.userName, persona: config.persona, worldbookIds: config.worldbookIds, regexIds: config.regexIds,
    scanDepth: config.scanDepth, worldTokenBudget: config.worldTokenBudget, recursiveScan: config.recursiveScan, maxRecursionSteps: config.maxRecursionSteps };
  if (type === 'characters.conversation.create') {
    const settings = app.product.runtimeSettings();
    const preset = app.settings.snapshot().settings.modeProfiles?.character?.promptModeId ?? settings.getCurrentPromptModeId();
    const character = value.characterId ? (await app.characters.get(value.characterId)).resource : null;
    const greeting = await app.characterPipeline.greeting(value);
    const conversation = await app.createConversation(client.actorId, character?.name ?? '新角色对话', undefined,
      { platformMode: 'character', promptModeConfig: { modeId: preset }, characterConfig: value }, greeting ? [greeting] : undefined);
    return { conversationId: conversation.id };
  }
  if (type !== 'characters.conversation.save') throw new Error('未知角色会话操作。');
  const state = await app.conversations.read(client.actorId, data.conversationId);
  if ((state.metadata.custom as Record<string, unknown> | undefined)?.platformMode !== 'character')
    throw new Error('请新建角色对话，已有普通或代码对话保留原模式。');
  await app.storage.commitConversation({ conversationId: data.conversationId, expectedRevision: state.history.revision,
    expectedMetadataToken: data.metadataToken, metadata: { ...state.metadata, updatedAt: Date.now(),
      custom: { ...(state.metadata.custom as Record<string, unknown>), characterConfig: value } } });
  app.productUi.conversations.clearMetadataCache();
  return { success: true };
}
