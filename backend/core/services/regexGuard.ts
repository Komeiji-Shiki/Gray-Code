/**
 * 正则 ReDoS 防护共享工具（跨端统一单一来源）
 *
 * 完整实现已迁移至 shared/regexGuard.ts（方案 A：前端复用后端完整逻辑，消除双实现分叉）。
 * 本文件仅作 re-export，保持既有导出面（MAX_REGEX_SOURCE_LENGTH /
 * hasNestedQuantifiedGroups / validateRegexPattern）与消费方
 * （search_in_files / history_search / MemoryManager.recall）不变。
 */
export { MAX_REGEX_SOURCE_LENGTH, hasNestedQuantifiedGroups, validateRegexPattern } from '../../../shared/regexGuard';
