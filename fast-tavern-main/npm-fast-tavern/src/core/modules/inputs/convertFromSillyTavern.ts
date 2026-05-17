import type {
  ChatMessage,
  CharacterCard,
  PresetInfo,
  PromptInfo,
  RegexMacroMode,
  RegexScriptData,
  RegexTarget,
  RegexView,
  UtilityPrompts,
  WorldBook,
  WorldBookEntry,
  WorldBookEntryActivationMode,
  WorldBookEntryRole,
  WorldBookEntrySelectiveLogic,
} from '../../types';

import { normalizeRegexes } from './normalizeRegexes';

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toArray<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function toStr(v: unknown, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  return String(v);
}

function toNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function cloneJson<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

function readString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : String(v);
}

function readNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function mergeUtilityPrompts(base: UtilityPrompts, patch: UtilityPrompts): UtilityPrompts {
  return {
    impersonationPrompt: patch.impersonationPrompt ?? base.impersonationPrompt,
    worldInfoFormat: patch.worldInfoFormat ?? base.worldInfoFormat,
    scenarioFormat: patch.scenarioFormat ?? base.scenarioFormat,
    personalityFormat: patch.personalityFormat ?? base.personalityFormat,
    groupNudgePrompt: patch.groupNudgePrompt ?? base.groupNudgePrompt,
    newChatPrompt: patch.newChatPrompt ?? base.newChatPrompt,
    newGroupChatPrompt: patch.newGroupChatPrompt ?? base.newGroupChatPrompt,
    newExampleChatPrompt: patch.newExampleChatPrompt ?? base.newExampleChatPrompt,
    continueNudgePrompt: patch.continueNudgePrompt ?? base.continueNudgePrompt,
    sendIfEmpty: patch.sendIfEmpty ?? base.sendIfEmpty,
    seed: patch.seed ?? base.seed,
  };
}

const UTILITY_PROMPT_KEYS = [
  // snake_case（ST）
  'impersonation_prompt',
  'wi_format',
  'scenario_format',
  'personality_format',
  'group_nudge_prompt',
  'new_chat_prompt',
  'new_group_chat_prompt',
  'new_example_chat_prompt',
  'continue_nudge_prompt',
  'send_if_empty',
  'seed',
  // camelCase aliases
  'impersonationPrompt',
  'wiFormat',
  'worldInfoFormat',
  'scenarioFormat',
  'personalityFormat',
  'groupNudgePrompt',
  'newChatPrompt',
  'newGroupChatPrompt',
  'newExampleChatPrompt',
  'continueNudgePrompt',
  'sendIfEmpty',
] as const;

function extractUtilityPrompts(other: any): UtilityPrompts {
  const source = isObject(other) ? other : {};

  const pick = (keys: string[]) => {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(source, k) && source[k] !== undefined) return source[k];
    }
    return undefined;
  };

  return {
    impersonationPrompt: readString(pick(['impersonation_prompt', 'impersonationPrompt'])),
    worldInfoFormat: readString(pick(['wi_format', 'wiFormat', 'worldInfoFormat'])),
    scenarioFormat: readString(pick(['scenario_format', 'scenarioFormat'])),
    personalityFormat: readString(pick(['personality_format', 'personalityFormat'])),
    groupNudgePrompt: readString(pick(['group_nudge_prompt', 'groupNudgePrompt'])),
    newChatPrompt: readString(pick(['new_chat_prompt', 'newChatPrompt'])),
    newGroupChatPrompt: readString(pick(['new_group_chat_prompt', 'newGroupChatPrompt'])),
    newExampleChatPrompt: readString(pick(['new_example_chat_prompt', 'newExampleChatPrompt'])),
    continueNudgePrompt: readString(pick(['continue_nudge_prompt', 'continueNudgePrompt'])),
    sendIfEmpty: readString(pick(['send_if_empty', 'sendIfEmpty'])),
    seed: readNumber(pick(['seed'])),
  };
}

function stripUtilityPrompts(other: Record<string, any>) {
  for (const k of UTILITY_PROMPT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(other, k)) {
      delete other[k];
    }
  }
}

