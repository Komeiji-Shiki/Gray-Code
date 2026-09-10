import type { RemoteAccessSettings } from '@graycode/contracts';

/** 反向代理来源必须明确配置，不能从转发头自动扩大可信来源。 */
export function normalizeWebOrigin(origin?: string): string | undefined {
  if (origin === undefined || origin === '') return undefined;
  if (typeof origin !== 'string') throw new Error('远程入口来源必须是 HTTPS 地址。');
  const value = new URL(origin);
  if (value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' || value.search || value.hash)
    throw new Error('远程入口必须是完整的 HTTPS 来源，例如 https://graycode.example.com。');
  return value.origin;
}
export function validateRemoteAccess(settings?: RemoteAccessSettings): void {
  if (!settings) return;
  if (typeof settings.enabled !== 'boolean' || !Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535)
    throw new Error('远程入口需要明确的启用状态和 0 至 65535 之间的端口。');
  settings.publicOrigin = normalizeWebOrigin(settings.publicOrigin);
  if (settings.credentialRef !== undefined && (typeof settings.credentialRef !== 'string' || !settings.credentialRef.trim()))
    throw new Error('远程访问令牌引用无效。');
  if (settings.enabled && !settings.credentialRef) throw new Error('启用远程入口前，请生成或填写访问令牌。');
}
