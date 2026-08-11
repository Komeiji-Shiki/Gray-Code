import type {
  BuildPromptParams,
  BuildPromptResult,
  ChatMessage,
  RegexScriptData,
  Role,
  TaggedContent,
  WorldBookEntry,
} from '../../types';
import { convertMessagesOut } from '../../convert';
import { assembleTaggedPromptList } from '../assemble';
import { compileTaggedStages } from '../pipeline';
import { getActiveEntries } from '../worldbook';
import mergeRegexRules } from '../regex';
import { normalizeRegexes, normalizeWorldbooks } from '../inputs';
import { createVariableContext } from '../variables';

function normalizeRole(raw: string, fallback: Role = 'user'): Role {
  const r = String(raw ?? '').toLowerCase();
  if (r === 'system') return 'system';
  if (r === 'user') return 'user';
  if (r === 'model' || r === 'assistant') return 'model';
  return fallback;
}

/** 从 ChatMessage 中提取纯文本（content 风格或 parts 风格） */
function messageText(m: ChatMessage): string {
  if ('content' in m) return String(m.content ?? '');
  return (m.parts || []).map((p: any) => ('text' in p ? (p.text ?? '') : '')).join('');
}

function toInternalMessages(stage: TaggedContent[]): ChatMessage[] {
  return (stage || []).map((item) => ({
    role: item.role,
    parts: [{ text: item.text ?? '' }],
  }));
}

/**
 * 主入口：预设 + 世界书 + 正则 + 角色卡 + 历史 + 变量 -> 多阶段提示词。
 *
 * 流程（对齐 docs/FORMAT_ZH.md「组装流程」）：
 * 1) History 归一化为内部 parts 风格，并标注 historyDepth（从末尾计数，0=最后一条）
 * 2) 宏与变量上下文（char 未显式提供时用 character.name 补全）
 * 3) 世界书激活（getActiveEntries，使用最近 recentHistoryForWorldbook 条历史作为上下文）
 * 4) 装配 TaggedContent（assembleTaggedPromptList：骨架 + 插槽 + fixed 注入）
 * 5) 正则脚本合并（global + preset + character）
 * 6) 分阶段编译（raw/afterPreRegex/afterMacro/afterPostRegex）
 * 7) 输出转换（tagged 直接返回带 tag 列表；其余按 outputFormat + systemRolePolicy）
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
    macros: userMacros,
    variables,
    globalVariables,
    options,
  } = params;

  // 1) History 归一化：内部 parts 风格 + historyDepth（0=最后一条）
  const chatMessages: ChatMessage[] = (history || []).map((m) => ({
    role: normalizeRole(String((m as any)?.role ?? '')),
    parts: [{ text: messageText(m) }],
  }));

  const chatNodes = chatMessages.map((m, idx, arr) => ({
    role: normalizeRole(String(m.role ?? '')),
    text: messageText(m),
    historyDepth: arr.length - 1 - idx,
  }));

  // 2) 宏与变量上下文
  const macros: Record<string, string> = { ...(userMacros || {}) };
  if (character?.name && macros.char === undefined) {
    macros.char = character.name;
  }
  const variableContext = createVariableContext(variables, globalVariables);

  // 3) 世界书激活（最近几条历史作为 keyword 匹配上下文）
  const recentHistoryForWorldbook = options?.recentHistoryForWorldbook ?? 5;
  const contextText = chatNodes
    .slice(-recentHistoryForWorldbook)
    .map((n) => n.text)
    .join('\n');

  const activeWorldbookEntries: WorldBookEntry[] = getActiveEntries({
    contextText,
    globalEntries: normalizeWorldbooks(globals?.worldBooks),
    characterWorldBook: character?.worldBook ?? null,
    options,
  });

  // 4) 装配 TaggedContent
  const tagged = assembleTaggedPromptList({
    presetPrompts: preset.prompts || [],
    activeEntries: activeWorldbookEntries,
    chatHistory: chatNodes,
    positionMap: options?.positionMap,
    chatHistoryIdentifier: 'chatHistory',
  });

  // 5) 正则脚本合并
  const mergedRegexScripts: RegexScriptData[] = mergeRegexRules({
    globalScripts: normalizeRegexes(globals?.regexScripts),
    presetScripts: preset.regexScripts || [],
    characterScripts: character?.regexScripts || [],
  });

  // 6) 分阶段编译
  const compiled = compileTaggedStages(tagged, {
    view,
    scripts: mergedRegexScripts,
    macros,
    variableContext,
  });

  // 7) 输出转换
  const toOutput = (
    stage: TaggedContent[]
  ): ChatMessage[] | TaggedContent[] | string => {
    if (outputFormat === 'tagged') return stage;
    let internal = toInternalMessages(stage);
    if (systemRolePolicy === 'to_user') {
      internal = internal.map((m) => (m.role === 'system' ? { ...m, role: 'user' } : m));
    }
    return convertMessagesOut(internal, outputFormat as Exclude<typeof outputFormat, 'tagged'>);
  };

  return {
    outputFormat,
    systemRolePolicy,
    activeWorldbookEntries,
    mergedRegexScripts,
    variables: { local: variableContext.local, global: variableContext.global },
    stages: {
      tagged: compiled.stages,
      internal: {
        raw: toInternalMessages(compiled.stages.raw),
        afterPreRegex: toInternalMessages(compiled.stages.afterPreRegex),
        afterMacro: toInternalMessages(compiled.stages.afterMacro),
        afterPostRegex: toInternalMessages(compiled.stages.afterPostRegex),
      },
      output: {
        raw: toOutput(compiled.stages.raw),
        afterPreRegex: toOutput(compiled.stages.afterPreRegex),
        afterMacro: toOutput(compiled.stages.afterMacro),
        afterPostRegex: toOutput(compiled.stages.afterPostRegex),
      },
      perItem: compiled.perItem,
    },
  };
}
