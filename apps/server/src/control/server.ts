import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PlatformApplication } from '../application';
import { ApplicationRouter } from '../transport/router';
import { ControlRequestError, controlRoutes, jsonBodyLimit, session, type ControlRoute, type RouteContext } from './routes';
import { controlDiscoveryDirectory } from './discovery';
import { ControlEventProjector, type ControlEvent } from './events';

const replayLimit = 1_000;
const replayBytesLimit = 8 * 1024 * 1024;
/** 断线后在这段时间内重连可以续传；没有事件流连接时不再缓存，也不再为每个事件序列化。 */
const resumeWindowMs = 5 * 60_000;
const slowClientBytes = 4 * 1024 * 1024;
const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
/** 存储层与上游失败带有错误码；没有错误码的是业务校验错误，按参数错误处理。 */
const statusByCode: Record<string, number> = {
  NOT_FOUND: 404, INVALID_INPUT: 400, REVISION_CONFLICT: 409, SOURCE_CHANGED: 409, STORAGE_BUSY: 409,
  STORAGE_CLOSED: 503, CORRUPT_DATA: 500, UNSUPPORTED_VERSION: 500, IO_ERROR: 500, UPSTREAM_FAILED: 502,
};

function hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ControlRequestError(413, `请求内容超过 ${Math.floor(limit / 1024 / 1024)} MiB 上限。`);
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

function write(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...corsHeaders, ...headers });
  response.end(JSON.stringify(value ?? null));
}

function failure(error: unknown): [number, { error: string; code?: string }] {
  const code = (error as { code?: unknown }).code;
  const status = error instanceof ControlRequestError ? error.status : typeof code === 'string' ? statusByCode[code] ?? 400 : 400;
  return [status, { error: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) }];
}

interface CompiledRoute { route: ControlRoute; pattern: RegExp; names: string[] }

function compile(route: ControlRoute): CompiledRoute {
  const names: string[] = [];
  const source = route.path.replace(/:(\w+)/g, (_, name: string) => { names.push(name); return '([^/]+)'; });
  return { route, pattern: new RegExp(`^${source}$`), names };
}

export interface ControlServerOptions { port: number; token: string; allowLan: boolean }

interface BufferedEvent { sequence: number; frame: Buffer; matches: (types: string[], conversationId: string | null) => boolean }

const sseFrame = (id: string, value: unknown) => Buffer.from(`id: ${id}\ndata: ${JSON.stringify(value)}\n\n`);

/**
 * 稳定事件与原始事件各自补发：流式增量只在原始缓冲里挤占位置，稳定订阅方断线期间即使有一轮大量输出，
 * 重连后仍能补齐任务事件。续传按共用序号判断，游标之后没有事件被挤出就能续上，游标那一条本身不必还在缓冲里。
 */
class ReplayBuffer {
  private readonly entries: BufferedEvent[] = [];
  private bytes = 0;
  /** 已被挤出或丢弃的最大序号；游标早于它时中间可能缺事件，只能让订阅方重置。 */
  private droppedThrough = 0;
  push(entry: BufferedEvent): void {
    this.entries.push(entry);
    this.bytes += entry.frame.length;
    while (this.entries.length > replayLimit || this.bytes > replayBytesLimit) {
      const dropped = this.entries.shift()!;
      this.bytes -= dropped.frame.length;
      this.droppedThrough = dropped.sequence;
    }
  }
  clear(sequence: number): void {
    this.entries.length = 0; this.bytes = 0; this.droppedThrough = sequence;
  }
  /** 返回游标之后的事件；缓冲无法证明中间没有缺口时返回 undefined。 */
  after(sequence: number): readonly BufferedEvent[] | undefined {
    if (sequence < this.droppedThrough) return undefined;
    return this.entries.filter(entry => entry.sequence > sequence);
  }
}

function rawMatches(event: Record<string, any>, types: string[], conversationId: string | null): boolean {
  const eventTypes = [event.type, event.event && typeof event.event === 'object' ? event.event.type : undefined].filter(Boolean);
  if (types.length && !eventTypes.some(type => types.includes(String(type)))) return false;
  if (!conversationId) return true;
  return [event.conversationId, event.run?.conversationId, event.event?.conversationId,
    event.event?.run?.conversationId, event.event?.payload?.conversationId].includes(conversationId);
}

