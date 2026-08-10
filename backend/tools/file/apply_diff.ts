/**
 * Apply Diff 工具 - 按用户设置选择两种格式应用文件变更：
 * - unified diff patch（---/+++/@ @/+/-）
 * - legacy search/replace/start_line diffs
 *
 * 支持多工作区（Multi-root Workspaces）
 *
 * 模块化重构第三批：实现已按职责拆分到 diff/ 子目录，本文件仅为 re-export 壳，
 * 对外导出符号与原文件完全一致（diffManager / file/index.ts / 测试均不受影响）：
 * - diff/types.ts       共享类型（LegacyDiffBlock / StructuredDiffHunk / StructuredHunkPlan 等）
 * - diff/parse.ts       hunk/补丁解析、行号计算与匹配扫描（normalizeLineEndings / countLineBreaks）
 * - diff/match.ts       上下文匹配（精确 + 缩进容错 fallback、行对齐、失败诊断）
 * - diff/apply.ts       应用引擎（计划拼接、替换/插入/删除、行号漂移、冲突处理）
 * - diff/declaration.ts 工具声明 + 参数校验 + pendingDiff 审阅流程 + 错误文案
 */

export {
    LegacyDiffBlock,
    StructuredDiffHunk,
    StructuredHunkPlanEntry,
    StructuredHunkPlan
} from './diff/types';
export {
    normalizeLineEndings,
    countLineBreaks
} from './diff/parse';
export {
    applyStructuredDiffHunksBestEffort,
    applyDiffToContent
} from './diff/apply';
export {
    createApplyDiffTool,
    registerApplyDiff
} from './diff/declaration';
