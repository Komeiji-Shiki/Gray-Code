import { randomUUID } from 'node:crypto';
import type {
  CharacterChatConfig, PlatformConversation, PlatformMessage, RegexRule, WorldActivation, WorldbookDefinition,
} from '@graycode/contracts';
import { CharacterEngine, expandCharacterMacros, readCharacterDefinition, readRegexRules } from '@graycode/core';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import {
  DEFAULT_MAX_CONTEXT_TOKENS, resolveMaxContextTokensForConfig, resolveModelContextWindowForConfig,
} from '../../../../backend/modules/api/chat/services/contextTrim/contextWindowResolution';
import type { PlatformApplication } from '../application';
import { WorldbookPreparation } from './preparation';
import { restoreCharacterTurn, storeCharacterTurn, WORLD_SLOTS } from './snapshot';
import { WorldbookVectors } from './vectors';

export interface CharacterTurn {
  config: CharacterChatConfig;
  resources: { id: string; revision: number | null; sha256: string }[];
  modules: Record<string, string>;
  injections: PlatformMessage[];
  outlets: Record<string, string>;
  macros: Record<string, string>;
  rules: RegexRule[];
  activation: WorldActivation;
  capturedAt: number;
  messagePosition?: number;
}
const messageText = (message: PlatformMessage) => message.parts
  .filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n');

export interface CharacterCaptureOptions {
  actorId?: string;
  channel?: ChannelConfig;
  modelOverride?: string;
  preview?: boolean;
}

