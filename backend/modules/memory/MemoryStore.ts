import type { LogEntry, MemoryConfig } from './types';

/** 记忆算法所需的存储操作；文件宿主与独立数据库宿主实现同一合同。 */
export interface MemoryStore {
    initStorage(): Promise<void>;
    ensureLogMigrated(): Promise<void>;
    logLen(): Promise<number>;
    logAppend(items: Array<{ date: string; text: string }>): Promise<number>;
    logSlice(lo: number, hi: number): Promise<LogEntry[]>;
    logGet(index: number): Promise<LogEntry>;
    rawEntryIdAt(index: number): Promise<number | null>;
    logScan(): AsyncGenerator<LogEntry>;
    treeGet(lo: number, hi: number): Promise<string | null>;
    treePut(lo: number, hi: number, text: string): Promise<boolean>;
    treeDrop(lo: number, hi: number): Promise<Array<[number, number]>>;
    dropSummariesCovering(id: number): Promise<void>;
    pending(total: number, limit?: number): Promise<Array<[number, number]>>;
    pendingCount(total: number): Promise<number>;
    updateEntry(id: number, text: string): Promise<void>;
    deleteRange(lo: number, hi: number): Promise<{ removed: number }>;
    deleteEntries(ids: number[]): Promise<{ removed: number }>;
    truncateLog(keepId: number): Promise<{ removed: number }>;
}

export interface MemoryHost {
    store(getConfig: () => MemoryConfig): MemoryStore;
    config: {
        initialize(defaults: MemoryConfig): Promise<void>;
        load(): Promise<MemoryConfig | null>;
        save(value: MemoryConfig): Promise<void>;
    };
}
