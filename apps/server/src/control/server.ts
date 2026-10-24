import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PlatformApplication } from '../application';
import { ApplicationRouter, type ClientSession } from '../transport/router';
import { chatUserMessage } from '../transport/chatInput';
import packageMetadata from '../../../../package.json';

const bodyLimit = 40 * 1024 * 1024;
const replayLimit = 1_000;
const replayBytesLimit = 8 * 1024 * 1024;
const clientId = 'control-api';
const session: ClientSession = { actorId: 'owner', clientId };

class ControlRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > bodyLimit) throw new ControlRequestError(413, '请求内容超过大小限制。');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ControlRequestError(400, '请求内容不是有效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControlRequestError(400, '请求必须是 JSON 对象。');
  return value as Record<string, any>;
}

function tokenFrom(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const header = request.headers['x-graycode-token'];
  return bearer || (typeof header === 'string' ? header.trim() : '');
}

function write(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value ?? null);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
  response.end(body);
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (parsed === undefined || parsed === null || parsed === '') return fallback;
  if (!Number.isInteger(parsed) || Number(parsed) < min || Number(parsed) > max) throw new ControlRequestError(400, `参数必须在 ${min} 至 ${max} 之间。`);
  return Number(parsed);
}

function string(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new ControlRequestError(400, `${field} 不能为空。`);
  if (value.length > max) throw new ControlRequestError(400, `${field} 超过长度限制。`);
  return value;
}

export interface ControlServerOptions { port: number; token: string; allowLan: boolean }

