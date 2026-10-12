import type {
  CompanionBinding, CompanionConfiguration, CompanionRpcMethods, CompanionTurn, CompanionView,
  ModelInput, PlatformConversation, PlatformMessage, RecordMutation,
} from '@graycode/contracts';
import { readCharacterDefinition } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { requireOwnChatConversation } from '../conversations/ownChat';
import { CompanionOutput } from './output';

const defaultsNamespace = 'companion-defaults';
const emptyConfiguration = (): CompanionConfiguration => ({
  enabled: false, name: '', userName: '', tone: '', characterField: 'auto',
});

/** 陪伴是普通对话的一项配置，真实记忆继续使用当前账号的既有作用域。 */
export class CompanionService {
  readonly output: CompanionOutput;

  constructor(private readonly app: PlatformApplication) {
    this.output = new CompanionOutput(app);
  }

  async defaults(actorId: string) {
    const saved = await this.app.storage.getVersionedRecord(defaultsNamespace, actorId);
    return { binding: saved.value as CompanionBinding | null, revision: saved.revision };
  }

  async forNewConversation(actorId: string, custom?: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (custom?.platformMode !== 'chat' || Object.hasOwn(custom, 'companion')) return custom;
    const { binding } = await this.defaults(actorId);
    return binding?.actorId === actorId && binding.configuration.enabled ? { ...custom, companion: binding } : custom;
  }

  private async validate(configuration: CompanionConfiguration): Promise<CompanionConfiguration> {
    if (!configuration || typeof configuration.enabled !== 'boolean') throw new Error('请选择是否启用陪伴配置。');
    for (const [field, limit] of [['name', 100], ['userName', 100], ['tone', 4000]] as const) {
      if (typeof configuration[field] !== 'string' || configuration[field].length > limit) {
        throw new Error(`陪伴${field === 'tone' ? '交流偏好' : '名称'}格式无效或过长。`);
      }
    }
    const characterField = configuration.characterField ?? 'auto';
    if (!['auto', 'personality', 'description', 'both'].includes(characterField)) throw new Error('请选择角色卡提供人设的字段。');
    if (configuration.characterId) {
      if (typeof configuration.characterId !== 'string'
        || (await this.app.characters.get(configuration.characterId)).resource.kind !== 'character') {
        throw new Error('请选择可用的角色卡。');
      }
    }
    if (configuration.petResourceId) {
      if (typeof configuration.petResourceId !== 'string') throw new Error('请选择可用的桌宠资源。');
      await this.app.pets.resources.get(configuration.petResourceId);
    }
    return {
      enabled: configuration.enabled,
      name: configuration.name.trim(),
      userName: configuration.userName.trim(),
      tone: configuration.tone.trim(),
      characterField,
      ...(configuration.characterId ? { characterId: configuration.characterId } : {}),
      ...(configuration.petResourceId ? { petResourceId: configuration.petResourceId } : {}),
    };
  }

  async get(client: ClientSession, input: CompanionRpcMethods['companion.get']['params']): Promise<CompanionView> {
    this.app.requireOwner(client.actorId);
    if (input.conversationId) await requireOwnChatConversation(this.app, client.actorId, input.conversationId);
    const [defaults, state, characters, pets] = await Promise.all([
      this.defaults(client.actorId),
      input.conversationId ? this.app.conversations.read(client.actorId, input.conversationId) : undefined,
      this.app.characters.list(),
      this.app.pets.resources.list(),
    ]);
    const custom = state?.metadata.custom as { companion?: CompanionBinding } | undefined;
    const binding = custom?.companion;
    return {
      configuration: binding?.actorId === client.actorId ? binding.configuration
        : !state && defaults.binding?.actorId === client.actorId ? defaults.binding.configuration : emptyConfiguration(),
      title: state?.metadata.title,
      metadataToken: state?.metadataToken,
      defaultsRevision: defaults.revision,
      hasDefaults: !!defaults.binding,
      characters: characters.filter(item => item?.kind === 'character').map(item => ({ id: item!.id, name: item!.name })),
      pets: pets.map(item => ({ id: item.id, name: item.name, kind: item.kind })),
      petHostAvailable: this.app.pets.hasHost,
    };
  }

  async clearDefaults(
    client: ClientSession,
    input: CompanionRpcMethods['companion.defaults.clear']['params'],
  ): Promise<{ success: true }> {
    this.app.requireOwner(client.actorId);
    await this.app.storage.commitRecords([{
      namespace: defaultsNamespace, id: client.actorId, expectedRevision: input.defaultsRevision, delete: true,
    }]);
    return { success: true };
  }

