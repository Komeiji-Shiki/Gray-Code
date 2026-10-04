import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

interface Pending { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface DapMessage { seq: number; type: string; command?: string; arguments?: any; request_seq?: number; success?: boolean; message?: string; body?: any; event?: string }

/** DAP 使用 UTF-8 字节长度分帧，响应序号与本端的请求序号对应。 */
export class DapConnection extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private frame?: { body: Buffer; offset: number };
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  reverseRequest?: (command: string, args: Record<string, any>) => Promise<unknown>;
  constructor(private readonly input: Readable, private readonly output: Writable) {
    super();
    input.on('data', this.read);
    input.once('end', this.ended); input.once('error', this.failed); output.once('error', this.failed);
  }
  private read = (bytes: Buffer) => {
    try {
      let offset = 0;
      while (offset < bytes.length && !this.closed) {
        if (!this.frame) {
          // 头部只保留有界片段，正文按已知长度写入一次，避免大变量结果拆包时反复复制全部已收内容。
          const headerBytes = Buffer.concat([this.buffer, bytes.subarray(offset, offset + 8196 - this.buffer.length)]);
          const boundary = headerBytes.indexOf('\r\n\r\n');
          if (boundary < 0) { if (headerBytes.length > 8192) throw new Error('DAP 消息头过长。'); this.buffer = headerBytes; return; }
          if (boundary > 8192) throw new Error('DAP 消息头过长。');
          const header = headerBytes.subarray(0, boundary).toString('ascii');
          const length = Number(/^Content-Length:\s*(\d+)\s*$/im.exec(header)?.[1]);
          if (!Number.isSafeInteger(length) || length < 1 || length > 16 * 1024 * 1024) throw new Error('DAP 消息长度无效。');
          offset += boundary + 4 - this.buffer.length;
          this.buffer = Buffer.alloc(0);
          this.frame = { body: Buffer.allocUnsafe(length), offset: 0 };
        }
        const frame = this.frame;
        const count = Math.min(frame.body.length - frame.offset, bytes.length - offset);
        bytes.copy(frame.body, frame.offset, offset, offset + count);
        frame.offset += count; offset += count;
        if (frame.offset === frame.body.length) {
          const message = JSON.parse(frame.body.toString('utf8')) as DapMessage;
          this.frame = undefined;
          this.receive(message);
        }
      }
    } catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))); }
  };
  private receive(message: DapMessage) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq!);
      if (!pending) return;
      this.pending.delete(message.request_seq!); clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.body ?? {});
      else pending.reject(new Error(message.message ?? message.body?.error?.format ?? '调试器拒绝了请求。'));
    } else if (message.type === 'event') this.emit('event', message.event, message.body ?? {});
    else if (message.type === 'request') {
      // 反向请求可以等待另一条连接，不能阻塞当前连接继续接收响应。
      void Promise.resolve().then(() => {
        if (!this.reverseRequest) throw new Error('当前客户端不支持调试器请求：' + message.command);
        return this.reverseRequest(message.command!, message.arguments ?? {});
      }).then(body => this.respond(message, true, body), error => this.respond(message, false, undefined, String(error)));
    }
  }
  private write(message: Omit<DapMessage, 'seq'>) {
    if (this.closed) throw new Error('调试连接已关闭。');
    const sequence = ++this.sequence;
    const body = Buffer.from(JSON.stringify({ ...message, seq: sequence }), 'utf8');
    this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    return sequence;
  }
  private respond(request: DapMessage, success: boolean, body?: unknown, message?: string) {
    if (!this.closed) this.write({ type: 'response', request_seq: request.seq, command: request.command, success, body, message });
  }
  request<T = any>(command: string, args: Record<string, unknown> = {}, timeout = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('调试连接已关闭。'));
    return new Promise<T>((resolve, reject) => {
      const sequence = this.sequence + 1;
      const timer = setTimeout(() => { this.pending.delete(sequence); reject(new Error(`调试器请求超时：${command}`)); }, timeout);
      this.pending.set(sequence, { resolve, reject, timer });
      try { this.write({ type: 'request', command, arguments: args }); }
      catch (error) { this.pending.delete(sequence); clearTimeout(timer); reject(error); }
    });
  }
  waitEvent(name: string, timeout = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('调试连接已关闭。'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('event', event); this.off('close', close); };
      const event = (type: string, body: unknown) => { if (type === name) { cleanup(); resolve(body); } };
      const close = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('等待调试器事件超时：' + name)); }, timeout);
      this.on('event', event); this.once('close', close);
    });
  }
  private ended = () => this.dispose(new Error('调试连接已结束。'));
  private failed = (error: Error) => this.dispose(error);
  dispose(error = new Error('调试连接已关闭。')) {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.read); this.input.off('end', this.ended); this.input.off('error', this.failed);
    this.output.off('error', this.failed);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.buffer = Buffer.alloc(0); this.frame = undefined;
    this.emit('close', error); this.input.destroy(); this.output.destroy();
  }
}
