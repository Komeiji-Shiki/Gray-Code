import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PlatformApplication } from '../application';
import { ApplicationRouter, type ClientSession } from './router';
import { WebSessions, type WebSessionSnapshot } from './webSessions';
import { serveWebAsset } from './webAssets';
import { WebHost } from './webHost';
import { randomUUID } from 'node:crypto';
import { normalizeWebOrigin } from './webOrigin';
import { serveWorkspaceFile } from './fileTransfers';

export interface HttpServerOptions { port?: number; token: string; actorId?: string; clientDirectory?: string; publicOrigin?: string; onConnectionsChanged?: () => void; clientRecoveryGraceMs?: number }
async function readBody(request: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('请求内容超过大小限制。'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须是对象。');
  return value;
}

/** 保持回环监听；远程访问由显式配置的 HTTPS 反向代理入口提供。 */
export async function startHttpServer(application: PlatformApplication, options: HttpServerOptions) {
  const publicOrigin = normalizeWebOrigin(options.publicOrigin);
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('Web 端口必须在 0 至 65535 之间。');
  const actorId = options.actorId ?? 'owner';
  const sessions = new WebSessions(options.token, actorId, !!publicOrigin, options.onConnectionsChanged, {
    read: async () => await application.storage.getRecord('web-sessions', actorId) as WebSessionSnapshot | null,
    write: async value => { await application.storage.putRecord({ namespace: 'web-sessions', id: actorId, value }); },
  });
  await sessions.restore();
  const router = new ApplicationRouter(application);
  const streams = new Map<ServerResponse, { client: ClientSession; connectionId: string; valid(): boolean; queue: Promise<void>; queuedBytes: number; accepting: boolean }>();
  const recoveryGrace = options.clientRecoveryGraceMs ?? 30_000;
  if (!Number.isFinite(recoveryGrace) || recoveryGrace < 0) throw new Error('客户端恢复宽限必须是非负毫秒数。');
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clientReleases = new Map<string, Promise<void>>();
  const failedClientReleases = new Map<string, unknown>();
  const releasedClients = new Set<string>();
  const webClients = new Set<string>();
  let serverClosing = false;
  const connected = (clientId: string) => [...streams.values()].some(value => value.client.clientId === clientId && value.valid());
  const releaseClient = (clientId: string): Promise<void> => {
    const pending = clientReleases.get(clientId); if (pending) return pending;
    releasedClients.add(clientId);
    const completion = router.clientClosed(clientId).then(() => { failedClientReleases.delete(clientId); }).catch(error => {
      failedClientReleases.set(clientId, error); console.warn('[Web] 客户端资源释放失败，将在离线宽限后重试：', error);
    });
    clientReleases.set(clientId, completion);
    void completion.finally(() => {
      if (clientReleases.get(clientId) === completion) clientReleases.delete(clientId);
      if (failedClientReleases.has(clientId)) scheduleRelease(clientId);
    });
    return completion;
  };
  const activateClient = async (clientId: string, valid: () => boolean, acknowledgeRelease = false): Promise<boolean> => {
    if (!valid()) return false;
    clearTimeout(recoveryTimers.get(clientId)); recoveryTimers.delete(clientId);
    // 清理已经开始时先等它结束，避免重连刚恢复的文档或进程被旧清理回调再次释放。
    await clientReleases.get(clientId);
    // 被撤销的迟到请求不能重新激活资源，也不能取走下一次有效重连需要的重建标记。
    if (!valid()) return false;
    const released = acknowledgeRelease ? releasedClients.delete(clientId) : releasedClients.has(clientId);
    webClients.add(clientId); router.clientConnected(clientId); scheduleRelease(clientId); return released;
  };
  const scheduleRelease = (clientId: string) => {
    if (serverClosing || connected(clientId) || recoveryTimers.has(clientId)) return;
    const timer = setTimeout(() => {
      recoveryTimers.delete(clientId);
      if (!connected(clientId)) void releaseClient(clientId);
    }, recoveryGrace);
    timer.unref(); recoveryTimers.set(clientId, timer);
  };
  const writable = (response: ServerResponse, identity: { valid(): boolean }) => !response.destroyed && !response.writableEnded && identity.valid();
  const closeInvalidStreams = () => { for (const [stream, identity] of streams) if (!identity.valid()) { stream.end(); streams.delete(stream); } };
  const epoch = randomUUID(); let sequence = 0; let bufferedBytes = 0; let backlogResets = 0;
  const recent: { id: string; event: Record<string, unknown>; frame: Buffer; bytes: number }[] = [];
  const host = new WebHost(application, router);
  const failures = new Map<string, { count: number; until: number }>();
  const server = createServer(async (request, response) => {
    let validSession: (() => boolean) | undefined;
    response.on('error', () => response.destroy());
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const ownOrigin = publicOrigin ?? `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const allowed = new URL(ownOrigin);
    // 不信任客户端提交的 X-Forwarded-*；代理须保留已配置的 Host。
    if (request.headers.host !== allowed.host || (request.headers.origin && request.headers.origin !== ownOrigin)) {
      response.writeHead(403); response.end(JSON.stringify({ error: 'Origin is not allowed.' })); return;
    }
    try {
      const url = new URL(request.url ?? '/', ownOrigin);
      if (request.method === 'POST' && url.pathname === '/auth/login' && options.clientDirectory) {
        if (request.headers.origin !== ownOrigin) { response.writeHead(403); response.end('{}'); return; }
        const address = request.socket.remoteAddress ?? 'local'; const failure = failures.get(address);
        if (failure && failure.until > Date.now() && failure.count >= 10) {
          response.writeHead(429); response.end(JSON.stringify({ error: '尝试次数过多，请稍后重试。' })); return;
        }
        const input = await readBody(request, 4096);
        if (!sessions.matches(input.token)) {
          failures.set(address, { count: failure && failure.until > Date.now() ? failure.count + 1 : 1, until: Date.now() + 60_000 });
          response.writeHead(401); response.end(JSON.stringify({ error: '访问令牌不正确。' })); return;
        }
        const deviceName = typeof input.deviceName === 'string' ? input.deviceName : /Android/i.test(request.headers['user-agent'] ?? '') ? 'Android 浏览器' : /iPhone|iPad/i.test(request.headers['user-agent'] ?? '') ? 'iPhone / iPad 浏览器' : '浏览器';
        failures.delete(address); sessions.logout(request, response); sessions.login(response, deviceName); closeInvalidStreams();
        await sessions.flush();
        response.end(JSON.stringify({ success: true })); return;
      }
      const tab = String(request.headers['x-graycode-client'] ?? url.searchParams.get('client') ?? '');
      const auth = sessions.authenticate(request, tab, response);
      if (auth) {
        const valid = auth.valid, cookie = response.getHeader('Set-Cookie');
        auth.valid = () => {
          const current = valid();
          // 迟到响应不能用已撤销的 Cookie 覆盖新登录；退出主动写入的清除头和已发出的流式响应保持原样。
          if (!current && !response.headersSent && response.getHeader('Set-Cookie') === cookie) response.removeHeader('Set-Cookie');
          return current;
        };
        validSession = auth.valid;
      }
      if (request.method === 'GET' && !['/events', '/auth/session'].includes(url.pathname)
        && !url.pathname.startsWith('/assets/background/') && !url.pathname.startsWith('/preview/') && !url.pathname.startsWith('/files/')) {
        if (options.clientDirectory && await serveWebAsset(options.clientDirectory, url.pathname, response, validSession)) return;
      }
      if (!auth) { response.writeHead(401); response.end(JSON.stringify({ error: 'Authentication required.' })); return; }
      if (auth.browser && request.method === 'POST' && request.headers.origin !== ownOrigin) {
        response.writeHead(403); response.end(JSON.stringify({ error: 'Origin is required.' })); return;
      }
      const stillAuthenticated = () => {
        if (auth.valid()) return true;
        response.writeHead(401); response.end(JSON.stringify({ error: 'Authentication required.' })); return false;
      };
      if (url.pathname === '/auth/session' && request.method === 'GET') {
        response.end(JSON.stringify({ actor: application.actor(auth.client.actorId), clientId: auth.client.clientId })); return;
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        sessions.logout(request, response);
        await sessions.flush();
        closeInvalidStreams();
        response.end(JSON.stringify({ success: true })); return;
      }
      if (await serveWorkspaceFile(application, auth, url, request, response)) return;
      if (url.pathname.startsWith('/assets/background/') && request.method === 'GET') {
        application.requireOwner(auth.client.actorId);
        const image = await application.images.get(url.pathname.slice('/assets/background/'.length));
        if (!stillAuthenticated()) return;
        if (!image) { response.writeHead(404); response.end('{}'); return; }
        response.setHeader('Content-Type', image.mimeType); response.end(Buffer.from(image.bytes)); return;
      }
      if (url.pathname.startsWith('/preview/') && request.method === 'GET') {
        application.requireOwner(auth.client.actorId);
        const workspace = application.workspace(auth.client.actorId, decodeURIComponent(url.pathname.slice('/preview/'.length)), ['workspace_read']);
        const document = await application.files.read(workspace, url.searchParams.get('path') ?? '');
        if (!stillAuthenticated()) return;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        // 项目 HTML 在独立沙箱中显示，脚本不能访问登录 cookie、父窗口或宿主接口。
        response.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        response.end(document.text); return;
      }
      if (url.pathname === '/ui/media' && request.method === 'POST') {
        application.requireOwner(auth.client.actorId);
        const input = await readBody(request, 70 * 1024 * 1024);
        if (!stillAuthenticated()) return;
        if (!['previewAttachment', 'showContextContent', 'saveImageToPath'].includes(input.type)) throw new Error('不是媒体传输请求。');
        await activateClient(auth.client.clientId, auth.valid);
        if (!stillAuthenticated()) return;
        const result = await host.call(auth.client, 'ui.request', { type: input.type, data: input.data });
        auth.valid();
        response.end(JSON.stringify({ result })); return;
      }
      if (url.pathname === '/settings/import' && request.method === 'POST') {
        application.requireOwner(auth.client.actorId);
        const input = await readBody(request, 128 * 1024 * 1024);
        if (!stillAuthenticated()) return;
        await activateClient(auth.client.clientId, auth.valid);
        if (!stillAuthenticated()) return;
        const result = await host.call(auth.client, 'ui.request', { type: 'settings.importData', data: { value: input } });
        auth.valid();
        response.end(JSON.stringify({ result })); return;
      }
      if (url.pathname === '/character-resources/import' && request.method === 'POST') {
        application.requireOwner(auth.client.actorId);
        const input = await readBody(request, 44 * 1024 * 1024);
        if (!stillAuthenticated()) return;
        const result = await application.characters.import(input as { name: string; data: string });
        auth.valid();
        response.end(JSON.stringify({ result })); return;
      }
      if (url.pathname === '/pet-resources/import' && request.method === 'POST') {
        application.requireOwner(auth.client.actorId);
        const input = await readBody(request, 180 * 1024 * 1024);
        if (!stillAuthenticated()) return;
        await activateClient(auth.client.clientId, auth.valid);
        if (!stillAuthenticated()) return;
        const result = await router.call(auth.client, 'pets.import', input);
        auth.valid();
        response.end(JSON.stringify({ result })); return;
      }
      if (url.pathname === '/events' && request.method === 'GET') {
        const released = await activateClient(auth.client.clientId, auth.valid, true);
        if (!stillAuthenticated()) return;
        if (response.destroyed || response.writableEnded) { scheduleRelease(auth.client.clientId); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(': connected\n\n');
        const identity = { ...auth, queue: Promise.resolve(), queuedBytes: 0, accepting: true };
        const cursor = String(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '');
        let reset = released;
        if (released) response.write('event: reset\ndata: {}\n\n');
        if (cursor) {
          const index = recent.findIndex(event => event.id === cursor);
          if (index < 0) { if (!reset) response.write('event: reset\ndata: {}\n\n'); reset = true; }
          else {
            const replay = recent.slice(index + 1);
            identity.queue = (async () => {
              for (const entry of replay) if (writable(response, identity) && await router.mayReceive(identity.client, entry.event) && writable(response, identity)) response.write(entry.frame);
            })().catch(() => { identity.accepting = false; response.end(); });
          }
        }
        // 补发完成后再通知客户端同步快照，避免快照与旧事件相互覆盖。
        identity.queue = identity.queue.then(() => { if (writable(response, identity)) response.write(`event: synchronized\ndata: ${JSON.stringify({ reset })}\n\n`); });
        streams.set(response, identity);
        options.onConnectionsChanged?.();
        const heartbeat = setInterval(() => { if (!writable(response, auth)) { response.end(); return; } response.write(': heartbeat\n\n'); }, 20_000);
        heartbeat.unref(); response.once('close', () => {
          clearInterval(heartbeat); streams.delete(response); options.onConnectionsChanged?.();
          if (![...streams.values()].some(value => value.client.clientId === auth.client.clientId && value.valid())) {
            void application.computer.clientClosed(auth.client.clientId).catch(() => {});
            void application.nodes.clientClosed(auth.client.clientId).catch(() => {});
            scheduleRelease(auth.client.clientId);
          }
        }); return;
      }
      if (url.pathname !== '/rpc' || request.method !== 'POST') { response.writeHead(404); response.end('{"error":"Not found."}'); return; }
      const body = await readBody(request);
      if (!stillAuthenticated()) return;
      if (typeof body.method !== 'string' || (body.params && (typeof body.params !== 'object' || Array.isArray(body.params)))) throw new Error('Invalid RPC request.');
      await activateClient(auth.client.clientId, auth.valid);
      if (!stillAuthenticated()) return;
      const result = await host.call(auth.client, body.method, body.params ?? {});
      auth.valid();
      response.end(JSON.stringify({ result: result ?? null }));
    } catch (error) {
      validSession?.();
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed.',
        ...((error as { code?: string }).code ? { code: (error as { code: string }).code } : {}) }));
    }
  });
  const unsubscribe = application.subscribe(event => {
    const id = `${epoch}:${++sequence}`;
    // 编码后的字节只读复用，多个订阅和断线补发不必反复把同一帧转换为 UTF-8。
    const frame = Buffer.from(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    const bytes = frame.length;
    recent.push({ id, event, frame, bytes }); bufferedBytes += bytes;
    while (recent.length > 2000 || bufferedBytes > 8 * 1024 * 1024) bufferedBytes -= recent.shift()!.bytes;
    for (const [stream, identity] of streams) {
      if (!identity.valid()) { stream.end(); streams.delete(stream); continue; }
      if (!identity.accepting) continue;
      const backlog = identity.queuedBytes + stream.writableLength;
      if (backlog > 0 && backlog + bytes > 1024 * 1024) {
        identity.accepting = false; backlogResets++;
        // 先完整交付已接受的帧，再让客户端重建快照，不能中途截断一张较大的工具图片。
        void identity.queue.then(() => {
          if (!stream.destroyed && !stream.writableEnded) { stream.write('event: reset\ndata: {}\n\n'); stream.end(); }
        }).catch(() => stream.destroy());
        continue;
      }
      identity.queuedBytes += bytes;
      identity.queue = identity.queue.then(async () => {
        if (!writable(stream, identity) || !await router.mayReceive(identity.client, event) || !writable(stream, identity)) return;
        stream.write(frame);
      }).catch(() => {
        // 先完整发完已接受的帧，再断开补发；后续事件不能让游标越过本次失败。
        identity.accepting = false;
        stream.end();
      }).finally(() => { identity.queuedBytes -= bytes; });
    }
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); }); }
  catch (error) { unsubscribe(); server.close(); throw error; }
  let closing: Promise<void> | undefined;
  return { port: (server.address() as AddressInfo).port, router,
    diagnostics: () => ({ connections: streams.size, replayEvents: recent.length, replayBytes: bufferedBytes, backlogResets, failedClientReleases: failedClientReleases.size,
      queuedBytes: [...streams.values()].reduce((total, stream) => total + stream.queuedBytes, 0) }),
    connections: () => { const connected = new Set([...streams.values()].filter(value => value.valid()).map(value => value.connectionId));
      return sessions.connections().map(connection => ({ ...connection, connected: connected.has(connection.id) })); },
    revoke: async (id: string) => { sessions.revoke(id); closeInvalidStreams(); await sessions.flush(); },
    rotateToken: async (token: string) => { sessions.rotate(token); closeInvalidStreams(); await sessions.flush(); },
    close: () => closing ??= (async () => {
      serverClosing = true;
      for (const timer of recoveryTimers.values()) clearTimeout(timer); recoveryTimers.clear();
      unsubscribe(); for (const stream of streams.keys()) stream.end();
      // 让已经接受的保存请求先返回，避免更改连接设置后误报保存失败。
      const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
      try {
        await new Promise<void>(resolve => server.close(() => resolve())); await sessions.flush();
        await Promise.all([...webClients].map(releaseClient));
        if (failedClientReleases.size) throw new AggregateError([...failedClientReleases.values()], 'Web 客户端资源未能全部释放。');
      } finally { clearTimeout(deadline); }
    })() };
}