export async function startControlServer(application: PlatformApplication, options: ControlServerOptions) {
  let expected = hash(options.token);
  const router = new ApplicationRouter(application);
  const recent: { id: string; event: Record<string, any>; frame: Buffer; bytes: number }[] = [];
  const streams = new Map<ServerResponse, (event: Record<string, any>) => boolean>();
  const failures = new Map<string, { count: number; until: number }>();
  const epoch = randomUUID();
  let sequence = 0;
  let bufferedBytes = 0;
  let closing = false;

  const authorized = (request: IncomingMessage): boolean => {
    const address = request.socket.remoteAddress ?? 'local';
    const failure = failures.get(address);
    if (failure && failure.until > Date.now() && failure.count >= 10) throw new ControlRequestError(429, '尝试次数过多，请稍后重试。');
    const token = tokenFrom(request);
    if (!token || !timingSafeEqual(expected, hash(token))) {
      failures.set(address, { count: failure && failure.until > Date.now() ? failure.count + 1 : 1, until: Date.now() + 60_000 });
      throw new ControlRequestError(401, '访问令牌不正确。');
    }
    failures.delete(address);
    return true;
  };

  const matches = (event: Record<string, any>, url: URL): boolean => {
    const types = url.searchParams.get('types');
    const allowed = types?.split(',').map(value => value.trim()).filter(Boolean);
    const eventTypes = [event.type, event.event && typeof event.event === 'object' ? event.event.type : undefined].filter(Boolean);
    if (allowed?.length && !eventTypes.some(type => allowed.includes(String(type)))) return false;
    const conversationId = url.searchParams.get('conversationId');
    if (!conversationId) return true;
    return [event.conversationId, event.run?.conversationId, event.event?.conversationId,
      event.event?.run?.conversationId, event.event?.payload?.conversationId].includes(conversationId);
  };

  const streamEvents = (request: IncomingMessage, response: ServerResponse, url: URL) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
    });
    response.write(': connected\n\n');
    const filter = (event: Record<string, any>) => matches(event, url);
    const cursor = String(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '');
    if (cursor) {
      const index = recent.findIndex(entry => entry.id === cursor);
      if (index < 0) response.write('event: reset\ndata: {}\n\n');
      else for (const entry of recent.slice(index + 1)) if (filter(entry.event)) response.write(entry.frame);
    }
    streams.set(response, filter);
    const heartbeat = setInterval(() => {
      if (response.destroyed || response.writableEnded) return;
      response.write(': heartbeat\n\n');
    }, 20_000);
    heartbeat.unref();
    response.once('close', () => { clearInterval(heartbeat); streams.delete(response); });
  };

  const server = createServer(async (request, response) => {
    response.on('error', () => response.destroy());
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID, X-GrayCode-Token' });
        response.end(); return;
      }
      authorized(request);
      const path = decodeURIComponent(url.pathname);
      if (request.method === 'GET' && path === '/v1/health') {
        write(response, 200, { name: 'GrayCode', version: packageMetadata.version, status: 'ok' }); return;
      }
      if (request.method === 'GET' && path === '/v1/status') {
        write(response, 200, {
          name: 'GrayCode', version: packageMetadata.version, actorId: session.actorId,
          agents: application.settings.read('agents').agents.map(agent => ({ id: agent.id, name: agent.name })),
          activeRuns: application.runtime.activeCount,
        }); return;
      }
      if (request.method === 'GET' && path === '/v1/conversations') {
        const list = await application.storage.listConversations({
          limit: number(url.searchParams.get('limit'), 50, 1, 100),
          ...(url.searchParams.get('workspaceUri') ? { workspaceUri: url.searchParams.get('workspaceUri')! } : {}),
          ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
          ...(url.searchParams.get('cursor') ? { cursor: JSON.parse(url.searchParams.get('cursor')!) } : {}),
        });
        write(response, 200, list); return;
      }
      if (request.method === 'POST' && path === '/v1/conversations') {
        const input = await readJson(request);
        const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : '外部控制对话';
        const conversation = await application.createConversation(session.actorId, title,
          typeof input.workspaceId === 'string' && input.workspaceId ? input.workspaceId : undefined);
        write(response, 201, conversation); return;
      }
      const conversationMatch = /^\/v1\/conversations\/([^/]+)(?:\/messages)?$/.exec(path);
      if (conversationMatch) {
        const id = conversationMatch[1];
        const conversation = await application.conversation(session.actorId, id);
        if (request.method === 'GET' && !path.endsWith('/messages')) {
          write(response, 200, conversation); return;
        }
        if (request.method === 'GET' && path.endsWith('/messages')) {
          const page = await application.storage.readHistory(id, {
            limit: number(url.searchParams.get('limit'), 50, 1, 200),
            ...(url.searchParams.get('beforeIndex') ? { beforeIndex: number(url.searchParams.get('beforeIndex'), 0, 0, Number.MAX_SAFE_INTEGER) } : {}),
            ...(url.searchParams.get('offset') ? { offset: number(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER) } : {}),
          });
          write(response, 200, page); return;
        }
        if (request.method === 'POST' && path.endsWith('/messages')) {
          const input = await readJson(request);
          const text = typeof input.text === 'string' ? input.text : '';
          if (text.length > 100_000) throw new ControlRequestError(400, '消息内容超过长度限制。');
          if (input.attachments !== undefined && !Array.isArray(input.attachments))
            throw new ControlRequestError(400, 'attachments 必须是数组。');
          const message = chatUserMessage({ attachments: input.attachments }, text);
          if (!message.parts.length) throw new ControlRequestError(400, '请输入消息内容。');
          const agents = application.settings.read('agents').agents;
          const agentId = typeof input.agentId === 'string' && input.agentId ? input.agentId : agents[0]?.id;
          if (!agentId || !agents.some(agent => agent.id === agentId)) throw new ControlRequestError(400, '指定的 Agent 不存在。');
          const run = await application.runtime.start({
            requestKey: `control:${randomUUID()}`, actorId: session.actorId, agentId,
            conversationId: conversation.id, ...(typeof conversation.workspaceId === 'string' ? { workspaceId: conversation.workspaceId } : {}),
            ...(typeof input.providerId === 'string' && input.providerId ? { providerId: input.providerId } : {}),
            ...(typeof input.model === 'string' && input.model ? { modelOverride: input.model } : {}),
            ...(typeof input.reasoningEffort === 'string' && input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            message,
          });
          const value = input.wait === true ? await application.runtime.wait(run.id) : run;
          write(response, 202, { conversationId: conversation.id, run: value }); return;
        }
      }
      const runMatch = /^\/v1\/runs\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
      if (runMatch) {
        const run = await application.storage.getRun(runMatch[1]);
        if (!run) throw new ControlRequestError(404, '任务不存在。');
        await application.conversation(session.actorId, run.conversationId);
        if (request.method === 'GET' && !runMatch[2]) { write(response, 200, run); return; }
        if (request.method === 'GET' && runMatch[2] === 'events') {
          const events = await application.storage.readRunEvents(run.id, number(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER),
            number(url.searchParams.get('limit'), 200, 1, 1000));
          write(response, 200, { run, events }); return;
        }
        if (request.method === 'POST' && runMatch[2] === 'cancel') {
          await application.runtime.cancel(run.id, session.actorId);
          write(response, 202, { success: true }); return;
        }
      }
      if (request.method === 'GET' && path === '/v1/events') { streamEvents(request, response, url); return; }
      if (request.method === 'POST' && path === '/v1/rpc') {
        const input = await readJson(request);
        if (typeof input.method !== 'string' || !input.method) throw new ControlRequestError(400, 'method 不能为空。');
        if (input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)))
          throw new ControlRequestError(400, 'params 必须是对象。');
        const result = await router.call(session, input.method, input.params ?? {});
        write(response, 200, { result: result ?? null }); return;
      }
      if (request.method === 'POST' && path === '/v1/speech') {
        const input = await readJson(request);
        const result = await application.speech.synthesize({
          text: string(input.text, 'text', 12_000),
          ...(typeof input.voice === 'string' && input.voice ? { voice: input.voice } : {}),
          ...(input.speed !== undefined ? { speed: Number(input.speed) } : {}),
          ...(input.format === 'mp3' || input.format === 'wav' || input.format === 'opus' ? { format: input.format } : {}),
        }, session.actorId);
        write(response, 200, result); return;
      }
      if (request.method === 'POST' && path === '/v1/speech/clone') {
        const input = await readJson(request);
        const result = await application.speech.clone({
          title: string(input.title, 'title', 80), audio: string(input.audio, 'audio', 70 * 1024 * 1024),
          mimeType: string(input.mimeType, 'mimeType', 100), ...(typeof input.text === 'string' ? { text: input.text } : {}),
        }, session.actorId);
        write(response, 201, result); return;
      }
      throw new ControlRequestError(404, '接口不存在。');
    } catch (error) {
      const status = error instanceof ControlRequestError ? error.status : 400;
      if (response.headersSent) { response.destroy(); return; }
      write(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const unsubscribe = application.subscribe(event => {
    const id = `${epoch}:${++sequence}`;
    const frame = Buffer.from(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    bufferedBytes += frame.length;
    recent.push({ id, event, frame, bytes: frame.length });
    while (recent.length > replayLimit || bufferedBytes > replayBytesLimit) bufferedBytes -= recent.shift()!.bytes;
    for (const [stream, filter] of streams) {
      if (stream.destroyed || stream.writableEnded || !filter(event)) continue;
      // 慢客户端不能无限堆积事件；断开后由 Last-Event-ID 从补发缓冲恢复。
      if (stream.writableLength > 4 * 1024 * 1024) { stream.end(); streams.delete(stream); continue; }
      stream.write(frame);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.allowLan ? '0.0.0.0' : '127.0.0.1', () => resolve());
    });
  } catch (error) {
    unsubscribe(); server.close(); throw error;
  }

  return {
    port: (server.address() as AddressInfo).port,
    /** 保留端口和进行中的请求；事件流按旧令牌建立，轮换后全部断开，客户端需用新令牌重连。 */
    rotateToken: async (token: string) => {
      expected = hash(token);
      for (const stream of streams.keys()) stream.end();
      streams.clear();
    },
    close: async () => {
      if (closing) return;
      closing = true;
      unsubscribe();
      for (const stream of streams.keys()) stream.end();
      streams.clear();
      // 等待中的长请求不能拖住退出；给正常请求留出返回时间后强制关闭连接。
      const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
      deadline.unref();
      try { await new Promise<void>(resolve => server.close(() => resolve())); }
      finally { clearTimeout(deadline); }
      await router.clientClosed(clientId).catch(error => console.warn('[ControlApi] 客户端资源释放失败：', error));
    },
  };
}
