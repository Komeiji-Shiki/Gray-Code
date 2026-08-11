/**
 * Prompt 工具调用解析器（已下沉 backend/core/parsers/promptToolParser.ts）
 *
 * 本文件为兼容壳（模块化重构第五批）：实现已迁移至 core 层，全部导出符号
 * 经 `export *` 转发。保留本路径仅供既有消费方（modules/channel、
 * modules/api、测试等）过渡使用；新代码应直接引用 core 实现。
 */

export * from '../core/parsers/promptToolParser';
