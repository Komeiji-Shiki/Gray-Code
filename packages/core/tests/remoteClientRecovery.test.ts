import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { startHttpServer } from '../../../apps/server/src/transport/http';
import { fixture } from './fixtures';
import { PlatformPromptService } from '../../../apps/server/src/prompt/service';

async function waitUntil(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('客户端资源未在预期时间内释放');
}
async function synchronized(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('同步回执前事件连接已结束');
    text += Buffer.from(chunk.value).toString('utf8');
    const match = /event: synchronized\ndata: ([^\n]+)\n\n/.exec(text);
    if (match) return { text, value: JSON.parse(match[1]) };
  }
}

test('真实 Web 重连在宽限内保留锁，离线清理后恢复原身份与草稿并拒绝覆盖新磁盘版本', async () => {
  const f = await fixture(); await f.store.close();
  await writeFile(path.join(f.source, 'main.ts'), 'export const saved = 1;\n');
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const token = 'isolated-browser-client-recovery-token';
  const http = await startHttpServer(app, { token, clientDirectory: f.root, clientRecoveryGraceMs: 120 });
  const origin = `http://127.0.0.1:${http.port}`;
  const controllers: AbortController[] = [];
  try {
    const settings = app.settings.snapshot();
    settings.settings.workspaces.push({ id: 'project', name: '恢复测试', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    const login = await fetch(origin + '/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(login.ok).toBe(true);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(origin + '/rpc', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Graycode-Client': 'retained-tab', 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
      const value = await response.json() as { result: any; error?: string };
      if (!response.ok) throw new Error(value.error); return value.result;
    };
    const connect = async (cursor = '') => {
      const controller = new AbortController(); controllers.push(controller);
      const response = await fetch(origin + '/events?client=retained-tab' + (cursor ? '&after=' + encodeURIComponent(cursor) : ''), { headers: { Cookie: cookie }, signal: controller.signal });
      const reader = response.body!.getReader(), result = await synchronized(reader);
      return { controller, reader, ...result };
    };
    const first = await connect(); expect(first.value.reset).toBe(false);
    const identity = await rpc('session.info');
    const client = { actorId: 'owner', clientId: identity.clientId };
    const params = { workspaceId: 'project', path: 'main.ts' };
    let document = await rpc('documents.open', params);
    document = await rpc('documents.update', { ...params, version: document.version, text: 'export const draft = 2;\n' });
    await rpc('documents.focus', params);
    const language = await rpc('language.ensure', params);
    expect(language.session.status).toBe('running');
    await rpc('ui.settings.begin');
    await rpc('ui.request', { type: 'tools.updateMaxToolIterations', data: { maxIterations: 73 } });
    expect(await app.productUi.hasDirtyPreferences()).toBe(true);
    app.publish({ type: 'fixture.recoveryCursor' });
    // 使用实际交付的事件游标，验证释放资源也会触发重建，而不是依赖游标失效。
    let delivered = '';
    while (!delivered.includes('"fixture.recoveryCursor"}\n\n')) {
      const chunk = await first.reader.read(); if (chunk.done) throw new Error('测试游标未交付');
      delivered += Buffer.from(chunk.value).toString('utf8');
    }
    const frame = delivered.split('\n\n').find(value => value.includes('fixture.recoveryCursor'))!;
    const cursor = /^id: (.+)$/m.exec(frame)![1];
    first.controller.abort();
    await waitUntil(() => http.diagnostics().connections === 0);
    await expect(app.files.write(app.workspace('owner', 'project', ['workspace_write']), 'main.ts', 'blocked', document.baseHash)).rejects.toThrow('DOCUMENT_DIRTY');
    const withinGrace = await connect(cursor); expect(withinGrace.value.reset).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(app.files.dirtyPaths('project')).toEqual(['main.ts']);
    expect(await app.productUi.hasDirtyPreferences()).toBe(true);
    withinGrace.controller.abort();
    await waitUntil(async () => http.diagnostics().connections === 0 && !app.files.dirtyPaths('project').length &&
      !app.languages.list(client).sessions.length && !await app.productUi.hasDirtyPreferences());
    expect(app.files.clientDocument(client.clientId, 'project', 'main.ts')).toMatchObject({ text: document.text, baseHash: document.baseHash, version: document.version, dirty: true });
    expect(app.files.dirtyDocumentCount()).toBe(1); expect(app.files.dirtyDocumentCount(false)).toBe(0);
    expect(app.files.dirtyDocumentCount(true, client.clientId)).toBe(0);
    expect(await app.productUi.hasDirtyPreferences(true)).toBe(true);
    const workspace = app.workspace('owner', 'project', ['workspace_write']);
    await app.files.write(workspace, 'main.ts', 'export const otherWriter = 3;\n', document.baseHash);
    // 普通 RPC 先于 SSE 恢复时也不能吞掉需要重建的回执。
    expect((await rpc('session.info')).clientId).toBe(client.clientId);
    const resumed = await connect(cursor); expect(resumed.value.reset).toBe(true);
    const restored = await rpc('documents.open', { ...params, reload: true });
    expect(restored).toMatchObject({ text: document.text, version: document.version, baseHash: document.baseHash, dirty: true });
    await expect(rpc('documents.save', { ...params, version: restored.version })).rejects.toThrow('FILE_CONFLICT');
    expect(await readFile(path.join(f.source, 'main.ts'), 'utf8')).toContain('otherWriter');
    expect(await rpc('ui.settings.begin')).toMatchObject({ dirty: true });
    expect(await rpc('ui.request', { type: 'tools.getMaxToolIterations', data: {} })).toMatchObject({ maxIterations: 73 });
    expect(await app.productUi.hasDirtyPreferences()).toBe(true);
    const restarted = await rpc('language.ensure', params);
    expect(restarted.session.status).toBe('running'); expect(restarted.session.id).not.toBe(language.session.id);
  } finally { for (const controller of controllers) controller.abort(); await http.close(); await app.close(); await f.cleanup(); }
});

test('旧提示词准备挂起时仍能经真实 HTTP 重连并进入取消，清理不等待交互队列', async () => {
  const f = await fixture(); await f.store.close();
  const generate = jest.fn(async () => ({ role: 'model', parts: [{ text: '不应生成' }] }));
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate } });
  const token = 'isolated-pending-client-recovery-token';
  const http = await startHttpServer(app, { token, clientRecoveryGraceMs: 50 });
  const origin = `http://127.0.0.1:${http.port}`, headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const entered = deferred(), release = deferred(), aborted = deferred();
  const prepare = PlatformPromptService.prototype.prepare;
  const preparing = jest.spyOn(PlatformPromptService.prototype, 'prepare').mockImplementationOnce(async function (this: PlatformPromptService, input) {
    entered.resolve(); await release.promise; return prepare.call(this, input);
  });
  const begin = app.runtime.start.bind(app.runtime);
  const start = jest.spyOn(app.runtime, 'start').mockImplementation((...args) => {
    args[2]?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true }); return begin(...args);
  });
  const close = jest.spyOn(http.router, 'clientClosed');
  const controllers: AbortController[] = [];
  const rpc = async (type: string, data: object) => {
    const response = await fetch(origin + '/rpc', { method: 'POST', headers, body: JSON.stringify({ method: 'ui.request', params: { type, data } }) });
    return { status: response.status, ...await response.json() as { result?: any; error?: string } };
  };
  let started: ReturnType<typeof rpc> | undefined, stopping: ReturnType<typeof rpc> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const connect = async () => {
      const controller = new AbortController(); controllers.push(controller);
      const response = await fetch(origin + '/events', { headers, signal: controller.signal });
      const result = await synchronized(response.body!.getReader()); return { controller, ...result };
    };
    const first = await connect();
    const conversation = await app.createConversation('owner', 'HTTP 准备取消');
    started = rpc('chatStream', { conversationId: conversation.id, configId: 'fixture', streamId: 'pending-http', message: '保留待发送输入' });
    await entered.promise; first.controller.abort(); await waitUntil(() => close.mock.calls.length > 0);
    deadline = setTimeout(() => controllers.at(-1)?.abort(new Error('重连被旧队列阻塞')), 1000);
    const resumed = await connect(); clearTimeout(deadline);
    expect(resumed.value.reset).toBe(true);
    stopping = rpc('cancelStream', { conversationId: conversation.id });
    await Promise.race([aborted.promise, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('HTTP 取消入口被旧队列阻塞')), 1000); })]);
    clearTimeout(deadline); release.resolve();
    expect(await stopping).toMatchObject({ status: 200, result: { success: true } });
    expect(await started).toMatchObject({ status: 400 });
    expect((await app.storage.readFullHistory(conversation.id)).messages).toEqual([]); expect(generate).not.toHaveBeenCalled();
  } finally {
    clearTimeout(deadline); release.resolve(); await started; await stopping;
    for (const controller of controllers) controller.abort(); preparing.mockRestore(); start.mockRestore(); close.mockRestore();
    await http.close(); await app.close(); await f.cleanup();
  }
});

