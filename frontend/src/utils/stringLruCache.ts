/** An LRU bounded by both entry count and retained UTF-16 key/value bytes. */
export class StringLruCache {
  private readonly entries = new Map<string, string>()
  private retainedBytes = 0

  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

  get size(): number { return this.entries.size }

  get(key: string): string | undefined {
    const value = this.entries.get(key)
    if (value !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
  }

  set(key: string, value: string): void {
    this.delete(key)
    const bytes = (key.length + value.length) * 2
    if (bytes > this.maxBytes || this.maxEntries === 0) return
    this.entries.set(key, value)
    this.retainedBytes += bytes
    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.delete(oldestKey)
    }
  }

  delete(key: string): boolean {
    const value = this.entries.get(key)
    if (value === undefined) return false
    this.retainedBytes -= (key.length + value.length) * 2
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.retainedBytes = 0
  }
}
