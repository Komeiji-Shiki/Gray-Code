/**
 * GrayCode 对话存储接口与内存实现的统一出口。
 * 对话历史与元数据的实际持久化布局由宿主注入的适配器决定。
 *
 * 本文件已按职责拆分，只保留统一再导出口径（公共 API 保持不变）：
 * - storageTypes.ts：IStorageAdapter 接口与所有存储结果类型；
 * - storageWriteQueues.ts：分段历史写 / 元数据读改写串行队列与挂起超时；
 * - storageIds.ts：存储 ID 安全校验；
 * - memoryStorageAdapter.ts：内存存储适配器；
 * - segmentedHistoryUtils.ts：分段历史索引与文件系统纯工具函数。
 */

export * from './storageTypes';
export { withHangTimeout, withMetadataWriteSerialized } from './storageWriteQueues';
export { assertSafeStorageId } from './storageIds';
export { MemoryStorageAdapter } from './memoryStorageAdapter';
