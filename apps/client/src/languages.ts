import * as monaco from 'monaco-editor';
import type { SourceRange, LanguageDiagnostic, LanguageSessionInfo, LanguageDocumentStatus } from '@graycode/contracts';
import type { ServerCapabilities, CompletionItem as LspCompletion, CompletionList, SignatureHelp, CodeAction, Command, WorkspaceEdit } from 'vscode-languageserver-protocol';
import { languageMethodSupported } from '../../../shared/languageSupport';
import { documentLanguageId } from '../../../shared/documentLanguages';
import { completionItems } from '../../../shared/completionItems';
import { call, subscribe } from './api';
import { report } from './state';

// 在创建模型之前停用浏览器内的重复诊断，避免其异步结果覆盖真实工作区的语言服务。
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setModeConfiguration({ ...defaults.modeConfiguration, completionItems: false, hovers: false, definitions: false,
    references: false, documentSymbols: false, rename: false, documentRangeFormattingEdits: false, diagnostics: false, signatureHelp: false, codeActions: false });
  defaults.setDiagnosticsOptions({ ...defaults.getDiagnosticsOptions(), noSyntaxValidation: true, noSemanticValidation: true, noSuggestionDiagnostics: true });
}
for (const defaults of [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults, monaco.html.htmlDefaults, monaco.json.jsonDefaults]) {
  defaults.setModeConfiguration({ ...defaults.modeConfiguration, completionItems: false, hovers: false, documentSymbols: false,
    documentFormattingEdits: false, documentRangeFormattingEdits: false, diagnostics: false,
    ...('definitions' in defaults.modeConfiguration ? { definitions: false, references: false, rename: false } : {}) });
}

interface Binding {
  model: monaco.editor.ITextModel; workspaceId: string; path: string; uri?: string;
  version(): number; flush(): Promise<unknown>;
  open(path: string, range?: monaco.IRange, focus?: boolean): Promise<void>;
  ready?: Promise<unknown>;
  capabilities?: ServerCapabilities;
  diagnostics?: LanguageDiagnostic[];
  status?(state: LanguageDocumentStatus): void;
}
interface LspEdit { range: SourceRange; newText: string }
const bindings = new Map<string, Binding>();
const registered = new Set<string>();
const completionSources = new WeakMap<monaco.languages.CompletionItem, { binding: Binding; value: LspCompletion; modelVersion: number; cursor: monaco.Position }>();
const suggestionProviders = new Map<string, { triggers: string[]; signatures: string[]; retriggers: string[]; dispose(): void }>();
const codeActionSources = new WeakMap<monaco.languages.CodeAction, { binding: Binding; value: CodeAction; modelVersion: number; versions: Map<string, number> }>();
const languageCommands = new Map<string, { binding: Binding; versions: Map<string, number> }>();
export const editorUri = (workspaceId: string, file: string) => monaco.Uri.from({ scheme: 'graycode', authority: workspaceId, path: '/' + file.replaceAll('\\', '/') });
const range = (value: SourceRange) => new monaco.Range(value.start.line + 1, value.start.character + 1, value.end.line + 1, value.end.character + 1);
const position = (value: monaco.Position) => ({ line: value.lineNumber - 1, character: value.column - 1 });
const edit = (value: LspEdit) => ({ range: range(value.range), text: value.newText });
const documentation = (value: string | { value: string } | undefined) => value === undefined ? undefined : { value: typeof value === 'string' ? value : value.value, isTrusted: false, supportHtml: false };

