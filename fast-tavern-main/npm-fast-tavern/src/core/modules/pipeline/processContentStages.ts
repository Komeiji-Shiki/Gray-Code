import type { PerItemStages, RegexScriptData, RegexTarget, RegexView } from '../../types';
import type { VariableContext } from '../variables';
import { applyRegex } from '../regex';
import { replaceMacros } from '../macro';

export interface ProcessContentStagesParams {
  target: RegexTarget;
  view: RegexView;
  scripts: RegexScriptData[];
  macros: Record<string, string>;
  /** 变量上下文（可选），用于处理 getvar/setvar 等宏 */
  variableContext?: VariableContext;
  /** 若该文本来自聊天历史，则提供 depth（0=最后一条） */
  historyDepth?: number;
}

export function processContentStages(
  text: string,
  params: ProcessContentStagesParams
): Pick<PerItemStages, 'raw' | 'afterPreRegex' | 'afterMacro' | 'afterPostRegex'> {
  const raw = text ?? '';

  // 新语义下没有 before/after macro 两段正则；保留 afterPreRegex 仅用于兼容调试结构
  const afterPreRegex = raw;

  // 宏替换（包含变量处理）
  const afterMacro = replaceMacros(afterPreRegex, {
    macros: params.macros,
    variableContext: params.variableContext
  });

  const afterPostRegex = applyRegex(afterMacro, {
    scripts: params.scripts,
    target: params.target,
    view: params.view,
    macros: params.macros,
    variableContext: params.variableContext,
    historyDepth: params.historyDepth,
  });

  return { raw, afterPreRegex, afterMacro, afterPostRegex };
}
