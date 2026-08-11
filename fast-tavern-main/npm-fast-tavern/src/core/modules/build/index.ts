import type {
  BuildPromptFromSillyTavernParams,
  BuildPromptParams,
  BuildPromptResult,
  ChatMessage,
  RegexScriptData,
  RegexScriptsInput,
  TaggedContent,
  WorldBookEntry,
  WorldBooksInput,
} from '../../types';
import { convertMessagesIn, convertMessagesOut } from '../../convert';
import { assembleTaggedPromptList } from '../assemble';
import {
  convertCharacterFromSillyTavern,
  convertHistoryFromSillyTavern,
  convertPresetFromSillyTavern,
  convertRegexesFromSillyTavern,
  convertWorldBooksFromSillyTavern,
  normalizeRegexes,
  normalizeWorldbooks,
} from '../inputs';
import { compileTaggedStages } from '../pipeline/compileTaggedStages';
import { getActiveEntries } from '../worldbook';
import { createVariableContext } from '../variables';

/** TaggedContent[] -> 内部 ChatMessage[]（parts 格式） */
function toInternal(stage: TaggedContent[]): ChatMessage[] {
  return (stage || []).map((m) => ({
    role: m.role,
    parts: [{ text: m.text ?? '' }],
  }));
}

/** systemRolePolicy='to_user' 时把 system 降级为 user */
function applySystemRolePolicy(internal: ChatMessage[], policy: 'keep' | 'to_user'): ChatMessage[] {
  if (policy === 'keep') return internal;
  return (internal || []).map((m) =>
    String(m.role) === 'system' ? { ...m, role: 'user' } : m
  );
}

