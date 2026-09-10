import { randomUUID } from 'node:crypto';
import type { CharacterChatConfig, PlatformConversation, PlatformMessage, RegexRule, WorldActivation, WorldbookDefinition } from '@graycode/contracts';
import { CharacterEngine, expandCharacterMacros, readCharacterDefinition, readRegexRules, readWorldbook } from '@graycode/core';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';
import type { PlatformApplication } from '../application';

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
const worldSlots: Record<string, string> = { before_char: 'WORLDBOOK_BEFORE_CHARACTER', after_char: 'WORLDBOOK_AFTER_CHARACTER',
  examples_before: 'WORLDBOOK_BEFORE_EXAMPLES', examples_after: 'WORLDBOOK_AFTER_EXAMPLES',
  authors_note_before: 'WORLDBOOK_BEFORE_NOTE', authors_note_after: 'WORLDBOOK_AFTER_NOTE' };
const messageText = (message: PlatformMessage) => message.parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n');

/** 每个用户回合捕获一次资源与随机结果，工具迭代沿用快照。 */
export class CharacterPipeline {
  readonly engine = new CharacterEngine();
  private readonly estimator = new MessageTokenEstimator();
  constructor(private readonly app: PlatformApplication) {}
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
  async capture(conversation: PlatformConversation, history: PlatformMessage[], source?: PlatformMessage, previousTurn?: PlatformMessage): Promise<CharacterTurn | undefined> {
    if (previousTurn?.characterTurn) return structuredClone(previousTurn.characterTurn) as CharacterTurn;
    const custom = conversation.custom as Record<string, unknown> | undefined;
    const config = (custom?.characterConfig as CharacterChatConfig | undefined) ?? { kind: 'character', userName: '', persona: '', worldbookIds: [], regexIds: [], scanDepth: 2 } as CharacterChatConfig;
    if (custom?.platformMode !== 'character') return undefined;
    const resources: CharacterTurn['resources'] = [];
    const read = async (id: string) => {
      const value = await this.app.characters.get(id);
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
    const sourceForWorld: PlatformMessage | undefined = source ? { ...source, role: 'user', parts: (await this.transformParts(source.parts, { macros, rules }, 1, 'source')).parts } : undefined;
    const books: WorldbookDefinition[] = [];
    for (const id of new Set([...(character?.bindings.worldbookIds ?? []), ...config.worldbookIds])) {
      const resource = await read(id); books.push(readWorldbook(resource.raw, id));
    }
    let messagePosition: number | undefined;
    let activation: WorldActivation = { entries: [], skipped: [] };
    const injections: PlatformMessage[] = [], outlets: Record<string, string> = {};
    if (books.length) {
      if (config.worldTokenBudget === undefined) throw new Error('请在角色配置中填写世界书最大注入 Token，填 0 可关闭注入。');
      const tokenCosts: Record<string, number> = {}, randomValues: Record<string, number> = {};
      const worldEntries = books.flatMap(book => book.entries.map(entry => ({ bookId: book.id, entry })));
      const worldRules = rules.filter(rule => rule.placements.includes(5));
      const sourceText = await this.engine.transformBatch(worldEntries.map(item => ({ text: expand(item.entry.content),
        context: { placement: 5, phase: 'source' as const, macros } })), worldRules);
      const promptText = await this.engine.transformBatch(sourceText.map(item => ({ text: item.text,
        context: { placement: 5, phase: 'prompt' as const, macros } })), worldRules);
      const renderedWorld = new Map(worldEntries.map((item, index) => [`${item.bookId}/${item.entry.id}`, promptText[index].text]));
      for (const book of books) for (const entry of book.entries) {
        const key = `${book.id}/${entry.id}`;
        tokenCosts[key] = this.estimator.estimateMessageTokens({ role: 'user', parts: [{ text: renderedWorld.get(key) ?? '' }] });
        randomValues[key] = Math.random();
        for (const group of entry.group ?? []) randomValues[`group:${group}`] ??= Math.random();
      }
      const messages = [...history, ...(sourceForWorld ? [sourceForWorld] : [])].filter(message => message.role === 'model' || message.role === 'user' && message.isUserInput !== false)
        .filter(message => !message.parts.some(part => part.functionCall || part.functionResponse));
      const previousIndex = messages.findLastIndex(message => message !== sourceForWorld && message.isUserInput && message.characterTurn);
      const prior = previousIndex >= 0 ? messages[previousIndex].characterTurn as CharacterTurn : undefined;
      messagePosition = prior?.messagePosition === undefined ? messages.length : prior.messagePosition + messages.length - previousIndex - 1;
      activation = await this.engine.worldbooks({ books, history: messages.map(message => `\u0001${message.role === 'model' ? macros.char ?? 'assistant' : macros.user ?? 'user'}: ${messageText(message)}`),
        scanDepth: config.scanDepth, tokenBudget: config.worldTokenBudget, macros, tokenCosts, randomValues,
        messageCount: messagePosition, timedEffects: prior?.activation.timedEffects, recursive: config.recursiveScan, maxRecursionSteps: config.maxRecursionSteps,
        additionalSources: { matchPersonaDescription: config.persona, matchCharacterDescription: definition?.description ?? '', matchCharacterPersonality: definition?.personality ?? '',
          matchCharacterDepthPrompt: definition?.postHistory ?? '', matchScenario: definition?.scenario ?? '', matchCreatorNotes: definition?.creatorNotes ?? '' } });
      activation.regexErrors = [...new Map([...sourceText, ...promptText].flatMap(result => result.errors).map(error => [error.id + error.message, error])).values()];
      for (let index = 0; index < activation.entries.length; index++) {
        const item = activation.entries[index]; item.text = renderedWorld.get(`${item.bookId}/${item.entry.id}`) ?? item.text;
        const slot = worldSlots[item.entry.position];
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
    const output = structuredClone(parts);
    targets.forEach(({ index }, position) => { output[index].text = transformed[position].text; });
    return { parts: output, stages: stages.map((stage, index) => ({ ...stage, afterRegex: transformed[index].text, applied: transformed[index].applied, errors: transformed[index].errors })) };
  }
  async modelHistory(messages: PlatformMessage[], snapshot: CharacterTurn | undefined, signal: AbortSignal) {
    if (!snapshot) return messages;
    const result = structuredClone(messages);
    const targets = result.flatMap((message, index) => message.parts.map((part, partIndex) => ({ message, part, index, partIndex })))
      .filter(item => typeof item.part.text === 'string' && !item.part.thoughtSignature && !item.part.thoughtSignatures && !item.part.redactedThinking);
    const outputs = await this.engine.transformBatch(targets.map(item => ({ text: String(item.part.text), context: {
      placement: item.part.thought ? 6 : item.message.role === 'model' ? 2 : 1, phase: 'prompt' as const,
      depth: messages.length - item.index - 1, macros: snapshot.macros,
    } })), snapshot.rules, signal);
    targets.forEach((item, index) => { result[item.index].parts[item.partIndex].text = outputs[index].text; });
    return result;
  }
  async output(turn: CharacterTurn | undefined, message: PlatformMessage, signal: AbortSignal) {
    if (!turn) return message;
    let transformed: Awaited<ReturnType<CharacterPipeline['transformParts']>>;
    try { transformed = await this.transformParts(message.parts, turn, 2, 'source', signal); }
    catch (error) {
      signal.throwIfAborted();
      return { ...message, characterMode: true, characterOriginalParts: message.parts,
        characterDisplayStages: [{ errors: [{ message: (error as Error).message }] }], characterTurn: turn };
    }
    let display: Awaited<ReturnType<CharacterPipeline['transformParts']>>;
    try { display = await this.transformParts(transformed.parts, turn, 2, 'display', signal); }
    catch (error) {
      signal.throwIfAborted();
      display = { parts: transformed.parts, stages: [{ raw: '', afterMacro: '', afterRegex: '', applied: [], errors: [{ id: 'display', message: (error as Error).message }] }] };
    }
    return { ...message, parts: transformed.parts, characterOriginalParts: message.parts, characterDisplayParts: display.parts,
      characterStages: transformed.stages, characterDisplayStages: display.stages, characterTurn: turn };
  }
  close() { return this.engine.close(); }
}
