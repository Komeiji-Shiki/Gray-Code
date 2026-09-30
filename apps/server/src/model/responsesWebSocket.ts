import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { PlatformMessage } from '@graycode/contracts';
import type { HttpRequestOptions } from '../../../../backend/modules/channel/types';
import { establishConnectTunnel } from '../../../../backend/modules/channel/proxyFetch/proxyConnectTunnel';

type Event = Record<string, any>;
type Steer = { messageId: string; target: string; input: unknown; id?: string; state: 'sent' | 'accepted' | 'pending' | 'applied' | 'failed' };

/** 一个任务拥有一个连接。写入后出现不确定的断线时终止任务，不能自动重放工具或用户输入。 */
export class ResponsesWebSocket {
  readonly id = randomUUID();
  readonly identity: string;
  private readonly events: Event[] = [];
  private readonly changed = new Set<() => void>();
  private readonly steering: Steer[] = [];
  private readonly sent = new Set<string>();
  private previousHistory: string[] = [];
  private previousPromptContext?: string;
  private failure?: Error;
  private currentResponse?: string;
  private generating = false;
  private lastResponse?: string;
  private deferredInput = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastActivity = Date.now();
  private readonly abort: () => void;

  static identity(options: HttpRequestOptions): string {
    return JSON.stringify([options.url, options.headers, options.body?.model]);
  }

  private constructor(private readonly socket: WebSocket, options: HttpRequestOptions, private readonly signal: AbortSignal) {
    this.identity = ResponsesWebSocket.identity(options);
    this.timeout = options.timeout ?? 120_000;
    this.abort = () => this.fail(new Error('Responses WebSocket 请求已取消。'));
    signal.addEventListener('abort', this.abort, { once: true });
    socket.on('message', raw => {
      this.lastActivity = Date.now();
      try { this.receive(JSON.parse(raw.toString())); }
      catch { this.fail(new Error('Responses WebSocket 返回了无效事件。')); }
    });
    socket.on('pong', () => { this.lastActivity = Date.now(); });
    socket.on('error', () => this.fail(new Error('Responses WebSocket 连接失败。')));
    socket.on('close', () => this.fail(new Error('Responses WebSocket 连接已关闭，当前任务不能继续复用响应。')));
    socket.on('open', () => this.pulse());
  }
  private readonly timeout: number;

