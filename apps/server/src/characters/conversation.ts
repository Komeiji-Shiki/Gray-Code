import type { CharacterChatConfig, UiRequestHandlers } from '@graycode/contracts';
import type { ClientSession } from '../transport/router';
import type { PlatformApplication } from '../application';

async function characterConfig(app: PlatformApplication, config: CharacterChatConfig): Promise<CharacterChatConfig> {
  if (!config || typeof config.userName !== 'string' || typeof config.persona !== 'string') throw new Error('请填写角色对话设置。');
  if (!Number.isSafeInteger(config.scanDepth) || config.scanDepth < 0) throw new Error('关键词扫描范围必须是非负整数。');
  if (config.worldTokenBudget !== undefined && (!Number.isSafeInteger(config.worldTokenBudget) || config.worldTokenBudget < 0)) throw new Error('世界书 Token 上限必须是非负整数。');
  if (config.recursiveScan !== undefined && typeof config.recursiveScan !== 'boolean') throw new Error('递归扫描设置无效。');
  if (config.maxRecursionSteps !== undefined && (!Number.isSafeInteger(config.maxRecursionSteps) || config.maxRecursionSteps < 0)) throw new Error('递归次数必须是非负整数。');
  await app.characters.validateBindings(config.worldbookIds, config.regexIds);
  if (config.characterId && (await app.characters.get(config.characterId)).resource.kind !== 'character') throw new Error('请选择角色卡。');
  return { kind: 'character', characterId: config.characterId, greetingIndex: config.greetingIndex,
    userName: config.userName, persona: config.persona, worldbookIds: config.worldbookIds, regexIds: config.regexIds,
    scanDepth: config.scanDepth, worldTokenBudget: config.worldTokenBudget, recursiveScan: config.recursiveScan, maxRecursionSteps: config.maxRecursionSteps };
}

export async function characterConversation(app: PlatformApplication, client: ClientSession, type: string, data: Record<string, unknown>) {
  const handlers: Pick<UiRequestHandlers, 'characters.conversation.get' | 'characters.conversation.create' | 'characters.conversation.save'> = {
    'characters.conversation.get': async params => {
      const state = await app.conversations.read(client.actorId, params.conversationId);
      const custom = state.metadata.custom as { characterConfig?: CharacterChatConfig; platformMode?: unknown } | undefined;
      return { config: custom?.characterConfig ?? null, metadataToken: state.metadataToken, mode: custom?.platformMode };
    },
    'characters.conversation.create': async params => {
      const value = await characterConfig(app, params.config);
      const settings = app.product.runtimeSettings();
      const preset = app.settings.snapshot().settings.modeProfiles?.character?.promptModeId ?? settings.getCurrentPromptModeId();
      const character = value.characterId ? (await app.characters.get(value.characterId)).resource : null;
      const greeting = await app.characterPipeline.greeting(value);
      const conversation = await app.createConversation(client.actorId, character?.name ?? '新角色对话', undefined,
        { platformMode: 'character', promptModeConfig: { modeId: preset }, characterConfig: value }, greeting ? [greeting] : undefined);
      return { conversationId: conversation.id };
    },
    'characters.conversation.save': async params => {
      const value = await characterConfig(app, params.config);
      const state = await app.conversations.read(client.actorId, params.conversationId);
      if ((state.metadata.custom as Record<string, unknown> | undefined)?.platformMode !== 'character')
        throw new Error('请新建角色对话，已有普通或代码对话保留原模式。');
      await app.storage.commitConversation({ conversationId: params.conversationId, expectedRevision: state.history.revision,
        expectedMetadataToken: params.metadataToken, metadata: { ...state.metadata, updatedAt: Date.now(),
          custom: { ...(state.metadata.custom as Record<string, unknown>), characterConfig: value } } });
      app.productUi.conversations.clearMetadataCache();
      return { success: true };
    },
  };
  const handler = Object.prototype.hasOwnProperty.call(handlers, type) ? handlers[type as keyof typeof handlers] : undefined;
  if (handler) return (handler as (params: Record<string, unknown>) => Promise<unknown>)(data);
  await characterConfig(app, data.config as CharacterChatConfig);
  throw new Error('未知角色会话操作。');
}
