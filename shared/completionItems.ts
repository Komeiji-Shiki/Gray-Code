import type { CompletionItem, CompletionList } from 'vscode-languageserver-protocol';

/** 将服务端共享的补全默认值还原到每个条目，保留替换范围和自动导入所需数据。 */
export function completionItems(result: CompletionItem[] | CompletionList | null): CompletionItem[] {
  if (Array.isArray(result)) return result;
  const defaults = result?.itemDefaults;
  return (result?.items ?? []).map(item => {
    const value = { ...item, commitCharacters: item.commitCharacters ?? defaults?.commitCharacters,
      insertTextFormat: item.insertTextFormat ?? defaults?.insertTextFormat, data: item.data ?? defaults?.data };
    if (!value.textEdit && defaults?.editRange) value.textEdit = { newText: value.textEditText ?? value.insertText ?? value.label,
      ...('start' in defaults.editRange ? { range: defaults.editRange } : defaults.editRange) };
    return value;
  });
}
