import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ModelInput, PlatformMessage, ProviderDefinition } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { channelProfile, projectChannels } from '../../../apps/server/src/settings/providers';
import { formatHistoryForAPI } from '../../../backend/modules/conversation/manager/historyFormatting';
import { validateHistoryIntegrity } from '../../../backend/modules/channel/HistoryIntegrityValidator';

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const send = (socket: WebSocket, event: object) => socket.send(JSON.stringify(event));
const item = (text: string) => ({ type: 'message', id: `msg_${text}`, role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
function completed(socket: WebSocket, id: string, output = [item('answer')], type = 'response.completed') {
  send(socket, { type, response: { id, model: 'fixture', status: type === 'response.incomplete' ? 'incomplete' : 'completed',
    ...(type === 'response.incomplete' ? { incomplete_details: { reason: 'steered' } } : {}), output, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
}

describe('Responses native socket with a real local WebSocket upstream', () => {
  let server: Server, upstream: WebSocketServer, adapter: ProviderModelAdapter, profile: ProviderDefinition;
  let handler: (socket: WebSocket, event: any) => void | Promise<void>;
  let requests: any[], connections: number, errors: unknown[];
  let controller: AbortController;
  const base = (): ModelInput => ({ runId: 'native-run', conversationId: 'chat', providerId: 'fixture', systemPrompt: 'stable system',
    messages: [{ id: 'user1', role: 'user', parts: [{ text: 'hello' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }],
    tools: [{ name: 'inspect', description: 'read', async: true, parameters: { type: 'object', properties: {} } }], signal: controller.signal, onToolCallReady: () => true });
  const steer = async (message: PlatformMessage) => {
    const before = requests.filter(event => event.type === 'response.steer').length;
    for (let attempt = 0; attempt < 100; attempt++) {
      const accepted = await adapter.steer('native-run', message);
      if (accepted || requests.filter(event => event.type === 'response.steer').length > before) return accepted;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('The created event did not reach the client');
  };
  beforeEach(async () => {
    requests = []; connections = 0; errors = []; controller = new AbortController();
    server = createServer(); upstream = new WebSocketServer({ server });
    upstream.on('connection', (socket, request) => {
      connections++; expect(request.headers.authorization).toBe('Bearer synthetic');
      socket.on('message', raw => { const event = JSON.parse(raw.toString()); requests.push(event); void Promise.resolve(handler(socket, event)).catch(error => errors.push(error)); });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    profile = { id: 'fixture', name: 'fixture', protocol: 'openai-responses', endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,
      model: 'fixture', models: [], credentialRef: 'key', stream: true, timeoutMs: 3000, generation: {},
      capabilities: { responsesWebSocket: true, responsesAsyncTools: true, outputTokenParameter: 'protocol_default', strictTools: 'disabled',
        reasoningParameter: 'protocol_default', reasoningLevels: [], reasoningSignature: 'native', compatibility: { deepSeekUserId: false, openCodeSession: false, deepSeekVision: false, nativePdf: false } } };
    adapter = new ProviderModelAdapter({ profile: async () => profile, credential: async () => 'synthetic' });
  });
  afterEach(async () => {
    adapter.endRun('native-run'); controller.abort();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(errors).toEqual([]);
  });

  test('starts a complete async tool while the response is still generating, then sends only its result', async () => {
    const started = deferred(); let ready = 0;
    const call = { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'inspect', arguments: '{}', async: true };
    handler = async (socket, event) => {
      const id = requests.length === 1 ? 'resp1' : 'resp2';
      send(socket, { type: 'response.created', response: { id } });
      if (id === 'resp1') {
        send(socket, { type: 'response.output_item.added', item: { ...call, arguments: '' }, output_index: 0 });
        send(socket, { type: 'response.output_item.done', item: call, output_index: 0 });
        await started.promise;
        completed(socket, id, [call, item('continued')] as any);
      } else completed(socket, id);
    };
    const input = base(); input.onToolCallReady = call => { expect(call).toMatchObject({ id: 'call1', async: true, args: {} }); ready++; started.resolve(); return true; };
    const first = await adapter.generate(input);
    expect(ready).toBe(1); expect(first.parts[0].functionCall).toMatchObject({ id: 'call1', async: true });
    const second = await adapter.generate({ ...input, messages: [...input.messages, { ...first, id: 'model1' },
      { id: 'result1', role: 'user', parts: [{ functionResponse: { id: 'call1', name: 'inspect', response: { success: true, data: 'read result' } } }] }] });
    expect(second.parts.map(part => part.text).join('')).toBe('answer'); expect(connections).toBe(1);
    expect(requests[0].tools[0].async).toBe(true); expect(requests[0].input[0].content[1].image_url).toContain('aGVsbG8=');
    expect(requests[1].previous_response_id).toBe('resp1'); expect(requests[1].input).toHaveLength(1);
    expect(requests[1].input[0]).toMatchObject({ type: 'function_call_output', call_id: 'call1' });
    expect(requests[1].stream).toBeUndefined();
  });

  test('consumes an automatic successor and never resends accepted steering', async () => {
    const active = deferred(); const user: PlatformMessage = { id: 'interrupt1', role: 'user', parts: [{ text: 'new direction' }] };
    handler = (socket, event) => {
      if (event.type === 'response.create') { send(socket, { type: 'response.created', response: { id: 'resp1' } }); active.resolve(); }
      else {
        expect(Object.keys(event).sort()).toEqual(['input', 'previous_response_id', 'type']);
        send(socket, { type: 'response.steer.accepted', steer: { id: 's1', previous_response_id: 'resp1' } });
        completed(socket, 'resp1', [item('original')], 'response.incomplete');
        send(socket, { type: 'response.created', response: { id: 'resp2', previous_response_id: 'resp1' } });
        completed(socket, 'resp2', [item('updated')]);
      }
    };
    const input = base(); const firstRequest = adapter.generate(input); await active.promise;
    expect(await steer(user)).toBe(true);
    const first = await firstRequest; expect(adapter.hasContinuation('native-run')).toBe(true);
    const second = await adapter.generate({ ...input, messages: [...input.messages, { ...first, id: 'm1' }, user] });
    expect(second.parts.map(part => part.text).join('')).toBe('updated');
    expect(requests.filter(event => event.type === 'response.create')).toHaveLength(1);
    expect(adapter.hasContinuation('native-run')).toBe(false);
  });

  test('returns required tool output on the same connection without repeating pending steering', async () => {
    const active = deferred(); const user: PlatformMessage = { id: 'interrupt2', role: 'user', parts: [{ text: 'updated scope' }] };
    const call = { type: 'function_call', call_id: 'sync-call', name: 'inspect', arguments: '{}' };
    handler = (socket, event) => {
      if (event.type === 'response.steer') {
        send(socket, { type: 'response.steer.accepted', steer: { id: 's2', previous_response_id: 'resp1' } });
        completed(socket, 'resp1', [call] as any);
        send(socket, { type: 'response.steer.pending', steer: { id: 's2', previous_response_id: 'resp1' }, required_input: [{ type: 'function_call_output', call_id: 'sync-call' }] });
      } else if (!event.previous_response_id) { send(socket, { type: 'response.created', response: { id: 'resp1' } }); active.resolve(); }
      else { send(socket, { type: 'response.created', response: { id: 'resp2' } }); completed(socket, 'resp2'); }
    };
    const input = base(); const pending = adapter.generate(input); await active.promise; await steer(user);
    const first = await pending;
    await adapter.generate({ ...input, messages: [...input.messages, { ...first, id: 'm1' }, user,
      { id: 'tool-result', role: 'user', parts: [{ functionResponse: { id: 'sync-call', name: 'inspect', response: { success: true } } }] }] });
    expect(requests[2].input).toHaveLength(1); expect(requests[2].input[0].call_id).toBe('sync-call');
    expect(requests[2].previous_response_id).toBe('resp1'); expect(connections).toBe(1);
  });

  test('a confirmed steering failure returns the queued user message through an ordinary continuation', async () => {
    const active = deferred(); const user: PlatformMessage = { id: 'interrupt3', role: 'user', parts: [{ text: 'try next response' }] };
    handler = (socket, event) => {
      if (event.type === 'response.steer') {
        send(socket, { type: 'response.steer.accepted', steer: { id: 's3', previous_response_id: 'resp1' } });
        completed(socket, 'resp1');
        send(socket, { type: 'response.steer.failed', steer: { id: 's3', previous_response_id: 'resp1', input: event.input } });
      } else if (!event.previous_response_id) { send(socket, { type: 'response.created', response: { id: 'resp1' } }); active.resolve(); }
      else { send(socket, { type: 'response.created', response: { id: 'resp2' } }); completed(socket, 'resp2'); }
    };
    const input = base(); const pending = adapter.generate(input); await active.promise; await steer(user);
    const first = await pending;
    await adapter.generate({ ...input, messages: [...input.messages, { ...first, id: 'm1' }, user] });
    expect(requests[2].input).toHaveLength(1); expect(requests[2].input[0].content[0].text).toBe('try next response');
  });

  test('retains tools until a complete item arrives and respects a preceding synchronous call', async () => {
    let ready = 0;
    handler = socket => {
      send(socket, { type: 'response.created', response: { id: 'resp1' } });
      const sync = { type: 'function_call', id: 'fc-sync', call_id: 'sync', name: 'inspect', arguments: '{}' };
      const async = { ...sync, id: 'fc-async', call_id: 'async', async: true };
      send(socket, { type: 'response.output_item.added', item: sync, output_index: 0 });
      send(socket, { type: 'response.output_item.done', item: async, output_index: 1 });
      completed(socket, 'resp1', [sync, async] as any);
    };
    await adapter.generate({ ...base(), onToolCallReady: () => { ready++; return true; } });
    expect(ready).toBe(0);
  });

  test('reuses the configured CONNECT proxy for WebSocket handshakes', async () => {
    const proxy = createServer(); let tunnels = 0;
    proxy.on('connect', (request, client, head) => {
      tunnels++; const target = new URL('http://' + request.url);
      const socket = connect(Number(target.port), target.hostname, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.write(head); client.pipe(socket); socket.pipe(client); });
      client.on('error', () => socket.destroy()); socket.on('error', () => client.destroy()); client.on('close', () => socket.destroy());
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    adapter = new ProviderModelAdapter({ profile: async () => profile, credential: async () => 'synthetic', proxyUrl: () => `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` });
    handler = socket => { send(socket, { type: 'response.created', response: { id: 'proxy-response' } }); completed(socket, 'proxy-response'); };
    try { await adapter.generate(base()); expect(tunnels).toBe(1); }
    finally { adapter.endRun('native-run'); await new Promise<void>(resolve => proxy.close(() => resolve())); }
  });

  test('preserves native switches through provider/channel projection and explicit disable', () => {
    const [channel] = projectChannels([profile], [], []);
    expect(channelProfile(channel).capabilities).toMatchObject({ responsesWebSocket: true, responsesAsyncTools: true });
    const disabled = { ...profile, capabilities: { ...profile.capabilities, responsesWebSocket: false, responsesAsyncTools: false } };
    const [updated] = projectChannels([disabled], [channel], [profile]);
    expect(channelProfile(updated, profile).capabilities).toMatchObject({ responsesWebSocket: false, responsesAsyncTools: false });
  });

  test('the standalone platform persists steering once, executes the native read once and completes all successors', async () => {
    const f = await fixture(); await f.store.close();
    const app = await PlatformApplication.open({ dataDirectory: f.data, models: adapter });
    const router = new ApplicationRouter(app);
    const started = deferred(), release = deferred(); let executions = 0;
    const callItem = { type: 'function_call', id: 'fc-platform', call_id: 'platform-call', name: 'native_read_fixture', arguments: '{"task_handle":"platform-read"}', async: true };
    app.tools.register({ declaration: { name: 'native_read_fixture', description: 'isolated read', parameters: { type: 'object', properties: {} } },
      parallelRead: true, effects: () => ['public_read'], execute: async () => { executions++; started.resolve(); await release.promise; return { success: true, data: 'observed value' }; } });
    handler = (socket, event) => {
      if (event.type === 'response.steer') {
        send(socket, { type: 'response.steer.accepted', steer: { id: 's-platform', previous_response_id: 'resp1' } });
        completed(socket, 'resp1', [callItem, item('original')] as any, 'response.incomplete');
        send(socket, { type: 'response.created', response: { id: 'resp2' } }); completed(socket, 'resp2', [item('steered')]);
      } else if (!event.previous_response_id) {
        send(socket, { type: 'response.created', response: { id: 'resp1' } });
        send(socket, { type: 'response.output_item.added', output_index: 0, item: { ...callItem, arguments: '' } });
        send(socket, { type: 'response.output_item.done', output_index: 0, item: callItem });
      } else { send(socket, { type: 'response.created', response: { id: 'resp3' } }); completed(socket, 'resp3', [item('result consumed')]); }
    };
    try {
      const draft = await app.product.draft();
      const providerId = await draft.configs.createConfig({ type: 'openai-responses', name: 'native isolated', enabled: true,
        url: profile.endpoint, model: 'fixture', apiKey: '', timeout: 3000 });
      await draft.configs.updateConfig(providerId, { responsesWebSocketEnabled: true, responsesAsyncToolsEnabled: true } as any);
      await app.product.save(draft);
      const snapshot = app.settings.snapshot(); profile.id = providerId;
      expect(snapshot.settings.providers.find(provider => provider.id === providerId)?.capabilities).toMatchObject({ responsesWebSocket: true, responsesAsyncTools: true });
      const agent = { ...snapshot.settings.agents[0], id: 'native-flow', providerId, name: 'native flow', toolNames: ['native_read_fixture'], maxIterations: 6 };
      snapshot.settings.agents.push(agent); await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
      const conversation = await app.createConversation('owner', 'Native isolated flow');
      const run = await app.runtime.start({ actorId: 'owner', agentId: agent.id, conversationId: conversation.id, requestKey: 'native-ui',
        message: { role: 'user', parts: [{ text: 'read and continue' }] } });
      await started.promise;
      const request = { type: 'chat.sendInterruptMessage', data: { conversationId: conversation.id, messageId: 'user-update', text: 'new platform direction' } };
      const receipts = await Promise.all([router.call({ actorId: 'owner', clientId: 'native-ui' }, 'ui.request', request),
        router.call({ actorId: 'owner', clientId: 'native-ui' }, 'ui.request', request)]);
      expect(receipts[0]).toEqual(receipts[1]); expect(receipts[0]).toMatchObject({ success: true, queued: true });
      release.resolve();
      expect((await app.runtime.wait(run.id))?.status).toBe('completed');
      const history = (await app.storage.readFullHistory(conversation.id)).messages;
      expect(executions).toBe(1);
      expect(history.filter(message => message.role === 'model')).toHaveLength(3);
      expect(history.filter(message => message.parts.some(part => part.text === 'new platform direction'))).toHaveLength(1);
      expect(history.flatMap(message => message.parts).filter(part => part.functionResponse)).toHaveLength(1);
      expect(requests.filter(event => event.type === 'response.steer')).toHaveLength(1);
      expect(requests.filter(event => event.type === 'response.create')).toHaveLength(2);
      expect(requests.at(-1).previous_response_id).toBe('resp2');
      expect(requests.at(-1).input).toHaveLength(1); expect(requests.at(-1).input[0].call_id).toBe('platform-call');
    } finally { release.resolve(); await app.close(); await f.cleanup(); }
  });

  test('does not reconnect or replay after a connection closes during a response', async () => {
    handler = socket => { send(socket, { type: 'response.created', response: { id: 'lost' } }); socket.close(); };
    await expect(adapter.generate(base())).rejects.toThrow('连接已关闭');
    expect(connections).toBe(1); expect(requests).toHaveLength(1);
  });

  test('真实后台命令与浏览器跨轮执行，原始结果和截图只回传一次', async () => {
    const f = await fixture(); await f.store.close();
    const browserStarted = deferred(), browserRelease = deferred(); let browserExecutions = 0, rounds = 0;
    const image = 'aW1hZ2U=';
    const app = await PlatformApplication.open({ dataDirectory: f.data, models: adapter, browser: () => ({
      tool: async (name, args, context) => {
        expect(name).toBe('browser_action'); expect(args.task_handle).toBeUndefined(); expect(context.nativeAsync).toBe(true);
        browserExecutions++; browserStarted.resolve(); await browserRelease.promise;
        return { success: true, data: { observationId: 'new-observation', url: args.url }, attachments: [{ mimeType: 'image/png', data: image }] };
      }, call: async () => ({}), finishRun: () => {}, close: () => {},
    }) });
    app.tools.register({ declaration: { name: 'native_independent', description: '独立工作', parameters: { type: 'object', properties: {} } },
      effects: () => [], execute: async () => { await browserStarted.promise; browserRelease.resolve(); return { success: true }; } });
    const command = process.platform === 'win32' ? 'node native-terminal.cjs; exit $LASTEXITCODE' : 'node native-terminal.cjs; exit $?';
    await writeFile(path.join(f.root, 'native-terminal.cjs'), "console.log('native-output'); setTimeout(() => { process.exitCode = 7; }, 500);");
    const nativeCall = (id: string, name: string, args: object) => ({ type: 'function_call', id: `fc-${id}`, call_id: id, name, arguments: JSON.stringify(args), async: true });
    const commandCall = nativeCall('command-call', 'execute_command', { command, shell: process.platform === 'win32' ? 'powershell' : 'default', background: true, task_handle: 'command' });
    const browserCall = nativeCall('browser-call', 'browser_action', { action: 'navigate', tabId: 'fixture-tab', url: 'https://fixture.test/', task_handle: 'browser' });
    handler = async (socket, event) => {
      expect(event.type).toBe('response.create'); rounds++;
      send(socket, { type: 'response.created', response: { id: `migration-${rounds}` } });
      if (rounds === 1) {
        for (const [output_index, call] of [commandCall, browserCall].entries()) send(socket, { type: 'response.output_item.done', output_index, item: call });
        completed(socket, 'migration-1', [commandCall, { ...browserCall, async: false }] as any);
      } else if (rounds === 2) {
        expect((event.input ?? []).some((value: any) => value.type === 'function_call_output')).toBe(false);
        completed(socket, 'migration-2', [{ type: 'function_call', id: 'fc-independent', call_id: 'independent', name: 'native_independent', arguments: '{}' }] as any);
      } else if (rounds === 3) {
        completed(socket, 'migration-3', [{ type: 'function_call', id: 'fc-wait', call_id: 'wait', name: 'wait_for_tasks', arguments: '{"task_handles":["command","browser"]}' }] as any);
      } else completed(socket, `migration-${rounds}`, [item('finished')]);
    };
    try {
      const draft = await app.product.draft();
      const providerId = await draft.configs.createConfig({ type: 'openai-responses', name: 'native migration', enabled: true,
        url: profile.endpoint, model: 'fixture', apiKey: '', timeout: 10000, multimodalToolsEnabled: true });
      await draft.configs.updateConfig(providerId, { responsesWebSocketEnabled: true, responsesAsyncToolsEnabled: true } as any);
      await app.product.save(draft); profile.id = providerId;
      const snapshot = app.settings.snapshot();
      snapshot.settings.workspaces.push({ id: 'native-workspace', name: 'Native fixture', directory: f.root, deviceId: 'local' });
      snapshot.settings.agents.push({ ...snapshot.settings.agents[0], id: 'native-migration', providerId, maxIterations: 8,
        toolNames: ['execute_command', 'browser_action', 'native_independent'], toolApproval: { execute_command: 'auto', browser_action: 'auto' } });
      await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
      const conversation = await app.createConversation('owner', 'native migration');
      await app.storage.appendHistory(conversation.id, [
        { id: 'native-first', role: 'user', isUserInput: true, parts: [{ text: '保留当前任务。' }] },
        { id: 'native-old', role: 'model', isSummarized: true, parts: [{ text: 'summarized-native-evidence' }] },
        { id: 'native-boundary', role: 'user', isSummary: true, parts: [{ text: '继续当前窗口。' }] },
      ]);
      const run = await app.runtime.start({ actorId: 'owner', agentId: 'native-migration', workspaceId: 'native-workspace', conversationId: conversation.id,
        requestKey: 'native-migration', message: { role: 'user', parts: [{ text: '启动命令并打开页面，同时继续其他工作。' }] } });
      expect((await app.runtime.wait(run.id))?.status).toBe('completed'); expect(browserExecutions).toBe(1);
      expect(requests[1].previous_response_id).toBe('migration-1');
      expect(JSON.stringify(requests)).not.toContain('summarized-native-evidence');
      const history = (await app.storage.readFullHistory(conversation.id)).messages;
      const results = history.flatMap(message => message.parts).flatMap(part => part.functionResponse ? [part.functionResponse as any] : []);
      expect(results.filter(value => value.id === 'command-call')).toHaveLength(1);
      expect(results.find(value => value.id === 'command-call').response).toMatchObject({ success: false, data: { exitCode: 7, status: 'error', running: false } });
      expect(results.find(value => value.id === 'command-call').response.data.output).toContain('native-output');
      expect(results.filter(value => value.id === 'browser-call')).toHaveLength(1);
      expect(history.filter(message => message.backgroundTask)).toHaveLength(0);
      expect(requests.flatMap(event => event.input ?? []).filter((value: any) => value.type === 'function_call_output' && value.call_id === 'command-call')).toHaveLength(1);
      expect(JSON.stringify(requests)).toContain(`data:image/png;base64,${image}`);
      const legacyHistory = formatHistoryForAPI(history as any, { channelType: 'openai' });
      expect(validateHistoryIntegrity(legacyHistory, { detectOrphanFunctionCall: true }).valid).toBe(true);
      expect(JSON.stringify(legacyHistory)).toContain('native-output');
      expect(legacyHistory.flatMap(message => message.parts).flatMap(part => part.inlineData ? [part.inlineData.data] : [])).toEqual([image]);
      expect(await app.storage.listRecords('native-tool-calls')).toEqual([]);
    } finally { browserRelease.resolve(); await app.close(); await f.cleanup(); }
  }, 25000);

  test.each([false, true])('取消生成仍保留原生后台命令且只交付一次，清理期间完成：%s', async duringCancellation => {
    const f = await fixture(); await f.store.close();
    const ready = deferred(), delivered = deferred(); let rounds = 0;
    const app = await PlatformApplication.open({ dataDirectory: f.data, models: adapter });
    app.subscribe(event => {
      if (event.type === 'tool.progress' && String((event as any).payload?.text).includes('native-ready')) ready.resolve();
    });
    const enqueue = app.subagents.feedback.enqueueMessage.bind(app.subagents.feedback);
    jest.spyOn(app.subagents.feedback, 'enqueueMessage').mockImplementation(async (pending, records) => {
      await enqueue(pending, records);
      if (pending.message.parts.some(part => (part.functionResponse as any)?.id === 'cancel-command')) delivered.resolve();
    });
    const heldFeedback = duringCancellation ? jest.spyOn(app.subagents.feedback, 'flush').mockResolvedValue(false) : undefined;
    if (duringCancellation) {
      const nativeTools = (app.runtime as any).nativeTools;
      const interrupt = nativeTools.interrupt.bind(nativeTools);
      // 固定命令先完成、取消后结算的顺序，不依赖定时竞争碰巧发生。
      jest.spyOn(nativeTools, 'interrupt').mockImplementation(async runId => { await delivered.promise; return interrupt(runId); });
    }
    await writeFile(path.join(f.root, 'native-cancel.cjs'), "console.log('native-ready'); setTimeout(() => { console.log('native-finished'); }, 1000);");
    const command = process.platform === 'win32' ? 'node native-cancel.cjs; exit $LASTEXITCODE' : 'node native-cancel.cjs; exit $?';
    const call = { type: 'function_call', id: 'fc-cancel-command', call_id: 'cancel-command', name: 'execute_command', async: true,
      arguments: JSON.stringify({ command, shell: process.platform === 'win32' ? 'powershell' : 'default', background: true, task_handle: 'cancel-command' }) };
    handler = socket => {
      rounds++; send(socket, { type: 'response.created', response: { id: `cancel-${rounds}` } });
      if (rounds === 1) send(socket, { type: 'response.output_item.done', output_index: 0, item: call });
      else completed(socket, `cancel-${rounds}`, [item('background consumed')]);
    };
    try {
      const draft = await app.product.draft();
      const providerId = await draft.configs.createConfig({ type: 'openai-responses', name: 'native cancel', enabled: true,
        url: profile.endpoint, model: 'fixture', apiKey: '', timeout: 10000 });
      await draft.configs.updateConfig(providerId, { responsesWebSocketEnabled: true, responsesAsyncToolsEnabled: true } as any);
      await app.product.save(draft); profile.id = providerId;
      const snapshot = app.settings.snapshot();
      snapshot.settings.workspaces.push({ id: 'cancel-workspace', name: 'Cancel fixture', directory: f.root, deviceId: 'local' });
      snapshot.settings.agents.push({ ...snapshot.settings.agents[0], id: 'native-cancel', providerId, maxIterations: 6,
        toolNames: ['execute_command'], toolApproval: { execute_command: 'auto' } });
      await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
      const conversation = await app.createConversation('owner', 'native cancel');
      const run = await app.runtime.start({ actorId: 'owner', agentId: 'native-cancel', workspaceId: 'cancel-workspace', conversationId: conversation.id,
        requestKey: 'native-cancel', message: { role: 'user', parts: [{ text: '启动后台命令。' }] } });
      await ready.promise; await app.runtime.cancel(run.id, 'owner'); expect((await app.runtime.wait(run.id))?.status).toBe('cancelled');
      if (!duringCancellation) expect(app.runtime.pendingAsyncToolCalls(conversation.id)).toEqual(['cancel-command']);
      await delivered.promise;
      if (duringCancellation) {
        const beforeDelivery = (await app.storage.readFullHistory(conversation.id)).messages;
        const callIndex = beforeDelivery.findIndex(message => message.parts.some(part => (part.functionCall as any)?.id === 'cancel-command'));
        await app.conversations.settleCancelled('owner', conversation.id, callIndex, ['cancel-command']);
        expect((await app.storage.readFullHistory(conversation.id)).messages.flatMap(message => message.parts)
          .filter(part => (part.functionResponse as any)?.id === 'cancel-command')).toHaveLength(0);
        heldFeedback!.mockRestore();
        await app.subagents.feedback.flush(conversation.id);
      }
      const history = (await app.storage.readFullHistory(conversation.id)).messages;
      const results = history.flatMap(message => message.parts).flatMap(part => part.functionResponse ? [part.functionResponse as any] : []);
      expect(results.filter(value => value.id === 'cancel-command')).toHaveLength(1);
      expect(results.find(value => value.id === 'cancel-command').response).toMatchObject({ success: true, data: { exitCode: 0 } });
      expect(results.find(value => value.id === 'cancel-command').response.data.output).toContain('native-finished');
      expect(history.filter(message => message.backgroundTask)).toHaveLength(0);
    } finally { heldFeedback?.mockRestore(); await app.close(); await f.cleanup(); }
  }, 25000);
});
