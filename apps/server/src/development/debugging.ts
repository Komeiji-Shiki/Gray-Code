import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { DebugBreakpoint, DebugBreakpointResult, DebugConfiguration, DebugOutput, DebugSessionInfo, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { DapConnection } from './dapConnection';
import { DebugAdapterCatalog, type DebugAdapterRuntime } from './debugAdapters';
import { validateDebugBreakpoints, validateDebugConfiguration } from './debugSettings';
import { workspaceFilePath } from '../workspace/paths';
import type { DebugTerminalProgram } from '../workspace/interactiveTerminals';

interface Session {
  info: DebugSessionInfo; client: ClientSession; workspace: WorkspaceDefinition; configuration: DebugConfiguration;
  connection?: DapConnection; ready?: Promise<void>; runtime?: DebugAdapterRuntime; opening?: Promise<DebugAdapterRuntime>; stopping?: Promise<void>;
  programs: DebugTerminalProgram[];
  output: DebugOutput[]; outputSequence: number; executionRevision: number; breakpointResults: Record<string, DebugBreakpointResult[]>;
}
const finished = (session: Session) => ['terminated', 'failed'].includes(session.info.status);
const requestMethods = new Set(['threads', 'stackTrace', 'scopes', 'variables', 'evaluate', 'continue', 'pause', 'next', 'stepIn', 'stepOut',
  'setVariable', 'setExpression', 'exceptionInfo', 'source', 'loadedSources', 'completions']);

/** 调试句柄只对创建它的客户端开放，根会话统一管理适配器与子会话。 */
export class DebugServices {
  private readonly sessions = new Map<string, Session>();
  private readonly catalog = new DebugAdapterCatalog();
  private closing = false;
  constructor(private readonly app: PlatformApplication) {}
  private workspace(client: ClientSession, id: string, execute = false) {
    this.app.requireOwner(client.actorId);
    return this.app.workspace(client.actorId, id, [execute ? 'process_execute' : 'workspace_read']);
  }
  async adapters(client: ClientSession, refresh = false) {
    this.app.requireOwner(client.actorId);
    return this.catalog.list(this.app.settings.snapshot().settings.development?.debugAdapters ?? [], refresh);
  }
  async settings(client: ClientSession, workspaceId: string) {
    this.workspace(client, workspaceId);
    const [configurations, breakpoints] = await Promise.all([
      this.app.storage.getVersionedRecord('debug-configurations', workspaceId), this.app.storage.getVersionedRecord('debug-breakpoints', workspaceId),
    ]);
    return { configurations: (configurations.value ?? []) as DebugConfiguration[], breakpoints: (breakpoints.value ?? []) as DebugBreakpoint[],
      configurationRevision: configurations.revision, breakpointRevision: breakpoints.revision };
  }
  async saveConfigurations(client: ClientSession, workspaceId: string, values: DebugConfiguration[], expectedRevision: number | null) {
    this.workspace(client, workspaceId);
    if (!Array.isArray(values)) throw new Error('调试配置列表无效。');
    const ids = new Set<string>();
    for (const value of values) { validateDebugConfiguration(value); if (ids.has(value.id)) throw new Error('调试配置标识重复。'); ids.add(value.id); }
    if (expectedRevision === undefined) throw new Error('请先读取当前调试配置，再保存修改。');
    await this.app.storage.commitRecords([{ namespace: 'debug-configurations', id: workspaceId, value: values, expectedRevision }]);
    this.app.publish({ type: 'debug.configuration', workspaceId });
    return this.settings(client, workspaceId);
  }
  async setBreakpoints(client: ClientSession, workspaceId: string, breakpoints: DebugBreakpoint[], expectedRevision: number | null) {
    const workspace = this.workspace(client, workspaceId);
    validateDebugBreakpoints(breakpoints);
    for (const file of new Set(breakpoints.map(value => value.path))) await this.app.files.resolve(workspace, file);
    const previous = (await this.settings(client, workspaceId)).breakpoints;
    if (expectedRevision === undefined) throw new Error('请先读取当前断点，再保存修改。');
    await this.app.storage.commitRecords([{ namespace: 'debug-breakpoints', id: workspaceId, value: breakpoints, expectedRevision }]);
    this.app.publish({ type: 'debug.breakpoints', workspaceId, breakpoints });
    const paths = [...new Set([...previous, ...breakpoints].map(value => value.path))];
    const live = [...this.sessions.values()].filter(session => session.workspace.id === workspaceId && !finished(session) && session.connection);
    for (const session of live) for (const file of paths) await this.applyBreakpoints(session, file, breakpoints);
    return this.settings(client, workspaceId);
  }
  list(client: ClientSession, workspaceId?: string) {
    this.app.requireOwner(client.actorId);
    return [...this.sessions.values()].filter(session => session.client.clientId === client.clientId && (!workspaceId || session.workspace.id === workspaceId)).map(session => structuredClone(session.info));
  }
  private get(client: ClientSession, id: string) {
    this.app.requireOwner(client.actorId);
    const session = this.sessions.get(id);
    if (!session || session.client.clientId !== client.clientId) throw new Error('调试会话不属于当前窗口。');
    return session;
  }
  snapshot(client: ClientSession, id: string) {
    const session = this.get(client, id);
    return structuredClone({ session: session.info, output: session.output, breakpoints: session.breakpointResults });
  }
  async sourcePath(client: ClientSession, workspaceId: string, file: string) {
    const workspace = this.workspace(client, workspaceId);
    return workspaceFilePath(workspace, await this.app.files.resolve(workspace, file));
  }
  private changed(session: Session) { this.app.publish({ type: 'debug.session', clientId: session.client.clientId, session: structuredClone(session.info) }); }
  private output(session: Session, category: string, text: string, extra: Partial<DebugOutput> = {}) {
    const entry = { ...extra, sequence: ++session.outputSequence, category, output: text.slice(-200_000) };
    session.output.push(entry);
    while (session.output.length > 1000 || session.output.length > 1 && session.output.reduce((sum, item) => sum + item.output.length, 0) > 300_000) session.output.shift();
    this.app.publish({ type: 'debug.output', clientId: session.client.clientId, sessionId: session.info.id, entry });
  }
  async start(client: ClientSession, workspaceId: string, configuration: DebugConfiguration) {
    if (this.closing) throw new Error('应用正在关闭。');
    validateDebugConfiguration(configuration);
    const workspace = this.workspace(client, workspaceId, true);
    const cwd = await this.app.files.resolve(workspace, configuration.cwd || '.');
    if (!(await stat(cwd)).isDirectory()) throw new Error('调试工作目录不是文件夹。');
    const dirty = this.app.files.clientDocuments(client.clientId, workspaceId).filter(document => document.dirty);
    if (configuration.request === 'launch' && dirty.length) throw new Error('项目仍有未保存文件，请先保存，再运行调试。');
    const definitions = this.app.settings.snapshot().settings.development?.debugAdapters ?? [];
    const definition = this.catalog.definitions(definitions).find(item => item.id === configuration.adapterId);
    if (!definition) throw new Error('调试器不存在，请检查开发设置。');
    const args = { ...configuration.options, name: configuration.name, request: configuration.request, cwd,
      ...(configuration.console ? { console: configuration.console } : {}),
      ...(configuration.args ? { args: configuration.args } : {}), ...(configuration.env ? { env: configuration.env } : {}) } as Record<string, any>;
    if (configuration.program) args.program = await this.app.files.resolve(workspace, configuration.program);
    if (configuration.request === 'launch' && !args.program && !args.module && !args.code && !args.runtimeArgs) throw new Error('请填写要调试的程序，或在高级选项中指定模块与运行参数。');
    if (configuration.adapterId === 'node') {
      args.type = 'pwa-node';
      const bundledNode = !configuration.runtimeExecutable && !!process.versions.electron;
      args.console ??= bundledNode ? 'integratedTerminal' : 'internalConsole';
      if (bundledNode && args.console === 'internalConsole') throw new Error('内置 Node 运行程序使用 integratedTerminal；使用 internalConsole 时，请指定独立 Node 程序路径。');
      // 独立适配器需要宿主提供项目根目录，才能解析默认 source map 搜索范围。
      args.__workspaceFolder = workspace.directory;
      for (const key of ['outFiles', 'resolveSourceMapLocations']) if (Array.isArray(args[key])) args[key] = args[key].map((value: string) => value.replaceAll('\\', '/'));
      if (configuration.request === 'launch') {
        args.runtimeExecutable = configuration.runtimeExecutable || process.execPath;
        if (bundledNode) args.env = { ...args.env, ELECTRON_RUN_AS_NODE: '1' };
      } else {
        if (!configuration.port && !args.processId) throw new Error('请填写 Node inspector 的监听端口。');
        if (configuration.port) args.port = configuration.port;
        args.address = configuration.host || '127.0.0.1';
      }
    } else if (configuration.adapterId === 'python') {
      args.type = 'debugpy'; args.console ??= 'internalConsole'; args.redirectOutput ??= true;
      if (configuration.runtimeExecutable) args.python = [configuration.runtimeExecutable];
      if (configuration.request === 'attach') args.connect = { host: configuration.host || '127.0.0.1', port: configuration.port };
    }
    const root = this.create(client, workspace, configuration);
    root.opening = this.catalog.start(definition, configuration, cwd, definitions.some(value => value.id === definition.id), (category, text) => this.output(root, category, text));
    void root.opening.then(async runtime => {
      root.runtime = runtime;
      if (root.stopping) return;
      await this.initialize(root, await runtime.connect(), args);
    }).catch(error => this.failed(root, error));
    return structuredClone(root.info);
  }
  private create(client: ClientSession, workspace: WorkspaceDefinition, configuration: DebugConfiguration, parent?: Session): Session {
    const id = randomUUID();
    const session: Session = { client, workspace, configuration: structuredClone(configuration), output: [], programs: [], outputSequence: 0, executionRevision: 0, breakpointResults: {},
      info: { id, rootId: parent?.info.rootId ?? id, parentId: parent?.info.id, workspaceId: workspace.id, configurationId: configuration.id,
        adapterId: configuration.adapterId, request: configuration.request, name: configuration.name, status: 'starting', capabilities: {} } };
    this.sessions.set(id, session); this.changed(session); return session;
  }
  private initialize(session: Session, connection: DapConnection, args: Record<string, any>) {
    return session.ready = this.initializeConnection(session, connection, args);
  }
  private async initializeConnection(session: Session, connection: DapConnection, args: Record<string, any>) {
    const root = this.sessions.get(session.info.rootId)!;
    if (root.stopping) { connection.dispose(); return; }
    session.connection = connection;
    connection.on('event', (event: string, body: Record<string, any>) => this.event(session, event, body));
    connection.once('close', error => { if (!root.stopping && !finished(session)) void this.failed(session, error); });
    connection.reverseRequest = async (command, request) => {
      if (command === 'runInTerminal') {
        if (root.stopping || root.configuration.request !== 'launch') throw new Error('当前调试会话不能启动终端程序。');
        const env = { ...request.env };
        // js-debug 会清除继承的此变量；仅为本端明确选择的内置 Node 运行环境恢复它。
        if (process.versions.electron && root.configuration.adapterId === 'node' && !root.configuration.runtimeExecutable && request.args?.[0] === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
        const program = await this.app.interactiveTerminals.launchProgram(root.client.actorId, root.workspace.id,
          { args: request.args, cwd: request.cwd, env, title: root.configuration.name });
        root.programs.push(program); root.info.terminalId = program.info.id; this.changed(root);
        if (root.stopping) { await program.stop(); throw new Error('调试会话已停止。'); }
        return { processId: program.info.pid };
      }
      if (command !== 'startDebugging') throw new Error('当前客户端不支持调试器请求：' + command);
      if (root.stopping || !root.runtime || !['launch', 'attach'].includes(request.request) || !request.configuration) throw new Error('无法创建调试子会话。');
      const child = this.create(session.client, session.workspace, { ...session.configuration, name: request.configuration.name || session.configuration.name, request: request.request }, session);
      // 使用适配器提供的目标标识与连接参数，不能用父会话配置替代。
      try { await this.initialize(child, await root.runtime.connect(request.configuration), { ...request.configuration, request: request.request }); }
      catch (error) { await this.failed(child, error); throw error; }
      return {};
    };
    const initialized = connection.waitEvent('initialized');
    // 为提前退出安装拒绝处理；启动响应可能一直等待 configurationDone。
    void initialized.catch(() => {});
    session.info.capabilities = await connection.request('initialize', { clientID: 'graycode', clientName: 'GrayCode', adapterID: session.configuration.adapterId,
      locale: 'zh-CN', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true, supportsVariablePaging: true,
      supportsStartDebuggingRequest: true, supportsRunInTerminalRequest: true, supportsProgressReporting: true, supportsInvalidatedEvent: true });
    const launched = connection.request(session.configuration.request, args, 30_000);
    const failedLaunch = launched.then(() => new Promise<never>(() => {}));
    await Promise.race([initialized, failedLaunch]);
    const breakpoints = (await this.settings(session.client, session.workspace.id)).breakpoints;
    for (const file of new Set(breakpoints.map(value => value.path))) await this.applyBreakpoints(session, file, breakpoints);
    const filters = Array.isArray(args.exceptionBreakpoints) ? args.exceptionBreakpoints : [];
    if (Array.isArray(session.info.capabilities.exceptionBreakpointFilters)) await connection.request('setExceptionBreakpoints', { filters });
    if (session.info.capabilities.supportsConfigurationDoneRequest) await connection.request('configurationDone');
    await launched;
    if (session.info.status === 'starting') { session.info.status = 'running'; this.changed(session); }
  }
  private async applyBreakpoints(session: Session, file: string, values: DebugBreakpoint[]) {
    if (!session.connection || finished(session)) return;
    const source = { path: await this.app.files.resolve(session.workspace, file) };
    const enabled = values.filter(value => value.path === file && value.enabled);
    const result = await session.connection.request<{ breakpoints: DebugBreakpointResult[] }>('setBreakpoints', { source,
      breakpoints: enabled.map(({ line, column, condition, hitCondition, logMessage }) => ({ line, column, condition, hitCondition, logMessage })) });
    session.breakpointResults[file] = result.breakpoints;
    this.app.publish({ type: 'debug.breakpointResult', clientId: session.client.clientId, sessionId: session.info.id, path: file, breakpoints: result.breakpoints });
  }
  private event(session: Session, event: string, body: Record<string, any>) {
    if (['stopped', 'continued', 'terminated'].includes(event)) session.executionRevision++;
    if (event === 'output') {
      if (body.category !== 'telemetry') this.output(session, body.category ?? 'console', String(body.output ?? ''),
        { source: body.source, line: body.line, variablesReference: body.variablesReference, group: body.group });
      return;
    }
    if (event === 'stopped') { session.info.status = 'stopped'; session.info.threadId = body.threadId; session.info.reason = body.reason; session.info.description = body.description; }
    if (event === 'continued') { session.info.status = 'running'; session.info.threadId = undefined; session.info.reason = undefined; session.info.description = undefined; }
    if (event === 'process') session.info.processId = body.systemProcessId;
    if (event === 'exited') session.info.exitCode = body.exitCode;
    if (event === 'capabilities') Object.assign(session.info.capabilities, body.capabilities);
    if (event === 'terminated') {
      session.info.status = 'terminated';
      if (!session.info.parentId) void this.stopRoot(session).catch(error => this.failed(session, error));
    }
    if (event === 'breakpoint') {
      for (const values of Object.values(session.breakpointResults)) {
        const existing = values.find(value => value.id !== undefined && value.id === body.breakpoint?.id);
        if (existing) Object.assign(existing, body.breakpoint);
      }
    }
    this.changed(session);
    this.app.publish({ type: 'debug.event', clientId: session.client.clientId, sessionId: session.info.id, event, body });
  }
  private async failed(session: Session, error: unknown) {
    const root = this.sessions.get(session.info.rootId)!;
    if (root.stopping || finished(session)) return;
    session.info.status = 'failed'; session.info.error = String(error); this.changed(session);
    try { await this.stopRoot(root); }
    catch (cleanup) { root.info.status = 'failed'; root.info.error = String(error) + '\n停止调试器失败：' + String(cleanup); this.changed(root); }
  }
  async request(client: ClientSession, id: string, command: string, args: Record<string, unknown> = {}) {
    const session = this.get(client, id);
    this.workspace(client, session.workspace.id, true);
    if (!requestMethods.has(command)) throw new Error('不支持的调试操作。');
    if (!session.connection || finished(session)) throw new Error('调试会话已经结束。');
    // 适配器可能在 launch 响应前报告入口断点，交互请求必须等配置握手完成。
    await session.ready;
    if (finished(session)) throw new Error('调试会话已经结束。');
    if (command === 'pause') return this.pause(session, args);
    const revision = session.executionRevision;
    const result = await session.connection.request(command, args);
    // 单步停止事件可能早于请求响应，不能把已经到达的新暂停状态覆盖成运行中。
    if (['continue', 'next', 'stepIn', 'stepOut'].includes(command) && session.executionRevision === revision && session.info.status === 'stopped') {
      session.info.status = 'running'; session.info.threadId = undefined; this.changed(session);
    }
    return result;
  }
  private async pause(session: Session, args: Record<string, unknown>) {
    const paused = () => session.info.status === 'stopped';
    if (paused()) return {};
    const node = session.configuration.adapterId === 'node';
    for (let attempt = 0; attempt < (node ? 2 : 1); attempt++) {
      const stopped = session.connection!.waitEvent('stopped', node && attempt === 0 ? 750 : 5000);
      void stopped.catch(() => {});
      const response = await session.connection!.request('pause', args);
      try { await stopped; return response; }
      catch (error) {
        if (paused()) return response;
        // js-debug 在刚继续执行时可能确认却丢失暂停；只有仍在运行时补发一次。
        if (!node || attempt > 0 || session.info.status !== 'running') throw error;
      }
    }
    throw new Error('调试器没有暂停目标程序，请重试。');
  }
  async stop(client: ClientSession, id: string) {
    const session = this.get(client, id); await this.stopRoot(this.sessions.get(session.info.rootId)!); return { success: true };
  }
  private stopRoot(root: Session): Promise<void> {
    if (root.stopping) return root.stopping;
    root.stopping = (async () => {
      const runtime = root.runtime ?? await root.opening?.catch(() => undefined);
      const sessions = [...this.sessions.values()].filter(session => session.info.rootId === root.info.id).reverse();
      // launch 的进程由本端创建，attach 只分离；不要终止用户已运行的目标。
      await Promise.allSettled(sessions.map(session => session.connection?.request('disconnect', { restart: false, terminateDebuggee: root.configuration.request === 'launch' }, 2500)));
      for (const session of sessions) { session.connection?.dispose(); if (session.info.status !== 'failed') session.info.status = 'terminated'; this.changed(session); }
      await runtime?.close();
      await Promise.all(root.programs.map(program => program.stop()));
    })();
    return root.stopping;
  }
  async restart(client: ClientSession, id: string) {
    const session = this.get(client, id), root = this.sessions.get(session.info.rootId)!;
    await this.stopRoot(root); return this.start(client, root.workspace.id, root.configuration);
  }
  openTerminal(client: ClientSession, id: string) {
    const session = this.get(client, id), root = this.sessions.get(session.info.rootId)!;
    if (!root.info.terminalId) throw new Error('此会话没有关联的终端。');
    this.app.publish({ type: 'workspace.terminal.open', clientId: client.clientId, id: root.info.terminalId });
  }
  async close() {
    this.closing = true;
    const results = await Promise.allSettled([...this.sessions.values()].filter(session => !session.info.parentId).map(session => this.stopRoot(session)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), '部分调试进程未能退出。');
  }
}
