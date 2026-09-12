import { workspaceFilePath, workspaceRoots } from '../workspace/paths';
import type { ToolContext } from '@graycode/core';
import { stopDevelopmentProcess } from './process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc/node';
import type { ServerCapabilities, PublishDiagnosticsParams, InitializeResult, WorkspaceEdit, ApplyWorkspaceEditResult } from 'vscode-languageserver-protocol';
import type { DocumentState, LanguageServerDefinition, LanguageSessionInfo, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { languageMethodSupported } from '../../../../shared/languageSupport';

interface Session {
  info: LanguageSessionInfo; client: ClientSession; workspace: WorkspaceDefinition; definition: LanguageServerDefinition;
  child: ChildProcessWithoutNullStreams; connection: MessageConnection; capabilities: ServerCapabilities;
  documents: Map<string, number>; diagnostics: Map<string, PublishDiagnosticsParams & { receivedAtDocumentVersion: number }>;
  changes: Promise<void>; ready: Promise<void>; stderr: string;
  commands: Promise<unknown>; commandRequestId?: string;
}
const languageIds: Record<string, string> = { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.mts': 'typescript', '.cts': 'typescript', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.rs': 'rust', '.go': 'go', '.vue': 'vue', '.json': 'json', '.css': 'css', '.html': 'html' };
const methods = new Set(['textDocument/completion', 'completionItem/resolve', 'textDocument/hover', 'textDocument/definition',
  'textDocument/references', 'textDocument/documentSymbol', 'textDocument/rename', 'textDocument/prepareRename', 'textDocument/formatting',
  'textDocument/signatureHelp', 'textDocument/codeAction', 'codeAction/resolve']);
export const documentLanguage = (file: string) => languageIds[path.extname(file).toLowerCase()] ?? 'plaintext';

// 语言服务可能编码盘符冒号或改变盘符大小写，统一成同一个文档标识。
function documentUri(value: string): string {
  try {
    let file = fileURLToPath(value);
    if (process.platform === 'win32') file = file.replace(/^[A-Z]:/, drive => drive.toLowerCase());
    return pathToFileURL(file).toString();
  } catch { return value; }
}

/** 每个客户端和工作区拥有独立语言进程，未保存草稿不会互相覆盖。 */
export class LanguageServices {
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, CancellationTokenSource>();
  private readonly editorEdits = new Map<string, { clientId: string; requestId: string; resolve(value: ApplyWorkspaceEditResult): void }>();
  constructor(private readonly app: PlatformApplication) {}
  definitions(): LanguageServerDefinition[] {
    const custom = this.app.settings.snapshot().settings.development?.languageServers ?? [];
    return [...custom, { id: 'typescript', name: 'TypeScript / JavaScript', languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
      command: process.execPath, args: [require.resolve('typescript-language-server/lib/cli.mjs'), '--stdio'],
      initializationOptions: { hostInfo: 'GrayCode', disableAutomaticTypingAcquisition: true,
        // 初次语义请求等待完整项目解析，不使用只掌握当前文件的临时语法结果。
        tsserver: { path: require.resolve('typescript/lib/tsserver.js'), useSyntaxServer: 'never' } } }];
  }
  list(client: ClientSession) {
    this.app.requireOwner(client.actorId);
    return { definitions: this.definitions().map(({ id, name, languages }) => ({ id, name, languages })),
      sessions: [...this.sessions.values()].filter(session => session.client.clientId === client.clientId).map(session => session.info) };
  }
  private key(client: ClientSession, workspaceId: string, serverId: string) { return JSON.stringify([client.clientId, workspaceId, serverId]); }
  async ensure(client: ClientSession, workspaceId: string, file: string) {
    this.app.requireOwner(client.actorId);
    const workspace = this.app.workspace(client.actorId, workspaceId, ['workspace_read']);
    const absolute = await this.app.files.resolve(workspace, file);
    const uri = documentUri(pathToFileURL(absolute).toString());
    const languageId = documentLanguage(file);
    const disabled = this.app.settings.snapshot().settings.development?.disabledLanguageServers ?? [];
    const definition = this.definitions().find(item => item.languages.includes(languageId) && !disabled.includes(item.id));
    if (!definition) return { languageId, uri, session: null };
    const key = this.key(client, workspaceId, definition.id);
    let session = this.sessions.get(key);
    let hydrate = false;
    if (session && (JSON.stringify(session.definition) !== JSON.stringify(definition) || JSON.stringify(session.workspace) !== JSON.stringify(workspace))) await this.stopSession(session);
    if (!session || ['stopped', 'failed'].includes(session.info.status)) {
      session = this.create(client, workspace, definition); this.sessions.set(key, session); hydrate = true;
    }
    await session.ready;
    if (hydrate || !session.documents.has(uri))
      for (const doc of this.app.files.clientDocuments(client.clientId, workspaceId)) if (definition.languages.includes(documentLanguage(doc.path))) await this.sync(session, doc);
    return { languageId, uri, session: session.info, capabilities: session.capabilities };
  }
  private create(client: ClientSession, workspace: WorkspaceDefinition, definition: LanguageServerDefinition): Session {
    const child = spawn(definition.command, definition.args, { cwd: workspace.directory, shell: false, windowsHide: true,
      env: { ...process.env, ...(definition.command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'pipe' });
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const session: Session = { info: { id: randomUUID(), serverId: definition.id, name: definition.name, workspaceId: workspace.id, status: 'starting' },
      client, workspace, definition, child, connection, capabilities: {}, documents: new Map(), diagnostics: new Map(), changes: Promise.resolve(), commands: Promise.resolve(), ready: Promise.resolve(), stderr: '' };
    const fail = (error: unknown) => {
      if (session.info.status === 'stopped') return;
      session.info.status = 'failed'; session.info.error = `${String(error)}${session.stderr ? `\n${session.stderr}` : ''}`;
      connection.dispose(); void stopDevelopmentProcess(child); this.changed(session);
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(`语言服务已退出：${code ?? signal}`));
    child.stderr.on('data', bytes => { session.stderr = (session.stderr + bytes.toString()).slice(-8192); });
    connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
      if (typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
      const uri = documentUri(params.uri);
      const version = session.documents.get(uri);
      if (version === undefined || params.version !== undefined && params.version !== version) return;
      session.diagnostics.set(uri, { ...params, uri, receivedAtDocumentVersion: version });
      this.app.publish({ type: 'language.diagnostics', clientId: client.clientId, workspaceId: workspace.id, sessionId: session.info.id,
        ...params, uri, path: workspaceFilePath(workspace, fileURLToPath(uri)), receivedAtDocumentVersion: version });
    });
    connection.onRequest('workspace/configuration', (params: { items: { section?: string }[] }) => params.items.map(item => {
      let value: unknown = definition.settings ?? {};
      for (const key of item.section?.split('.') ?? []) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
      return value ?? null;
    }));
    connection.onRequest('workspace/workspaceFolders', () => workspaceRoots(workspace).map(root => ({ uri: pathToFileURL(root.directory).toString(), name: root.name })));
    connection.onRequest('workspace/applyEdit', (params: { edit: WorkspaceEdit; label?: string }) => {
      const requestId = session.commandRequestId;
      if (!requestId) return { applied: false, failureReason: '请从编辑器选择要执行的修复或重构。' };
      const id = randomUUID();
      return new Promise<ApplyWorkspaceEditResult>(resolve => {
        this.editorEdits.set(id, { clientId: client.clientId, requestId, resolve });
        this.app.publish({ type: 'language.applyEdit', clientId: client.clientId, workspaceId: workspace.id, requestId, id, ...params });
      });
    });
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('window/showMessageRequest', () => null);
    connection.onNotification('window/showMessage', (params: { message: string; type: number }) => {
      this.app.publish({ type: 'language.message', clientId: client.clientId, sessionId: session.info.id, message: params.message, severity: params.type });
    });
    connection.onError(([error]) => fail(error));
    connection.listen();
    session.ready = (async () => {
      try {
        const result = await this.timed<InitializeResult>(session, 'initialize', { processId: process.pid,
          clientInfo: { name: 'GrayCode', version: '0.1.0' }, rootUri: pathToFileURL(workspace.directory).toString(),
          workspaceFolders: workspaceRoots(workspace).map(root => ({ uri: pathToFileURL(root.directory).toString(), name: root.name })),
          capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: true, workspaceEdit: { documentChanges: true } },
            textDocument: { synchronization: { dynamicRegistration: false, didSave: true },
              completion: { contextSupport: true, completionItem: { snippetSupport: true, insertReplaceSupport: true, labelDetailsSupport: true,
                commitCharactersSupport: true, tagSupport: { valueSet: [1] }, documentationFormat: ['markdown', 'plaintext'],
                resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] } },
                completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'data'] } },
              signatureHelp: { contextSupport: true, signatureInformation: { documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
              codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } },
                isPreferredSupport: true, disabledSupport: true, dataSupport: true, resolveSupport: { properties: ['edit'] } },
              hover: { contentFormat: ['markdown', 'plaintext'] }, definition: { linkSupport: true },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true }, rename: { prepareSupport: true },
              publishDiagnostics: { versionSupport: true, relatedInformation: true, dataSupport: true, tagSupport: { valueSet: [1, 2] } } } },
          initializationOptions: definition.initializationOptions });
        session.capabilities = result.capabilities;
        await connection.sendNotification('initialized', {});
        if (definition.settings) await connection.sendNotification('workspace/didChangeConfiguration', { settings: definition.settings });
        session.info.status = 'running'; this.changed(session);
      } catch (error) { fail(error); await stopDevelopmentProcess(child); throw error; }
    })();
    return session;
  }
  private changed(session: Session) { this.app.publish({ type: 'language.status', clientId: session.client.clientId, session: session.info }); }
  private async timed<T>(session: Session, method: string, params: unknown, cancellation = new CancellationTokenSource(), timeout = 30_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([session.connection.sendRequest<T>(method, params, cancellation.token), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { cancellation.cancel(); reject(new Error(`语言服务请求超时：${method}`)); }, timeout);
      })]);
    } finally { clearTimeout(timer); cancellation.dispose(); }
  }
  private sync(session: Session, doc: DocumentState, saved = false): Promise<void> {
    const next = session.changes.catch(() => {}).then(async () => {
      await session.ready;
      const uri = documentUri(pathToFileURL(await this.app.files.resolve(session.workspace, doc.path)).toString());
      const previous = session.documents.get(uri);
      if (previous === undefined) {
        await session.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: documentLanguage(doc.path), version: doc.version, text: doc.text } });
      } else if (previous < doc.version) {
        this.clearDiagnostics(session, uri, doc.version);
        await session.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text: doc.text }] });
      }
      if (previous === undefined || previous < doc.version) session.documents.set(uri, doc.version);
      if (saved) await session.connection.sendNotification('textDocument/didSave', { textDocument: { uri }, text: doc.text });
    });
    session.changes = next; return next;
  }
  documentChanged(doc: DocumentState, saved = false): void {
    for (const session of this.sessions.values()) if (session.client.clientId === doc.clientId && session.workspace.id === doc.workspaceId &&
      session.definition.languages.includes(documentLanguage(doc.path)) && !['failed', 'stopped'].includes(session.info.status))
      void this.sync(session, doc, saved).catch(error => { session.info.error = String(error); this.changed(session); });
  }
  async documentClosed(client: ClientSession, workspaceId: string, file: string): Promise<void> {
    for (const session of this.sessions.values()) if (session.client.clientId === client.clientId && session.workspace.id === workspaceId) {
      await session.changes.catch(() => {});
      const uri = documentUri(pathToFileURL(await this.app.files.resolve(session.workspace, file)).toString());
      if (session.documents.delete(uri) && session.info.status === 'running') await session.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
      this.clearDiagnostics(session, uri);
      if (!session.documents.size) await this.stopSession(session);
    }
  }
  async request(client: ClientSession, input: { workspaceId: string; path: string; version: number; method: string; params?: Record<string, unknown>; requestId: string }) {
    if (!methods.has(input.method) || typeof input.requestId !== 'string') throw new Error('不支持此语言服务请求。');
    const ready = await this.ensure(client, input.workspaceId, input.path);
    if (!ready.session) return null;
    const session = [...this.sessions.values()].find(item => item.info.id === ready.session!.id)!;
    if (!languageMethodSupported(session.capabilities, input.method)) return null;
    if (this.app.files.documentVersion(client.clientId, input.workspaceId, input.path) !== input.version) throw new Error('编辑草稿已变化，请重新请求。');
    await session.changes;
    const requestKey = JSON.stringify([client.clientId, input.requestId]);
    if (this.requests.has(requestKey)) throw new Error('语言服务请求标识重复。');
    const cancellation = new CancellationTokenSource(); this.requests.set(requestKey, cancellation);
    try {
      const params = ['completionItem/resolve', 'codeAction/resolve'].includes(input.method) ? input.params : { ...input.params, textDocument: { uri: ready.uri } };
      return await this.timed(session, input.method, params, cancellation);
    } finally { this.requests.delete(requestKey); }
  }
  cancel(client: ClientSession, requestId: string) { this.requests.get(JSON.stringify([client.clientId, requestId]))?.cancel(); }
  async executeCommand(client: ClientSession, input: { workspaceId: string; path: string; version: number; requestId: string; command: string; arguments?: unknown[] }) {
    const ready = await this.ensure(client, input.workspaceId, input.path);
    if (!ready.session) throw new Error('当前文件没有可用的语言服务。');
    const session = [...this.sessions.values()].find(item => item.info.id === ready.session!.id)!;
    const operation = session.commands.catch(() => {}).then(async () => {
      await session.changes;
      if (this.app.files.documentVersion(client.clientId, input.workspaceId, input.path) !== input.version) throw new Error('编辑草稿已变化，请重新选择修复。');
      const requestKey = JSON.stringify([client.clientId, input.requestId]);
      if (this.requests.has(requestKey)) throw new Error('语言服务请求标识重复。');
      const cancellation = new CancellationTokenSource(); this.requests.set(requestKey, cancellation);
      session.commandRequestId = input.requestId;
      try { return await this.timed(session, 'workspace/executeCommand', { command: input.command, arguments: input.arguments }, cancellation) }
      finally {
        session.commandRequestId = undefined; this.requests.delete(requestKey);
        for (const [id, pending] of this.editorEdits) if (pending.clientId === client.clientId && pending.requestId === input.requestId) {
          this.editorEdits.delete(id); pending.resolve({ applied: false, failureReason: '编辑操作已结束或取消。' });
        }
      }
    });
    session.commands = operation; return operation;
  }
  completeEditorEdit(client: ClientSession, id: string, result: ApplyWorkspaceEditResult) {
    const pending = this.editorEdits.get(id);
    if (!pending || pending.clientId !== client.clientId) throw new Error('编辑请求不属于当前客户端或已经结束。');
    this.editorEdits.delete(id); pending.resolve({ applied: result.applied === true, failureReason: result.failureReason });
    return { success: true };
  }
  /** 模型读取使用独立文档缓冲，文件正文已由工具的读取策略确认。 */
  async toolRequest(context: ToolContext, absolute: string, text: string, method: string, params: Record<string, unknown> = {}) {
    if (!context.workspace || !context.conversationId || !['textDocument/definition', 'textDocument/references', 'textDocument/documentSymbol'].includes(method)) throw new Error('代码导航请求无效。');
    const workspace = this.app.workspace(context.actorId, context.workspace.id, ['workspace_read', 'process_execute']);
    const client = { actorId: context.actorId, clientId: `language-tool:${context.runId}` };
    const languageId = documentLanguage(absolute);
    const disabled = this.app.settings.snapshot().settings.development?.disabledLanguageServers ?? [];
    const definition = this.definitions().find(item => item.languages.includes(languageId) && !disabled.includes(item.id));
    if (!definition) throw new Error(`没有为 ${languageId} 配置语言服务。`);
    const key = this.key(client, workspace.id, definition.id);
    let session = this.sessions.get(key);
    if (!session || ['failed', 'stopped'].includes(session.info.status)) { session = this.create(client, workspace, definition); this.sessions.set(key, session); }
    await session.ready; context.signal.throwIfAborted();
    const current = session;
    const uri = documentUri(pathToFileURL(absolute).toString());
    const synchronized = current.changes.catch(() => {}).then(async () => {
      const version = current.documents.get(uri);
      if (version === undefined) await current.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
      else await current.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] });
      current.documents.set(uri, (version ?? 0) + 1);
    });
    current.changes = synchronized; await synchronized;
    const cancellation = new CancellationTokenSource(); const cancel = () => cancellation.cancel();
    context.signal.addEventListener('abort', cancel, { once: true });
    try { context.signal.throwIfAborted(); return await this.timed<unknown>(current, method, { ...params, textDocument: { uri } }, cancellation, 20_000); }
    finally { context.signal.removeEventListener('abort', cancel); }
  }
  async finishToolRun(runId: string) {
    const clientId = `language-tool:${runId}`;
    for (const [key, session] of this.sessions) if (session.client.clientId === clientId) { await this.stopSession(session); this.sessions.delete(key); }
  }
  async relativePath(client: ClientSession, workspaceId: string, uri: string): Promise<string> {
    this.app.requireOwner(client.actorId);
    const workspace = this.app.workspace(client.actorId, workspaceId, ['workspace_read']);
    const absolute = await this.app.files.resolve(workspace, fileURLToPath(uri));
    return workspaceFilePath(workspace, absolute);
  }
  diagnostics(client: ClientSession, workspaceId: string) {
    this.app.requireOwner(client.actorId);
    return [...this.sessions.values()].filter(session => session.client.clientId === client.clientId && session.workspace.id === workspaceId)
      .flatMap(session => [...session.diagnostics.values()].map(item => ({ sessionId: session.info.id, ...item,
        path: workspaceFilePath(session.workspace, fileURLToPath(item.uri)) })));
  }
  private clearDiagnostics(session: Session, uri: string, version?: number) {
    session.diagnostics.delete(uri);
    this.app.publish({ type: 'language.diagnostics', clientId: session.client.clientId, workspaceId: session.workspace.id,
      sessionId: session.info.id, uri, path: workspaceFilePath(session.workspace, fileURLToPath(uri)), version, diagnostics: [] });
  }
  async stop(client: ClientSession, id: string) {
    this.app.requireOwner(client.actorId);
    const session = [...this.sessions.values()].find(item => item.info.id === id && item.client.clientId === client.clientId);
    if (session) await this.stopSession(session);
  }
  async restart(client: ClientSession, id: string) {
    this.app.requireOwner(client.actorId);
    const session = [...this.sessions.values()].find(item => item.info.id === id && item.client.clientId === client.clientId);
    if (!session) throw new Error('语言服务会话不存在。');
    await this.stopSession(session);
    const doc = this.app.files.clientDocuments(client.clientId, session.workspace.id).find(item => session.definition.languages.includes(documentLanguage(item.path)));
    return doc ? this.ensure(client, doc.workspaceId, doc.path) : null;
  }
  private async stopSession(session: Session): Promise<void> {
    session.info.status = 'stopped';
    try { await this.timed(session, 'shutdown', null, undefined, 3000); await session.connection.sendNotification('exit'); } catch { /* 已退出的语言服务直接释放。 */ }
    session.connection.dispose(); await stopDevelopmentProcess(session.child);
    for (const uri of session.documents.keys()) this.clearDiagnostics(session, uri);
    session.diagnostics.clear(); this.changed(session);
  }
  async configure(): Promise<void> {
    if (!this.sessions.size) return;
    const settings = this.app.settings.snapshot().settings.development;
    const definitions = this.definitions();
    await Promise.allSettled([...this.sessions.values()].filter(session => settings?.disabledLanguageServers?.includes(session.definition.id) ||
      JSON.stringify(definitions.find(item => item.id === session.definition.id)) !== JSON.stringify(session.definition) ||
      !session.client.clientId.startsWith('language-tool:') && JSON.stringify(this.app.settings.snapshot().settings.workspaces.find(item => item.id === session.workspace.id)) !== JSON.stringify(session.workspace)).map(session => this.stopSession(session)));
  }
  async close(): Promise<void> { await Promise.allSettled([...this.sessions.values()].map(session => this.stopSession(session))); }
}