function normalizeUtilityPrompts(input: any): UtilityPrompts {
  if (!isObject(input)) return {};
  return {
    impersonationPrompt: readString(input.impersonationPrompt),
    worldInfoFormat: readString(input.worldInfoFormat),
    scenarioFormat: readString(input.scenarioFormat),
    personalityFormat: readString(input.personalityFormat),
    groupNudgePrompt: readString(input.groupNudgePrompt),
    newChatPrompt: readString(input.newChatPrompt),
    newGroupChatPrompt: readString(input.newGroupChatPrompt),
    newExampleChatPrompt: readString(input.newExampleChatPrompt),
    continueNudgePrompt: readString(input.continueNudgePrompt),
    sendIfEmpty: readString(input.sendIfEmpty),
    seed: readNumber(input.seed),
  };
}

const REGEX_TARGET_MAP_FROM_ST: Record<number, RegexTarget> = {
  1: 'userInput',
  2: 'aiOutput',
  3: 'slashCommands',
  5: 'worldBook',
  6: 'reasoning',
};

const REGEX_LEGACY_TARGET_MAP: Record<string, RegexTarget> = {
  userInput: 'userInput',
  aiOutput: 'aiOutput',
  slashCommands: 'slashCommands',
  worldBook: 'worldBook',
  reasoning: 'reasoning',
  user: 'userInput',
  model: 'aiOutput',
  assistant_response: 'aiOutput',
  preset: 'slashCommands',
  world_book: 'worldBook',
};

const REGEX_MACRO_MODE_MAP: Record<number, RegexMacroMode> = {
  0: 'none',
  1: 'raw',
  2: 'escaped',
};

function normalizeRegexTarget(v: unknown): RegexTarget | null {
  if (typeof v === 'number') return REGEX_TARGET_MAP_FROM_ST[v] ?? null;
  const s = toStr(v).trim();
  if (!s) return null;
  return REGEX_LEGACY_TARGET_MAP[s] ?? null;
}

function normalizeRegexView(v: unknown): RegexView | null {
  const s = toStr(v).trim();
  if (s === 'user' || s === 'model') return s;
  if (s === 'user_view') return 'user';
  if (s === 'model_view' || s === 'assistant_view') return 'model';
  return null;
}

function normalizeRegexMacroMode(v: unknown): RegexMacroMode {
  if (v === 'none' || v === 'raw' || v === 'escaped') return v;
  if (typeof v === 'number') return REGEX_MACRO_MODE_MAP[v] ?? 'none';
  return 'none';
}

function normalizeDepth(v: unknown): number | null {
  if (v === null) return null;
  const n = readNumber(v);
  return n === undefined ? null : n;
}

/** 单条旧酒馆正则 -> 新格式 RegexScriptData */
export function convertRegexFromSillyTavern(rawRegex: any): RegexScriptData {
  const raw = isObject(rawRegex) ? rawRegex : {};

  const name = toStr(raw.name ?? raw.scriptName ?? '');
  const fallbackIdBase = name || 'regex';
  const id = toStr(raw.id ?? '').trim() || `${fallbackIdBase}_${Math.random().toString(36).slice(2, 10)}`;

  const targetsFromTargets = toArray(raw.targets).map(normalizeRegexTarget).filter(Boolean) as RegexTarget[];
  const placements = Array.isArray(raw.placement)
    ? raw.placement
    : raw.placement === undefined || raw.placement === null
      ? []
      : [raw.placement];
  const targetsFromPlacement = placements.map(normalizeRegexTarget).filter(Boolean) as RegexTarget[];
  const targets = (targetsFromTargets.length > 0 ? targetsFromTargets : targetsFromPlacement)
    .filter((x, i, arr) => arr.indexOf(x) === i);

  const viewFromView = toArray(raw.view).map(normalizeRegexView).filter(Boolean) as RegexView[];
  const view: RegexView[] = viewFromView.length > 0
    ? viewFromView
    : [
        ...(raw.markdownOnly ? (['user'] as const) : []),
        ...(raw.promptOnly ? (['model'] as const) : []),
      ];

  const enabled = typeof raw.enabled === 'boolean'
    ? raw.enabled
    : typeof raw.disabled === 'boolean'
      ? !raw.disabled
      : true;

  return {
    id,
    name,
    enabled,
    findRegex: toStr(raw.findRegex ?? ''),
    replaceRegex: toStr(raw.replaceRegex ?? raw.replaceString ?? ''),
    trimRegex: toArray(raw.trimRegex ?? raw.trimStrings).map((x) => toStr(x)),
    targets,
    view,
    runOnEdit: toBool(raw.runOnEdit, false),
    macroMode: normalizeRegexMacroMode(raw.macroMode ?? raw.substituteRegex),
    minDepth: normalizeDepth(raw.minDepth),
    maxDepth: normalizeDepth(raw.maxDepth),
  };
}