async function request<T>(binding: Binding, method: string, params: Record<string, unknown>, token?: monaco.CancellationToken): Promise<T | null> {
  const version = binding.model.getVersionId();
  const ready = binding.ready;
  let subscription: monaco.IDisposable | undefined;
  try {
    await ready;
    if (!binding.uri || !binding.capabilities || !languageMethodSupported(binding.capabilities, method) || token?.isCancellationRequested) return null;
    await binding.flush();
    if (binding.model.isDisposed() || version !== binding.model.getVersionId() || token?.isCancellationRequested) return null;
    const requestId = crypto.randomUUID();
    subscription = token?.onCancellationRequested(() => { void call('language.cancel', { requestId }); });
    const result = await call<T>('language.request', { workspaceId: binding.workspaceId, path: binding.path,
      version: binding.version(), method, params, requestId });
    return token?.isCancellationRequested || binding.model.isDisposed() || binding.model.getVersionId() !== version || binding.ready !== ready ? null : result;
  } catch (error) {
    if (!token?.isCancellationRequested && !binding.model.isDisposed() && binding.model.getVersionId() === version) report(error);
    return null;
  } finally { subscription?.dispose(); }
}
function completion(value: LspCompletion, binding: Binding, cursor: monaco.Position): monaco.languages.CompletionItem {
  const names = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit',
    'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
  const word = binding.model.getWordUntilPosition(cursor);
  const textEdit = value.textEdit;
  const item: monaco.languages.CompletionItem = { label: value.labelDetails ? { label: value.label, ...value.labelDetails } : value.label,
    kind: monaco.languages.CompletionItemKind[names[(value.kind ?? 1) - 1] as keyof typeof monaco.languages.CompletionItemKind] ?? monaco.languages.CompletionItemKind.Text,
    detail: value.detail, documentation: documentation(value.documentation), sortText: value.sortText, filterText: value.filterText,
    preselect: value.preselect, commitCharacters: value.commitCharacters,
    tags: value.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    command: value.command ? editorCommand(value.command, binding) : undefined,
    insertText: textEdit?.newText ?? value.insertText ?? value.label,
    insertTextRules: value.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range: textEdit && 'range' in textEdit ? range(textEdit.range) : textEdit && 'insert' in textEdit ? { insert: range(textEdit.insert), replace: range(textEdit.replace) }
      : new monaco.Range(cursor.lineNumber, word.startColumn, cursor.lineNumber, word.endColumn),
    additionalTextEdits: value.additionalTextEdits?.map(edit) };
  completionSources.set(item, { binding, value, modelVersion: binding.model.getVersionId(), cursor }); return item;
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
function registerSuggestions(languageId: string, capabilities: ServerCapabilities) {
  const previous = suggestionProviders.get(languageId);
  const merge = (old: string[] = [], next: string[] = []) => [...new Set([...old, ...next])].sort();
  const triggers = merge(previous?.triggers, capabilities.completionProvider?.triggerCharacters);
  const signatures = merge(previous?.signatures, capabilities.signatureHelpProvider?.triggerCharacters);
  const retriggers = merge(previous?.retriggers, capabilities.signatureHelpProvider?.retriggerCharacters);
  if (previous && JSON.stringify([previous.triggers, previous.signatures, previous.retriggers]) === JSON.stringify([triggers, signatures, retriggers])) return;
  previous?.dispose();
  const completionProvider = monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: triggers,
    async provideCompletionItems(model, cursor, context, token) {
      const binding = bindings.get(model.uri.toString()); if (!binding) return;
      const result = await request<LspCompletion[] | CompletionList>(binding, 'textDocument/completion',
        { position: position(cursor), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } }, token);
      return { suggestions: completionItems(result).map(value => completion(value, binding, cursor)), incomplete: !Array.isArray(result) && result?.isIncomplete === true };
    },
    async resolveCompletionItem(item, token) {
      const source = completionSources.get(item); if (!source || source.binding.model.getVersionId() !== source.modelVersion) return item;
      const resolved = await request<LspCompletion>(source.binding, 'completionItem/resolve', source.value as unknown as Record<string, unknown>, token);
      return resolved ? completion({ ...source.value, ...resolved }, source.binding, source.cursor) : item;
    },
  });
  const signatureProvider = monaco.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: signatures, signatureHelpRetriggerCharacters: retriggers,
    async provideSignatureHelp(model, cursor, token, context) {
      const binding = bindings.get(model.uri.toString()); if (!binding) return;
      const value = await request<SignatureHelp>(binding, 'textDocument/signatureHelp', {
        position: position(cursor), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger },
      }, token);
      if (!value?.signatures.length) return;
      return { value: { activeSignature: value.activeSignature ?? 0, activeParameter: value.activeParameter ?? 0,
        signatures: value.signatures.map(signature => ({ ...signature, documentation: documentation(signature.documentation),
          parameters: (signature.parameters ?? []).map(parameter => ({ ...parameter, documentation: documentation(parameter.documentation) })) })) }, dispose() {} };
    },
  });
  suggestionProviders.set(languageId, { triggers, signatures, retriggers, dispose() { completionProvider.dispose(); signatureProvider.dispose(); } });
}
function documentVersions(binding: Binding) {
  return new Map([...bindings].filter(([, item]) => item.workspaceId === binding.workspaceId).map(([uri, item]) => [uri, item.model.getVersionId()]));
}
async function workspaceEdit(binding: Binding, value: WorkspaceEdit, versions: Map<string, number>): Promise<monaco.languages.WorkspaceEdit> {
  const changes: Array<{ uri: string; version?: number | null; edits: LspEdit[] }> = Object.entries(value.changes ?? {}).map(([uri, edits]) => ({ uri, edits }));
  for (const change of value.documentChanges ?? []) {
    if (!('textDocument' in change)) throw new Error('此操作包含文件创建或移动，请通过文件操作处理。');
    changes.push({ ...change.textDocument, edits: change.edits });
  }
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const change of changes) {
    const resource = await target(binding, change.uri, undefined, true);
    const targetBinding = bindings.get(resource.toString());
    if (!targetBinding) throw new Error('目标文件尚未打开，请重试。');
    await targetBinding.flush();
    if (versions.has(resource.toString()) && versions.get(resource.toString()) !== targetBinding.model.getVersionId()) throw new Error('编辑内容已变化，请重新执行操作。');
    if (change.version != null && change.version !== targetBinding.version()) throw new Error('目标文件已变化，请重新执行操作。');
    for (const item of change.edits) edits.push({ resource, textEdit: edit(item), versionId: targetBinding.model.getVersionId() });
  }
  return { edits };
}
function editorCommand(command: Command, binding: Binding, version?: number): monaco.languages.Command {
  return { id: 'graycode.language.command', title: command.title, arguments: [binding.model.uri.toString(), command, version] };
}
monaco.editor.registerCommand('graycode.language.command', async (_accessor, uri: string, command: Command, version?: number) => {
  const binding = bindings.get(uri); if (!binding || binding.model.isDisposed()) return;
  if (version !== undefined && binding.model.getVersionId() !== version) throw new Error('编辑内容已变化，请重新选择修复。');
  await binding.flush();
  const requestId = crypto.randomUUID();
  languageCommands.set(requestId, { binding, versions: documentVersions(binding) });
  try { await call('language.executeCommand', { workspaceId: binding.workspaceId, path: binding.path, version: binding.version(), requestId, command: command.command, arguments: command.arguments }); }
  finally { languageCommands.delete(requestId); }
});
subscribe(event => {
  if (event.type !== 'language.applyEdit') return;
  void (async () => {
    const pending = languageCommands.get(event.requestId);
    try {
      if (!pending || pending.binding.workspaceId !== event.workspaceId) throw new Error('编辑操作已经取消。');
      const changes = await workspaceEdit(pending.binding, event.edit, pending.versions);
      if (!languageCommands.has(event.requestId)) throw new Error('编辑操作已经取消。');
      const grouped = new Map<monaco.editor.ITextModel, monaco.editor.IIdentifiedSingleEditOperation[]>();
      for (const change of changes.edits) {
        if (!('textEdit' in change)) throw new Error('编辑操作没有提供文本内容。');
        const model = monaco.editor.getModel(change.resource);
        if (!model || change.versionId !== undefined && model.getVersionId() !== change.versionId) throw new Error('编辑内容已变化，请重新选择修复。');
        grouped.set(model, [...grouped.get(model) ?? [], { range: monaco.Range.lift(change.textEdit.range), text: change.textEdit.text }]);
      }
      // 使用模型的编辑栈，批量检查版本后同步修改；语言服务不直接写磁盘。
      for (const [model, edits] of grouped) { model.pushStackElement(); model.pushEditOperations([], edits, () => []); model.pushStackElement(); }
      await Promise.all([...grouped.keys()].map(model => bindings.get(model.uri.toString())?.flush()));
      pending.versions = documentVersions(pending.binding);
      await call('language.applyEditResult', { id: event.id, result: { applied: true } });
    } catch (error) {
      await call('language.applyEditResult', { id: event.id, result: { applied: false, failureReason: String(error) } }).catch(() => {});
      report(error);
    }
  })();
});
function register(languageId: string) {
  if (registered.has(languageId)) return;
  registered.add(languageId);
  monaco.languages.registerCodeActionProvider(languageId, {
    async provideCodeActions(model, selection, context, token) {
      const binding = bindings.get(model.uri.toString()); if (!binding) return;
      const versions = documentVersions(binding);
      const values = await request<Array<CodeAction | Command>>(binding, 'textDocument/codeAction', {
        range: { start: position(selection.getStartPosition()), end: position(selection.getEndPosition()) },
        context: { diagnostics: (binding.diagnostics ?? []).filter(item => monaco.Range.areIntersectingOrTouching(range(item.range), selection)),
          only: context.only ? [context.only] : undefined, triggerKind: context.trigger },
      }, token);
      return { actions: (values ?? []).map(value => {
        const action: monaco.languages.CodeAction = { title: value.title };
        if (typeof value.command === 'string') action.command = editorCommand(value as Command, binding, model.getVersionId());
        else {
          const source = value as CodeAction;
          Object.assign(action, { kind: source.kind, isPreferred: source.isPreferred, disabled: source.disabled?.reason,
            command: source.command ? editorCommand(source.command, binding, source.edit ? undefined : model.getVersionId()) : undefined });
          codeActionSources.set(action, { binding, value: source, modelVersion: model.getVersionId(), versions });
        }
        return action;
      }), dispose() {} };
    },
    async resolveCodeAction(action, token) {
      const source = codeActionSources.get(action); if (!source) return action;
      try {
        if (source.binding.model.isDisposed() || source.binding.model.getVersionId() !== source.modelVersion) throw new Error('编辑内容已变化，请重新获取修复。');
        const value = source.value.edit || source.value.command ? source.value
          : await request<CodeAction>(source.binding, 'codeAction/resolve', source.value as unknown as Record<string, unknown>, token);
        const resolved = value ?? source.value;
        if (!resolved.edit && !resolved.command) throw new Error(resolved.disabled?.reason ?? '没有可应用的修改。');
        // Monaco 的解析结果只回填 edit，命令必须留在原条目上。
        action.edit = resolved.edit ? await workspaceEdit(source.binding, resolved.edit, source.versions) : undefined;
        action.command = resolved.command ? editorCommand(resolved.command, source.binding, resolved.edit ? undefined : source.modelVersion) : undefined;
      } catch (error) { action.command = undefined; action.edit = undefined; action.disabled = String(error); report(error); }
      return action;
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
      await binding.ready;
      if (binding.capabilities?.renameProvider && !languageMethodSupported(binding.capabilities, 'textDocument/prepareRename')) {
        const word = model.getWordAtPosition(cursor);
        return word ? { range: new monaco.Range(cursor.lineNumber, word.startColumn, cursor.lineNumber, word.endColumn), text: word.word } : undefined;
      }
      const result = await request<any>(binding, 'textDocument/prepareRename', { position: position(cursor) }, token);
      if (!result) return { range: new monaco.Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column), text: '', rejectReason: '该位置不能重命名。' };
      const selection = range(result.range ?? result);
      return { range: selection, text: result.placeholder ?? model.getValueInRange(selection) };
    },
    async provideRenameEdits(model, cursor, newName, token) {
      const binding = bindings.get(model.uri.toString()); if (!binding) return;
      const versions = documentVersions(binding);
      const result = await request<WorkspaceEdit>(binding, 'textDocument/rename', { position: position(cursor), newName }, token); if (!result) return;
      try { return await workspaceEdit(binding, result, versions) }
      catch (error) { return { edits: [], rejectReason: String(error) } }
    },
  });
}

