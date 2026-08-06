/**
 * tokenizer 资源模块：运行时下载词表（cl100k / DeepSeek V3）到扩展数据目录。
 */

import { TokenizerResourceManager } from './TokenizerResourceManager';

export * from './converters';
export { TokenizerResourceManager } from './TokenizerResourceManager';
export type { TokenizerResource, TokenizerResourceName } from './TokenizerResourceManager';

let globalManager: TokenizerResourceManager | null = null;

/** 设置全局管理器（扩展激活时注入，与 ActivityTracker 同模式） */
export function setGlobalTokenizerResourceManager(manager: TokenizerResourceManager | null): void {
    globalManager = manager;
}

/** 获取全局管理器（未初始化时返回 null，调用方回退字符估算） */
export function getGlobalTokenizerResourceManager(): TokenizerResourceManager | null {
    return globalManager;
}
