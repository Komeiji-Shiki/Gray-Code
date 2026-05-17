import type {
  BuildPromptParams,
  BuildPromptResult,
  ChatMessage,
  Role,
  TaggedContent,
} from '../../types';

import { convertMessagesOut } from '../../convert';
import { normalizeRegexes, normalizeWorldbooks } from '../inputs';
import { getActiveEntries } from '../worldbook';
import { assembleTaggedPromptList } from '../assemble';
import { mergeRegexRules } from '../regex';
import { compileTaggedStages } from '../pipeline';
import { createVariableContext } from '../variables';

function normalizeRole(raw: string | undefined | null, fallback: Role = 'user'): Role {
  const r = String(raw ?? '').toLowerCase();
  if (r === 'system') return 'system';
  if (r === 'user') return 'user';
  if (r === 'model' || r === 'assistant') return 'model';
  return fallback;
}

function chatMessageToText(m: ChatMessage): string {
  if (!m) return '';
  if ('content' in m) return String(m.content ?? '');
  return (m.parts || []).map((p: any) => ('text' in p ? (p.text ?? '') : '')).join('');
}

function toInternalHistory(messages: ChatMessage[]): ChatMessage[] {
  return (messages || []).map((m) => {
    const role = normalizeRole(m.role, 'user');
    if ('parts' in m) {
      return {
        role,
        ...(m.name ? { name: m.name } : {}),
        ...(typeof m.swipeId === 'number' ? { swipeId: m.swipeId } : {}),
        parts: (m.parts || []).map((p: any) => ({ ...p })),
        ...(Array.isArray((m as any).swipes) ? { swipes: (m as any).swipes } : {}),
      };
    }

    return {
      role,
      ...(m.name ? { name: m.name } : {}),
      ...(typeof m.swipeId === 'number' ? { swipeId: m.swipeId } : {}),
      parts: [{ text: String((m as any).content ?? '') }],
    };
  });
}

function internalHistoryToChatNodes(internal: ChatMessage[]): Array<{ role: Role; text: string; historyDepth: number }> {
  const list = (internal || []).map((m) => ({
    role: normalizeRole(m.role, 'user'),
    text: chatMessageToText(m),
  }));

  const n = list.length;
  return list.map((x, idx) => ({ ...x, historyDepth: n - 1 - idx }));
}

function taggedToInternal(tagged: TaggedContent[]): ChatMessage[] {
  return (tagged || []).map((item) => ({
    role: item.role,
    parts: [{ text: item.text ?? '' }],
  }));
}

function applySystemRolePolicy(internal: ChatMessage[], policy: 'keep' | 'to_user'): ChatMessage[] {
  if (policy === 'keep') return internal;
  return (internal || []).map((m) => ({
    ...m,
    role: String(m.role || '') === 'system' ? 'user' : m.role,
  }));
}

/**
 * 仅从 character 提取 char 宏，并与用户提供的 macros 合并。
 * 优先级：用户显式提供的 macros > character 自动提取
 */
function buildMacros(userMacros: Record<string, string>, character?: BuildPromptParams['character']): Record<string, string> {
  const out: Record<string, string> = {};

  if (character?.name) {
    out.char = character.name;
  }

  return { ...out, ...(userMacros || {}) };
}


/**
 * 向后兼容：允许调用方继续传旧字段 `apiSetting`。
 *
 * 说明：当前 build 流程不直接消费 `other/apiSetting`，
 * 但这里做轻量归一化，保证输入结构语义一致。
 */
function normalizePresetCompat(preset: BuildPromptParams['preset']): BuildPromptParams['preset'] {
  const raw = (preset || {}) as any;
  return {
    ...raw,
    other: raw.other ?? raw.apiSetting ?? {},
    utilityPrompts: raw.utilityPrompts ?? {},
  } as BuildPromptParams['preset'];
}

