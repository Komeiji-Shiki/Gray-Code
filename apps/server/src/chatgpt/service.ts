import { createHash, randomUUID } from 'node:crypto';
import { t } from "../../../../backend/i18n";
import type { PlatformApplication } from '../application';
import { createProxyFetch } from '../../../../backend/modules/channel/proxyFetch';
import { CHATGPT_CREDENTIAL_PREFIX, CHATGPT_USAGE_URL } from '../../../../backend/modules/channel/chatgpt';
import { createChatGPTLogin } from './login';
import { DIRECT_SCOPE, ChatGPTAuthError, OpenAIChatGPTClient, readChatGPTCredentials,
  type AuthFetch, type ChatGPTAccount, type ChatGPTCredentials } from './oauth';

const credentialId = (channelId: string) => `${CHATGPT_CREDENTIAL_PREFIX}${createHash('sha256').update(channelId).digest('hex').slice(0, 32)}`;
const signedOut = (account: ChatGPTAccount): ChatGPTAccount => {
  const { accessToken, refreshToken, idToken, earliestRefreshAt, pendingRefresh, ...registration } = account;
  return { ...registration, expiresAt: 0 };
};
const canUsePlan = (account?: ChatGPTAccount) => !!account?.accessToken && account.scopes.includes(DIRECT_SCOPE);
type PendingLogin = Awaited<ReturnType<typeof createChatGPTLogin>>;

