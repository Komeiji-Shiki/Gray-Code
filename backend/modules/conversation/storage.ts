/**
 * GrayCode - 存储适配器
 * 
 * 存储格式说明:
 * - 对话历史: 完整的 Gemini Content[] 格式
 * - 文件命名: {conversationId}.json
 * - 元数据: 单独存储在 {conversationId}.meta.json
 * 
 * 这样设计的优势:
 * 1. 历史文件可直接用于 Gemini API
 * 2. 完整保留所有 Gemini 特性(函数调用、思考签名等)
 * 3. 元数据与历史分离,便于管理
 *
 * 本文件已按职责拆分，只保留统一再导出口径（公共 API 保持不变）：
 * - storageTypes.ts：IStorageAdapter 接口与所有存储结果类型；
 * - storageWriteQueues.ts：分段历史写 / 元数据读改写串行队列与挂起超时；
 * - storageIds.ts：存储 ID 安全校验；
 * - memoryStorageAdapter.ts：内存存储适配器；
 * - vscodeStorageAdapter.ts：VS Code globalState 存储适配器；
 * - fileSystemStorageAdapter.ts：workspace.fs 文件系统存储适配器；
 * - segmentedHistoryUtils.ts：分段历史索引与文件系统纯工具函数。
 */

export * from './storageTypes';
export { withHangTimeout, withMetadataWriteSerialized } from './storageWriteQueues';
export { assertSafeStorageId } from './storageIds';
export { MemoryStorageAdapter } from './memoryStorageAdapter';
export { VSCodeStorageAdapter } from './vscodeStorageAdapter';
export { FileSystemStorageAdapter } from './fileSystemStorageAdapter';
