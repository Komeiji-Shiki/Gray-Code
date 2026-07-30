/**
 * LimCode - Memory 模块
 *
 * OptMem 风格永久记忆系统。
 */

export {
    MemoryManager,
} from './MemoryManager';

export type {
    LogEntry,
    WakeBlock,
    WakeResult,
    NoteResult,
    RecallResult,
    CompressResult,
    ZoomResult,
    NapPrompt,
    MemoryConfig,
} from './types';

export {
    DEFAULT_MEMORY_CONFIG,
    LOG_REC,
    TREE_REC,
    RAW_MAX,
} from './types';

// ─── 单例访问器 ──────────────────────────────────

let _instance: import('./MemoryManager').MemoryManager | null = null;

/** 设置全局 MemoryManager 实例 */
export function setGlobalMemoryManager(manager: import('./MemoryManager').MemoryManager): void {
    _instance = manager;
}

/** 获取全局 MemoryManager 实例 */
export function getGlobalMemoryManager(): import('./MemoryManager').MemoryManager | null {
    return _instance;
}
