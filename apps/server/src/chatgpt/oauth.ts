import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { t } from "../../../../backend/i18n";

export const OPENAI_ISSUER = 'https://auth.openai.com';
export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', DIRECT_SCOPE].join(' ');
export type AuthFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface PendingChatGPTRefresh { data: Record<string, any>; receivedAt: number }
export interface ChatGPTAccount {
  clientId: string;
  subject: string;
  email?: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  /** 官方最早续期时间转换为毫秒，缺少该字段的旧记录沿用原续期策略。 */
  earliestRefreshAt?: number;
  pendingRefresh?: PendingChatGPTRefresh;
  scopes: string[];
}
export interface ChatGPTCredentials { version: 1; activeClientId?: string; accounts: ChatGPTAccount[]; usageNoticeSeen?: boolean }

const terminalRefreshCodes = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
export class ChatGPTAuthError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
  get unusableRefreshToken(): boolean { return terminalRefreshCodes.has(this.code ?? ''); }
}

/** 使用官方发现文档和 JOSE 验证签名，账户身份不能来自未经验证的 JWT 解码。 */
export class OpenAIChatGPTClient {
  private readonly keys;
  constructor(private readonly fetcher: AuthFetch) {
    this.keys = createRemoteJWKSet(new URL(`${OPENAI_ISSUER}/.well-known/jwks.json`), {
      timeoutDuration: 30_000, [customFetch]: (url, init) => this.fetcher(url, init),
    });
  }
  private async token(body: URLSearchParams, signal: AbortSignal): Promise<Record<string, any>> {
    const response = await this.fetcher(`${OPENAI_ISSUER}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const data = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) {
      const code = typeof data.error === 'string' && /^[a-z_]{1,80}$/.test(data.error) ? data.error : undefined;
      // 令牌接口的原始响应可能包含凭据；错误只保留稳定代码和 HTTP 状态。
      throw new ChatGPTAuthError(`ChatGPT 授权请求失败（HTTP ${response.status}${code ? `，${code}` : ''}）。`, code);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ChatGPTAuthError(t('modules.chatgpt.invalidResponse'));
    return data;
  }
  private async account(data: Record<string, any>, clientId: string, previous?: ChatGPTAccount, nonce?: string,
    receivedAt = Date.now(), persistRotation?: () => Promise<void>): Promise<ChatGPTAccount> {
    const scopes = typeof data.scope === 'string' ? data.scope.trim().split(/\s+/).filter(Boolean) : previous?.scopes;
    if (!scopes) throw new ChatGPTAuthError(t('modules.chatgpt.missingScopes'));
    if (scopes.includes(DIRECT_SCOPE) && (typeof data.access_token !== 'string' || !data.access_token.trim()
      || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0)
      )
      throw new ChatGPTAuthError(t('modules.chatgpt.invalidTokens'));
    if (data.token_type !== undefined && String(data.token_type).toLowerCase() !== 'bearer')
      throw new ChatGPTAuthError(t('modules.chatgpt.unsupportedTokenType'));
    const refresh = data.refresh_token ?? previous?.refreshToken;
    if (scopes.includes(DIRECT_SCOPE) && (typeof refresh !== 'string' || !refresh.trim()))
      throw new ChatGPTAuthError(t('modules.chatgpt.missingRefreshToken'));
    if (data.id_token !== undefined && (typeof data.id_token !== 'string' || !data.id_token))
      throw new ChatGPTAuthError(t('modules.chatgpt.invalidIdentityToken'));
    // 上游已消耗旧续期令牌，先加密保存新令牌，再执行可能需要联网的身份验证。
    await persistRotation?.();
    let identity = previous;
    if (data.id_token !== undefined) {
      if (typeof data.id_token !== 'string' || !data.id_token) throw new ChatGPTAuthError(t('modules.chatgpt.invalidIdentityToken'));
      const { payload } = await jwtVerify(data.id_token, this.keys, {
        issuer: OPENAI_ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 30,
        currentDate: new Date(receivedAt),
      });
      if (typeof payload.sub !== 'string' || !payload.sub || nonce !== undefined && payload.nonce !== nonce)
        throw new ChatGPTAuthError(t('modules.chatgpt.identityMismatch'));
      if (previous && payload.sub !== previous.subject) throw new ChatGPTAuthError(t('modules.chatgpt.accountMismatch'));
      identity = { clientId, subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined,
        name: typeof payload.name === 'string' ? payload.name : undefined, expiresAt: 0, scopes: [] };
    } else if (!previous || nonce !== undefined) throw new ChatGPTAuthError(t('modules.chatgpt.missingIdentityToken'));
    if (!identity) throw new ChatGPTAuthError(t('modules.chatgpt.missingIdentity'));
    const earliest = typeof data.earliest_refresh_at === 'number' ? data.earliest_refresh_at * 1000
      : typeof data.earliest_refresh_at === 'string' ? Date.parse(data.earliest_refresh_at) : undefined;
    return { ...identity, clientId, accessToken: data.access_token, refreshToken: refresh,
      idToken: data.id_token ?? previous?.idToken, expiresAt: typeof data.expires_in === 'number' && data.expires_in > 0
        ? receivedAt + data.expires_in * 1000 : 0,
      earliestRefreshAt: earliest !== undefined && Number.isFinite(earliest) ? earliest : undefined,
      pendingRefresh: undefined, scopes };
  }
  async exchange(code: string, verifier: string, redirectUri: string, clientId: string, nonce: string,
    signal: AbortSignal, previous?: ChatGPTAccount): Promise<ChatGPTAccount> {
    const data = await this.token(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
      code, code_verifier: verifier, redirect_uri: redirectUri, resource: CHATGPT_RESOURCE }), signal);
    return this.account(data, clientId, previous, nonce);
  }
  async refresh(account: ChatGPTAccount, signal: AbortSignal,
    persistRotation?: (value: PendingChatGPTRefresh) => Promise<void>): Promise<ChatGPTAccount> {
    if (!account.pendingRefresh && account.earliestRefreshAt !== undefined && Date.now() < account.earliestRefreshAt)
      throw new ChatGPTAuthError(t('modules.chatgpt.refreshNotReady'), 'refresh_not_ready');
    let pending = account.pendingRefresh;
    if (!pending) {
      const data = await this.token(new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId,
        refresh_token: account.refreshToken!, resource: CHATGPT_RESOURCE }), signal);
      if (typeof data.refresh_token !== 'string' || !data.refresh_token.trim())
        throw new ChatGPTAuthError(t('modules.chatgpt.missingRefreshToken'));
      pending = { receivedAt: Date.now(), data: Object.fromEntries(Object.entries(data).filter(([key]) =>
        ['access_token', 'refresh_token', 'id_token', 'token_type', 'scope', 'expires_in', 'earliest_refresh_at'].includes(key))) };
    }
    const rotation = pending;
    return this.account(rotation.data, account.clientId, account, undefined, rotation.receivedAt,
      !account.pendingRefresh && persistRotation ? () => persistRotation(rotation) : undefined);
  }
  async revoke(account: ChatGPTAccount, signal: AbortSignal): Promise<boolean> {
    const refreshToken = typeof account.pendingRefresh?.data.refresh_token === 'string'
      ? account.pendingRefresh.data.refresh_token : account.refreshToken;
    if (!refreshToken) return true;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const discovery = await this.fetcher(`${OPENAI_ISSUER}/.well-known/openid-configuration`, { signal: combined });
    if (!discovery.ok) return false;
    const data = await discovery.json() as { revocation_endpoint?: string };
    if (!data.revocation_endpoint || new URL(data.revocation_endpoint).origin !== OPENAI_ISSUER) return false;
    const response = await this.fetcher(data.revocation_endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }).toString(),
      signal: combined });
    return response.status === 200;
  }
}

export function readChatGPTCredentials(raw: string | null): ChatGPTCredentials {
  if (!raw) return { version: 1, accounts: [] };
  const value = JSON.parse(raw) as ChatGPTCredentials;
  if (value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.some(account =>
    !account || typeof account.clientId !== 'string' || !account.clientId || typeof account.subject !== 'string'
    || !Array.isArray(account.scopes) || !Number.isFinite(account.expiresAt)
    || account.earliestRefreshAt !== undefined && !Number.isFinite(account.earliestRefreshAt)
    || account.pendingRefresh !== undefined && (!account.pendingRefresh || !account.pendingRefresh.data || typeof account.pendingRefresh.data !== 'object'
      || Array.isArray(account.pendingRefresh.data) || !Number.isFinite(account.pendingRefresh.receivedAt))))
    throw new ChatGPTAuthError(t('modules.chatgpt.invalidCredentials'));
  return value;
}
