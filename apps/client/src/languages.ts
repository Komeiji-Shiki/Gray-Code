import * as monaco from 'monaco-editor';
import type { SourceRange, LanguageDiagnostic } from '@graycode/contracts';
import { call, subscribe } from './api';
import { report } from './state';

// 在创建模型之前停用浏览器内的重复诊断，避免其异步结果覆盖真实工作区的语言服务。
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setModeConfiguration({ ...defaults.modeConfiguration, completionItems: false, hovers: false, definitions: false,
    references: false, documentSymbols: false, rename: false, documentRangeFormattingEdits: false, diagnostics: false });
  defaults.setDiagnosticsOptions({ ...defaults.getDiagnosticsOptions(), noSyntaxValidation: true, noSemanticValidation: true, noSuggestionDiagnostics: true });
}

interface Binding {
  model: monaco.editor.ITextModel; workspaceId: string; path: string; uri?: string;
  version(): number; flush(): Promise<unknown>;
  open(path: string, range?: monaco.IRange, focus?: boolean): Promise<void>;
  ready?: Promise<unknown>;
}
interface LspEdit { range: SourceRange; newText: string }
interface LspCompletion { label: string; kind?: number; detail?: string; documentation?: string | { value: string }; insertText?: string;
  insertTextFormat?: number; sortText?: string; filterText?: string; preselect?: boolean; commitCharacters?: string[];
  textEdit?: { newText: string; range?: SourceRange; insert?: SourceRange; replace?: SourceRange }; additionalTextEdits?: LspEdit[]; data?: unknown }
const bindings = new Map<string, Binding>();
const registered = new Set<string>();
const completionSources = new WeakMap<monaco.languages.CompletionItem, { binding: Binding; value: LspCompletion; modelVersion: number }>();
export const editorUri = (workspaceId: string, file: string) => monaco.Uri.from({ scheme: 'graycode', authority: workspaceId, path: '/' + file.replaceAll('\\', '/') });
const range = (value: SourceRange) => new monaco.Range(value.start.line + 1, value.start.character + 1, value.end.line + 1, value.end.character + 1);
const position = (value: monaco.Position) => ({ line: value.lineNumber - 1, character: value.column - 1 });
const edit = (value: LspEdit) => ({ range: range(value.range), text: value.newText });
const documentation = (value: string | { value: string } | undefined) => value === undefined ? undefined : { value: typeof value === 'string' ? value : value.value, isTrusted: false, supportHtml: false };

