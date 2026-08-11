/**
 * Diff 管理器（已下沉 backend/core/services/diffManager.ts）
 *
 * 本文件为兼容壳（模块化重构第五批）：实现已迁移至 core 层，全部导出符号
 * 经 `export *` 转发。保留本路径仅供既有消费方（modules/checkpoint、
 * tools/search/search_in_files、webview、测试等）过渡使用，避免一次性改动
 * 全部 import；新代码应直接引用 core 实现。
 */

export * from '../../core/services/diffManager';
