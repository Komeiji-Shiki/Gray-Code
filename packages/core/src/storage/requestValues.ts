import { isDeepStrictEqual } from 'node:util';

const MAX_CACHE_ENTRIES = 2048;
// 读缓存与当前写入暂存各有此上限；字符串按 UTF16 持有体积估算，不能只数编码后的短引用。
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

interface CachedRequestValue { value: unknown; hash: Buffer; bytes: number }

/** 条目来自 Worker 私有消息；完整内容相等才复用已成功提交的值引用。 */
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
    const account = (input: unknown): void => {
      if (bytes > MAX_CACHE_BYTES) return;
      if (typeof input === 'string') {
        bytes += input.length * 2 + 16;
        return;
      }
      if (!input || typeof input !== 'object') {
        bytes += 8;
        return;
      }
      if (input instanceof Uint8Array) {
        bytes += input.byteLength + 32;
        return;
      }
      if (Array.isArray(input)) {
        bytes += 32 + input.length * 8;
        for (const item of input) account(item);
        return;
      }
      bytes += 64;
      for (const [name, item] of Object.entries(input)) {
        bytes += name.length * 2 + 16;
        account(item);
      }
    };
    account(value);
    if (bytes <= MAX_CACHE_BYTES) this.stage(key, { value, hash, bytes });
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
    // 外层存储操作提交后才淘汰旧条目；超出容量的顺序扫描仍能命中上次保留的尾部。
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

  discard(): void {
    this.staged.clear();
    this.stagedBytes = 0;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
    this.discard();
  }
}
