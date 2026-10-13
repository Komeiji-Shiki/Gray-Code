import { isDeepStrictEqual } from 'node:util';

const MAX_CACHE_ENTRIES = 2048;
// 读缓存与当前写入暂存各有此上限；字符串按 UTF16 持有体积估算，不能只数编码后的短引用。
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const TOO_LARGE = Symbol('request-value-too-large');

interface CachedRequestValue { value: unknown; hash: Buffer; bytes: number }

/** 只保存已通过存储校验的条目副本；完整内容相等才复用原来的值引用。 */
export class RequestValueCache {
  private readonly entries = new Map<string, CachedRequestValue>();
  private bytes = 0;
  private readonly staged = new Map<string, CachedRequestValue>();
  private stagedBytes = 0;

  find(key: string, value: unknown): CachedRequestValue | undefined {
    const cached = this.entries.get(key);
    if (!cached || !isDeepStrictEqual(cached.value, value)) return undefined;
    this.stage(key, cached);
    return cached;
  }

  remember(key: string, value: unknown, hash: Buffer): void {
    let bytes = 0;
    const account = (size: number) => {
      bytes += size;
      if (bytes > MAX_CACHE_BYTES) throw TOO_LARGE;
    };
    const copy = (input: unknown): unknown => {
      if (typeof input === 'string') { account(input.length * 2 + 16); return input; }
      if (!input || typeof input !== 'object') { account(8); return input; }
      if (input instanceof Uint8Array) {
        account(input.byteLength + 32);
        return Buffer.isBuffer(input) ? Buffer.from(input) : new Uint8Array(input);
      }
      if (Array.isArray(input)) {
        account(32 + input.length * 8);
        return input.map(copy);
      }
      account(64);
      const cloned = Object.fromEntries(Object.entries(input).map(([name, item]) => {
        account(name.length * 2 + 16);
        return [name, copy(item)];
      }));
      return Object.getPrototypeOf(input) === null ? Object.setPrototypeOf(cloned, null) : cloned;
    };
    try { this.stage(key, { value: copy(value), hash, bytes }); }
    catch (error) { if (error !== TOO_LARGE) throw error; }
  }

  private stage(key: string, cached: CachedRequestValue): void {
    this.stagedBytes -= this.staged.get(key)?.bytes ?? 0;
    this.staged.delete(key);
    this.staged.set(key, cached);
    this.stagedBytes += cached.bytes;
    while (this.staged.size > MAX_CACHE_ENTRIES || this.stagedBytes > MAX_CACHE_BYTES) {
      const first = this.staged.keys().next().value!;
      this.stagedBytes -= this.staged.get(first)!.bytes;
      this.staged.delete(first);
    }
  }

  commit(): void {
    // 一次请求读完后才淘汰旧条目；超出容量的顺序扫描仍能命中上次保留的尾部。
    for (const [key, cached] of this.staged) {
      this.bytes -= this.entries.get(key)?.bytes ?? 0;
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.bytes += cached.bytes;
      while (this.entries.size > MAX_CACHE_ENTRIES || this.bytes > MAX_CACHE_BYTES) {
        const first = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(first)!.bytes;
        this.entries.delete(first);
      }
    }
    this.discard();
  }

  discard(): void { this.staged.clear(); this.stagedBytes = 0; }
  clear(): void { this.entries.clear(); this.bytes = 0; this.discard(); }
}
