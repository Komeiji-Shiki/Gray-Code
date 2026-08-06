/**
 * LimCode - Memory 模块
 *
 * OptMem 风格永久记忆系统。
 */

import * as path from 'path';

import { MemoryManager } from './MemoryManager';

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
    MEMORY_TOOL_NAMES,
    isMemoryToolName,
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

/**
 * 初始化全局 MemoryManager（永久记忆系统）。
 *
 * VS Code 扩展（ChatViewProvider）与 Electron 桌面版（BackendHost）共用同一套
 * 初始化流程：在 <dataPath>/memory 下创建 LOG/TREE 存储、加载运行时配置并注册
 * 全局单例。提取为共享助手避免两宿主复制粘贴漂移。
 */
export async function initMemoryManager(dataPath: string): Promise<import('./MemoryManager').MemoryManager> {
    const memoryPath = path.join(dataPath, 'memory');
    const manager = new MemoryManager(memoryPath);
    await manager.init();
    await manager.loadConfig();
    setGlobalMemoryManager(manager);
    return manager;
}