function collectRegexItems(input: unknown, out: any[]) {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    for (const item of input) collectRegexItems(item, out);
    return;
  }
  if (isObject(input) && Array.isArray((input as any).regexScripts)) {
    collectRegexItems((input as any).regexScripts, out);
    return;
  }
  if (isObject(input) && Array.isArray((input as any).scripts)) {
    collectRegexItems((input as any).scripts, out);
    return;
  }
  out.push(input);
}

/** 旧酒馆正则集合（多形态）-> 新格式 RegexScriptData[] */
export function convertRegexesFromSillyTavern(input: unknown): RegexScriptData[] {
  if (input === null || input === undefined) return [];
  const rawItems: any[] = [];
  collectRegexItems(input, rawItems);
  return normalizeRegexes(rawItems.map((x) => convertRegexFromSillyTavern(x)));
}

const WORLDBOOK_POSITION_MAP_FROM_ST: Record<number, string> = {
  0: 'beforeChar',
  1: 'afterChar',
  2: 'beforeAn',
  3: 'afterAn',
  4: 'fixed',
  5: 'beforeEm',
  6: 'afterEm',
  7: 'outlet',
};

const WORLDBOOK_POSITION_MAP_FROM_STR: Record<string, string> = {
  beforeChar: 'beforeChar',
  afterChar: 'afterChar',
  beforeAn: 'beforeAn',
  afterAn: 'afterAn',
  fixed: 'fixed',
  beforeEm: 'beforeEm',
  afterEm: 'afterEm',
  outlet: 'outlet',
  before_char: 'beforeChar',
  after_char: 'afterChar',
  before_an: 'beforeAn',
  after_an: 'afterAn',
  before_em: 'beforeEm',
  after_em: 'afterEm',
};

const WORLDBOOK_ROLE_MAP_FROM_ST: Record<number, WorldBookEntryRole> = {
  0: 'system',
  1: 'user',
  2: 'model',
};

const WORLDBOOK_SELECTIVE_LOGIC_MAP_FROM_ST: Record<number, WorldBookEntrySelectiveLogic> = {
  0: 'andAny',
  1: 'notAll',
  2: 'notAny',
  3: 'andAll',
};

function normalizeWorldBookPosition(position: unknown, extPosition: unknown): string {
  const p = position ?? extPosition;
  if (typeof p === 'number') return WORLDBOOK_POSITION_MAP_FROM_ST[p] ?? String(p);

  const s = toStr(p).trim();
  if (!s) return 'beforeChar';
  const maybeNumeric = Number(s);
  if (Number.isFinite(maybeNumeric)) {
    return WORLDBOOK_POSITION_MAP_FROM_ST[maybeNumeric] ?? s;
  }
  return WORLDBOOK_POSITION_MAP_FROM_STR[s] ?? s;
}

function normalizeWorldBookSelectiveLogic(v: unknown): WorldBookEntrySelectiveLogic {
  if (v === 'andAny' || v === 'andAll' || v === 'notAll' || v === 'notAny') return v;
  if (typeof v === 'number') return WORLDBOOK_SELECTIVE_LOGIC_MAP_FROM_ST[v] ?? 'andAny';
  return 'andAny';
}

function normalizeWorldBookRole(v: unknown): WorldBookEntryRole {
  if (v === 'system' || v === 'user' || v === 'model') return v;
  if (typeof v === 'number') return WORLDBOOK_ROLE_MAP_FROM_ST[v] ?? 'system';
  return 'system';
}

function normalizeWorldBookActivationMode(raw: any, ext: any): WorldBookEntryActivationMode {
  if (raw.activationMode === 'always' || raw.activationMode === 'keyword' || raw.activationMode === 'vector') {
    return raw.activationMode;
  }
  const constant = raw.constant ?? ext.constant;
  const vectorized = raw.vectorized ?? ext.vectorized;
  if (constant) return 'always';
  if (vectorized) return 'vector';
  return 'keyword';
}

