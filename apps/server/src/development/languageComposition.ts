import type { CompletionItem, CompletionList, CodeAction, Command, Hover, ServerCapabilities } from 'vscode-languageserver-protocol';
import { completionItems } from '../../../../shared/completionItems';

/** Vue 与 TypeScript 各自保留协议状态，编辑器只看到一组完整能力。 */
export function mergeLanguageCapabilities(primary: ServerCapabilities, companion?: ServerCapabilities): ServerCapabilities {
  if (!companion) return primary;
  const result: ServerCapabilities = { ...companion, ...primary };
  for (const key of ['hoverProvider', 'definitionProvider', 'referencesProvider', 'documentSymbolProvider', 'documentFormattingProvider'] as const)
    result[key] = primary[key] || companion[key];
  const strings = (...lists: (string[] | undefined)[]) => [...new Set(lists.flatMap(list => list ?? []))];
  if (primary.completionProvider || companion.completionProvider) result.completionProvider = {
    ...companion.completionProvider, ...primary.completionProvider,
    resolveProvider: !!(primary.completionProvider?.resolveProvider || companion.completionProvider?.resolveProvider),
    triggerCharacters: strings(primary.completionProvider?.triggerCharacters, companion.completionProvider?.triggerCharacters),
    allCommitCharacters: strings(primary.completionProvider?.allCommitCharacters, companion.completionProvider?.allCommitCharacters),
  };
  if (primary.signatureHelpProvider || companion.signatureHelpProvider) result.signatureHelpProvider = {
    triggerCharacters: strings(primary.signatureHelpProvider?.triggerCharacters, companion.signatureHelpProvider?.triggerCharacters),
    retriggerCharacters: strings(primary.signatureHelpProvider?.retriggerCharacters, companion.signatureHelpProvider?.retriggerCharacters),
  };
  if (primary.renameProvider || companion.renameProvider) result.renameProvider = {
    prepareProvider: [primary.renameProvider, companion.renameProvider].some(value => typeof value === 'object' && value.prepareProvider),
  };
  if (primary.codeActionProvider || companion.codeActionProvider) result.codeActionProvider = {
    resolveProvider: [primary.codeActionProvider, companion.codeActionProvider].some(value => typeof value === 'object' && value.resolveProvider),
    codeActionKinds: strings(...[primary.codeActionProvider, companion.codeActionProvider].map(value => typeof value === 'object' ? value.codeActionKinds : undefined)),
  };
  if (primary.executeCommandProvider || companion.executeCommandProvider) result.executeCommandProvider = {
    commands: strings(primary.executeCommandProvider?.commands, companion.executeCommandProvider?.commands),
  };
  return result;
}

interface RoutedData { __graycodeLanguageService: string; value?: unknown }
const commandPrefix = 'graycode.language:';

/** 补全及修复的后续解析必须回到产生它的服务，不能把两种不兼容的 data 交叉发送。 */
export function languageResultSource(params?: Record<string, unknown>): { source?: string; params: Record<string, unknown> } {
  const data = params?.data as Partial<RoutedData> | undefined;
  if (!data || typeof data.__graycodeLanguageService !== 'string') return { params: params ?? {} };
  return { source: data.__graycodeLanguageService, params: { ...params, data: data.value } };
}
export function languageCommandSource(command: string): { source?: string; command: string } {
  if (!command.startsWith(commandPrefix)) return { command };
  const value: unknown = JSON.parse(command.slice(commandPrefix.length));
  if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) throw new Error('语言服务命令来源无效。');
  return { source: value[0], command: value[1] };
}
function tagged<T extends { data?: unknown }>(value: T, source: string): T {
  return { ...value, data: { __graycodeLanguageService: source, value: value.data } };
}
function taggedCommand(value: Command, source: string): Command {
  return { ...value, command: commandPrefix + JSON.stringify([source, value.command]) };
}
function taggedAction(value: CodeAction | Command, source: string): CodeAction | Command {
  if (typeof value.command === 'string') return taggedCommand(value as Command, source);
  const action = tagged(value as CodeAction, source);
  return action.command ? { ...action, command: taggedCommand(action.command, source) } : action;
}
const unique = <T>(values: T[]) => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];

export function mergeLanguageResults(method: string, results: Array<{ source: string; value: unknown }>): unknown {
  if (method === 'completionItem/resolve') {
    const result = results[0]; return result?.value ? tagged(result.value as CompletionItem, result.source) : null;
  }
  if (method === 'codeAction/resolve') {
    const result = results[0]; return result?.value ? taggedAction(result.value as CodeAction, result.source) : null;
  }
  if (method === 'textDocument/completion') return {
    isIncomplete: results.some(result => !Array.isArray(result.value) && (result.value as CompletionList | null)?.isIncomplete),
    items: results.flatMap(result => completionItems(result.value as CompletionItem[] | CompletionList | null).map(item => tagged(item, result.source))),
  };
  if (method === 'textDocument/codeAction') return results.flatMap(result => (result.value as (CodeAction | Command)[] | null ?? []).map(action => taggedAction(action, result.source)));
  if (method === 'textDocument/definition' || method === 'textDocument/references')
    return unique(results.flatMap(result => !result.value ? [] : Array.isArray(result.value) ? result.value : [result.value]));
  if (method === 'textDocument/hover') {
    const values = results.map(result => result.value as Hover | null).filter((value): value is Hover => !!value);
    const contents = unique(values.flatMap(value => Array.isArray(value.contents) ? value.contents : [value.contents]).map(value => {
      if (typeof value === 'string') return value;
      if ('language' in value) return '```' + value.language + '\n' + value.value + '\n```';
      return value.value;
    }));
    return contents.length ? { ...values[0], contents: { kind: 'markdown', value: contents.join('\n\n') } } : null;
  }
  // 格式化与重命名选择单个完整编辑结果，避免两个服务的编辑互相覆盖。
  return results.map(result => result.value).find(value => {
    if (!value) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object' && 'signatures' in value) return Array.isArray(value.signatures) && value.signatures.length > 0;
    return true;
  }) ?? null;
}
