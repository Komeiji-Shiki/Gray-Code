import { PlatformStorageError } from '@graycode/core';
import type { PlatformStorage, MemoryScopeDefinition, MemoryMutation, MemorySummary } from '@graycode/core';
import type { MemoryStore } from '../../../../backend/modules/memory/MemoryStore';
import type { MemoryConfig, LogEntry } from '../../../../backend/modules/memory/types';
import { assertRecordFits, die } from '../../../../backend/modules/memory/logFormat';

/** 将原 LOG/TREE 合同映射为独立存储的索引与事务，不再填充固定宽度空白。 */
export class DatabaseMemoryStore implements MemoryStore {
  private summaries?: MemorySummary[];
  constructor(private readonly storage: PlatformStorage, readonly scope: MemoryScopeDefinition,
    private readonly getConfig: () => MemoryConfig, private readonly source?: Record<string, unknown>, private revision?: number) {}
  async initStorage() {}
  async ensureLogMigrated() {}
  async state() {
    const state = await this.storage.memoryState(this.scope);
    if (this.revision !== undefined && state.revision !== this.revision) throw new PlatformStorageError('REVISION_CONFLICT', '记忆在读取期间发生变化，请重新读取。');
    this.revision = state.revision;
    return state;
  }
  async logLen() { return (await this.state()).length; }
  async write(mutation: MemoryMutation, expectedRevision?: number) {
    const state = await this.state();
    const result = await this.storage.memoryWrite({ scope: this.scope, expectedRevision: expectedRevision ?? state.revision, mutation, source: this.source });
    this.revision = result.state.revision;
    this.summaries = undefined;
    return result;
  }
  async logAppend(items: Array<{ date: string; text: string }>) {
    const base = await this.logLen();
    items.forEach((item, index) => assertRecordFits(base + index, item.date, item.text));
    const result = await this.write({ type: 'append', entries: items.map(item => ({ ...item, source: this.source })) });
    return result.appendedAt!;
  }
  async logSlice(lo: number, hi: number): Promise<LogEntry[]> {
    const result: LogEntry[] = [];
    for (let offset = lo; offset < hi; offset += 4096)
      result.push(...await this.storage.memoryEntries(this.scope, offset, Math.min(4096, hi - offset), this.revision));
    return result;
  }
  async logGet(id: number) {
    const entry = (await this.logSlice(id, id + 1))[0];
    if (!entry) die(`No memory at index ${id}`);
    return entry;
  }
  async rawEntryIdAt(id: number) { return (await this.logSlice(id, id + 1))[0]?.id ?? null; }
  async *logScan(): AsyncGenerator<LogEntry> {
    const total = await this.logLen();
    for (let offset = 0; offset < total; offset += 4096)
      for (const item of await this.storage.memoryEntries(this.scope, offset, Math.min(4096, total - offset), this.revision)) yield item;
  }
  async treeGet(lo: number, hi: number) { return (await this.storage.memorySummaries(this.scope, lo, hi, this.revision))[0]?.text ?? null; }
  async treePut(lo: number, hi: number, text: string) { return (await this.write({ type: 'summary.put', lo, hi, text })).changed; }
  async treeDrop(lo: number, hi: number) { return (await this.write({ type: 'summary.drop', lo, hi })).dropped; }
  async dropSummariesCovering(id: number) { await this.treeDrop(Math.floor(id / 2) * 2, Math.floor(id / 2) * 2 + 2); }
  private async summaryKeys() {
    this.summaries ??= await this.storage.memorySummaries(this.scope, undefined, undefined, this.revision);
    return new Set(this.summaries.map(item => `${item.lo}:${item.hi}`));
  }
  async pending(total: number, limit?: number): Promise<Array<[number, number]>> {
    const keys = await this.summaryKeys(); const result: Array<[number, number]> = [];
    for (let width = 2; width <= total; width *= 2) for (let lo = 0; lo + width <= total; lo += width) {
      if (keys.has(`${lo}:${lo + width}`)) continue;
      result.push([lo, lo + width]); if (limit && result.length >= limit) return result;
    }
    return result;
  }
  async pendingCount(total: number) {
    const keys = await this.summaryKeys(); let count = 0;
    for (let width = 2; width <= total; width *= 2) for (let lo = 0; lo + width <= total; lo += width)
      if (!keys.has(`${lo}:${lo + width}`)) count++;
    return count;
  }
  async updateEntry(id: number, text: string) {
    const trimmed = text.trim();
    if (!trimmed || /[\r\n]/.test(trimmed)) die('A memory is one line.');
    if (Buffer.byteLength(trimmed) > this.getConfig().entryChars) die(`Too long: limit ${this.getConfig().entryChars} bytes.`);
    const entry = await this.logGet(id); assertRecordFits(id, entry.date, trimmed);
    await this.write({ type: 'update', id, text: trimmed });
  }
  async deleteRange(lo: number, hi: number) {
    const total = await this.logLen();
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi >= total) die(`Invalid delete range: ${lo}-${hi}.`);
    if (hi === total - 1) return this.truncateLog(lo);
    return this.deleteEntries(Array.from({ length: hi - lo + 1 }, (_, index) => lo + index));
  }
  async deleteEntries(ids: number[]) { return { removed: (await this.write({ type: 'delete', ids })).removed }; }
  async truncateLog(keepId: number) { return { removed: (await this.write({ type: 'truncate', keep: keepId })).removed }; }
}