function extractHistoryText(m: ChatMessage): string {
  if ('parts' in m && Array.isArray(m.parts)) {
    return (m.parts as any[])
      .map((p: any) => ('text' in p ? (p.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(('content' in m ? m.content : '') ?? '');
}

/**
 * 构建 Prompt（现代新格式输入）。
 *
 * 流程：世界书激活 -> 历史转内部 -> assemble 组装 tagged.raw ->
 * 阶段管道（macro + regex）-> internal / output 格式转换。
 */
export function buildPrompt(params: BuildPromptParams): BuildPromptResult {
  const {
    preset,
    character,
    globals,
    history,
    view,
    outputFormat = 'gemini',
    systemRolePolicy = 'keep',
    macros = {},
    variables,
    globalVariables,
    options,
  } = params;

  // 1) 世界书：多形态归一化 + 激活（contextText 取最近几条历史文本，默认 5）
  const worldBooksNormalized: WorldBookEntry[] = globals?.worldBooks
    ? normalizeWorldbooks(globals.worldBooks)
    : [];
  const recentHistoryForWorldbook = options?.recentHistoryForWorldbook ?? 5;
  const contextText = (history || [])
    .slice(-recentHistoryForWorldbook)
    .map(extractHistoryText)
    .filter(Boolean)
    .join('\n');

  const activeWorldbookEntries = getActiveEntries({
    contextText,
    globalEntries: worldBooksNormalized,
    characterWorldBook: character?.worldBook ?? null,
    options: {
      vectorSearch: options?.vectorSearch,
      recursionLimit: options?.recursionLimit,
      rng: options?.rng,
      defaultCaseSensitive: options?.defaultCaseSensitive,
    },
  });

  // 2) 正则：global + preset + character 合并归一化
  const mergedRegexScripts: RegexScriptData[] = [
    ...(globals?.regexScripts ? normalizeRegexes(globals.regexScripts) : []),
    ...(preset?.regexScripts ?? []),
    ...(character?.regexScripts ?? []),
  ];

  // 3) 历史：统一为内部 parts 格式，再转 Role + text（historyDepth 从末尾计数，0=最后一条）
  const historyInternal = convertMessagesIn(history, 'auto').internal;
  const chatHistory = historyInternal.map((m, idx) => ({
    role: (String(m.role) === 'assistant' ? 'model' : String(m.role)) as 'system' | 'user' | 'model',
    text: extractHistoryText(m),
    historyDepth: historyInternal.length - 1 - idx,
  }));

  // 4) 组装 tagged.raw（relative 骨架 + 插槽条目 + fixed 注入）
  const taggedRaw = assembleTaggedPromptList({
    presetPrompts: preset?.prompts ?? [],
    activeEntries: activeWorldbookEntries,
    chatHistory,
    positionMap: options?.positionMap,
  });

  // 5) 阶段管道（宏 + 正则），产出 tagged 四阶段与 perItem
  // 变量上下文：setvar/getvar 宏就地写入 context，最终状态随结果返回
  const variableContext = createVariableContext(variables, globalVariables);
  const { stages: taggedStages, perItem } = compileTaggedStages(taggedRaw, {
    view,
    scripts: mergedRegexScripts,
    macros,
    variableContext,
  });

  // 6) internal（parts 格式，role: system/user/model）
  const internalStages = {
    raw: toInternal(taggedStages.raw),
    afterPreRegex: toInternal(taggedStages.afterPreRegex),
    afterMacro: toInternal(taggedStages.afterMacro),
    afterPostRegex: toInternal(taggedStages.afterPostRegex),
  };

  // 7) output：按 outputFormat 转换（tagged 无法逆向，直接返回 tagged 阶段）
  let outputStages: BuildPromptResult['stages']['output'];
  if (outputFormat === 'tagged') {
    outputStages = {
      raw: taggedStages.raw,
      afterPreRegex: taggedStages.afterPreRegex,
      afterMacro: taggedStages.afterMacro,
      afterPostRegex: taggedStages.afterPostRegex,
    };
  } else {
    const convFormat = outputFormat === 'text' ? 'text' : outputFormat === 'openai' ? 'openai' : 'gemini';
    const conv = (stage: ChatMessage[]) =>
      convertMessagesOut(applySystemRolePolicy(stage, systemRolePolicy), convFormat);
    outputStages = {
      raw: conv(internalStages.raw),
      afterPreRegex: conv(internalStages.afterPreRegex),
      afterMacro: conv(internalStages.afterMacro),
      afterPostRegex: conv(internalStages.afterPostRegex),
    };
  }

  return {
    outputFormat,
    systemRolePolicy,
    activeWorldbookEntries: activeWorldbookEntries,
    mergedRegexScripts,
    variables: {
      local: variableContext.local,
      global: variableContext.global,
    },
    stages: {
      tagged: taggedStages,
      internal: internalStages,
      output: outputStages,
      perItem,
    },
  };
}

/**
 * 构建 Prompt（旧酒馆 SillyTavern 原始格式入口）：
 * 先转换为新格式，再执行 buildPrompt。
 */
export function buildPromptFromSillyTavern(params: BuildPromptFromSillyTavernParams): BuildPromptResult {
  const { preset, character, globals, history, ...rest } = params;

  const convertedPreset = convertPresetFromSillyTavern(preset);
  const convertedCharacter = character ? convertCharacterFromSillyTavern(character) : undefined;
  const convertedHistory = convertHistoryFromSillyTavern(history ?? []);
  const convertedGlobals: { worldBooks?: WorldBooksInput; regexScripts?: RegexScriptsInput } = {
    ...(globals?.worldBooks ? { worldBooks: convertWorldBooksFromSillyTavern(globals.worldBooks) } : {}),
    ...(globals?.regexScripts ? { regexScripts: convertRegexesFromSillyTavern(globals.regexScripts) } : {}),
  };

  return buildPrompt({
    preset: convertedPreset,
    ...(convertedCharacter ? { character: convertedCharacter } : {}),
    ...(Object.keys(convertedGlobals).length > 0 ? { globals: convertedGlobals } : {}),
    history: convertedHistory,
    ...rest,
  });
}