/** 单条旧酒馆世界书条目 -> 新格式 WorldBookEntry */
export function convertWorldBookEntryFromSillyTavern(rawEntry: any, fallbackIndex = 0): WorldBookEntry | null {
  if (!isObject(rawEntry)) return null;

  const ext = isObject(rawEntry.extensions) ? rawEntry.extensions : {};

  const index = toNum(rawEntry.index ?? rawEntry.uid ?? rawEntry.id, fallbackIndex);
  const position = normalizeWorldBookPosition(rawEntry.position, ext.position);

  const selectiveLogic = normalizeWorldBookSelectiveLogic(
    rawEntry.selectiveLogic ?? ext.selectiveLogic ?? ext.selective_logic
  );

  const role = position === 'fixed'
    ? normalizeWorldBookRole(rawEntry.role ?? ext.role)
    : null;

  const caseSensitiveRaw =
    rawEntry.caseSensitive ??
    ext.caseSensitive ??
    ext.case_sensitive;

  const caseSensitive =
    caseSensitiveRaw === null || typeof caseSensitiveRaw === 'boolean'
      ? caseSensitiveRaw
      : null;

  const {
    index: _index,
    uid: _uid,
    id: _id,
    name: _name,
    comment: _comment,
    content: _content,
    enabled: _enabled,
    disable: _disable,
    activationMode: _activationMode,
    constant: _constant,
    vectorized: _vectorized,
    key: _key,
    keys: _keys,
    secondaryKey: _secondaryKey,
    keysecondary: _keysecondary,
    secondary_keys: _secondary_keys,
    selectiveLogic: _selectiveLogic,
    insertion_order: _insertionOrder,
    order: _order,
    depth: _depth,
    position: _position,
    role: _role,
    caseSensitive: _caseSensitive,
    excludeRecursion: _excludeRecursion,
    preventRecursion: _preventRecursion,
    probability: _probability,
    extensions: _extensions,
    other: rawOther,
    ...restRaw
  } = rawEntry;

  const other: Record<string, any> = {
    ...(isObject(rawOther) ? rawOther : {}),
    ...restRaw,
  };

  if (Object.keys(ext).length > 0 && !Object.prototype.hasOwnProperty.call(other, 'extensions')) {
    other.extensions = ext;
  }

  return {
    index,
    name: toStr(rawEntry.name ?? rawEntry.comment ?? ''),
    content: toStr(rawEntry.content ?? ''),
    enabled: typeof rawEntry.enabled === 'boolean'
      ? rawEntry.enabled
      : typeof rawEntry.disable === 'boolean'
        ? !rawEntry.disable
        : true,
    activationMode: normalizeWorldBookActivationMode(rawEntry, ext),
    key: toArray(rawEntry.key ?? rawEntry.keys).map((x) => toStr(x)),
    secondaryKey: toArray(rawEntry.secondaryKey ?? rawEntry.keysecondary ?? rawEntry.secondary_keys).map((x) => toStr(x)),
    selectiveLogic,
    order: toNum(rawEntry.order ?? rawEntry.insertion_order, 100),
    depth: toNum(rawEntry.depth ?? ext.depth, 4),
    position,
    role,
    caseSensitive,
    excludeRecursion: toBool(rawEntry.excludeRecursion ?? ext.excludeRecursion ?? ext.exclude_recursion, false),
    preventRecursion: toBool(rawEntry.preventRecursion ?? ext.preventRecursion ?? ext.prevent_recursion, false),
    probability: toNum(rawEntry.probability ?? ext.probability, 100),
    other,
  };
}