async function request<T>(binding: Binding, method: string, params: Record<string, unknown>, token?: monaco.CancellationToken): Promise<T | null> {
  const version = binding.model.getVersionId();
  await binding.ready;
  if (!binding.uri || token?.isCancellationRequested) return null;
  await binding.flush();
  if (version !== binding.model.getVersionId()) return null;
  const requestId = crypto.randomUUID();
  const subscription = token?.onCancellationRequested(() => { void call('language.cancel', { requestId }); });
  try {
    const result = await call<T>('language.request', { workspaceId: binding.workspaceId, path: binding.path,
      version: binding.version(), method, params, requestId });
    return token?.isCancellationRequested || binding.model.isDisposed() || binding.model.getVersionId() !== version ? null : result;
  } catch (error) {
    if (!token?.isCancellationRequested) report(error);
    return null;
  } finally { subscription?.dispose(); }
}
function completion(value: LspCompletion, binding: Binding, cursor: monaco.Position): monaco.languages.CompletionItem {
  const names = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit',
    'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
  const word = binding.model.getWordUntilPosition(cursor);
  const textEdit = value.textEdit;
  const item: monaco.languages.CompletionItem = { label: value.label,
    kind: monaco.languages.CompletionItemKind[names[(value.kind ?? 1) - 1] as keyof typeof monaco.languages.CompletionItemKind] ?? monaco.languages.CompletionItemKind.Text,
    detail: value.detail, documentation: documentation(value.documentation), sortText: value.sortText, filterText: value.filterText,
    preselect: value.preselect, commitCharacters: value.commitCharacters,
    insertText: textEdit?.newText ?? value.insertText ?? value.label,
    insertTextRules: value.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range: textEdit?.range ? range(textEdit.range) : textEdit?.insert && textEdit.replace ? { insert: range(textEdit.insert), replace: range(textEdit.replace) }
      : new monaco.Range(cursor.lineNumber, word.startColumn, cursor.lineNumber, word.endColumn),
    additionalTextEdits: value.additionalTextEdits?.map(edit) };
  completionSources.set(item, { binding, value, modelVersion: binding.model.getVersionId() }); return item;
}
async function target(binding: Binding, uri: string, location?: SourceRange, open = false) {
  const file = await call<string>('language.path', { workspaceId: binding.workspaceId, uri });
  if (open) await binding.open(file, location ? range(location) : undefined, false);
  return editorUri(binding.workspaceId, file);
}
async function locations(binding: Binding, values: any): Promise<monaco.languages.Location[]> {
  return Promise.all((Array.isArray(values) ? values : values ? [values] : []).map(async (value: any) => ({
    uri: await target(binding, value.targetUri ?? value.uri), range: range(value.targetSelectionRange ?? value.range) })));
}
function symbols(values: any[]): monaco.languages.DocumentSymbol[] {
  return values.map(value => ({ name: value.name, detail: value.detail ?? '', kind: Math.max(0, value.kind - 1), tags: value.tags ?? [],
    range: range(value.range ?? value.location.range), selectionRange: range(value.selectionRange ?? value.range ?? value.location.range),
    children: value.children ? symbols(value.children) : undefined }));
}
function register(languageId: string) {
  if (registered.has(languageId)) return;
  registered.add(languageId);
  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<'],
    async provideCompletionItems(model, cursor, context, token) {
      const binding = bindings.get(model.uri.toString()); if (!binding) return;
      const result = await request<LspCompletion[] | { items: LspCompletion[]; isIncomplete?: boolean }>(binding, 'textDocument/completion',
        { position: position(cursor), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } }, token);
      return { suggestions: (Array.isArray(result) ? result : result?.items ?? []).map(value => completion(value, binding, cursor)), incomplete: !Array.isArray(result) && result?.isIncomplete === true };
    },
    async resolveCompletionItem(item, token) {
      const source = completionSources.get(item); if (!source || source.binding.model.getVersionId() !== source.modelVersion) return item;
      const resolved = await request<LspCompletion>(source.binding, 'completionItem/resolve', source.value as unknown as Record<string, unknown>, token);
      return resolved ? { ...item, detail: resolved.detail ?? item.detail, documentation: documentation(resolved.documentation) ?? item.documentation,
        additionalTextEdits: resolved.additionalTextEdits?.map(edit) ?? item.additionalTextEdits } : item;
    },
  });
  monaco.languages.registerHoverProvider(languageId, { async provideHover(model, cursor, token) {
    const binding = bindings.get(model.uri.toString()); if (!binding) return;
    const result = await request<any>(binding, 'textDocument/hover', { position: position(cursor) }, token); if (!result) return;
    return { range: result.range ? range(result.range) : undefined,
      contents: (Array.isArray(result.contents) ? result.contents : [result.contents]).map((value: any) => documentation(typeof value === 'string' ? value : value.value)!) };
  } });
  monaco.languages.registerDefinitionProvider(languageId, { async provideDefinition(model, cursor, token) {
    const binding = bindings.get(model.uri.toString()); if (!binding) return;
    return locations(binding, await request(binding, 'textDocument/definition', { position: position(cursor) }, token));
  } });
  monaco.languages.registerReferenceProvider(languageId, { async provideReferences(model, cursor, context, token) {
    const binding = bindings.get(model.uri.toString()); if (!binding) return;
    return locations(binding, await request(binding, 'textDocument/references', { position: position(cursor), context }, token));
  } });
  monaco.languages.registerDocumentSymbolProvider(languageId, { async provideDocumentSymbols(model, token) {
    const binding = bindings.get(model.uri.toString()); if (!binding) return;
    return symbols(await request<any[]>(binding, 'textDocument/documentSymbol', {}, token) ?? []);
  } });
  monaco.languages.registerDocumentFormattingEditProvider(languageId, { async provideDocumentFormattingEdits(model, options, token) {
    const binding = bindings.get(model.uri.toString()); if (!binding) return;
    return (await request<LspEdit[]>(binding, 'textDocument/formatting', { options }, token) ?? []).map(edit);
  } });
  monaco.languages.registerRenameProvider(languageId, {
    async resolveRenameLocation(model, cursor, token) {
      const binding = bindings.get(model.uri.toString()); if (!binding) return;
      const result = await request<any>(binding, 'textDocument/prepareRename', { position: position(cursor) }, token);
      if (!result) return { range: new monaco.Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column), text: '', rejectReason: '该位置不能重命名。' };
      const selection = range(result.range ?? result);
      return { range: selection, text: result.placeholder ?? model.getValueInRange(selection) };
    },
    async provideRenameEdits(model, cursor, newName, token) {
      const binding = bindings.get(model.uri.toString()); if (!binding) return;
      const versions = new Map([...bindings].filter(([, item]) => item.workspaceId === binding.workspaceId).map(([uri, item]) => [uri, item.model.getVersionId()]));
      const result = await request<any>(binding, 'textDocument/rename', { position: position(cursor), newName }, token); if (!result) return;
      const changes: Array<{ uri: string; version?: number | null; edits: LspEdit[] }> = Object.entries(result.changes ?? {}).map(([uri, edits]) => ({ uri, edits: edits as LspEdit[] }));
      for (const change of result.documentChanges ?? []) {
        if (!change.textDocument) return { edits: [], rejectReason: '此重命名包含文件创建或移动，请通过文件操作处理。' };
        changes.push({ ...change.textDocument, edits: change.edits });
      }
      const edits: monaco.languages.IWorkspaceTextEdit[] = [];
      for (const change of changes) {
        const resource = await target(binding, change.uri, undefined, true);
        const targetBinding = bindings.get(resource.toString());
        if (!targetBinding) return { edits: [], rejectReason: '目标文件尚未打开，请重试。' };
        if (versions.has(resource.toString()) && versions.get(resource.toString()) !== targetBinding.model.getVersionId()) return { edits: [], rejectReason: '另一个编辑草稿已经变化，请重新重命名。' };
        await targetBinding.flush();
        if (change.version != null && change.version !== targetBinding.version()) return { edits: [], rejectReason: '目标文件已经变化，请重新重命名。' };
        for (const value of change.edits) edits.push({ resource, textEdit: edit(value), versionId: targetBinding.model.getVersionId() });
      }
      return { edits };
    },
  });
}

