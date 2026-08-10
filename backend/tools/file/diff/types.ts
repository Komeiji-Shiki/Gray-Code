/**
 * apply_diff 的共享类型定义。
 *
 * 模块化重构第三批：从 backend/tools/file/apply_diff.ts 拆分而来，内容逐字保留。
 * 对外（apply_diff.ts 壳）只 re-export 其中 LegacyDiffBlock / StructuredDiffHunk /
 * StructuredHunkPlanEntry / StructuredHunkPlan；其余类型为 diff/ 子目录内部共享。
 */

/**
 * Legacy：单个 search/replace diff（仍被 DiffManager 用于旧结构的块级 accept/reject 逻辑）
 */
export interface LegacyDiffBlock {
    /** 要搜索的内容（必须 100% 精确匹配） */
    search: string;
    /** 替换后的内容 */
    replace: string;
    /** 搜索起始行号（1-based，可选） */
    start_line?: number;
}

/**
 * 结构化 hunk：apply_diff 的推荐新输入格式。
 *
 * 为什么要新增：旧 patch 字符串要求模型同时处理 JSON 字符串转义和 unified diff 前缀，容易把 `"` 当成文件内容写入。
 * 怎么改：把每个连续修改片段拆成 oldContent/newContent 字段，字段值按 JSON 字符串规则进入工具后直接作为最终文本使用。
 * 目的：保留多 hunk 能力来处理行号偏移，同时让内容字段和 write_file.content 的语义保持一致。
 */
export interface StructuredDiffHunk {
    /** 要被替换的原始内容，必须和当前文件内容精确匹配 */
    oldContent: string;
    /** 替换后的目标内容，按最终文件内容填写 */
    newContent: string;
    /** 可选。仅当 oldContent 在文件中重复出现时用于定位，1-based，基于原文件行号。 */
    startLine?: number;
}

/**
 * 结构化 hunk 应用计划的单条记录：某个 hunk 在规范化原始内容中的精确匹配位置与替换内容。
 *
 * 为什么要新增：fast path（独立精确匹配）已经算好每个 hunk 的匹配区间，块级拒绝/最终内容重放
 * 如果每次都重新扫描会重复付出相同的 indexOf/行号计算成本。
 * 怎么改：把已算好的匹配结果固化为计划条目，重放任意子集时直接按 startIndex/endIndex 拼接。
 * 目的：让 tryApplyIndependentExactStructuredHunks 的产物可被 diffManager 缓存并在任意子集重放时复用。
 */
export interface StructuredHunkPlanEntry {
    /** hunk 在原数组中的下标（0-based） */
    index: number;
    /** 匹配起点（基于 normalizedOriginal 的字符偏移，含） */
    startIndex: number;
    /** 匹配终点（基于 normalizedOriginal 的字符偏移，不含） */
    endIndex: number;
    /** 原文件中的起始行号（1-based） */
    originalStartLine: number;
    /** 规范化后的 oldContent */
    oldContent: string;
    /** 规范化后的 newContent */
    newContent: string;
}

/**
 * 结构化 hunk 应用计划：一组按原数组顺序排列的独立精确匹配记录 + 产生该计划的规范化原始内容。
 *
 * normalizedOriginal 用于重放前的起始内容校验：只有当前起始内容与产生计划时的内容一致时
 * 才能安全复用计划（行号/偏移都是相对这份内容算出来的）。
 */
export interface StructuredHunkPlan {
    entries: StructuredHunkPlanEntry[];
    normalizedOriginal: string;
}

export type StructuredMatchKind = 'exact' | 'indent_fallback';

export interface StructuredLineSpan {
    content: string;
    newline: '' | '\n';
    startIndex: number;
    endIndex: number;
    lineNumber: number;
}

export interface StructuredMatchCandidate {
    startIndex: number;
    endIndex: number;
    startLine: number;
    matchedOldContent: string;
}

export interface ResolvedStructuredMatch {
    kind: StructuredMatchKind;
    startIndex: number;
    endIndex: number;
    startLine: number;
    matchCount: number;
    candidateLines?: number[];
    matchedOldContent: string;
    replacementContent: string;
}
