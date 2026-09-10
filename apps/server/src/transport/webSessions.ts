import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientSession } from './router';
import type { WebConnectionInfo } from '@graycode/contracts';

interface BrowserSession { id: string; name: string; createdAt: number; lastSeenAt: number }
export interface WebSessionSnapshot { version: 1; tokenHash: string; browsers: Array<[string, BrowserSession]> }
export interface WebSessionStore { read(): Promise<WebSessionSnapshot | null>; write(value: WebSessionSnapshot): Promise<void> }
const cookieName = 'graycode_session';
const cookieLifetimeSeconds = 365 * 24 * 60 * 60;
/** 登录凭据保存在 HttpOnly cookie；本机只保存会话摘要，重启后继续使用原登录。 */
export class WebSessions {
  private expected: Buffer;
  private readonly browsers = new Map<string, BrowserSession>();
  private bearer: ClientSession;
  private bearerInfo?: Omit<WebConnectionInfo, 'connected'>;
  private generation = 0;
  private saves: Promise<void> = Promise.resolve();
  private lastActivitySaved = 0;
  constructor(token: string, private readonly actorId: string, private readonly secure: boolean, private readonly changed: () => void = () => {}, private readonly store?: WebSessionStore) {
    if (token.length < 32) throw new Error('请通过环境变量提供至少 32 个字符的随机访问令牌。');
    this.expected = this.hash(token);
    this.bearer = { actorId, clientId: randomUUID() };
  }
  private hash(value: string) { return createHash('sha256').update(value).digest(); }
  async restore(): Promise<void> {
    const saved = await this.store?.read();
    if (saved?.version !== 1 || saved.tokenHash !== this.expected.toString('hex')) {
      if (saved) { this.persist(); await this.flush(); }
      return;
    }
    for (const [key, session] of saved.browsers) this.browsers.set(key, session);
  }
  private persist(): void {
    if (!this.store) return;
    const value: WebSessionSnapshot = { version: 1, tokenHash: this.expected.toString('hex'), browsers: structuredClone([...this.browsers]) };
    this.saves = this.saves.catch(() => {}).then(() => this.store!.write(value));
    // 请求和关闭入口时等待写入；后台更新时间不产生未处理的拒绝。
    void this.saves.catch(() => {});
    this.lastActivitySaved = Date.now();
  }
  flush(): Promise<void> { return this.saves; }
  matches(token: unknown): boolean { return typeof token === 'string' && timingSafeEqual(this.expected, this.hash(token)); }
  private cookie(request: IncomingMessage): string | undefined {
    return request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  }
  private writeCookie(response: ServerResponse, value: string, seconds: number) {
    response.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`);
  }
  login(response: ServerResponse, name = '浏览器'): void {
    if (this.browsers.size >= 100) throw new Error('浏览器会话数量已达上限，请退出不用的会话。');
    const cookie = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.browsers.set(this.hash(cookie).toString('hex'), { id: randomUUID(), name: name.replace(/[\x00-\x1f]/g, '').trim().slice(0, 60) || '浏览器', createdAt: now, lastSeenAt: now });
    this.writeCookie(response, cookie, cookieLifetimeSeconds);
    this.persist(); this.changed();
  }
  logout(request: IncomingMessage, response: ServerResponse): void {
    const cookie = this.cookie(request);
    if (cookie && this.browsers.delete(this.hash(cookie).toString('hex'))) { this.persist(); this.changed(); }
    this.writeCookie(response, '', 0);
  }
  connections(): WebConnectionInfo[] {
    const connections: WebConnectionInfo[] = [...this.browsers.values()].map(session => ({ ...session, kind: 'browser', connected: false }));
    if (this.bearerInfo) connections.push({ ...this.bearerInfo, connected: false });
    return connections;
  }
  revoke(id: string): void {
    if (this.bearerInfo?.id === id) throw new Error('API 共用部署令牌，请更换访问令牌以撤销 API 访问。');
    for (const [cookie, session] of this.browsers) if (session.id === id) { this.browsers.delete(cookie); this.persist(); this.changed(); return; }
  }
  rotate(token: string): void {
    if (typeof token !== 'string' || token.length < 32) throw new Error('访问令牌至少需要 32 个字符。');
    this.expected = this.hash(token); this.generation++; this.browsers.clear();
    this.bearer = { actorId: this.actorId, clientId: randomUUID() }; this.bearerInfo = undefined; this.persist(); this.changed();
  }
  authenticate(request: IncomingMessage, tabId = '', response?: ServerResponse): { client: ClientSession; browser: boolean; connectionId: string; valid(): boolean } | null {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ') && this.matches(header.slice(7))) {
      const generation = this.generation; const now = Date.now();
      this.bearerInfo ??= { id: this.bearer.clientId, name: '部署令牌 / API', kind: 'api', createdAt: now, lastSeenAt: now };
      this.bearerInfo.lastSeenAt = now;
      return { client: this.bearer, browser: false, connectionId: this.bearerInfo.id, valid: () => generation === this.generation };
    }
    const cookie = this.cookie(request);
    const key = cookie ? this.hash(cookie).toString('hex') : '';
    const session = this.browsers.get(key);
    if (!session) return null;
    session.lastSeenAt = Date.now();
    if (session.lastSeenAt - this.lastActivitySaved >= 60_000) this.persist();
    // 每次访问续期浏览器 cookie，服务端不按固定时长让设备退出。
    if (response) this.writeCookie(response, cookie!, cookieLifetimeSeconds);
    // 同一浏览器的不同标签页分别持有草稿；重新连接保持该标签页的客户端身份。
    const clientId = this.hash(`${this.actorId}:${/^[a-zA-Z0-9_-]{1,80}$/.test(tabId) ? tabId : session.id}`).toString('hex');
    return { client: { actorId: this.actorId, clientId }, browser: true, connectionId: session.id,
      valid: () => this.browsers.get(key) === session };
  }
}