monaco.editor.registerEditorOpener({ async openCodeEditor(source, resource, selection) {
  if (resource.scheme !== 'graycode') return false;
  const binding = bindings.get(source.getModel()?.uri.toString() ?? ''); if (!binding) return false;
  const targetRange = selection ? 'startLineNumber' in selection ? selection : new monaco.Range(selection.lineNumber, selection.column, selection.lineNumber, selection.column) : undefined;
  await binding.open(resource.path.slice(1), targetRange, true); return true;
} });

export function bindLanguageDocument(input: Binding) {
  let disposed = false;
  let latest: { diagnostics: LanguageDiagnostic[]; version?: number } | undefined;
  const updateMarkers = () => {
    if (disposed || !latest || latest.version !== undefined && latest.version !== input.version()) return;
    monaco.editor.setModelMarkers(input.model, 'graycode-lsp', latest.diagnostics.map(value => ({ ...range(value.range), message: value.message,
      severity: [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][(value.severity ?? 1) - 1],
      source: value.source, code: value.code === undefined ? undefined : String(value.code), tags: value.tags })));
  };
  bindings.set(input.model.uri.toString(), input);
  input.ready = call<any>('language.ensure', { workspaceId: input.workspaceId, path: input.path }).then(async ready => {
    if (disposed || !ready.session) return;
    input.uri = ready.uri; register(input.model.getLanguageId());
    const current = await call<any[]>('language.diagnostics', { workspaceId: input.workspaceId });
    latest = current.find(value => value.uri === ready.uri); updateMarkers();
  }).catch(report);
  const unsubscribe = subscribe(event => {
    if (event.type === 'language.diagnostics' && event.uri === input.uri && Array.isArray(event.diagnostics)) {
      latest = { diagnostics: event.diagnostics, version: event.version }; updateMarkers();
    }
  });
  return { updateMarkers, dispose() { disposed = true; unsubscribe(); bindings.delete(input.model.uri.toString()); monaco.editor.setModelMarkers(input.model, 'graycode-lsp', []); } };
}
