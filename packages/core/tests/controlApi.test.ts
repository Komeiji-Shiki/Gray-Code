import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { startControlServer } from '../../../apps/server/src/control/server';
import { ControlApiService } from '../../../apps/server/src/control/service';
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

/** 测试只检查响应中的字段，统一按任意 JSON 读取。 */
const body = (response: Response): Promise<any> => response.json();

async function request(port: number, path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function withServer(test: (port: number, app: ReturnType<typeof createApp>['app']) => Promise<void>) {
  const { app } = createApp();
  const server = await startControlServer(app, { port: 0, token, allowLan: false });
  try { await test(server.port, app); } finally { await server.close(); }
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

  test('synthesizes speech through the configured service', () => withServer(async (port, app) => {
    const speech = await request(port, '/v1/speech', { method: 'POST', headers, body: JSON.stringify({ text: '你好' }) });
    expect(await body(speech)).toMatchObject({ provider: 'fish', clips: [{ base64: 'YQ==' }] });
    expect(app.synthesized[0]).toMatchObject({ text: '你好' });
    const upstream = await request(port, '/v1/speech', { method: 'POST', headers, body: JSON.stringify({ text: 'fail' }) });
    expect(upstream.status).toBe(502);
    expect(await body(upstream)).toMatchObject({ code: 'UPSTREAM_FAILED' });
  }));

  test('service follows saved settings, rotates tokens in place and publishes a discovery file while listening', async () => {
    const { app } = createApp();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'graycode-control-discovery-'));
    const listeners: ((event: Record<string, any>) => void)[] = [];
    let config: Record<string, any> = { enabled: true, port: 0, credentialRef: 'control_api_token', allowLan: false };
    let secret = token;
    const read = app.settings.read;
    Object.assign(app, {
      settings: { read: (...keys: string[]) => keys[0] === 'controlApi' ? { controlApi: config } : read(...keys), credential: async () => secret },
      subscribe: (listener: (event: Record<string, any>) => void) => { listeners.push(listener); return () => {}; },
      publish: (event: Record<string, any>) => { for (const listener of [...listeners]) listener(event); },
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 80));
    const save = async (next: Record<string, any> = config) => {
      config = next;
      app.publish({ type: 'settings.changed' });
      await settle();
    };
    const discovery = async () => JSON.parse(await readFile(path.join(directory, `${process.pid}.json`), 'utf8'));
    const service = new ControlApiService(app, { discoveryDirectory: directory });
    try {
      await service.initialize();
      await settle();
      const { port } = service.status();
      expect(service.status().state).toBe('listening');
      expect(service.keepsAlive).toBe(true);
      expect(await discovery()).toMatchObject({ url: `http://127.0.0.1:${port}`, token, pid: process.pid, dataDirectory: '/data' });
      const controller = new AbortController();
      const stream = await request(port!, '/v1/events', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      const ended = stream.text();

      secret = 'b'.repeat(64);
      await save();
      await expect(ended).resolves.toContain(': connected');
      expect(service.status().port).toBe(port);
      expect((await request(port!, '/v1/health', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
      expect((await request(port!, '/v1/health', { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(200);
      expect(await discovery()).toMatchObject({ token: secret });

      const probe = createServer();
      const fixed = await new Promise<number>(resolve => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as any).port)));
      await new Promise(resolve => probe.close(resolve));
      await save({ ...config, port: fixed });
      expect(service.status()).toMatchObject({ state: 'listening', port: fixed });

      service.stop();
      await settle();
      expect(service.status().state).toBe('stopped');
      expect(service.keepsAlive).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      await save();
      expect(service.status().state).toBe('stopped');
      await save({ ...config, port: 0 });
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
});