monaco.editor.registerEditorOpener({ async openCodeEditor(source, resource, selection) {
  if (!['graycode', 'file'].includes(resource.scheme)) return false;
  const binding = bindings.get(source.getModel()?.uri.toString() ?? ''); if (!binding) return false;
  const targetRange = selection ? 'startLineNumber' in selection ? selection : new monaco.Range(selection.lineNumber, selection.column, selection.lineNumber, selection.column) : undefined;
  const file = resource.scheme === 'file' ? await call<string>('language.path', { workspaceId: binding.workspaceId, uri: resource.toString() }) : resource.path.slice(1);
  await binding.open(file, targetRange, true); return true;
} });

export function bindLanguageDocument(input: Binding) {
  let disposed = false;
  let session: LanguageSessionInfo | null | undefined;
  let generation = 0;
  let diagnosticsRevision = 0;
  let paintedMarkers = '';
  let latest: { diagnostics: LanguageDiagnostic[]; version?: number; receivedAtDocumentVersion?: number } | undefined;
  const clearMarkers = () => { latest = undefined; paintedMarkers = ''; input.diagnostics = []; monaco.editor.setModelMarkers(input.model, 'graycode-lsp', []); };
  const updateMarkers = async () => {
    const value = latest, modelVersion = input.model.getVersionId();
    if (disposed || !value) return;
    try { await input.flush() } catch { return }
    const version = value.version ?? value.receivedAtDocumentVersion;
    if (disposed || latest !== value || modelVersion !== input.model.getVersionId() || version !== undefined && version !== input.version()) return;
    input.diagnostics = value.diagnostics;
    const markers = value.diagnostics.map(value => ({ ...range(value.range), message: value.message,
      severity: [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][(value.severity ?? 1) - 1],
      source: value.source, code: value.code === undefined ? undefined : String(value.code), tags: value.tags,
      relatedInformation: value.relatedInformation?.map(item => ({ ...range(item.location.range), resource: monaco.Uri.parse(item.location.uri), message: item.message })) }));
    // 相同诊断不反复重设标记，避免触发额外分析并打断修复菜单的请求。
    const key = JSON.stringify([modelVersion, markers]);
    if (key !== paintedMarkers) { paintedMarkers = key; monaco.editor.setModelMarkers(input.model, 'graycode-lsp', markers); }
  };
  bindings.set(input.model.uri.toString(), input);
  const refresh = () => {
    const currentGeneration = ++generation;
    input.status?.({ languageId: documentLanguageId(input.path) });
    input.ready = call<any>('language.ensure', { workspaceId: input.workspaceId, path: input.path }).then(async ready => {
      if (disposed || currentGeneration !== generation) return;
      session = ready.session; input.uri = ready.uri; input.capabilities = ready.capabilities;
      input.status?.({ languageId: ready.languageId, session, service: ready.service, reason: ready.reason });
      if (!session) { clearMarkers(); return }
      register(input.model.getLanguageId()); registerSuggestions(input.model.getLanguageId(), ready.capabilities);
      const revision = diagnosticsRevision;
      const current = await call<any[]>('language.diagnostics', { workspaceId: input.workspaceId });
      if (disposed || currentGeneration !== generation || revision !== diagnosticsRevision) return;
      latest = current.find(value => value.uri === ready.uri && value.sessionId === session?.id); void updateMarkers();
    }).catch(error => { if (!disposed && currentGeneration === generation) { clearMarkers(); input.status?.({ languageId: documentLanguageId(input.path), session, error: String(error) }); } });
    return input.ready;
  };
  void refresh();
  const unsubscribe = subscribe(event => {
    if (event.type === 'language.configuration') { void refresh(); }
    else if (event.type === 'language.diagnostics' && event.workspaceId === input.workspaceId && event.uri === input.uri &&
      (!event.sessionId || event.sessionId === session?.id) && Array.isArray(event.diagnostics)) {
      diagnosticsRevision++;
      latest = { diagnostics: event.diagnostics, version: event.version, receivedAtDocumentVersion: event.receivedAtDocumentVersion }; void updateMarkers();
    } else if (event.type === 'language.status' && event.session.workspaceId === input.workspaceId && event.session.serverId === session?.serverId) {
      if (event.session.status === 'running') void refresh();
      else { session = event.session; clearMarkers(); input.status?.({ languageId: documentLanguageId(input.path), session }); }
    }
  });
  return { updateMarkers, refresh, clearMarkers, dispose() { disposed = true; generation++; unsubscribe(); bindings.delete(input.model.uri.toString()); clearMarkers(); } };
}