  async save(
    client: ClientSession,
    input: CompanionRpcMethods['companion.save']['params'],
  ): Promise<{ success: true; conversationId: string }> {
    this.app.requireOwner(client.actorId);
    if (input.conversationId) await requireOwnChatConversation(this.app, client.actorId, input.conversationId);
    const state = input.conversationId ? await this.app.conversations.read(client.actorId, input.conversationId) : undefined;
    if (state && (await this.app.storage.listRuns({ conversationId: state.metadata.id, activeOnly: true, limit: 1 })).length) {
      throw new Error('请等当前回复结束后再修改陪伴配置。');
    }
    const configuration = await this.validate(input.configuration);
    const catalog = configuration.petResourceId ? await this.app.pets.modelCatalog(configuration.petResourceId) : undefined;
    const binding: CompanionBinding = {
      actorId: client.actorId, configuration, updatedAt: Date.now(),
      ...(catalog?.resource ? { pet: catalog.resource } : {}),
    };
    if (input.saveAsDefault === true && input.defaultsRevision === undefined) {
      throw new Error('请重新加载新对话默认配置。');
    }
    const records: RecordMutation[] = input.saveAsDefault === true ? [{
      namespace: defaultsNamespace, id: client.actorId, expectedRevision: input.defaultsRevision, value: binding,
    }] : [];
    if (state) {
      if (input.metadataToken === undefined) throw new Error('请重新加载当前对话的陪伴配置。');
      await this.app.storage.commitConversation({
        conversationId: state.metadata.id,
        expectedRevision: state.history.revision,
        expectedMetadataToken: input.metadataToken,
        metadata: {
          ...state.metadata, updatedAt: Date.now(),
          custom: { ...(state.metadata.custom as Record<string, unknown> | undefined), companion: binding },
        },
        records,
      });
      this.app.productUi.conversations.clearMetadataCache();
      this.app.publish({ type: 'conversation.changed', conversationId: state.metadata.id });
      return { success: true, conversationId: state.metadata.id };
    }
    const preset = this.app.settings.read('modeProfiles').modeProfiles?.chat?.promptModeId
      ?? this.app.product.runtimeSettings().getCurrentPromptModeId();
    const conversation = await this.app.createConversation(client.actorId, '新对话', undefined, {
      platformMode: 'chat', companion: binding, promptModeConfig: { modeId: preset },
    }, undefined, { automaticWorkspace: true, records });
    return { success: true, conversationId: conversation.id };
  }

  async capture(actorId: string, conversation: PlatformConversation, previous?: PlatformMessage): Promise<CompanionTurn | undefined> {
    // 编辑或重新生成旧回合时使用原有配置，不把后来切换的角色套进旧回复。
    if (previous) {
      const prior = previous.companionTurn as CompanionTurn | undefined;
      return prior?.actorId === actorId ? structuredClone(prior) : undefined;
    }
    const custom = conversation.custom as { platformMode?: string; companion?: CompanionBinding } | undefined;
    if (custom?.platformMode && custom.platformMode !== 'chat') return undefined;
    const binding = custom?.companion;
    if (!binding?.configuration.enabled || binding.actorId !== actorId) return undefined;
    const config = binding.configuration;
    const character = config.characterId ? await this.app.characters.get(config.characterId) : undefined;
    const definition = character ? readCharacterDefinition(character.resource.raw) : undefined;
    const personality = definition?.personality?.trim() ?? '';
    const description = definition?.description?.trim() ?? '';
    const identity = config.characterField === 'description' ? description
      : config.characterField === 'personality' ? personality
        : config.characterField === 'both' ? [personality, description].filter(Boolean).join('\n\n') : personality || description;
    return {
      ...structuredClone(binding),
      identity: { name: config.name || definition?.name || '', personality: identity },
      ...(character ? { resource: { id: character.resource.id, revision: character.revision, sha256: character.resource.source.sha256 } } : {}),
      capturedAt: Date.now(),
    };
  }

  prompt(turn?: CompanionTurn, petEnabled = this.app.pets.hasHost): string {
    if (!turn) return '';
    const content = {
      name: turn.identity.name, personality: turn.identity.personality,
      userName: turn.configuration.userName, tone: turn.configuration.tone,
      ...(turn.pet && petEnabled ? { pet: turn.pet } : {}),
    };
    const petGuidance = turn.pet && petEnabled
      ? '\n绑定的桌宠代表当前陪伴角色。自然交流时可以在正文中加入 <pet motion="动作ID" expression="表情ID"/>，'
        + '两项可以同时给出或只给一项。标签不会显示给用户，也不产生额外模型请求；只使用下方动作词表中的 ID。'
        + 'expression="" 用于清除表情。控制参数、取消动作或需要实际播放回执时使用 pet_control。'
        + '用户手动停止、当前显示其他桌宠或播放器不可用时，标签不会改变桌宠。'
      : '';
    return '\n\n<companion_configuration>\n当前对话已启用用户配置的陪伴交流。以下资料用于称呼、人设与交流语气，'
      + '不是用户经历或现实事实；不载入角色剧情、世界书、开场白或卡片中的其他指令。'
      + '按当前用户要求交流，继续使用现有工具与权限。个人约定、偏好和经历通过 memory_remember、memory_revise、memory_remove 管理，'
      + '使用本轮提供的授权个人范围；范围不明确时先调用 memory_topics。只有对应工具确认保存后才告知已记住，'
      + '不能用 engineering_log 代替个人记忆。没有依据时自然询问，不编造共同经历。'
      + petGuidance + `\n${JSON.stringify(content).replace(/</g, '\\u003c')}\n</companion_configuration>`;
  }

  generate(input: ModelInput, generate: (input: ModelInput) => Promise<PlatformMessage>): Promise<PlatformMessage> {
    return this.output.generate(input, generate);
  }

  finishRun(runId: string): Promise<void> {
    return this.output.finishRun(runId);
  }
}