test('释放失败保留诊断并在离线期间重试，成功后才清除失败状态', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const token = 'isolated-failed-client-release-token';
  const http = await startHttpServer(app, { token, clientRecoveryGraceMs: 80 });
  const controller = new AbortController();
  const close = jest.spyOn(http.router, 'clientClosed').mockRejectedValueOnce(new Error('temporary stop failure'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const response = await fetch(`http://127.0.0.1:${http.port}/events`, { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal });
    await synchronized(response.body!.getReader()); controller.abort();
    await waitUntil(() => http.diagnostics().failedClientReleases === 1);
    await waitUntil(() => close.mock.calls.length >= 2 && http.diagnostics().failedClientReleases === 0);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { controller.abort(); close.mockRestore(); warn.mockRestore(); await http.close(); await app.close(); await f.cleanup(); }
});

test('离线的脏文档经过其它客户端目录移动后仍可恢复原正文和冲突基线', async () => {
  const f = await fixture(); await f.store.close();
  await writeFile(path.join(f.source, 'original.txt'), 'saved');
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app);
  const client = { actorId: 'owner', clientId: 'offline-editor' }, other = { actorId: 'owner', clientId: 'other-editor' };
  const rpc = (method: string, params: Record<string, unknown>, identity = client) => router.call(identity, method, { workspaceId: 'project', ...params }) as Promise<any>;
  try {
    const settings = app.settings.snapshot(); settings.settings.workspaces.push({ id: 'project', name: '文件恢复', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    let doc = await rpc('documents.open', { path: 'original.txt' });
    doc = await rpc('documents.update', { path: doc.path, text: 'retained draft', version: doc.version });
    await router.clientClosed(client.clientId);
    const entry = await rpc('files.inspect', { path: 'original.txt' }, other);
    await rpc('files.move', { path: entry.path, target: 'moved.txt', expectedVersion: entry.version }, other);
    const recovered = await rpc('documents.open', { path: 'original.txt', reload: true });
    expect(recovered).toMatchObject({ text: doc.text, baseHash: doc.baseHash, version: doc.version, dirty: true });
    await expect(rpc('documents.save', { path: recovered.path, version: recovered.version })).rejects.toThrow('FILE_CONFLICT');
    expect(await readFile(path.join(f.source, 'moved.txt'), 'utf8')).toBe('saved');
  } finally { await app.close(); await f.cleanup(); }
});
