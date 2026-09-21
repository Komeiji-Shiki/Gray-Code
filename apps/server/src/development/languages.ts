import { workspaceFilePath, workspaceRoots } from '../workspace/paths';
import type { ToolContext } from '@graycode/core';
import { stopOwnedProcess } from '../workspace/processLifecycle';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import spawn from 'cross-spawn';
import { randomUUID } from 'node:crypto';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc/node';
import type { ServerCapabilities, PublishDiagnosticsParams, InitializeResult, WorkspaceEdit, ApplyWorkspaceEditResult } from 'vscode-languageserver-protocol';
import type { DocumentState, LanguageSessionInfo, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { languageMethodSupported } from '../../../../shared/languageSupport';
import { documentLanguageId } from '../../../../shared/documentLanguages';
import { LanguageServerCatalog, type RuntimeLanguageServer } from './languageCatalog';
import { languageCommandSource, languageResultSource, mergeLanguageCapabilities, mergeLanguageResults } from './languageComposition';

interface Session {
  info: LanguageSessionInfo; client: ClientSession; workspace: WorkspaceDefinition; definition: RuntimeLanguageServer;
  child: ChildProcessWithoutNullStreams; connection: MessageConnection; capabilities: ServerCapabilities;
  documents: Map<string, number>; diagnostics: Map<string, PublishDiagnosticsParams & { receivedAtDocumentVersion: number }>;
  changes: Promise<void>; ready: Promise<void>; stderr: string;
  commands: Promise<unknown>; commandRequestId?: string;
  companion?: Session; stopping?: Promise<void>;
}
const methods = new Set(['textDocument/completion', 'completionItem/resolve', 'textDocument/hover', 'textDocument/definition',
  'textDocument/references', 'textDocument/documentSymbol', 'textDocument/rename', 'textDocument/prepareRename', 'textDocument/formatting',
  'textDocument/signatureHelp', 'textDocument/codeAction', 'codeAction/resolve']);
export const documentLanguage = documentLanguageId;

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
  private readonly catalog = new LanguageServerCatalog();
  private readonly sessionStarts = new Map<string, Promise<Session>>();
  private closing = false;
  private configurationSnapshot?: string;
  constructor(private readonly app: PlatformApplication) {}
  definitions(): RuntimeLanguageServer[] {
    const custom = this.app.settings.snapshot().settings.development?.languageServers ?? [];
    return this.catalog.all(custom).filter(entry => entry.info.available).map(entry => entry.definition);
  }
  services(client: ClientSession, custom = this.app.settings.snapshot().settings.development?.languageServers ?? [], refresh = false) {
    this.app.requireOwner(client.actorId);
    return this.catalog.all(custom, refresh).filter(entry => !entry.definition.internal).map(entry => entry.info);
  }
  list(client: ClientSession, refresh = false) {
    return { definitions: this.services(client, undefined, refresh),
      sessions: [...this.sessions.values()].filter(session => session.client.clientId === client.clientId && !session.definition.internal).map(session => session.info) };
  }
  private key(client: ClientSession, workspaceId: string, serverId: string) { return JSON.stringify([client.clientId, workspaceId, serverId]); }
  private accepts(session: Session, file: string) {
    return (session.definition.synchronizedLanguages ?? session.definition.languages).includes(documentLanguage(file));
  }
  /** 同一客户端的并发首次请求共用启动过程；Vue 的辅助服务也遵守同一工作区边界。 */
  private sessionFor(client: ClientSession, workspace: WorkspaceDefinition, definition: RuntimeLanguageServer): Promise<Session> {
    if (this.closing) return Promise.reject(new Error('语言服务正在退出。'));
    const key = this.key(client, workspace.id, definition.id);
    const pending = this.sessionStarts.get(key);
    if (pending) return pending;
    const starting = (async () => {
      let session = this.sessions.get(key);
      if (session?.stopping) await session.stopping;
      if (session?.info.status === 'failed' && session.child.exitCode === null && session.child.signalCode === null) await this.stopSession(session);
      if (session && (JSON.stringify(session.definition) !== JSON.stringify(definition) ||
        JSON.stringify(session.workspace) !== JSON.stringify(workspace))) await this.stopSession(session);
      let companion: Session | undefined;
      if (definition.companionId) {
        const paired = this.definitions().find(value => value.id === definition.companionId);
        if (!paired) throw new Error('语言服务缺少辅助运行程序：' + definition.companionId);
        companion = await this.sessionFor(client, workspace, paired);
      }
      if (session && session.companion !== companion) await this.stopSession(session);
      if (!session || ['stopped', 'failed'].includes(session.info.status)) {
        session = this.create(client, workspace, definition, companion); this.sessions.set(key, session);
      }
      await session.ready;
      return session;
    })();
    this.sessionStarts.set(key, starting);
    return starting.finally(() => { this.sessionStarts.delete(key); });
  }
  async ensure(client: ClientSession, workspaceId: string, file: string) {
    this.app.requireOwner(client.actorId);
    const workspace = this.app.workspace(client.actorId, workspaceId, ['workspace_read']);
    const absolute = await this.app.files.resolve(workspace, file);
    const uri = documentUri(pathToFileURL(absolute).toString());
    const languageId = documentLanguage(file);
    const disabled = this.app.settings.snapshot().settings.development?.disabledLanguageServers ?? [];
    const definition = this.definitions().find(item => item.languages.includes(languageId) && !disabled.includes(item.id));
    if (!definition) {
      const service = this.services(client).find(item => item.languages.includes(languageId));
      const reason = service ? disabled.includes(service.id) ? 'disabled' : 'unavailable' : 'unconfigured';
      return { languageId, uri, session: null, service, reason };
    }
    const session = await this.sessionFor(client, workspace, definition);
    for (const target of session.companion ? [session.companion, session] : [session]) {
      if (!target.documents.has(uri)) for (const doc of this.app.files.clientDocuments(client.clientId, workspaceId))
        if (this.accepts(target, doc.path)) await this.sync(target, doc);
    }
    return { languageId, uri, session: session.info, capabilities: mergeLanguageCapabilities(session.capabilities, session.companion?.capabilities) };
  }
  private create(client: ClientSession, workspace: WorkspaceDefinition, definition: RuntimeLanguageServer, companion?: Session): Session {
    const child = spawn(definition.command, definition.args, { cwd: workspace.directory, shell: false, windowsHide: true,
      env: { ...process.env, ...(definition.command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const session: Session = { info: { id: randomUUID(), serverId: definition.id, name: definition.name, workspaceId: workspace.id, status: 'starting' },
      client, workspace, definition, companion, child, connection, capabilities: {}, documents: new Map(), diagnostics: new Map(), changes: Promise.resolve(), commands: Promise.resolve(), ready: Promise.resolve(), stderr: '' };
    const fail = (error: unknown) => {
      if (session.info.status === 'stopped') return;
      session.info.status = 'failed'; session.info.error = `${String(error)}${session.stderr ? `\n${session.stderr}` : ''}`;
      connection.dispose();
      void stopOwnedProcess(child).catch(stopError => { session.info.error += '\n停止进程失败：' + String(stopError); this.changed(session); });
      this.changed(session);
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
      this.publishDiagnostics(session, uri);
    });
    if (companion) connection.onNotification('tsserver/request', async ([id, command, args]: [number, string, unknown]) => {
      try {
        await companion.ready; await companion.changes;
        const result = await this.timed<{ body?: unknown }>(companion, 'workspace/executeCommand', {
          command: 'typescript.tsserverRequest', arguments: [command, args, { executionTarget: 0, expectsResult: true }],
        });
        await connection.sendNotification('tsserver/response', [id, result?.body]);
      } catch (error) { fail(error); }
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
      } catch (error) { fail(error); await stopOwnedProcess(child); throw new Error(session.info.error ?? String(error), { cause: error }); }
    })();
    return session;
  }
  private changed(session: Session) {
    if (!session.definition.internal) this.app.publish({ type: 'language.status', clientId: session.client.clientId, session: session.info });
  }
  private async timed<T>(session: Session, method: string, params: unknown, cancellation?: CancellationTokenSource, timeout = 30_000): Promise<T> {
    const source = cancellation ?? new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([session.connection.sendRequest<T>(method, params, source.token), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { source.cancel(); reject(new Error(`语言服务请求超时：${method}`)); }, timeout);
      })]);
    } finally { clearTimeout(timer); if (!cancellation) source.dispose(); }
  }
  private sync(session: Session, doc: DocumentState, saved = false): Promise<void> {
    const next = session.changes.catch(() => {}).then(async () => {
      await session.ready;
      await session.companion?.changes;
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
      this.accepts(session, doc.path) && !['failed', 'stopped'].includes(session.info.status))
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
    if (this.app.files.documentVersion(client.clientId, input.workspaceId, input.path) !== input.version) throw new Error('编辑草稿已变化，请重新请求。');
    await session.changes;
    const requestKey = JSON.stringify([client.clientId, input.requestId]);
    if (this.requests.has(requestKey)) throw new Error('语言服务请求标识重复。');
    const cancellation = new CancellationTokenSource(); this.requests.set(requestKey, cancellation);
    try {
      const params = ['completionItem/resolve', 'codeAction/resolve'].includes(input.method) ? input.params : { ...input.params, textDocument: { uri: ready.uri } };
      return await this.invoke(session, input.method, params, cancellation);
    } finally { cancellation.dispose(); this.requests.delete(requestKey); }
  }
  private async invoke(session: Session, method: string, params: Record<string, unknown> | undefined, cancellation: CancellationTokenSource): Promise<unknown> {
    const members = session.companion ? [session, session.companion] : [session];
    const routed = ['completionItem/resolve', 'codeAction/resolve'].includes(method) ? languageResultSource(params) : { params: params ?? {}, source: undefined };
    const targets = routed.source ? members.filter(member => member.info.id === routed.source) : members.filter(member => languageMethodSupported(member.capabilities, method));
    if (routed.source && !targets.length) throw new Error('语言服务已重启，请重新选择补全或修复。');
    if (!targets.length) return null;
    const execute = async (target: Session) => {
      await target.changes;
      return { source: target.info.id, value: languageMethodSupported(target.capabilities, method)
        ? await this.timed<unknown>(target, method, routed.params, cancellation) : routed.params };
    };
    if (!session.companion) return (await execute(targets[0])).value;
    const combined = ['textDocument/completion', 'textDocument/codeAction', 'textDocument/definition', 'textDocument/references', 'textDocument/hover'];
    if (combined.includes(method)) return mergeLanguageResults(method, await Promise.all(targets.map(execute)));
    for (const target of targets) {
      const value = mergeLanguageResults(method, [await execute(target)]);
      if (value !== null) return value;
    }
    return null;
  }
  cancel(client: ClientSession, requestId: string) { this.requests.get(JSON.stringify([client.clientId, requestId]))?.cancel(); }
  async executeCommand(client: ClientSession, input: { workspaceId: string; path: string; version: number; requestId: string; command: string; arguments?: unknown[] }) {
    const ready = await this.ensure(client, input.workspaceId, input.path);
    if (!ready.session) throw new Error('当前文件没有可用的语言服务。');
    const session = [...this.sessions.values()].find(item => item.info.id === ready.session!.id)!;
    const members = session.companion ? [session, session.companion] : [session];
    const routed = languageCommandSource(input.command);
    const target = routed.source ? members.find(member => member.info.id === routed.source)
      : members.find(member => member.capabilities.executeCommandProvider?.commands.includes(routed.command)) ?? session;
    if (!target) throw new Error('语言服务已重启，请重新选择修复。');
    const operation = session.commands.catch(() => {}).then(async () => {
      await Promise.all(members.map(member => member.changes));
      if (this.app.files.documentVersion(client.clientId, input.workspaceId, input.path) !== input.version) throw new Error('编辑草稿已变化，请重新选择修复。');
      const requestKey = JSON.stringify([client.clientId, input.requestId]);
      if (this.requests.has(requestKey)) throw new Error('语言服务请求标识重复。');
      const cancellation = new CancellationTokenSource(); this.requests.set(requestKey, cancellation);
      for (const member of members) member.commandRequestId = input.requestId;
      try { return await this.timed(target, 'workspace/executeCommand', { command: routed.command, arguments: input.arguments }, cancellation) }
      finally {
        for (const member of members) member.commandRequestId = undefined;
        cancellation.dispose(); this.requests.delete(requestKey);
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
    const session = await this.sessionFor(client, workspace, definition);
    context.signal.throwIfAborted();
    const uri = documentUri(pathToFileURL(absolute).toString());
    for (const current of session.companion ? [session.companion, session] : [session]) {
      const synchronized = current.changes.catch(() => {}).then(async () => {
        const version = current.documents.get(uri);
        if (version === undefined) await current.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
        else await current.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] });
        current.documents.set(uri, (version ?? 0) + 1);
      });
      current.changes = synchronized; await synchronized;
    }
    const cancellation = new CancellationTokenSource(); const cancel = () => cancellation.cancel();
    context.signal.addEventListener('abort', cancel, { once: true });
    try { context.signal.throwIfAborted(); return await this.invoke(session, method, { ...params, textDocument: { uri } }, cancellation); }
    finally { cancellation.dispose(); context.signal.removeEventListener('abort', cancel); }
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
    return [...this.sessions.values()].filter(session => session.client.clientId === client.clientId && session.workspace.id === workspaceId && !session.definition.internal)
      .flatMap(session => [...session.documents.keys()].filter(uri => session.diagnostics.has(uri) || session.companion?.diagnostics.has(uri))
        .map(uri => this.diagnosticSnapshot(session, uri)));
  }
  private diagnosticSnapshot(session: Session, uri: string, version = session.documents.get(uri)) {
    const members = session.companion ? [session, session.companion] : [session];
    const diagnostics = version === undefined ? [] : members.flatMap(member => {
      const value = member.diagnostics.get(uri);
      return value?.receivedAtDocumentVersion === version ? value.diagnostics : [];
    });
    return { sessionId: session.info.id, uri, version, receivedAtDocumentVersion: version,
      path: workspaceFilePath(session.workspace, fileURLToPath(uri)),
      diagnostics: [...new Map(diagnostics.map(value => [JSON.stringify(value), value])).values()] };
  }
  private publishDiagnostics(session: Session, uri: string, version?: number) {
    const targets = session.definition.internal ? [...this.sessions.values()].filter(value => value.companion === session && value.documents.has(uri)) : [session];
    for (const target of targets) this.app.publish({ type: 'language.diagnostics', clientId: target.client.clientId, workspaceId: target.workspace.id,
      ...this.diagnosticSnapshot(target, uri, version) });
  }
  private clearDiagnostics(session: Session, uri: string, version?: number) {
    session.diagnostics.delete(uri);
    this.publishDiagnostics(session, uri, version);
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
  private stopSession(session: Session): Promise<void> {
    if (session.stopping) return session.stopping;
    session.info.status = 'stopped';
    session.stopping = (async () => {
      // 完成协议关闭后，在父进程仍存活时结束进程树，避免 exit 提前退出后留下后台分析子进程。
      try { await this.timed(session, 'shutdown', null, undefined, 3000); } catch { /* 已退出的语言服务直接释放。 */ }
      session.connection.dispose(); await stopOwnedProcess(session.child);
      if (session.companion) await this.stopSession(session.companion);
      for (const uri of [...session.documents.keys()]) { session.documents.delete(uri); this.clearDiagnostics(session, uri); }
      session.diagnostics.clear(); this.changed(session);
    })().catch(error => { session.stopping = undefined; session.info.status = 'failed'; session.info.error = String(error); this.changed(session); throw error; });
    return session.stopping;
  }
  async configure(): Promise<void> {
    const snapshot = this.app.settings.snapshot().settings;
    const settings = snapshot.development;
    const key = JSON.stringify({ servers: settings?.languageServers, disabled: settings?.disabledLanguageServers, workspaces: snapshot.workspaces });
    if (key === this.configurationSnapshot) return;
    const definitions = this.definitions();
    const selected = (file: string) => definitions.find(value => value.languages.includes(documentLanguage(file)) && !settings?.disabledLanguageServers?.includes(value.id));
    const results = await Promise.allSettled([...this.sessions.values()].filter(session => settings?.disabledLanguageServers?.includes(session.definition.id) ||
      JSON.stringify(definitions.find(item => item.id === session.definition.id)) !== JSON.stringify(session.definition) ||
      !session.definition.internal && session.documents.size > 0 && ![...session.documents.keys()].some(uri => selected(fileURLToPath(uri))?.id === session.definition.id) ||
      !session.client.clientId.startsWith('language-tool:') && JSON.stringify(snapshot.workspaces.find(item => item.id === session.workspace.id)) !== JSON.stringify(session.workspace)).map(session => this.stopSession(session)));
    this.app.publish({ type: 'language.configuration' });
    const failed = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(value => value.reason), '部分语言服务未能应用设置，请检查进程状态后重试。');
    this.configurationSnapshot = key;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.sessionStarts.values()]);
    await Promise.allSettled([...this.sessions.values()].map(session => this.stopSession(session)));
  }
}
