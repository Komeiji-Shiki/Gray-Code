import { randomUUID } from 'node:crypto';
import type { BotGateway, BotInbound, BotReply } from './gateway';
import type { OneBotProtocol, OneBotAction } from './onebotProtocol';

interface PendingCall { resolve(value: Record<string, any>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
/** OneBot 正向 WebSocket 共用传输：同一连接承载事件和带 echo 的 API 响应。 */
export class OneBotGateway implements BotGateway {
  private socket?: WebSocket;
  private readonly pending = new Map<string, PendingCall>();
  private receive?: (message: BotInbound) => void;
  private state?: (status: string) => void;
  private token = '';
  private botId?: string;
  private desired = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private reconnectDelay = 3000;
  constructor(private readonly endpoint: string, private readonly protocol: OneBotProtocol) {}
  async connect(token: string, _allMessages: boolean, receive: (message: BotInbound) => void, state: (status: string) => void) {
    await this.disconnect(); this.token = token; this.receive = receive; this.state = state; this.botId = undefined; this.desired = true;
    try { return await this.open(); }
    catch { await this.disconnect(); throw new Error('OneBot 连接失败，请检查 WebSocket 地址、访问令牌及 NapCat 状态。'); }
  }
  private async open(): Promise<{ id: string; name: string }> {
    const url = new URL(this.endpoint);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('OneBot 地址必须使用 ws 或 wss。');
    if (this.token) url.searchParams.set('access_token', this.token);
    const socket = this.socket = new WebSocket(url);
    socket.addEventListener('message', event => {
      if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024) return;
      try { this.message(JSON.parse(event.data)); } catch { /* 不完整事件不进入身份与任务解析。 */ }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.failPending(); this.state?.('disconnected');
      if (this.desired && this.botId) this.scheduleReconnect();
    });
    socket.addEventListener('error', () => { this.state?.('connection_error'); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('OneBot 连接超时。')); }, 15_000);
      const finish = (error?: Error) => { clearTimeout(timeout); socket.removeEventListener('open', ready); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed); error ? reject(error) : resolve(); };
      const ready = () => finish(); const failed = () => finish(new Error('OneBot 连接不可用。'));
      socket.addEventListener('open', ready, { once: true }); socket.addEventListener('error', failed, { once: true }); socket.addEventListener('close', failed, { once: true });
    });
    const login = this.protocol.identity(await this.call(this.protocol.login()));
    const id = login.id;
    if (this.botId && this.botId !== id) { this.desired = false; socket.close(); throw new Error('OneBot 登录账号已变化，请手动重新连接。'); }
    this.botId = id; this.reconnectDelay = 3000; this.state?.('connected');
    return login;
  }
  private scheduleReconnect() {
    if (!this.desired || this.reconnect) return;
    this.state?.('reconnecting');
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.open().catch(() => { this.socket?.close(); this.scheduleReconnect(); });
    }, this.reconnectDelay);
    this.reconnect.unref(); this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
  }
  private failPending() { for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('OneBot 连接已断开，未确认发送结果。')); } this.pending.clear(); }
  private message(value: Record<string, any>) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.echo === 'string') {
      const pending = this.pending.get(value.echo); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(value.echo);
      if (value.status === 'ok' && value.retcode === 0) pending.resolve(value.data ?? {});
      else pending.reject(new Error(`OneBot 操作失败（返回码 ${Number.isFinite(value.retcode) ? value.retcode : '未知'}）。`));
      return;
    }
    if (this.botId) { const message = this.protocol.inbound(value, this.botId); if (message) this.receive?.(message); }
  }
  private call(action: OneBotAction): Promise<Record<string, any>> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OneBot 尚未连接。'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('OneBot 响应超时，未确认操作结果。')); }, 15_000);
      this.pending.set(echo, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ ...action, echo })); }
      catch { clearTimeout(timer); this.pending.delete(echo); reject(new Error('OneBot 请求发送失败。')); }
    });
  }
  async send(channelId: string, content: string): Promise<void> { await this.call(this.protocol.send(channelId, content)); }
  async sendReply(channelId: string, reply: BotReply) {
    if (reply.files?.length) throw new Error('当前 OneBot 接入不支持这个附件输出方式。');
    const data = await this.call(this.protocol.send(channelId, reply.content ?? '', reply.replyToMessageId));
    return this.protocol.receipt(data);
  }
  async hydrate(message: BotInbound) { return this.protocol.hydrate(message, action => this.call(action)); }
  async disconnect(): Promise<void> {
    this.desired = false; if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined;
    const socket = this.socket; this.socket = undefined; socket?.close(); this.failPending(); this.token = '';
  }
}