  static async connect(options: HttpRequestOptions, proxy: string | undefined, signal: AbortSignal): Promise<ResponsesWebSocket> {
    signal.throwIfAborted();
    const target = new URL(options.url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)) throw new Error('Responses WebSocket 地址协议无效。');
    target.protocol = ['https:', 'wss:'].includes(target.protocol) ? 'https:' : 'http:';
    const tunnel = proxy ? await establishConnectTunnel(target, { method: 'GET', headers: options.headers, signal, timeout: options.timeout }, proxy) : undefined;
    if (signal.aborted) { tunnel?.destroy(); signal.throwIfAborted(); }
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(target, { headers: options.headers, handshakeTimeout: options.timeout ?? 120_000,
        ...(tunnel ? { createConnection: () => tunnel } : {}) });
    } catch (error) { tunnel?.destroy(); throw error; }
    const session = new ResponsesWebSocket(socket, options, signal);
    try {
      while (socket.readyState !== WebSocket.OPEN) await session.wait();
      signal.throwIfAborted();
      session.heartbeat = setInterval(() => {
        if (Date.now() - session.lastActivity > session.timeout) session.fail(new Error('Responses WebSocket 上游长时间未响应。'));
        else if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, Math.min(20_000, Math.max(100, session.timeout / 2)));
      session.heartbeat.unref();
      return session;
    } catch (error) { session.close(); throw error; }
  }

  private pulse(): void { for (const wake of this.changed) wake(); this.changed.clear(); }
  private check(): void { this.signal.throwIfAborted(); if (this.failure) throw this.failure; }
  private wait(): Promise<void> {
    this.check();
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer); this.changed.delete(wake);
        try { this.check(); resolve(); } catch (error) { reject(error); }
      };
      const timer = setTimeout(() => this.fail(new Error('Responses WebSocket 等待事件超时。')), this.timeout);
      this.changed.add(wake);
    });
  }
  private fail(error: Error): void {
    this.failure ??= error;
    this.close(); this.pulse();
  }
  close(): void {
    clearInterval(this.heartbeat);
    this.signal.removeEventListener('abort', this.abort);
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }

  private receive(event: Event): void {
    if (!event || typeof event.type !== 'string') throw new Error('Invalid event');
    if (event.type.startsWith('response.steer.')) {
      const steer = event.steer;
      const attempt = this.steering.find(item => steer?.id && item.id === steer.id)
        ?? this.steering.find(item => item.state === 'sent' && item.target === steer?.previous_response_id);
      if (attempt) {
        attempt.id = steer?.id;
        if (event.type === 'response.steer.accepted') attempt.state = 'accepted';
        else if (event.type === 'response.steer.pending') attempt.state = 'pending';
        else if (event.type === 'response.steer.failed') attempt.state = 'failed';
      }
      this.pulse(); return;
    }
    if (event.type === 'error') {
      // 错误正文可能包含代理凭据或原始请求，界面只展示结构化状态。
      this.fail(new Error(`Responses WebSocket 上游拒绝请求 (${event.status ?? 'error'} / ${event.error?.code ?? event.error?.type ?? 'unknown'})。`));
      return;
    }
    if (event.type === 'response.created') {
      const id = event.response?.id;
      if (typeof id !== 'string') throw new Error('Missing response id');
      for (const attempt of this.steering) if (attempt.target === this.currentResponse && ['accepted', 'pending'].includes(attempt.state)) attempt.state = 'applied';
      this.currentResponse = id; this.generating = true;
    }
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type) && event.response?.id === this.currentResponse) this.generating = false;
    this.events.push(event); this.pulse();
  }

  private async send(event: Event): Promise<void> {
    this.check();
    await new Promise<void>((resolve, reject) => this.socket.send(JSON.stringify(event), error => {
      if (error) { this.fail(new Error('Responses WebSocket 写入失败，发送状态不确定。')); reject(this.failure); }
      else resolve();
    }));
  }

  async steer(messageId: string, input: unknown): Promise<boolean> {
    this.check();
    if (!this.generating || !this.currentResponse) return false;
    const attempt: Steer = { messageId, target: this.currentResponse, input, state: 'sent' };
    this.steering.push(attempt);
    await this.send({ type: 'response.steer', previous_response_id: attempt.target, input });
    while (attempt.state === 'sent') await this.wait();
    return attempt.state !== 'failed';
  }

  private key(message: PlatformMessage): string { return message.id ?? JSON.stringify(message); }
  private fingerprint(message: PlatformMessage): string { return JSON.stringify([message.id, message.role, message.parts]); }
  private excluded(message: PlatformMessage): boolean {
    return this.sent.has(this.key(message)) || message.nativeResponse?.connectionId === this.id
      || this.steering.some(item => item.messageId === message.id && ['accepted', 'pending', 'applied'].includes(item.state));
  }
  hasContinuation(): boolean {
    return this.deferredInput || this.events.some(event => event.type === 'response.created')
      || this.steering.some(item => item.target === this.lastResponse && ['sent', 'accepted', 'pending'].includes(item.state));
  }

  /** 上下文压缩或编辑后从完整输入开始；有待应用补充消息时不能悄悄丢弃其归属。 */
  context(messages: PlatformMessage[], promptContext?: unknown): { full: boolean } {
    const history = messages.map(message => this.fingerprint(message));
    const prompt = JSON.stringify(promptContext ?? null);
    const changed = this.previousHistory.some((item, index) => item !== history[index])
      || this.previousPromptContext !== undefined && this.previousPromptContext !== prompt;
    if (changed) {
      if (this.hasContinuation()) throw new Error('待应用的生成中消息与当前上下文不一致，请结束当前任务后继续。');
      this.lastResponse = undefined; this.sent.clear(); this.steering.length = 0;
    }
    this.previousHistory = history; this.previousPromptContext = prompt;
    return { full: !this.lastResponse };
  }

  async *response(buildBody: (messages: PlatformMessage[], full: boolean) => Event, history: PlatformMessage[], full: boolean, onRequest: (body: Event) => Promise<void>): AsyncGenerator<Event> {
    this.check();
    // accepted 只表示排队。等待 successor.created 或 pending 后再决定是否显式续接。
    while (!this.events.some(event => event.type === 'response.created')
      && this.steering.some(item => item.target === this.lastResponse && ['sent', 'accepted'].includes(item.state))) await this.wait();
    const automatic = this.events.some(event => event.type === 'response.created');
    const messages = full ? history : history.filter(message => !this.excluded(message));
    const body = buildBody(messages, full);
    if (!automatic) {
      const event: Event = { ...body, type: 'response.create', ...(full ? {} : { previous_response_id: this.lastResponse }) };
      delete event.stream;
      if (full) delete event.previous_response_id;
      await onRequest(event);
      await this.send(event);
      for (const message of messages) this.sent.add(this.key(message));
    } else {
      const applied = this.steering.filter(item => item.state === 'applied');
      await onRequest({ type: 'response.steer', previous_response_id: applied.at(-1)?.target,
        input: applied.map(item => item.input), continuation: 'server' });
    }
    this.deferredInput = automatic && messages.some(message => !this.excluded(message));
    for (;;) {
      while (!this.events.length) await this.wait();
      this.check();
      const event = this.events.shift()!;
      yield event;
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
        this.lastResponse = event.response?.id;
        return;
      }
    }
  }
  reference(): { connectionId: string; responseId?: string } { return { connectionId: this.id, responseId: this.lastResponse }; }
}
