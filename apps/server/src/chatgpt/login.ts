import { createServer, type ServerResponse } from 'node:http';
import { t } from "../../../../backend/i18n";
import { randomBytes, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { OPENAI_ISSUER, CHATGPT_RESOURCE, CHATGPT_SCOPES, DIRECT_SCOPE, type ChatGPTAccount } from './oauth';

const randomValue = () => randomBytes(32).toString('base64url');
const callbackPath = '/auth/callback';
export type LoginState = 'pending' | 'exchanging' | 'completed' | 'failed' | 'cancelled';

function page(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>GrayCode · ChatGPT</title><style>body{background:#111318;color:#e7e7e7;font:16px system-ui;margin:10vh auto;max-width:580px;padding:32px;border:1px solid #343841}h1{font-size:24px}</style><h1>GrayCode · ChatGPT</h1><p>${message}</p></html>`);
}

/** 一次登录绑定一个界面客户端；回调可自动接收，也可由该客户端粘贴完整地址。 */
export async function createChatGPTLogin(hostId: string, previous: ChatGPTAccount | undefined,
  exchange: (code: string, verifier: string, redirect: string, clientId: string, nonce: string, signal: AbortSignal) => Promise<void>) {
  const state = randomValue(), nonce = randomValue(), verifier = randomValue();
  const controller = new AbortController();
  let phase: LoginState = 'pending', error = '';
  let redirectUri = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', redirectUri);
    if (request.method !== 'GET' || url.pathname !== callbackPath) return page(response, 404, t('modules.chatgpt.callbackNotFound'));
    try { await complete(url.href); page(response, 200, t('modules.chatgpt.callbackSuccess')); }
    catch { page(response, 400, t('modules.chatgpt.callbackFailed')); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${callbackPath}`;
  const timer = setTimeout(() => { error = t('modules.chatgpt.loginTimeout'); cancel('failed'); }, 10 * 60 * 1000);
  timer.unref();
  const url = new URL(`${OPENAI_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({ client_id: previous?.clientId ?? 'dynamic_agent_client',
    ...(!previous ? { agent_name_hint: 'GrayCode' } : {}),
    ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri,
    resource: CHATGPT_RESOURCE, scope: CHATGPT_SCOPES, state, nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(previous?.email ? { login_hint: previous.email } : {}),
    ...(previous && !previous.scopes.includes(DIRECT_SCOPE) ? { prompt: 'consent' } : {}),
  }).toString();
  function close() { clearTimeout(timer); server.close(); server.closeIdleConnections(); }
  function cancel(next: LoginState = 'cancelled') { controller.abort(); phase = next; close(); server.closeAllConnections(); }
  async function complete(input: string) {
    const callback = new URL(input);
    if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== callbackPath
      || callback.searchParams.get('state') !== state) throw new Error(t('modules.chatgpt.callbackMismatch'));
    if (phase !== 'pending' || controller.signal.aborted) throw new Error(t('modules.chatgpt.loginEnded'));
    phase = 'exchanging';
    try {
      if (callback.searchParams.has('error')) throw new Error(t('modules.chatgpt.consentDeclined'));
      const code = callback.searchParams.get('code'), issued = callback.searchParams.get('client_id');
      const clientId = issued ?? previous?.clientId;
      if (!code || !clientId || clientId === 'dynamic_agent_client' || previous && clientId !== previous.clientId)
        throw new Error(t('modules.chatgpt.invalidCallback'));
      await exchange(code, verifier, redirectUri, clientId, nonce, controller.signal);
      controller.signal.throwIfAborted();
      phase = 'completed';
    } catch (failure) {
      if (!controller.signal.aborted) { phase = 'failed'; error = failure instanceof Error ? failure.message : t('modules.chatgpt.failed'); }
      throw failure;
    } finally { close(); }
  }
  return { url: url.href, complete, cancel, snapshot: () => ({ state: phase, error }) };
}
