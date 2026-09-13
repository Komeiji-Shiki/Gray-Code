import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export const NODE_MAX_FRAME = 32 * 1024 * 1024;
type Reply = { kind: 'reply'; id: string; result?: unknown; error?: { code: string; message: string } };
type Request = { kind: 'request'; id: string; method: string; params: Record<string, any> };
type Event = { kind: 'event'; value: Record<string, unknown> };
export class NodeConnectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
/** 连接只恢复事件与状态，不重发已派发的命令；业务幂等由持久请求标识负责。 */
export class NodeWire {
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private received = 0;
  private closed = false;
  private alive = true;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  constructor(readonly socket: WebSocket, private readonly options: {
    request?: (method: string, params: Record<string, any>) => Promise<unknown>;
    event?: (value: Record<string, unknown>) => void; close?: (reason: string) => void;
  }) {
    this.signal = this.controller.signal;
    socket.on('message', data => { void this.message(data.toString()).catch(() => this.close('协议消息无效。')); });
    socket.on('pong', () => { this.alive = true; });
    socket.on('error', () => this.finish('设备连接发生错误。'));
    socket.on('close', (_code, reason) => this.finish(reason.toString() || '设备连接已断开。'));
    this.heartbeat = setInterval(() => {
      if (!this.alive) return this.close('设备连接没有回应。');
      this.alive = false; if (this.online) socket.ping();
    }, 20_000);
    this.heartbeat.unref();
  }
  get online() { return !this.closed && this.socket.readyState === WebSocket.OPEN; }
  private send(value: Request | Reply | Event) {
    if (!this.online) throw new NodeConnectionError('NODE_OFFLINE', '执行设备已离线。');
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > NODE_MAX_FRAME) throw new NodeConnectionError('NODE_MESSAGE_TOO_LARGE', '设备消息过大，请减小截图或结果范围。');
    if (this.socket.bufferedAmount > NODE_MAX_FRAME) { this.close('设备接收速度过慢，请重新连接。'); throw new NodeConnectionError('NODE_BACKPRESSURE', '设备接收速度过慢。'); }
    this.socket.send(body);
  }
  request<T = any>(method: string, params: Record<string, any> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.pending.size >= 64) return Promise.reject(new Error('设备请求过多，请等待当前操作。'));
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => {
        this.pending.delete(id); reject(new NodeConnectionError('NODE_RESULT_UNKNOWN', '等待设备结果超时。任务可能已经执行，请查询原请求，不要创建新的请求标识。'));
      }, timeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ kind: 'request', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  event(value: Record<string, unknown>) { if (this.online) this.send({ kind: 'event', value }); }
  private async message(body: string) {
    const value = JSON.parse(body) as Request | Reply | Event;
    if (!value || typeof value !== 'object') throw new Error('Invalid frame');
    if (value.kind === 'reply') {
      const pending = this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.error) pending.reject(new NodeConnectionError(value.error.code, value.error.message)); else pending.resolve(value.result);
    } else if (value.kind === 'event') {
      if (!value.value || typeof value.value !== 'object') throw new Error('Invalid event');
      this.options.event?.(value.value);
    } else if (value.kind === 'request' && typeof value.id === 'string' && value.id.length <= 100 && typeof value.method === 'string' && value.params && typeof value.params === 'object' && !Array.isArray(value.params)) {
      if (++this.received > 32) throw new Error('Too many requests');
      try {
        if (!this.options.request) throw new Error('此方向不接受设备命令。');
        const result = await this.options.request(value.method, value.params);
        if (this.online) this.send({ kind: 'reply', id: value.id, result });
      } catch (error) {
        if (this.online) this.send({ kind: 'reply', id: value.id, error: { code: (error as any).code ?? 'NODE_REQUEST_FAILED', message: (error as Error).message } });
      } finally { this.received--; }
    } else throw new Error('Invalid request');
  }
  close(reason = '设备连接已关闭。') { this.finish(reason); this.socket.terminate(); }
  private finish(reason: string) {
    if (this.closed) return; this.closed = true; clearInterval(this.heartbeat); this.controller.abort();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new NodeConnectionError('NODE_RESULT_UNKNOWN', `${reason}已派发操作的结果需要重新查询。`)); }
    this.pending.clear(); this.options.close?.(reason);
  }
}
