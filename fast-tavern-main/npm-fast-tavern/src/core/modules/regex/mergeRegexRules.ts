import type { RegexScriptData } from '../../types';

/**
 * 合并正则脚本（global + preset + character）。
 * 说明：此处只做“拼接”；字段归一化由 normalizeRegexes 负责。
 */
export function mergeRegexRules(params: {
  globalScripts?: RegexScriptData[];
  presetScripts?: RegexScriptData[];
  characterScripts?: RegexScriptData[];
}): RegexScriptData[] {
  const all: RegexScriptData[] = [];
  all.push(...(params.globalScripts || []));
  all.push(...(params.presetScripts || []));
  all.push(...(params.characterScripts || []));
  return all;
}