/** 单本旧酒馆世界书 -> 新格式 WorldBook */
export function convertWorldBookFromSillyTavern(rawBook: any, options?: { name?: string }): WorldBook {
  const book = rawBook;

  const ownName = isObject(book) ? toStr((book as any).name, '').trim() : '';
  const fallbackName = toStr(options?.name, '').trim();
  const name = ownName || fallbackName || 'WorldBook';

  const entries: WorldBookEntry[] = [];

  if (Array.isArray(book)) {
    book.forEach((raw, idx) => {
      const converted = convertWorldBookEntryFromSillyTavern(raw, idx);
      if (converted) entries.push(converted);
    });
  } else if (isObject(book) && Array.isArray((book as any).entries)) {
    (book as any).entries.forEach((raw: any, idx: number) => {
      const converted = convertWorldBookEntryFromSillyTavern(raw, idx);
      if (converted) entries.push(converted);
    });
  } else if (isObject(book) && isObject((book as any).entries)) {
    Object.entries((book as any).entries).forEach(([k, raw], idx) => {
      const fallbackIndex = Number.isFinite(Number(k)) ? Number(k) : idx;
      const converted = convertWorldBookEntryFromSillyTavern(raw, fallbackIndex);
      if (converted) entries.push(converted);
    });
  } else if (isObject(book)) {
    const converted = convertWorldBookEntryFromSillyTavern(book, 0);
    if (converted) entries.push(converted);
  }

  return { name, entries };
}

/** 旧酒馆世界书集合（多形态）-> 新格式 WorldBook[] */
export function convertWorldBooksFromSillyTavern(input: unknown): WorldBook[] {
  if (input === null || input === undefined) return [];

  if (Array.isArray(input)) {
    // 若是“单文件 entries[]”形态（元素像条目），包装成一本。
    const allEntryLike = input.every((x) => isObject(x) && ('content' in x || 'comment' in x));
    if (allEntryLike) {
      return [convertWorldBookFromSillyTavern(input, { name: 'WorldBook' })];
    }

    const out: WorldBook[] = [];
    input.forEach((item, idx) => {
      if (item === null || item === undefined) return;
      out.push(convertWorldBookFromSillyTavern(item, { name: `WorldBook_${idx + 1}` }));
    });
    return out;
  }

  return [convertWorldBookFromSillyTavern(input, { name: 'WorldBook' })];
}

function getPromptOrderList(rawOrder: unknown): Array<{ identifier: string; enabled: boolean }> {
  if (Array.isArray(rawOrder)) {
    // 取最后一个有效条目（character_id: 100001 是实际使用的排序，排在 100000 之后）
    const candidates = rawOrder.filter((x) => isObject(x) && Array.isArray((x as any).order));
    const last = candidates.length > 0 ? candidates[candidates.length - 1] as any : null;
    if (!last) return [];
    return toArray(last.order)
      .filter((x) => isObject(x) && typeof (x as any).identifier === 'string')
      .map((x) => ({
        identifier: toStr((x as any).identifier),
        enabled: toBool((x as any).enabled, true),
      }));
  }

  if (isObject(rawOrder) && Array.isArray((rawOrder as any).order)) {
    return toArray((rawOrder as any).order)
      .filter((x) => isObject(x) && typeof (x as any).identifier === 'string')
      .map((x) => ({
        identifier: toStr((x as any).identifier),
        enabled: toBool((x as any).enabled, true),
      }));
  }

  return [];
}

function convertPromptFromSillyTavern(
  rawPrompt: any,
  orderMap: Map<string, { enabled: boolean; index: number }>,
  fallbackIndex: number
): PromptInfo | null {
  if (!isObject(rawPrompt)) return null;

  /** 酒馆标准 marker identifier → 新格式 identifier */
  const ST_IDENTIFIER_MAP: Record<string, string> = {
    worldInfoBefore: 'charBefore',
    worldInfoAfter:  'charAfter',
  };

  const {
    injection_depth,
    injection_order,
    injection_trigger,
    injection_position,
    system_prompt,
    ...rest
  } = rawPrompt;

  const rawIdentifier = toStr(rest.identifier ?? `prompt_${fallbackIndex}`, '').trim() || `prompt_${fallbackIndex}`;
  const identifier = ST_IDENTIFIER_MAP[rawIdentifier] ?? rawIdentifier;
  // prompt_order 中使用的仍然是酒馆原始 identifier
  const orderItem = orderMap.get(rawIdentifier) ?? orderMap.get(identifier);

  const position =
    rest.position === 'relative' || rest.position === 'fixed'
      ? rest.position
      : Number(injection_position) === 1
        ? 'fixed'
        : 'relative';

  const role = toStr(rest.role ?? (system_prompt ? 'system' : 'system'));

  return {
    ...rest,
    identifier,
    name: toStr(rest.name ?? identifier),
    enabled: orderItem ? orderItem.enabled : (orderMap.size > 0 ? false : toBool(rest.enabled, true)),
    ...(orderItem ? { index: orderItem.index } : (typeof rest.index === 'number' ? { index: rest.index } : {})),
    role,
    content: toStr(rest.content ?? ''),
    depth: toNum(injection_depth ?? rest.depth, 0),
    order: toNum(injection_order ?? rest.order, 100),
    trigger: Array.isArray(injection_trigger ?? rest.trigger) ? (injection_trigger ?? rest.trigger) : [],
    position,
  };
}

