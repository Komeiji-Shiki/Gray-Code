import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { startControlEndpoint } from '../../../apps/server/src/control/server';
import { ControlApiService } from '../../../apps/server/src/control/service';
import { ControlDiscoveryFile } from '../../../apps/server/src/control/discovery';
import { PlatformStorageError } from '../../../packages/core/src/errors';
import { SpeechProviderError } from '../../../apps/server/src/speech/service';

const token = 'a'.repeat(64);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const conversation = { id: 'conversation-1', title: 'Hello', actorId: 'owner', createdAt: 1, updatedAt: 2, workspaceId: 'workspace-1' };

function createApp() {
  const listeners: ((event: Record<string, any>) => void)[] = [];
  const starts: Record<string, any>[] = [];
  const synthesized: Record<string, any>[] = [];
  const listed: Record<string, any>[] = [];
  const runs = new Map<string, Record<string, any>>([['run-1', { id: 'run-1', conversationId: conversation.id, status: 'completed' }]]);
  const settings: Record<string, any> = {
    agents: [{ id: 'default', name: 'GrayCode' }],
    providers: [{ id: 'provider', name: 'Provider', model: 'model-a', models: [{ id: 'model-a' }, { id: 'model-b' }] }],
    workspaces: [{ id: 'workspace-1', name: 'Project', directory: '/project' }, { id: 'managed', name: 'Auto', directory: '/auto', managedConversationId: 'x' }],
  };
  const app = {
    settings: { read: (...keys: string[]) => Object.fromEntries(keys.map(key => [key, settings[key]])) },
    runtime: {
      activeCount: 2,
      start: async (input: Record<string, any>) => {
        starts.push(input);
        if (input.requestKey === 'control:busy') throw new PlatformStorageError('STORAGE_BUSY', 'This conversation already has an active run.');
        const run = { id: input.requestKey === 'control:slow' ? 'run-slow' : 'run-1', status: 'running', conversationId: input.conversationId };
        if (run.id === 'run-slow') runs.set(run.id, run);
        return run;
      },
      wait: (id: string) => id === 'run-slow' ? new Promise(() => {}) : Promise.resolve(runs.get(id)),
      cancel: async () => {},
      pendingApprovals: () => [],
      pendingQuestions: () => [],
    },
    storage: {
      directory: '/data',
      listConversations: async (options: Record<string, any>) => {
        listed.push(options);
        return { items: [conversation], ...(options.cursor ? {} : { nextCursor: { updatedAt: 2, id: conversation.id } }) };
      },
      readHistory: async (id: string) => ({ conversationId: id, total: 3, startIndex: 0, revision: 3, messages: [
        { id: 'u', role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'BASE64_IMAGE' } }] },
        { id: 'm1', role: 'model', runId: 'run-1', parts: [{ text: '思考', thought: true }, { text: '先看看' },
          { functionCall: { id: 'c', name: 'read_file', args: { path: 'a.txt' } } }] },
        { id: 'r', role: 'user', parts: [{ functionResponse: { id: 'c', name: 'read_file', response: { content: 'x'.repeat(5_000) } } }] },
        { id: 'm2', role: 'model', runId: 'run-1', parts: [{ text: '你好' }, { text: '，完成了。' }] },
      ] }),
      getRun: async (id: string) => runs.get(id) ?? null,
      readRunEvents: async () => [{ sequence: 1, event: { type: 'run.completed' } }],
      listRuns: async () => [{ id: 'run-active', conversationId: 'conversation-1' }],
    },
    conversation: async (_actor: string, id: string) => {
      if (id !== conversation.id) throw new Error('Conversation is not accessible.');
      return conversation;
    },
    createConversation: async (_actor: string, title: string) => ({ ...conversation, id: 'conversation-2', title }),
    subscribe: (listener: (event: Record<string, any>) => void) => { listeners.push(listener); return () => {}; },
    emit: (event: Record<string, any>) => { for (const listener of listeners) listener(event); },
    speech: {
      synthesize: async (input: Record<string, any>) => { synthesized.push(input);
        if (input.text === 'fail') throw new SpeechProviderError('语音合成接口返回 500');
        return { provider: 'fish', clips: [{ text: input.text, mimeType: 'audio/mpeg', base64: 'YQ==' }] }; },
      clone: async () => ({ id: 'voice-2', state: 'trained' }),
    },
    requireOwner: () => {},
    files: { clientConnected: () => {}, clientClosed: async () => {} },
    languages: { clientConnected: () => {}, clientClosed: async () => {} },
    productUi: { clientConnected: () => {}, clientClosed: async () => {}, commands: { connected: () => {} } },
    starts,
    synthesized,
    listed,
  };
  return { app: app as unknown as PlatformApplication & typeof app };
}