export async function startControlServer(application: PlatformApplication, options: ControlServerOptions) {
  let expected = hash(options.token);
  const router = new ApplicationRouter(application);
  const buffers = { stable: new ReplayBuffer(), raw: new ReplayBuffer() };
  /** 每个事件流按自己的模式和过滤条件挑选要写出的事件。 */
  const streams = new Map<ServerResponse, { raw: boolean; types: string[]; conversationId: string | null }>();
  const projector = new ControlEventProjector();
  const epoch = randomUUID();
  let sequence = 0;
  /** 各模式最后一个订阅方断开的时间；续传窗口内继续缓存该模式的事件。 */
  const lastStreamAt = { stable: 0, raw: 0 };
  let closing = false;

  const streamEvents = ({ request, response, url }: RouteContext) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...corsHeaders,
    });
    response.write(': connected\n\n');
    const stream = { raw: url.searchParams.get('raw') === '1',
      types: url.searchParams.get('types')?.split(',').map(value => value.trim()).filter(Boolean) ?? [],
      conversationId: url.searchParams.get('conversationId') };
    const cursor = String(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '');
    if (cursor) {
      const [cursorEpoch, cursorSequence] = cursor.split(':');
      const missed = cursorEpoch === epoch && /^\d+$/.test(cursorSequence)
        ? buffers[stream.raw ? 'raw' : 'stable'].after(Number(cursorSequence)) : undefined;
      if (!missed) response.write('event: reset\ndata: {}\n\n');
      else for (const entry of missed) if (entry.matches(stream.types, stream.conversationId)) response.write(entry.frame);
    }
    streams.set(response, stream);
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n');
    }, 20_000);
    heartbeat.unref();
    response.once('close', () => { clearInterval(heartbeat); streams.delete(response); lastStreamAt[stream.raw ? 'raw' : 'stable'] = Date.now(); });
  };

  const routes = controlRoutes(application, { router, streamEvents }).map(compile);
  const resolve = (method: string, pathname: string) => {
    const candidates = routes.flatMap(entry => {
      const match = entry.pattern.exec(pathname);
      return match ? [{ ...entry, match }] : [];
    });
    const found = candidates.find(entry => entry.route.method === method);
    if (!found) {
      if (candidates.length) throw Object.assign(new ControlRequestError(405, `${pathname} 不支持 ${method}。`),
        { allow: [...new Set(candidates.map(entry => entry.route.method))].join(', ') });
      throw new ControlRequestError(404, '接口不存在，GET /v1 列出全部接口与参数。');
    }
    let params: Record<string, string>;
    try { params = Object.fromEntries(found.names.map((name, index) => [name, decodeURIComponent(found.match[index + 1])])); }
    catch { throw new ControlRequestError(400, '路径参数编码无效。'); }
    return { route: found.route, params };
  };

  const server = createServer(async (request, response) => {
    response.on('error', () => response.destroy());
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, Last-Event-ID, X-GrayCode-Token' });
        response.end(); return;
      }
      const token = tokenFrom(request);
      if (!token || !timingSafeEqual(expected, hash(token)))
        throw new ControlRequestError(401, `访问令牌不正确。令牌在 GrayCode「设置 → 外部控制」中；本机程序也可以读取 ${controlDiscoveryDirectory()} 下的发现文件。`);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const { route, params } = resolve(request.method ?? 'GET', url.pathname.replace(/\/+$/, '') || '/');
      const result = await route.handle({ url, params, request, response, body: (limit = jsonBodyLimit) => readJson(request, limit) });
      if (result) write(response, result[0], result[1]);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const allow = (error as { allow?: string }).allow;
      write(response, ...failure(error), allow ? { Allow: allow } : {});
    }
  });

  const unsubscribe = application.subscribe(event => {
    // 任务与会话的对应关系一直维护，订阅方晚连接时事件也能带上会话 ID。
    const projected = projector.project(event);
    const id = `${epoch}:${++sequence}`;
    const now = Date.now();
    // 某个模式既没有订阅方也过了续传窗口时不再缓存，也不为它序列化事件；序号照常递增。
    const wanted = (raw: boolean) => [...streams.values()].some(stream => stream.raw === raw) || now - lastStreamAt[raw ? 'raw' : 'stable'] <= resumeWindowMs;
    const entries = {
      raw: wanted(true) ? { sequence, frame: sseFrame(id, event), matches: (types: string[], conversationId: string | null) => rawMatches(event, types, conversationId) } : undefined,
      stable: projected && wanted(false) ? { sequence, frame: sseFrame(id, projected), matches: (types: string[], conversationId: string | null) =>
        (!types.length || types.includes(projected.type)) && (!conversationId || projected.conversationId === conversationId) } : undefined,
    };
    for (const mode of ['raw', 'stable'] as const) {
      const entry = entries[mode];
      if (entry) buffers[mode].push(entry);
      else if (mode === 'raw' || projected) buffers[mode].clear(sequence);
    }
    for (const [response, stream] of streams) {
      if (response.destroyed || response.writableEnded) continue;
      const entry = entries[stream.raw ? 'raw' : 'stable'];
      if (!entry?.matches(stream.types, stream.conversationId)) continue;
      // 慢客户端不能无限堆积事件；直接断开，由 Last-Event-ID 从补发缓冲恢复。
      if (response.writableLength > slowClientBytes) { response.destroy(); continue; }
      response.write(entry.frame);
    }
  });
  try {
    // 先订阅再登记已在运行的任务，两者之间创建的任务也不会漏掉会话 ID。
    projector.track(await application.storage.listRuns({ activeOnly: true }));
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
      await router.clientClosed(session.clientId).catch(error => console.warn('[ControlApi] 客户端资源释放失败：', error));
    },
  };
}