/**
 * 旧酒馆 preset/settings -> 新格式 PresetInfo
 *
 * 对齐 st-api-wrapper 的优化字段：
 * - apiSetting -> other
 * - utilityPrompts 独立字段
 * - prompt_order 合并到 prompts.enabled/index
 */
export function convertPresetFromSillyTavern(rawPreset: any, options?: { name?: string }): PresetInfo {
  const raw = isObject(rawPreset) ? rawPreset : {};

  // 1) other 源：new.other > old.apiSetting > 旧平铺 settings
  const otherSource: Record<string, any> = (() => {
    if (isObject(raw.other)) return cloneJson(raw.other);
    if (isObject(raw.apiSetting)) return cloneJson(raw.apiSetting);

    const {
      name: _name,
      prompts: _prompts,
      prompt_order: _promptOrder,
      regexScripts: _regexScripts,
      utilityPrompts: _utilityPrompts,
      other: _other,
      apiSetting: _apiSetting,
      ...rest
    } = raw;
    return cloneJson(rest);
  })();

  delete (otherSource as any).prompts;
  delete (otherSource as any).prompt_order;

  // 2) utilityPrompts：other 提取 + 显式 utilityPrompts 覆盖
  const utilityFromOther = extractUtilityPrompts(otherSource);
  stripUtilityPrompts(otherSource);
  const utilityPrompts = mergeUtilityPrompts(utilityFromOther, normalizeUtilityPrompts(raw.utilityPrompts));

  // 3) regexScripts：显式 regexScripts 优先，否则从 other.extensions.regex_scripts 读取
  const hasExplicitRegexScripts = Object.prototype.hasOwnProperty.call(raw, 'regexScripts');
  const regexScripts = hasExplicitRegexScripts
    ? convertRegexesFromSillyTavern(raw.regexScripts)
    : convertRegexesFromSillyTavern(
        (isObject(otherSource.extensions) && ((otherSource.extensions as any).regex_scripts ?? (otherSource.extensions as any).regexScripts)) ||
        []
      );

  // 4) prompts + prompt_order 合并
  const promptList = toArray(raw.prompts);
  const orderList = getPromptOrderList(raw.prompt_order ?? raw.apiSetting?.prompt_order ?? raw.other?.prompt_order);

  const orderMap = new Map<string, { enabled: boolean; index: number }>();
  orderList.forEach((item, idx) => {
    orderMap.set(item.identifier, { enabled: item.enabled, index: idx });
  });

  const prompts = promptList
    .map((p, idx) => convertPromptFromSillyTavern(p, orderMap, idx))
    .filter((x): x is PromptInfo => Boolean(x))
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => {
      const ai = typeof a.p.index === 'number' ? a.p.index : Number.POSITIVE_INFINITY;
      const bi = typeof b.p.index === 'number' ? b.p.index : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.idx - b.idx;
    })
    .map((x) => x.p);

  return {
    name: toStr(options?.name ?? raw.name ?? 'Default') || 'Default',
    prompts,
    utilityPrompts,
    regexScripts,
    other: otherSource,
  };
}