/** 授权记录复用平台加密凭据事务；每个渠道保存自己的账户注册和当前选择。 */
export class ChatGPTService {
  private readonly client: OpenAIChatGPTClient;
  private readonly pending = new Map<string, PendingLogin>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();
  private host?: Promise<string>;
  constructor(private readonly app: Pick<PlatformApplication, 'settings' | 'storage' | 'product'>, fetcher?: AuthFetch) {
    this.client = new OpenAIChatGPTClient(fetcher ?? ((url, init) =>
      createProxyFetch(this.app.product.runtimeSettings().getEffectiveProxyUrl())(url, init) as Promise<Response>));
  }
  private connection(channelId: string) { return this.app.settings.credential(credentialId(channelId)).then(readChatGPTCredentials); }
  private update(channelId: string, transform: (value: ChatGPTCredentials) => void): Promise<void> {
    return this.app.settings.updateCredential(credentialId(channelId), current => {
      const value = readChatGPTCredentials(current); transform(value); return JSON.stringify(value);
    });
  }
  private hostId(): Promise<string> {
    return this.host ??= (async () => {
      const record = await this.app.storage.getVersionedRecord('chatgpt-host', 'main');
      if (typeof record.value === 'string') return record.value;
      const id = `urn:uuid:${randomUUID()}`;
      await this.app.storage.commitRecords([{ namespace: 'chatgpt-host', id: 'main', value: id, expectedRevision: null }]);
      return id;
    })();
  }
  async status(channelId: string, clientId: string) {
    const connection = await this.connection(channelId);
    return { storageAvailable: this.app.settings.supportsEncryptedCredentials,
      activeClientId: connection.activeClientId, usageUrl: CHATGPT_USAGE_URL,
      needsUsageNotice: !connection.usageNoticeSeen && connection.accounts.some(account => canUsePlan(account)),
      accounts: connection.accounts.map(account => ({ clientId: account.clientId, email: account.email, name: account.name,
        connected: !!account.accessToken || !!account.idToken, planEnabled: canUsePlan(account) })),
      login: this.pending.get(`${clientId}:${channelId}`)?.snapshot() };
  }
  async start(channelId: string, clientId: string, accountId?: string, newAccount = false) {
    if (!this.app.settings.supportsEncryptedCredentials) throw new Error(t('modules.chatgpt.storageUnavailable'));
    this.lifetime.signal.throwIfAborted();
    const connection = await this.connection(channelId);
    const selected = newAccount ? undefined : accountId ?? connection.activeClientId;
    const previous = selected ? connection.accounts.find(account => account.clientId === selected) : undefined;
    if (selected && !previous) throw new Error(t('modules.chatgpt.accountMissing'));
    const key = `${clientId}:${channelId}`;
    this.pending.get(key)?.cancel(); this.pending.delete(key);
    const login = await createChatGPTLogin(await this.hostId(), previous, async (code, verifier, redirect, issued, nonce, signal) => {
      const account = await this.client.exchange(code, verifier, redirect, issued, nonce,
        AbortSignal.any([signal, this.lifetime.signal]), previous);
      await this.update(channelId, value => {
        signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
        const index = value.accounts.findIndex(item => item.clientId === account.clientId);
        if (index < 0) value.accounts.push(account); else value.accounts[index] = account;
        value.activeClientId = account.clientId;
      });
    });
    if (this.lifetime.signal.aborted) { login.cancel(); this.lifetime.signal.throwIfAborted(); }
    this.pending.set(key, login);
    return { url: login.url };
  }
  async complete(channelId: string, clientId: string, url: string) {
    const login = this.pending.get(`${clientId}:${channelId}`);
    if (!login) throw new Error(t('modules.chatgpt.loginMissing'));
    await login.complete(url);
    return this.status(channelId, clientId);
  }
  cancel(channelId: string, clientId: string) {
    const key = `${clientId}:${channelId}`;
    this.pending.get(key)?.cancel(); this.pending.delete(key);
    return { success: true };
  }
  async acknowledge(channelId: string) {
    await this.update(channelId, value => { value.usageNoticeSeen = true; });
    return { success: true };
  }
  async select(channelId: string, clientId: string, accountId: string) {
    await this.update(channelId, value => {
      if (!value.accounts.some(account => account.clientId === accountId)) throw new Error(t('modules.chatgpt.accountMissing'));
      value.activeClientId = accountId;
    });
    return this.status(channelId, clientId);
  }
  async disconnect(channelId: string, clientId: string, accountId: string) {
    this.cancel(channelId, clientId);
    const account = (await this.connection(channelId)).accounts.find(account => account.clientId === accountId);
    if (!account) throw new Error(t('modules.chatgpt.accountMissing'));
    await this.update(channelId, value => {
      const current = value.accounts.find(item => item.clientId === accountId);
      // 注销期间的新登录不能被旧请求删除。
      if (current && current.refreshToken === account.refreshToken) Object.assign(current, signedOut(account),
        { accessToken: undefined, refreshToken: undefined, idToken: undefined, earliestRefreshAt: undefined, pendingRefresh: undefined });
    });
    const revoked = await this.client.revoke(account, this.lifetime.signal).catch(() => false);
    return { ...await this.status(channelId, clientId), revoked };
  }
  async accessToken(channelId: string, signal: AbortSignal): Promise<string> {
    return (await this.credentials(channelId, signal)).token;
  }
  async credentials(channelId: string, signal: AbortSignal): Promise<{ token: string; identity: string }> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const connection = await this.connection(channelId);
    this.lifetime.signal.throwIfAborted();
    const account = connection.accounts.find(item => item.clientId === connection.activeClientId);
    if (!canUsePlan(account)) throw new Error(t('modules.chatgpt.signInRequired'));
    if (!account!.pendingRefresh) {
      const now = Date.now();
      if (account!.earliestRefreshAt !== undefined && now < account!.earliestRefreshAt) {
        if (account!.expiresAt <= now) throw new ChatGPTAuthError(t('modules.chatgpt.refreshNotReady'), 'refresh_not_ready');
        return { token: account!.accessToken!, identity: account!.clientId };
      }
      if (account!.expiresAt > now + 3 * 60_000) return { token: account!.accessToken!, identity: account!.clientId };
    }
    const key = `${channelId}:${account!.clientId}`;
    let refresh = this.refreshes.get(key);
    if (!refresh) {
      refresh = this.refresh(channelId, account!);
      this.refreshes.set(key, refresh);
      void refresh.finally(() => { if (this.refreshes.get(key) === refresh) this.refreshes.delete(key); }).catch(() => {});
    }
    let abort!: () => void;
    try {
      await Promise.race([refresh, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener('abort', abort); }
    signal.throwIfAborted();
    const latest = await this.connection(channelId);
    const active = latest.accounts.find(item => item.clientId === latest.activeClientId);
    if (latest.activeClientId !== account!.clientId || !canUsePlan(active)) throw new Error(t('modules.chatgpt.accountChanged'));
    if (active!.expiresAt <= Date.now()) throw new ChatGPTAuthError(t('modules.chatgpt.refreshNotReady'), 'refresh_not_ready');
    return { token: active!.accessToken!, identity: active!.clientId };
  }
  private async refresh(channelId: string, account: ChatGPTAccount) {
    try {
      // 正常退出会等待这次有界续期完成，不能因调用取消丢失唯一可用的轮换令牌。
      const renewed = await this.client.refresh(account, AbortSignal.timeout(60_000), async pendingRefresh => {
        await this.update(channelId, value => {
          const current = value.accounts.find(item => item.clientId === account.clientId);
          if (current && current.refreshToken === account.refreshToken) current.pendingRefresh = pendingRefresh;
        });
      });
      await this.update(channelId, value => {
        const index = value.accounts.findIndex(item => item.clientId === account.clientId);
        if (index >= 0 && value.accounts[index].refreshToken === account.refreshToken) value.accounts[index] = renewed;
      });
      if (!canUsePlan(renewed)) throw new Error(t('modules.chatgpt.refreshPermissionMissing'));
    } catch (error) {
      if (error instanceof ChatGPTAuthError && error.unusableRefreshToken) {
        let invalidated = false;
        await this.update(channelId, value => {
          const index = value.accounts.findIndex(item => item.clientId === account.clientId);
          if (index >= 0 && value.accounts[index].refreshToken === account.refreshToken) {
            value.accounts[index] = signedOut(account); invalidated = true;
          }
        });
        if (!invalidated) return;
        // 保留稳定错误码，便于区分令牌到期、撤销与重复轮换，不暴露令牌响应。
        throw new ChatGPTAuthError(`${t('modules.chatgpt.signInExpired')} (${error.code})`, error.code);
      }
      throw error;
    }
  }
  async close() {
    this.lifetime.abort();
    for (const login of this.pending.values()) login.cancel();
    this.pending.clear();
    await Promise.allSettled([...this.refreshes.values()]);
  }
}