/** 服务测试要读写外部控制设置、取令牌并发布事件，在基础夹具上补齐这几项。 */
function serviceApp(config: Record<string, any>) {
  const { app } = createApp();
  const listeners: ((event: Record<string, any>) => void)[] = [];
  const state = { config, secret: token };
  const read = app.settings.read;
  Object.assign(app, {
    settings: { read: (...keys: string[]) => keys[0] === 'controlApi' ? { controlApi: state.config } : read(...keys), credential: async () => state.secret },
    subscribe: (listener: (event: Record<string, any>) => void) => { listeners.push(listener); return () => {}; },
    publish: (event: Record<string, any>) => { for (const listener of [...listeners]) listener(event); },
  });
  return { app: app as typeof app & { publish(event: Record<string, any>): void }, state };
}

/** 测试只检查响应中的字段，统一按任意 JSON 读取。 */
const body = (response: Response): Promise<any> => response.json();

async function request(port: number, path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function withServer(test: (port: number, app: ReturnType<typeof createApp>['app']) => Promise<void>) {
  const { app } = createApp();
  const endpoint = await startControlEndpoint(app);
  const server = await endpoint.network({ port: 0, token, allowLan: false });
  try { await test(server.port, app); } finally { await endpoint.close(); }
}

/** fetch 不能改 Host，也连不到命名管道；这两类请求直接用 http 模块发出。 */
function raw(target: { port: number } | { socketPath: string }, route: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; value: any }>((resolve, reject) => {
    const outgoing = httpRequest({ ...target, ...('port' in target ? { host: '127.0.0.1' } : {}), path: route, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('external control API', () => {
  test('requires the token, describes itself and reports unknown routes with guidance', () => withServer(async port => {
    const denied = await request(port, '/v1/health');
    expect(denied.status).toBe(401);
    expect((await body(denied)).error).toContain('control-api');
    const catalog = await body(await request(port, '/v1', { headers }));
    expect(catalog.routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/v1/conversations/:id/messages' }));
    expect(catalog.routes.every((route: Record<string, unknown>) => !('handle' in route))).toBe(true);
    const missing = await request(port, '/v1/does-not-exist', { headers });
    expect(missing.status).toBe(404);
    expect((await body(missing)).error).toContain('GET /v1');
    const wrongMethod = await request(port, '/v1/status', { method: 'POST', headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
  }));

  test('网络端口不再允许跨域读取，拒绝 DNS 重绑定带来的域名 Host', () => withServer(async port => {
    const allowed = await request(port, '/v1/health', { headers });
    expect(allowed.status).toBe(200); expect(allowed.headers.get('access-control-allow-origin')).toBeNull();
    expect((await request(port, '/v1/health', { method: 'OPTIONS' })).status).toBe(401);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, '[::1]', '192.168.1.20:8080'])
      expect((await raw({ port }, '/v1/health', { ...headers, Host: host })).status).toBe(200);
    const rebound = await raw({ port }, '/v1/health', { ...headers, Host: `attacker.example:${port}` });
    expect(rebound.status).toBe(403); expect(rebound.value.error).toContain('Host');
  }));

  test('本机管道不需要令牌，接口说明给出 MCP 工具名，事件流与音频接口不暴露为工具', async () => {
    const { app } = createApp();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'graycode-control-pipe-'));
    const endpoint = await startControlEndpoint(app);
    try {
      const pipe = await new ControlDiscoveryFile(directory).pipe();
      await endpoint.local(pipe);
      expect((await raw({ socketPath: pipe }, '/v1/health')).value).toMatchObject({ status: 'ok' });
      const catalog = (await raw({ socketPath: pipe }, '/v1')).value;
      const tools = catalog.routes.filter((route: Record<string, unknown>) => route.tool).map((route: Record<string, unknown>) => route.tool);
      expect(tools).toEqual(expect.arrayContaining(['get_status', 'send_message', 'get_run', 'resolve_approval', 'answer_question']));
      expect(catalog.routes.find((route: Record<string, unknown>) => route.path === '/v1/events').tool).toBeUndefined();
      expect(catalog.routes.find((route: Record<string, unknown>) => route.path === '/v1/speech').tool).toBeUndefined();
    } finally { await endpoint.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test('exposes status choices and pages conversations with an opaque cursor', () => withServer(async (port, app) => {
    expect(await body(await request(port, '/v1/status', { headers }))).toMatchObject({ actorId: 'owner', activeRuns: 2,
      agents: [{ id: 'default', name: 'GrayCode' }], providers: [{ id: 'provider', models: ['model-a', 'model-b'] }],
      workspaces: [{ id: 'workspace-1', name: 'Project', directory: '/project' }] });
    const first = await body(await request(port, '/v1/conversations', { headers }));
    expect(first.items).toEqual([conversation]);
    expect(typeof first.nextCursor).toBe('string');
    await request(port, `/v1/conversations?cursor=${first.nextCursor}&limit=5`, { headers });
    expect(app.listed[1]).toEqual({ limit: 5, cursor: { updatedAt: 2, id: conversation.id } });
    const invalid = await request(port, '/v1/conversations?cursor=nope', { headers });
    expect(invalid.status).toBe(400);
    expect((await request(port, '/v1/conversations/missing', { headers })).status).toBe(404);
  }));

  test('starts a run, waits for the reply and keeps the idempotency key', () => withServer(async (port, app) => {
    const response = await request(port, '/v1/conversations/conversation-1/messages', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'retry-1' }, body: JSON.stringify({ text: '你好', wait: true }),
    });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ conversationId: 'conversation-1', done: true, reply: '你好，完成了。',
      run: { id: 'run-1', status: 'completed' } });
    expect(app.starts[0]).toMatchObject({ requestKey: 'control:retry-1', actorId: 'owner', agentId: 'default',
      conversationId: 'conversation-1', message: { role: 'user', parts: [{ text: '你好' }] } });

    const slow = await request(port, '/v1/conversations/conversation-1/messages', {
      method: 'POST', headers, body: JSON.stringify({ text: '慢一点', wait: 1, requestKey: 'slow' }),
    });
    expect(slow.status).toBe(202);
    expect(await body(slow)).toMatchObject({ done: false, run: { id: 'run-slow', status: 'running' } });

    const busy = await request(port, '/v1/conversations/conversation-1/messages', {
      method: 'POST', headers, body: JSON.stringify({ text: '再来', requestKey: 'busy' }),
    });
    expect(busy.status).toBe(409);
    expect(await body(busy)).toMatchObject({ code: 'STORAGE_BUSY' });
    const agent = await request(port, '/v1/conversations/conversation-1/messages', {
      method: 'POST', headers, body: JSON.stringify({ text: 'x', agentId: 'missing' }),
    });
    expect(agent.status).toBe(400);
    expect((await body(agent)).error).toContain('default');
    expect(await body(await request(port, '/v1/runs/run-1', { headers }))).toMatchObject({ done: true, reply: '你好，完成了。' });
  }));

  test('returns compact history without thoughts or base64 unless raw is requested', () => withServer(async port => {
    const compact = await body(await request(port, '/v1/conversations/conversation-1/messages', { headers }));
    const text = JSON.stringify(compact);
    expect(text).not.toContain('BASE64_IMAGE');
    expect(text).not.toContain('思考');
    expect(compact.messages[0]).toMatchObject({ index: 0, role: 'user', text: 'hi', attachments: [{ mimeType: 'image/png' }] });
    expect(compact.messages[1]).toMatchObject({ role: 'assistant', text: '先看看', toolCalls: [{ name: 'read_file', input: { text: '{"path":"a.txt"}' } }] });
    expect(compact.messages[2].toolResults[0].output).toMatchObject({ truncated: true });
    const raw = await body(await request(port, '/v1/conversations/conversation-1/messages?view=raw', { headers }));
    expect(JSON.stringify(raw)).toContain('BASE64_IMAGE');
  }));

  test('streams stable run events with conversation IDs, keeps raw events behind raw=1 and resumes from Last-Event-ID', () => withServer(async (port, app) => {
    const controller = new AbortController();
    const decoder = new TextDecoder();
    const readUntil = async (response: Response, text: string) => {
      const reader = response.body!.getReader();
      let value = '';
      while (!value.includes(text)) value += decoder.decode((await reader.read()).value);
      return value;
    };
    const runEvent = (runId: string, type: string, sequence: number) =>
      ({ type: 'event', event: { runId, type, sequence, timestamp: sequence, payload: {} }, status: 'completed' });
    try {
      const stable = await request(port, '/v1/events?types=run.completed&conversationId=conversation-1', { headers, signal: controller.signal });
      const raw = await request(port, '/v1/events?raw=1&types=model.delta', { headers, signal: controller.signal });
      app.emit({ type: 'run.created', runId: 'run-1', run: { id: 'run-1', conversationId: 'conversation-1', status: 'queued' } });
      app.emit({ type: 'model.delta', runId: 'run-1', parts: [{ text: '增量' }] });
      app.emit(runEvent('run-1', 'run.completed', 1));
      // 监听前已在运行的任务由启动时登记，事件同样带上会话 ID。
      app.emit(runEvent('run-active', 'run.completed', 2));
      const chunk = await readUntil(stable, 'run-active');
      const events = [...chunk.matchAll(/data: (.+)/g)].map(match => JSON.parse(match[1]));
      expect(events).toEqual([
        { type: 'run.completed', runId: 'run-1', conversationId: 'conversation-1', sequence: 1, timestamp: 1, status: 'completed', payload: {} },
        { type: 'run.completed', runId: 'run-active', conversationId: 'conversation-1', sequence: 2, timestamp: 2, status: 'completed', payload: {} },
      ]);
      expect(await readUntil(raw, 'model.delta')).toContain('增量');

      const id = /id: (\S+)/.exec(chunk)![1];
      app.emit(runEvent('run-2', 'run.completed', 3));
      const replay = await readUntil(await request(port, '/v1/events', { headers: { ...headers, 'Last-Event-ID': id }, signal: controller.signal }), 'run-2');
      expect(replay).not.toContain('"runId":"run-1"');
      expect(replay).not.toContain('model.delta');
      await readUntil(await request(port, '/v1/events', { headers: { ...headers, 'Last-Event-ID': 'gone:1' }, signal: controller.signal }), 'event: reset');
    } finally { controller.abort(); }
  }));

  test('稳定订阅方断线期间的大量流式输出不会挤掉任务事件，原始订阅方的旧游标照常重置', () => withServer(async (port, app) => {
    const controller = new AbortController();
    const decoder = new TextDecoder();
    const readUntil = async (response: Response, text: string) => {
      const reader = response.body!.getReader();
      let value = '';
      while (!value.includes(text)) value += decoder.decode((await reader.read()).value);
      reader.releaseLock();
      return value;
    };
    const runEvent = (runId: string, type: string, sequence: number) =>
      ({ type: 'event', event: { runId, type, sequence, timestamp: sequence, payload: {} }, status: 'completed' });
    try {
      const stableController = new AbortController();
      const stable = await request(port, '/v1/events?types=run.completed', { headers, signal: stableController.signal });
      const raw = await request(port, '/v1/events?raw=1', { headers, signal: controller.signal });
      app.emit({ type: 'run.created', runId: 'run-1', run: { id: 'run-1', conversationId: 'conversation-1', status: 'queued' } });
      app.emit(runEvent('run-1', 'run.completed', 1));
      const id = /id: (\S+)/.exec(await readUntil(stable, 'run-1'))![1];
      const rawId = /id: (\S+)/.exec(await readUntil(raw, 'run.completed'))![1];
      stableController.abort();
      // 一轮超过补发条数上限的流式增量，原始订阅方仍在线，原始缓冲因此一直保留。
      for (let index = 0; index < 1_200; index++) app.emit({ type: 'model.delta', runId: 'run-2', parts: [{ text: `增量 ${index}` }] });
      app.emit(runEvent('run-2', 'run.completed', 2));
      const replay = await readUntil(await request(port, '/v1/events?types=run.completed', { headers: { ...headers, 'Last-Event-ID': id }, signal: controller.signal }), 'run-2');
      expect(replay).not.toContain('event: reset');
      expect(replay).not.toContain('"runId":"run-1"');
      await readUntil(await request(port, '/v1/events?raw=1', { headers: { ...headers, 'Last-Event-ID': rawId }, signal: controller.signal }), 'event: reset');
    } finally { controller.abort(); }
  }));

  test('synthesizes speech through the configured service', () => withServer(async (port, app) => {
    const speech = await request(port, '/v1/speech', { method: 'POST', headers, body: JSON.stringify({ text: '你好' }) });
    expect(await body(speech)).toMatchObject({ provider: 'fish', clips: [{ base64: 'YQ==' }] });
    expect(app.synthesized[0]).toMatchObject({ text: '你好' });
    const upstream = await request(port, '/v1/speech', { method: 'POST', headers, body: JSON.stringify({ text: 'fail' }) });
    expect(upstream.status).toBe(502);
    expect(await body(upstream)).toMatchObject({ code: 'UPSTREAM_FAILED' });
  }));

  test('本机管道随服务常开，发现文件只写管道与 MCP 命令；网络端口跟随设置启停并原地轮换令牌', async () => {
    const { app, state } = serviceApp({ enabled: true, port: 0, credentialRef: 'control_api_token', allowLan: false });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'graycode-control-discovery-'));
    const settle = () => new Promise(resolve => setTimeout(resolve, 80));
    const save = async (next: Record<string, any> = state.config) => {
      state.config = next;
      app.publish({ type: 'settings.changed' });
      await settle();
    };
    const discovery = async () => JSON.parse(await readFile(path.join(directory, `${process.pid}.json`), 'utf8'));
    const service = new ControlApiService(app, { discoveryDirectory: directory, mcpBridge: '/bridge/controlMcp.cjs' });
    try {
      await service.initialize();
      await settle();
      const { port, local } = service.status();
      expect(service.status().state).toBe('listening');
      expect(service.keepsAlive).toBe(true);
      const found = await discovery();
      expect(found).toMatchObject({ pipe: local.pipe, http: { url: `http://127.0.0.1:${port}` }, pid: process.pid, dataDirectory: '/data',
        mcp: { command: process.execPath, args: ['/bridge/controlMcp.cjs'] } });
      expect(JSON.stringify(found)).not.toContain(token);
      const controller = new AbortController();
      const stream = await request(port!, '/v1/events', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      const ended = stream.text();

      state.secret = 'b'.repeat(64);
      await save();
      await expect(ended).resolves.toContain(': connected');
      expect(service.status().port).toBe(port);
      expect((await request(port!, '/v1/health', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
      expect((await request(port!, '/v1/health', { headers: { Authorization: `Bearer ${state.secret}` } })).status).toBe(200);

      const probe = createServer();
      const fixed = await new Promise<number>(resolve => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as any).port)));
      await new Promise(resolve => probe.close(resolve));
      await save({ ...state.config, port: fixed });
      expect(service.status()).toMatchObject({ state: 'listening', port: fixed });

      service.stop();
      await settle();
      expect(service.status().state).toBe('stopped');
      expect(service.keepsAlive).toBe(false);
      // 网络端口停了，本机管道照常可用，发现文件只剩管道。
      expect(await discovery()).not.toHaveProperty('http');
      expect((await raw({ socketPath: local.pipe! }, '/v1/health')).status).toBe(200);
      await save();
      expect(service.status().state).toBe('stopped');
      await save({ ...state.config, port: 0 });
      expect(service.status().state).toBe('listening');
      controller.abort();
    } finally {
      await service.close();
      await service.start();
      service.stop();
      expect(service.status().state).toBe('stopped');
      expect(service.keepsAlive).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('MCP 桥经本机管道生成并调用工具，GrayCode 启动后通知客户端刷新工具列表', async () => {
    const { app } = serviceApp({ enabled: false, port: 0 });
    const home = await mkdtemp(path.join(os.tmpdir(), 'graycode-control-home-'));
    // 用构建产物验证真实启动方式；发现目录跟随用户目录，换成临时目录即可隔离。
    const bridge = spawn(process.execPath, [path.resolve('apps/server/dist/controlMcp.cjs')],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'inherit'] });
    const inbox: Record<string, any>[] = [];
    const waiters: (() => void)[] = [];
    createInterface({ input: bridge.stdout! }).on('line', line => { inbox.push(JSON.parse(line)); waiters.splice(0).forEach(wake => wake()); });
    const receive = async (match: (message: Record<string, any>) => boolean) => {
      for (;;) {
        const index = inbox.findIndex(match);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise<void>(resolve => waiters.push(resolve));
      }
    };
    let id = 0;
    const rpc = (method: string, params: Record<string, unknown> = {}) => {
      const current = ++id;
      bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`);
      return receive(message => message.id === current);
    };
    const service = new ControlApiService(app, { discoveryDirectory: path.join(home, '.graycode', 'control-api'), mcpBridge: 'unused' });
    try {
      const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jest', version: '1' } });
      expect(initialized.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'graycode' } });
      bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      expect((await rpc('tools/list')).result.tools).toEqual([]);
      expect((await rpc('tools/call', { name: 'get_status', arguments: {} })).error.message).toContain('get_status');

      await service.initialize();
      await receive(message => message.method === 'notifications/tools/list_changed');
      const tools = (await rpc('tools/list')).result.tools;
      expect(tools.find((tool: Record<string, any>) => tool.name === 'send_message').inputSchema).toMatchObject({ required: ['id'],
        properties: { id: { type: 'string' }, text: { description: '消息正文' } } });
      const status = await rpc('tools/call', { name: 'get_status', arguments: {} });
      expect(JSON.parse(status.result.content[0].text)).toMatchObject({ providers: [{ id: 'provider', models: ['model-a', 'model-b'] }] });
      const sent = await rpc('tools/call', { name: 'send_message', arguments: { id: 'conversation-1', text: '经 MCP 发送', wait: 5 } });
      expect(sent.result.isError).toBeUndefined();
      expect(app.starts[0]).toMatchObject({ conversationId: 'conversation-1', message: { parts: [{ text: '经 MCP 发送' }] } });
      expect((await rpc('tools/call', { name: 'get_run', arguments: {} })).result).toMatchObject({ isError: true, content: [{ text: '缺少路径参数 id。' }] });
      const missing = await rpc('tools/call', { name: 'get_conversation', arguments: { id: 'missing' } });
      expect(missing.result.isError).toBe(true); expect(missing.result.content[0].text).toContain('会话不存在');
    } finally {
      bridge.stdin!.end();
      await new Promise(resolve => bridge.once('exit', resolve));
      await service.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