/** 旧酒馆角色卡 -> 新格式 CharacterCard */
export function convertCharacterFromSillyTavern(rawCharacter: any): CharacterCard {
  const raw = isObject(rawCharacter) ? rawCharacter : {};
  const data = isObject(raw.data) ? raw.data : {};

  const name = toStr(data.name ?? raw.name ?? '');
  const description = toStr(data.description ?? raw.description ?? '');
  const avatar = toStr(raw.avatar ?? raw.avatar_url ?? data.avatar ?? '');

  const message = (() => {
    if (Array.isArray(raw.message)) {
      return raw.message.map((x: any) => toStr(x));
    }
    const firstMes = data.first_mes ?? raw.first_mes;
    const alternates = toArray(data.alternate_greetings ?? raw.alternate_greetings).map((x) => toStr(x));
    if (firstMes === undefined && alternates.length === 0) return [];
    return [toStr(firstMes ?? ''), ...alternates];
  })();

  const worldBook = (() => {
    if (raw.worldBook === null) return null;
    if (isObject(raw.worldBook) || Array.isArray(raw.worldBook)) {
      return convertWorldBookFromSillyTavern(raw.worldBook, { name: toStr((raw.worldBook as any)?.name ?? name) || name });
    }
    if (isObject(data.character_book)) {
      return convertWorldBookFromSillyTavern(data.character_book, { name: toStr((data.character_book as any).name ?? name) || name });
    }
    return null;
  })();

  const hasExplicitRegexScripts = Object.prototype.hasOwnProperty.call(raw, 'regexScripts');
  const regexScripts = hasExplicitRegexScripts
    ? convertRegexesFromSillyTavern(raw.regexScripts)
    : convertRegexesFromSillyTavern(
        (isObject(data.extensions) && ((data.extensions as any).regex_scripts ?? (data.extensions as any).regexScripts)) ||
        []
      );

  const other = (() => {
    if (isObject(raw.other)) return cloneJson(raw.other);

    const copy = cloneJson(raw) as Record<string, any>;
    if (isObject(copy.data?.extensions)) {
      delete copy.data.extensions.regex_scripts;
      delete copy.data.extensions.regexScripts;
    }
    if (isObject(copy.data)) {
      delete copy.data.character_book;
      delete copy.data.first_mes;
      delete copy.data.alternate_greetings;
    }
    delete copy.first_mes;
    delete copy.alternate_greetings;
    delete copy.chat;
    delete copy.create_date;

    return copy;
  })();

  return {
    name,
    description,
    avatar,
    message,
    worldBook,
    regexScripts,
    other,
    chatDate: toStr(raw.chatDate ?? raw.chat ?? ''),
    createDate: toStr(raw.createDate ?? raw.create_date ?? ''),
  };
}

function normalizeHistoryRole(rawMessage: any): string {
  const role = toStr(rawMessage?.role, '').toLowerCase();
  if (role === 'assistant' || role === 'model') return 'model';
  if (role === 'user' || role === 'system') return role;
  if (rawMessage?.is_user) return 'user';
  if (rawMessage?.is_system) return 'system';
  return 'model';
}

/** 单条旧酒馆聊天消息 -> 新格式 ChatMessage */
export function convertHistoryMessageFromSillyTavern(rawMessage: any): ChatMessage | null {
  if (!isObject(rawMessage)) return null;

  const role = normalizeHistoryRole(rawMessage);
  const name = readString(rawMessage.name);
  const swipeId = readNumber(rawMessage.swipeId ?? rawMessage.swipe_id);

  if (Array.isArray(rawMessage.parts)) {
    const partSwipes = Array.isArray(rawMessage.swipes) && rawMessage.swipes.every((s) => Array.isArray(s))
      ? cloneJson(rawMessage.swipes)
      : undefined;

    return {
      role,
      ...(name ? { name } : {}),
      ...(typeof swipeId === 'number' ? { swipeId } : {}),
      parts: cloneJson(rawMessage.parts),
      ...(partSwipes ? { swipes: partSwipes } : {}),
    };
  }

  const content = toStr(rawMessage.content ?? rawMessage.mes ?? '');
  const swipes = Array.isArray(rawMessage.swipes)
    ? rawMessage.swipes.map((x: any) => toStr(x))
    : undefined;

  return {
    role,
    ...(name ? { name } : {}),
    ...(typeof swipeId === 'number' ? { swipeId } : {}),
    content,
    ...(swipes ? { swipes } : {}),
  };
}

/** 旧酒馆聊天数组 -> 新格式 ChatMessage[] */
export function convertHistoryFromSillyTavern(rawMessages: any): ChatMessage[] {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages
    .map((x) => convertHistoryMessageFromSillyTavern(x))
    .filter((x): x is ChatMessage => Boolean(x));
}
