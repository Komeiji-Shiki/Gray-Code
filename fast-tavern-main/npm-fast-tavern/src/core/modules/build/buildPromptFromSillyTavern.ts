import type { BuildPromptFromSillyTavernParams, BuildPromptParams, BuildPromptResult } from '../../types';
import {
  convertCharacterFromSillyTavern,
  convertHistoryFromSillyTavern,
  convertPresetFromSillyTavern,
  convertRegexesFromSillyTavern,
  convertWorldBooksFromSillyTavern,
} from '../inputs';
import { buildPrompt } from './buildPrompt';

/**
 * 旧酒馆（SillyTavern 原始结构）包装入口：
 * 先转换为新格式，再执行 buildPrompt。
 */
export function buildPromptFromSillyTavern(params: BuildPromptFromSillyTavernParams): BuildPromptResult {
  const converted: BuildPromptParams = {
    preset: convertPresetFromSillyTavern(params.preset),
    globals: {
      worldBooks: convertWorldBooksFromSillyTavern(params.globals?.worldBooks),
      regexScripts: convertRegexesFromSillyTavern(params.globals?.regexScripts),
    },
    history: convertHistoryFromSillyTavern(params.history),
    view: params.view,
    outputFormat: params.outputFormat,
    systemRolePolicy: params.systemRolePolicy,
    macros: params.macros,
    variables: params.variables,
    globalVariables: params.globalVariables,
    options: params.options,
  };

  if (params.character !== undefined && params.character !== null) {
    converted.character = convertCharacterFromSillyTavern(params.character);
  }

  return buildPrompt(converted);
}
