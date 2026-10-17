import os from 'node:os';
import type { RemoteAccessSettings } from '@graycode/contracts';

/** 本机可用的局域网 IPv4，常见私网网段优先；用于直连来源白名单与界面展示。 */
export function lanAddresses(interfaces = os.networkInterfaces()): string[] {
  const addresses = Object.values(interfaces).flat()
    .filter(info => info && info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.'))
    .map(info => info!.address);
  const rank = (address: string) => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3;
  return [...new Set(addresses)].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

/** 允许的浏览器来源；代理入口以 publicOrigin 为准，局域网直连按本机地址放行。 */
export function webAccessOrigins(options: {
  publicOrigin?: string; port: number; allowLan?: boolean; interfaces?: ReturnType<typeof os.networkInterfaces>;
}): string[] {
  if (options.publicOrigin) return [options.publicOrigin];
  const origins = [`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`];
  if (options.allowLan) for (const address of lanAddresses(options.interfaces)) origins.push(`http://${address}:${options.port}`);
  return origins;
}

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
  if (settings.allowLan !== undefined && typeof settings.allowLan !== 'boolean') throw new Error('局域网直连开关无效。');
  if (settings.credentialRef !== undefined && (typeof settings.credentialRef !== 'string' || !settings.credentialRef.trim()))
    throw new Error('远程访问令牌引用无效。');
  if (settings.enabled && !settings.credentialRef) throw new Error('启用远程入口前，请生成或填写访问令牌。');
}
