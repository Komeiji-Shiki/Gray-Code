/**
 * `crypto.randomUUID()` 只在安全上下文（HTTPS 或 localhost）可用。
 * 局域网 HTTP 直连时浏览器会直接缺少这个方法，外壳在模块初始化阶段调用会中断整个界面；
 * 这里用同样普遍可用的 `getRandomValues` 补齐一个等价的 UUID v4 实现。
 */
interface RandomSource {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}

export function randomUuid(source: RandomSource | undefined = (globalThis as { crypto?: RandomSource }).crypto): string {
  const bytes = source?.getRandomValues?.(new Uint8Array(16));
  if (!bytes) throw new Error('当前环境没有可用的随机数来源。');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const crypto = (globalThis as { crypto?: RandomSource }).crypto;
if (crypto && typeof crypto.randomUUID !== 'function' && typeof crypto.getRandomValues === 'function') {
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, writable: true, value: () => randomUuid(crypto) });
}