/** 每个用户回合捕获一次资源与随机结果，工具迭代沿用快照。 */
export class CharacterPipeline {
  readonly engine = new CharacterEngine();
  private readonly preparation = new WorldbookPreparation();
  private readonly vectors: WorldbookVectors;
  constructor(private readonly app: PlatformApplication) { this.vectors = new WorldbookVectors(app); }
  async greeting(config: CharacterChatConfig): Promise<PlatformMessage | undefined> {
    if (!config.characterId || config.greetingIndex === -1) return undefined;
    const { resource, revision } = await this.app.characters.get(config.characterId);
    const definition = readCharacterDefinition(resource.raw);
    const index = config.greetingIndex ?? 0;
    if (!Number.isSafeInteger(index) || index < 0 || index >= definition.greetings.length) throw new Error('请选择有效开场白。');
    const text = definition.greetings[index];
    if (!text) return undefined;
    const rules: RegexRule[] = [];
    for (const id of new Set([...resource.bindings.regexIds, ...config.regexIds])) {
      const linked = (await this.app.characters.get(id)).resource;
      rules.push(...readRegexRules(linked.raw).map(rule => ({ ...rule, id: `${id}/${rule.id}` })));
    }
    const turn: CharacterTurn = { config, resources: [{ id: resource.id, revision, sha256: resource.source.sha256 }], modules: {}, injections: [], outlets: {},
      macros: { char: definition.name, ...(config.userName ? { user: config.userName } : {}), persona: config.persona }, rules,
      activation: { entries: [], skipped: [] }, capturedAt: Date.now() };
    const original = [{ text }];
    const source = await this.transformParts(original, turn, 2, 'source');
    const display = await this.transformParts(source.parts, turn, 2, 'display');
    return { id: randomUUID(), parentId: null, role: 'model', parts: source.parts, timestamp: Date.now(), characterGreeting: true,
      characterMode: true, characterOriginalParts: original, characterDisplayParts: display.parts, characterStages: source.stages, characterDisplayStages: display.stages };
  }
  async capture(conversation: PlatformConversation, history: PlatformMessage[], source?: PlatformMessage, previousTurn?: PlatformMessage,
    signal?: AbortSignal, options: CharacterCaptureOptions = {}): Promise<CharacterTurn | undefined> {
    signal?.throwIfAborted();
    if (previousTurn?.characterTurn) return restoreCharacterTurn(structuredClone(previousTurn.characterTurn));
    const custom = conversation.custom as Record<string, unknown> | undefined;
    const config = (custom?.characterConfig as CharacterChatConfig | undefined) ?? { kind: 'character', userName: '', persona: '', worldbookIds: [], regexIds: [], scanDepth: 2 } as CharacterChatConfig;
    if (custom?.platformMode !== 'character') return undefined;
    const resources: CharacterTurn['resources'] = [];
    const read = async (id: string) => {
      signal?.throwIfAborted();
      const value = await this.app.characters.get(id);
      signal?.throwIfAborted();
      resources.push({ id, revision: value.revision, sha256: value.resource.source.sha256 }); return value.resource;
    };
    const character = config.characterId ? await read(config.characterId) : undefined;
    const definition = character ? readCharacterDefinition(character.raw) : undefined;
    const macros: Record<string, string> = { persona: config.persona };
    if (definition) macros.char = definition.name;
    if (config.userName) macros.user = config.userName;
    const expand = (value: string | undefined) => expandCharacterMacros(value ?? '', macros);
    const modules: Record<string, string> = {
      CHARACTER: [definition?.description, definition?.personality, definition?.scenario].map(expand).filter(Boolean).join('\n\n'),
      CHARACTER_DESCRIPTION: expand(definition?.description), CHARACTER_PERSONALITY: expand(definition?.personality), CHARACTER_SCENARIO: expand(definition?.scenario),
      CHARACTER_EXAMPLES: expand(definition?.examples), CHARACTER_SYSTEM: expand(definition?.systemPrompt), CHARACTER_POST_HISTORY: expand(definition?.postHistory),
      USER_PERSONA: expand(config.persona),
    };
    const rules: RegexRule[] = [];
    for (const id of new Set([...(character?.bindings.regexIds ?? []), ...config.regexIds])) {
      const resource = await read(id);
      rules.push(...readRegexRules(resource.raw).map(rule => ({ ...rule, id: `${id}/${rule.id}` })));
    }
    const sourceForWorld: PlatformMessage | undefined = source ? { ...source, role: 'user', parts: (await this.transformParts(source.parts, { macros, rules }, 1, 'source', signal)).parts } : undefined;
    const books: WorldbookDefinition[] = [];
    for (const id of new Set([...(character?.bindings.worldbookIds ?? []), ...config.worldbookIds])) {
      const resource = await read(id);
      books.push(this.preparation.read(resource, resources.at(-1)!.revision));
    }
    let messagePosition: number | undefined;
    let activation: WorldActivation = { entries: [], skipped: [] };
    const injections: PlatformMessage[] = [], outlets: Record<string, string> = {};
    if (books.length) {
      const contextWindow = options.channel
        ? (resolveModelContextWindowForConfig(options.channel, options.modelOverride)
          ?? resolveMaxContextTokensForConfig(options.channel, options.modelOverride)).maxContextTokens
        : DEFAULT_MAX_CONTEXT_TOKENS;
      const tokenBudget = config.worldTokenBudget ?? Math.floor(contextWindow * 0.05);
      const messages = [...history, ...(sourceForWorld ? [sourceForWorld] : [])].filter(message => {
        const conversational = message.role === 'model' || message.role === 'user' && message.isUserInput !== false;
        return conversational && !message.parts.some(part => part.functionCall || part.functionResponse);
      });
      const previousIndex = messages.findLastIndex(message => message !== sourceForWorld && message.isUserInput && message.characterTurn);
      const prior = previousIndex >= 0 ? messages[previousIndex].characterTurn as CharacterTurn : undefined;
      messagePosition = prior?.messagePosition === undefined ? messages.length : prior.messagePosition + messages.length - previousIndex - 1;
      activation = { entries: [], skipped: [], tokenBudget, timedEffects: { ...prior?.activation.timedEffects } };
      if (tokenBudget > 0) {
        const prepared = await this.preparation.prepare(this.engine, books, resources, rules, macros, signal);
        const randomValues: Record<string, number> = {};
        let maximumDepth = 0;
        for (const book of books) for (const entry of book.entries) {
          if (!entry.enabled || !entry.content.trim()) continue;
          maximumDepth = Math.max(maximumDepth, Math.floor(entry.scanDepth ?? book.scanDepth ?? config.scanDepth));
          randomValues[`${book.id}/${entry.id}`] = Math.random();
          for (const group of entry.group ?? []) randomValues[`group:${group}`] ??= Math.random();
        }
        // 时效计数与插入锚点保留完整消息索引，只有关键词扫描范围内的正文转成字符串。
        const scanHistory = maximumDepth === 0 ? [] : messages.slice(-maximumDepth).map(message =>
          `\u0001${message.role === 'model' ? macros.char ?? 'assistant' : macros.user ?? 'user'}: ${messageText(message)}`
        );
        const additionalSources = {
          matchPersonaDescription: config.persona,
          matchCharacterDescription: definition?.description ?? '',
          matchCharacterPersonality: definition?.personality ?? '',
          matchCharacterDepthPrompt: definition?.postHistory ?? '',
          matchScenario: definition?.scenario ?? '',
          matchCreatorNotes: definition?.creatorNotes ?? '',
        };
        const actorId = options.actorId ?? (typeof conversation.actorId === 'string' ? conversation.actorId : '');
        const vector = await this.vectors.activate({ actorId, books, history: scanHistory,
          scanDepth: config.scanDepth, macros, texts: prepared.texts, additionalSources, preview: options.preview }, signal);
        activation = await this.engine.worldbooks({ books, history: scanHistory,
          scanDepth: config.scanDepth, tokenBudget, macros, tokenCosts: prepared.tokenCosts, renderedTexts: prepared.texts, randomValues,
          messageCount: messagePosition, timedEffects: prior?.activation.timedEffects,
          recursive: config.recursiveScan, maxRecursionSteps: config.maxRecursionSteps, additionalSources,
          vectorMatches: vector.matches, vectorError: vector.error }, signal);
        activation.regexErrors = prepared.regexErrors;
      }
      for (let index = 0; index < activation.entries.length; index++) {
        const item = activation.entries[index];
        const slot = WORLD_SLOTS[item.entry.position];
        if (slot) modules[slot] = [modules[slot], item.text].filter(Boolean).join('\n\n');
        else if (item.entry.position === 'at_depth') {
          const depth = Math.max(0, Math.floor(item.entry.depth));
          const target = depth === 0 ? messages.at(-1) : messages[Math.max(0, messages.length - depth)];
          injections.push({ role: item.entry.role === 'assistant' ? 'model' : item.entry.role, parts: [{ text: item.text }],
            promptAnchor: { messageId: target?.id, edge: depth === 0 ? 'after' : 'before', order: item.entry.order } });
        } else if (item.entry.position === 'outlet' && item.entry.outletName) {
          outlets[item.entry.outletName] = [outlets[item.entry.outletName], item.text].filter(Boolean).join('\n\n');
        } else activation.skipped.push({ bookId: item.bookId, entryId: item.entry.id, reason: '条目插入位置不支持或出口未命名' });
      }
    }
    return { config: structuredClone(config), resources, modules, injections, outlets, macros, rules, activation, messagePosition, capturedAt: Date.now() };
  }
  async transformParts(parts: PlatformMessage['parts'], snapshot: Pick<CharacterTurn, 'macros' | 'rules'>, placement: number, phase: 'source' | 'prompt' | 'display', signal?: AbortSignal, isEdit = false) {
    // 带供应方签名的正文保持原样，显示变换使用独立副本。
    const targets = parts.map((part, index) => ({ part, index })).filter(item => typeof item.part.text === 'string'
      && (phase === 'display' || !item.part.thoughtSignature && !item.part.thoughtSignatures && !item.part.redactedThinking));
    const stages = targets.map(({ part }) => ({ raw: String(part.text), afterMacro: phase === 'source' ? expandCharacterMacros(String(part.text), snapshot.macros) : String(part.text) }));
    const transformed = await this.engine.transformBatch(stages.map((stage, index) => ({ text: stage.afterMacro,
      context: { placement: targets[index].part.thought ? 6 : placement, phase, depth: 0, macros: snapshot.macros, isEdit } })), snapshot.rules, signal);
    // 只替换文本块，图片、工具参数和签名块沿用原对象，避免复制无关附件。
    const output = [...parts];
    targets.forEach(({ index }, position) => {
      if (transformed[position].text !== parts[index].text) output[index] = { ...parts[index], text: transformed[position].text };
    });
    return { parts: output, stages: stages.map((stage, index) => ({ ...stage, afterRegex: transformed[index].text, applied: transformed[index].applied, errors: transformed[index].errors })) };
  }
  async modelHistory(messages: PlatformMessage[], snapshot: CharacterTurn | undefined, signal: AbortSignal) {
    snapshot = restoreCharacterTurn(snapshot);
    if (!snapshot) return messages;
    const targets: Array<{ message: PlatformMessage; part: PlatformMessage['parts'][number]; index: number; partIndex: number }> = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
        const part = message.parts[partIndex];
        if (typeof part.text === 'string' && !part.thoughtSignature && !part.thoughtSignatures && !part.redactedThinking)
          targets.push({ message, part, index, partIndex });
      }
    }
    const outputs = await this.engine.transformBatch(targets.map(item => ({ text: String(item.part.text), context: {
      placement: item.part.thought ? 6 : item.message.role === 'model' ? 2 : 1, phase: 'prompt' as const,
      depth: messages.length - item.index - 1, macros: snapshot.macros,
    } })), snapshot.rules, signal);
    // 角色正则只可能改文字，按实际变化复制消息和 parts，不复制整段历史的二进制内容。
    let result = messages;
    targets.forEach((item, index) => {
      const text = outputs[index].text;
      if (text === item.part.text) return;
      if (result === messages) result = [...messages];
      if (result[item.index] === item.message) result[item.index] = { ...item.message, parts: [...item.message.parts] };
      result[item.index].parts[item.partIndex] = { ...item.part, text };
    });
    return result;
  }
  async output(turn: CharacterTurn | undefined, message: PlatformMessage, signal: AbortSignal) {
    turn = restoreCharacterTurn(turn);
    if (!turn) return message;
    const storedTurn = storeCharacterTurn(turn);
    // 中断时保留用户已经看到的原文和角色来源，不再执行依赖完整输出的转换。
    if (message.incompleteReason) return { ...message, characterMode: true, characterOriginalParts: message.parts, characterTurn: storedTurn };
    let transformed: Awaited<ReturnType<CharacterPipeline['transformParts']>>;
    try { transformed = await this.transformParts(message.parts, turn, 2, 'source', signal); }
    catch (error) {
      signal.throwIfAborted();
      return { ...message, characterMode: true, characterOriginalParts: message.parts,
        characterDisplayStages: [{ errors: [{ message: (error as Error).message }] }], characterTurn: storedTurn };
    }
    let display: Awaited<ReturnType<CharacterPipeline['transformParts']>>;
    try { display = await this.transformParts(transformed.parts, turn, 2, 'display', signal); }
    catch (error) {
      signal.throwIfAborted();
      display = { parts: transformed.parts, stages: [{ raw: '', afterMacro: '', afterRegex: '', applied: [], errors: [{ id: 'display', message: (error as Error).message }] }] };
    }
    return { ...message, parts: transformed.parts, characterOriginalParts: message.parts, characterDisplayParts: display.parts,
      characterStages: transformed.stages, characterDisplayStages: display.stages, characterTurn: storedTurn };
  }
  snapshot(turn: CharacterTurn | undefined) { return turn ? storeCharacterTurn(turn) : undefined; }
  async close(): Promise<void> {
    this.preparation.clear();
    await Promise.all([this.engine.close(), this.vectors.close()]);
  }
}
