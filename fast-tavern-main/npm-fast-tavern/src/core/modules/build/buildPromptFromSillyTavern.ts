import type { BuildPromptFromSillyTavernParams, BuildPromptResult } from '../../types';

import { buildPrompt } from './buildPrompt';
import {
  convertCharacterFromSillyTavern,
  convertHistoryFromSillyTavern,
  convertPresetFromSillyTavern,
  convertRegexesFromSillyTavern,
  convertWorldBooksFromSillyTavern,
} from '../inputs';

/**
 * 旧酒馆（SillyTavern 原始结构）包装入口：
 * 1) 先把旧结构转换为 st-api-wrapper 新格式
 * 2) 再执行 buildPrompt
 */
export function buildPromptFromSillyTavern(params: BuildPromptFromSillyTavernParams): BuildPromptResult {
  const preset = convertPresetFromSillyTavern(params.preset);

  const character = params.character
    ? convertCharacterFromSillyTavern(params.character)
    : undefined;

  const worldBooks = params.globals?.worldBooks === undefined
    ? undefined
    : convertWorldBooksFromSillyTavern(params.globals.worldBooks);

  const regexScripts = params.globals?.regexScripts === undefined
    ? undefined
    : convertRegexesFromSillyTavern(params.globals.regexScripts);

  const history = convertHistoryFromSillyTavern(params.history);

  return buildPrompt({
    preset,
    character,
    globals: {
      worldBooks,
      regexScripts,
    },
    history,
    view: params.view,
    outputFormat: params.outputFormat,
    systemRolePolicy: params.systemRolePolicy,
    macros: params.macros,
    variables: params.variables,
    globalVariables: params.globalVariables,
    options: params.options,
  });
}