export function buildPrompt(params: BuildPromptParams): BuildPromptResult {
  const {
    preset,
    character,
    globals,
    history,
    macros,
    variables,
    globalVariables,
    view,
    options,
  } = params;

  const normalizedPreset = normalizePresetCompat(preset);

  const finalMacros = buildMacros(macros || {}, character);
  const variableContext = createVariableContext(variables, globalVariables);

  // 1) history：统一为内部 ChatMessage(parts)[]，并产出线性 chatHistory 节点（带 historyDepth）
  const internalHistory = toInternalHistory(history || []);
  const chatNodes = internalHistoryToChatNodes(internalHistory);

  // 用于世界书匹配：取最近 N 条历史文本
  const recentN = options?.recentHistoryForWorldbook ?? 5;
  const recentHistoryText = chatNodes
    .slice(-recentN)
    .map((n) => n.text)
    .join('\n');

  // 2) 世界书：全局 + 角色
  const globalWorldBookEntries = normalizeWorldbooks(globals?.worldBooks);
  const activeEntries = getActiveEntries({
    contextText: recentHistoryText,
    globalEntries: globalWorldBookEntries,
    characterWorldBook: character?.worldBook ?? null,
    options: {
      vectorSearch: options?.vectorSearch as any,
      recursionLimit: options?.recursionLimit,
      rng: options?.rng,
      defaultCaseSensitive: options?.defaultCaseSensitive,
    },
  });

  // 3) 装配：preset.prompts + 世界书插槽/注入 + 聊天历史
  const tagged = assembleTaggedPromptList({
    presetPrompts: normalizedPreset.prompts,
    activeEntries,
    chatHistory: chatNodes,
    positionMap: options?.positionMap,
  });

  // 4) 正则：global + preset + character（按 RegexScriptData 语义）
  const globalScripts = normalizeRegexes(globals?.regexScripts);
  const presetScripts = normalizeRegexes(normalizedPreset.regexScripts);
  const characterScripts = normalizeRegexes(character?.regexScripts);

  const scripts = mergeRegexRules({
    globalScripts,
    presetScripts,
    characterScripts,
  });

  // 5) 编译各阶段（raw -> macro -> regex）
  const compiled = compileTaggedStages(tagged, {
    view,
    scripts,
    macros: finalMacros,
    variableContext,
  });

  const taggedStages = compiled.stages;
  const perItem = compiled.perItem;

  const internalStages = {
    raw: taggedToInternal(taggedStages.raw),
    afterPreRegex: taggedToInternal(taggedStages.afterPreRegex),
    afterMacro: taggedToInternal(taggedStages.afterMacro),
    afterPostRegex: taggedToInternal(taggedStages.afterPostRegex),
  };

  const outputFormat = params.outputFormat ?? 'gemini';
  const systemRolePolicy = params.systemRolePolicy ?? 'keep';

  const internalAfterPolicy = {
    raw: applySystemRolePolicy(internalStages.raw, systemRolePolicy),
    afterPreRegex: applySystemRolePolicy(internalStages.afterPreRegex, systemRolePolicy),
    afterMacro: applySystemRolePolicy(internalStages.afterMacro, systemRolePolicy),
    afterPostRegex: applySystemRolePolicy(internalStages.afterPostRegex, systemRolePolicy),
  };

  const outputStages =
    outputFormat === 'tagged'
      ? taggedStages
      : {
          raw: convertMessagesOut(internalAfterPolicy.raw, outputFormat as any),
          afterPreRegex: convertMessagesOut(internalAfterPolicy.afterPreRegex, outputFormat as any),
          afterMacro: convertMessagesOut(internalAfterPolicy.afterMacro, outputFormat as any),
          afterPostRegex: convertMessagesOut(internalAfterPolicy.afterPostRegex, outputFormat as any),
        };

  return {
    outputFormat,
    systemRolePolicy,
    activeWorldbookEntries: activeEntries,
    mergedRegexScripts: scripts,
    variables: {
      local: { ...variableContext.local },
      global: { ...variableContext.global },
    },
    stages: {
      tagged: taggedStages,
      internal: internalStages,
      output: outputStages,
      perItem,
    },
  };
}

