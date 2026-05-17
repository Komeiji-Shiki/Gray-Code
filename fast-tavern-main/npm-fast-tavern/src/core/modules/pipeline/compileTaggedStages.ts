import type { PerItemStages, PromptStages, RegexScriptData, RegexView, TaggedContent } from '../../types';
import type { VariableContext } from '../variables';
import { processContentStages } from './processContentStages';

export interface CompileTaggedStagesParams {
  view: RegexView;
  scripts: RegexScriptData[];
  macros: Record<string, string>;
  /** 变量上下文（可选） */
  variableContext?: VariableContext;
}

export interface CompileTaggedStagesResult {
  stages: PromptStages<TaggedContent[]>;
  perItem: PerItemStages[];
}

export function compileTaggedStages(
  tagged: TaggedContent[],
  params: CompileTaggedStagesParams
): CompileTaggedStagesResult {
  const perItem: PerItemStages[] = [];

  const raw = (tagged || []).map((i) => ({ ...i }));
  const afterPreRegex: TaggedContent[] = [];
  const afterMacro: TaggedContent[] = [];
  const afterPostRegex: TaggedContent[] = [];

  for (const item of raw) {
    const s = processContentStages(item.text, {
      target: item.target,
      view: params.view,
      scripts: params.scripts,
      macros: params.macros,
      variableContext: params.variableContext,
      historyDepth: item.historyDepth,
    });

    perItem.push({
      tag: item.tag,
      role: item.role,
      target: item.target,
      historyDepth: item.historyDepth,
      ...s
    });

    afterPreRegex.push({ ...item, text: s.afterPreRegex });
    afterMacro.push({ ...item, text: s.afterMacro });
    afterPostRegex.push({ ...item, text: s.afterPostRegex });
  }

  return {
    stages: { raw, afterPreRegex, afterMacro, afterPostRegex },
    perItem
  };
}
