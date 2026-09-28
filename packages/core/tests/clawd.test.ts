import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ClawdTransport } from '../../../apps/server/src/clawd/transport';
import { pauseRestoredActivities } from '../../../apps/server/src/backups/resources';
import { fixture } from './fixtures';

const agentId = 'custom-graycode-0123456789ab';
const owner = { actorId: 'owner', clientId: 'clawd-settings' };
const waitUntil = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('等待 Clawd 联动超时。');
};
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('Clawd 自定义 HTTP Agent 联动', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication;
  let server: ReturnType<typeof createServer>, runtimePath: string, port: number;
  let requests: Array<{ body: Record<string, any>; headers: IncomingHttpHeaders; path?: string }>;
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  let statusCode: number, holdRequests: boolean, held: ServerResponse[];
  const gates: ReturnType<typeof gate>[] = [];
  const hold = () => { const result = gate(); gates.push(result); return result; };
  const enable = async () => {
    const snapshot = app.settings.snapshot(); snapshot.settings.clawd = { enabled: true, agentId };
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    expect(await app.clawd.check()).toMatchObject({ state: 'connected', port }); requests.length = 0;
  };
  const start = async (title = 'Clawd fixture') => {
    const conversation = await app.createConversation('owner', title);
    return app.runtime.start({ conversationId: conversation.id, actorId: 'owner', agentId: 'default', requestKey: conversation.id,
      message: { role: 'user', parts: [{ text: 'private-prompt-must-not-be-sent' }] } });
  };

  beforeEach(async () => {
    f = await fixture(); await f.store.close(); runtimePath = join(f.root, 'clawd-runtime.json');
    requests = []; held = []; statusCode = 200; holdRequests = false;
    server = createServer((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requests.push({ body: JSON.parse(body), headers: request.headers, path: request.url });
        if (holdRequests) held.push(response); else { response.writeHead(statusCode); response.end(statusCode === 204 ? undefined : 'ok'); }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as { port: number }).port;
    await writeFile(runtimePath, JSON.stringify({ app: 'clawd-on-desk', port }));
    const transport = new ClawdTransport(runtimePath), send = transport.send.bind(transport);
    jest.spyOn(ClawdTransport.prototype, 'send').mockImplementation(send);
    generate = async () => ({ role: 'model', parts: [{ text: 'finished' }] });
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } });
  });
  afterEach(async () => {
    holdRequests = false; for (const response of held) if (!response.writableEnded && !response.destroyed) { response.writeHead(200); response.end('ok'); }
    for (const item of gates.splice(0)) item.resolve();
    await app?.close(); jest.restoreAllMocks();
    server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup();
  });

  test('沿用设置草稿、导出和持久化，旧设置不启用，备份恢复暂停联动', async () => {
    expect(app.settings.snapshot().settings.clawd).toBeUndefined();
    expect(await app.clawd.check()).toEqual({ state: 'disabled' }); expect(requests).toHaveLength(0);
    await app.productUi.call(owner, 'ui.settings.begin');
    const settings = app.settings.snapshot().settings; settings.clawd = { enabled: true, agentId };
    await app.productUi.call(owner, 'platform.settings.update', { settings });
    expect(app.clawd.status().state).toBe('disabled');
    await app.productUi.call(owner, 'ui.settings.save');
    expect(await app.clawd.check()).toMatchObject({ state: 'connected' });
    const exported = await app.productUi.call(owner, 'settings.exportData') as { settings: typeof settings };
    expect(exported.settings.clawd).toEqual({ enabled: true, agentId });
    expect(await app.storage.getRecord('platform-settings', 'main')).toMatchObject({ clawd: { enabled: true, agentId } });
    await pauseRestoredActivities(app.storage);
    expect(await app.storage.getRecord('platform-settings', 'main')).toMatchObject({ clawd: { enabled: false, agentId } });
    const invalid = app.settings.snapshot(); invalid.settings.clawd = { enabled: true, agentId: 'claude-code' };
    await expect(app.settings.save({ settings: invalid.settings, expectedRevision: invalid.revision })).rejects.toThrow(/Agent ID/);
    await expect(app.productUi.call({ actorId: 'guest', clientId: 'guest' }, 'platform.clawd.check')).rejects.toThrow();
  });

  test('真实任务的思考、审批、工具和完成送往本机 HTTP，只包含生命周期元数据', async () => {
    const modelGate = hold(), toolGate = hold(), finishGate = hold(); let calls = 0;
    generate = async () => {
      if (++calls === 1) { await modelGate.promise; return { role: 'model', parts: [{ functionCall: { id: 'tool-1', name: 'clawd_fixture', args: { secret: 'private-tool-input' } } }] }; }
      await finishGate.promise; return { role: 'model', parts: [{ text: 'private-model-output' }] };
    };
    app.tools.register({ declaration: { name: 'clawd_fixture', description: 'fixture', parameters: { type: 'object' } },
      effects: () => ['process_execute'], execute: async () => { await toolGate.promise; return { success: true }; } });
    const snapshot = app.settings.snapshot(); snapshot.settings.agents[0].toolNames = ['clawd_fixture'];
    snapshot.settings.agents[0].toolApproval = { clawd_fixture: 'ask' };
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    await enable(); const run = await start();
    await waitUntil(() => requests.some(item => item.body.state === 'thinking'));
    modelGate.resolve(); await waitUntil(() => requests.some(item => item.body.state === 'notification'));
    const approval = app.runtime.pendingApprovals().find(item => item.runId === run.id)!;
    expect(approval).toBeDefined(); expect(requests.every(item => item.path === '/state')).toBe(true);
    await app.runtime.resolveApproval(approval.id, 'owner', true);
    await waitUntil(() => requests.some(item => item.body.state === 'working'));
    toolGate.resolve(); await waitUntil(() => calls === 2); finishGate.resolve();
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    await waitUntil(() => requests.some(item => item.body.event === 'Stop'));
    expect(new Set(requests.map(item => item.body.session_id)).size).toBe(1);
    expect(requests.every(item => item.headers.origin === undefined && item.headers.host === `127.0.0.1:${port}`
      && item.headers['content-type'] === 'application/json' && item.body.agent_id === agentId)).toBe(true);
    expect(JSON.stringify(requests)).not.toMatch(/private-prompt|private-tool-input|private-model-output/);
    await app.close(); await waitUntil(() => requests.some(item => item.body.event === 'SessionEnd'));
  });

  test.each(['cancelled', 'failed'] as const)('%s 结束真实任务，不误报完成', async outcome => {
    const modelGate = hold(); generate = async () => { await modelGate.promise; throw new Error('synthetic model failure'); };
    await enable(); const run = await start();
    await waitUntil(() => requests.some(item => item.body.state === 'thinking'));
    if (outcome === 'cancelled') await app.runtime.cancel(run.id, 'owner');
    modelGate.resolve(); expect((await app.runtime.wait(run.id))?.status).toBe(outcome);
    await waitUntil(() => requests.some(item => item.body.event === (outcome === 'cancelled' ? 'SessionEnd' : 'PostToolUseFailure')));
    expect(requests.some(item => item.body.event === 'Stop')).toBe(false);
  });

  test('慢连接不阻塞任务；待发送状态合并为最新状态，多个对话分别记录', async () => {
    const one = hold(), two = hold(); let calls = 0;
    generate = async () => { await (++calls === 1 ? one : two).promise; return { role: 'model', parts: [{ text: 'finished' }] }; };
    await enable(); holdRequests = true;
    const first = await start('one'); await waitUntil(() => held.length === 1);
    const second = await start('two'); await waitUntil(() => calls === 2);
    one.resolve(); expect((await app.runtime.wait(first.id))?.status).toBe('completed');
    expect(held[0].writableEnded).toBe(false);
    holdRequests = false; held[0].writeHead(200); held[0].end('ok');
    await waitUntil(() => requests.some(item => item.body.event === 'Stop'));
    await waitUntil(() => requests.some(item => item.body.session_id.endsWith(second.conversationId) && item.body.state === 'thinking'));
    expect(new Set(requests.map(item => item.body.session_id)).size).toBe(2);
    const snapshot = app.settings.snapshot(); snapshot.settings.clawd!.enabled = false;
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    await waitUntil(() => app.clawd.status().state === 'disabled');
    expect(requests.filter(item => item.body.event === 'SessionEnd')).toHaveLength(2);
    two.resolve(); await app.runtime.wait(second.id);
  });

  test('注册被禁用的 204 不视为连接成功，恢复后读取新的运行端口', async () => {
    await enable(); statusCode = 204;
    expect(await app.clawd.check()).toMatchObject({ state: 'unregistered' });
    await writeFile(runtimePath, JSON.stringify({ app: 'another-app', port }));
    expect(await app.clawd.check()).toEqual({ state: 'offline' });
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as { port: number }).port;
    statusCode = 200; await writeFile(runtimePath, JSON.stringify({ app: 'clawd-on-desk', port }));
    expect(await app.clawd.check()).toMatchObject({ state: 'connected', port });
    expect(requests.at(-1)!.body.event).toBe('SessionEnd');
  });
});
