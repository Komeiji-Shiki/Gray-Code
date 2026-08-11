/**
 * apply_diff 的应用引擎：结构化 hunk 与 legacy search/replace 的应用、
 * 计划拼接（fast path / plan 复用）、行号漂移补偿与冲突处理。
 *
 * 模块化重构第三批：从 backend/tools/file/apply_diff.ts 拆分而来，内容逐字保留。
 * applyStructuredDiffHunksBestEffort / applyDiffToContent 为对外导出（apply_diff.ts 壳 re-export）；
 * applyLegacyDiffsBestEffort 供 diff/declaration.ts 使用。
 */

import type {
    LegacyDiffBlock,
    StructuredDiffHunk,
    StructuredHunkPlan,
    StructuredHunkPlanEntry,
    StructuredMatchKind
} from './types';
import {
    normalizeLineEndings,
    findAllExactMatchIndexes,
    getCharOffsetForLine,
    getLineNumberAtIndex,
    countTextLines,
    countLineBreaks,
    countMatches,
    findAllExactMatchLineNumbers
} from './parse';
import { resolveStructuredHunkMatch, buildClosestBlockDiagnosis } from './match';

/**
 * 按计划条目拼接输出（fast path 与 plan 复用共享的拼接逻辑）。
 *
 * 为什么要抽成共享函数：首次应用与后续任意子集重放必须产出逐字节一致的输出、行号与块范围，
 * 用同一段拼接代码从结构上保证等价性，避免两份实现各自漂移。
 */
function splicePlannedEntries(
    normalizedOriginal: string,
    entries: StructuredHunkPlanEntry[]
): {
    newContent: string;
    results: Array<{
        index: number;
        success: boolean;
        startLine?: number;
        endLine?: number;
        matchCount?: number;
        matchKind?: StructuredMatchKind;
    }>;
    blocks: Array<{ index: number; startLine: number; endLine: number }>;
    appliedCount: number;
    failedCount: number;
} {
    const output: string[] = [];
    const results: Array<{
        index: number;
        success: boolean;
        startLine?: number;
        endLine?: number;
        matchCount?: number;
        matchKind?: StructuredMatchKind;
    }> = [];
    const blocks: Array<{ index: number; startLine: number; endLine: number }> = [];
    let cursor = 0;
    let lineDelta = 0;

    for (const item of entries) {
        output.push(normalizedOriginal.slice(cursor, item.startIndex), item.newContent);
        const startLine = item.originalStartLine + lineDelta;
        const endLine = startLine + Math.max(countTextLines(item.newContent), 1) - 1;
        results.push({
            index: item.index,
            success: true,
            startLine,
            endLine,
            matchCount: 1,
            matchKind: 'exact'
        });
        blocks.push({ index: item.index, startLine, endLine });
        lineDelta += countLineBreaks(item.newContent) - countLineBreaks(item.oldContent);
        cursor = item.endIndex;
    }
    output.push(normalizedOriginal.slice(cursor));

    return {
        newContent: output.join(''),
        results,
        blocks,
        appliedCount: results.length,
        failedCount: 0
    };
}

function tryApplyIndependentExactStructuredHunks(
    originalContent: string,
    hunks: StructuredDiffHunk[],
    applyIndices?: Set<number>
): {
    newContent: string;
    results: Array<{
        index: number;
        success: boolean;
        startLine?: number;
        endLine?: number;
        matchCount?: number;
        matchKind?: StructuredMatchKind;
    }>;
    blocks: Array<{ index: number; startLine: number; endLine: number }>;
    appliedCount: number;
    failedCount: number;
    /** 本次应用的独立精确匹配计划：供后续任意子集重放复用，跳过重复扫描 */
    plan: StructuredHunkPlan;
} | undefined {
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const planned: StructuredHunkPlanEntry[] = [];

    for (let index = 0; index < hunks.length; index++) {
        if (applyIndices && !applyIndices.has(index)) continue;
        const hunk = hunks[index];
        if (!hunk || typeof hunk.oldContent !== 'string' || typeof hunk.newContent !== 'string') return undefined;

        const oldContent = normalizeLineEndings(hunk.oldContent);
        if (!oldContent) return undefined;
        const matches = findAllExactMatchIndexes(normalizedOriginal, oldContent);
        // matches === null 表示候选超限（歧义过多），与多匹配一样放弃独立应用
        if (matches === null || matches.length === 0) return undefined;

        let startIndex: number;
        if (matches.length === 1) {
            startIndex = matches[0];
        } else {
            // 多匹配：仅当 hunk 携带 startLine 且能唯一消歧时才纳入计划。
            // 计划内 hunk 按原始坐标互不重叠且顺序应用时，慢路径的 lineDelta 补偿映射回
            // 原始坐标即为 startLine 本身，故此处 lineDelta=0 消歧与慢路径结果一致。
            if (typeof hunk.startLine !== 'number' || !Number.isFinite(hunk.startLine)) return undefined;
            const startOffset = getCharOffsetForLine(normalizedOriginal, hunk.startLine);
            if (startOffset === undefined) return undefined;
            const selected = matches.find(index => index >= startOffset);
            if (selected === undefined) return undefined;
            startIndex = selected;
        }

        const previous = planned[planned.length - 1];
        if (previous && startIndex < previous.endIndex) return undefined;
        planned.push({
            index,
            startIndex,
            endIndex: startIndex + oldContent.length,
            originalStartLine: getLineNumberAtIndex(normalizedOriginal, startIndex),
            oldContent,
            newContent: normalizeLineEndings(hunk.newContent)
        });
    }

    if (planned.length === 0) return undefined;

    const spliced = splicePlannedEntries(normalizedOriginal, planned);
    return {
        ...spliced,
        plan: { entries: planned, normalizedOriginal }
    };
}

export function applyStructuredDiffHunksBestEffort(
    originalContent: string,
    hunks: StructuredDiffHunk[],
    options?: {
        /** 只应用这些 hunk index（0-based，按原 hunks 顺序） */
        applyIndices?: Set<number>;
        /**
         * 复用先前 fast path 产出的计划：仅当计划覆盖本次所需 applyIndices（缺省=全部）
         * 且当前起始内容与产生计划时的内容一致时，直接按计划拼接输出（等价于 fast path），
         * 跳过重新扫描；不满足时行为与不传 plan 完全一致（重新扫描）。
         */
        plan?: StructuredHunkPlan;
    }
): {
    newContent: string;
    results: Array<{
        index: number;
        success: boolean;
        error?: string;
        startLine?: number;
        endLine?: number;
        matchCount?: number;
        candidateLines?: number[];
        matchKind?: StructuredMatchKind;
    }>;
    blocks: Array<{ index: number; startLine: number; endLine: number }>;
    appliedCount: number;
    failedCount: number;
    /** fast path / plan 复用成功时附带计划，供调用方缓存并用于后续块级重放 */
    plan?: StructuredHunkPlan;
} {
    const normalizedOriginal = normalizeLineEndings(originalContent);

    // plan 复用：跳过重新扫描，直接按计划拼接。
    // 约束：当前内容必须仍是产生计划时的内容；计划必须覆盖本次需要应用的全部下标。
    // 缺 plan / 计划不覆盖 / 起始内容不一致时一律回退到下方重新扫描，行为与旧实现完全一致。
    if (options?.plan && options.plan.entries.length > 0) {
        const requiredIndices = options.applyIndices ?? new Set(hunks.map((_, index) => index));
        const planIndexes = new Set(options.plan.entries.map(entry => entry.index));
        let coversAll = true;
        for (const index of requiredIndices) {
            if (!planIndexes.has(index)) {
                coversAll = false;
                break;
            }
        }
        if (coversAll && options.plan.normalizedOriginal === normalizedOriginal) {
            const selected = options.plan.entries.filter(entry => requiredIndices.has(entry.index));
            const spliced = splicePlannedEntries(normalizedOriginal, selected);
            return { ...spliced, plan: options.plan };
        }
    }

    const fastResult = tryApplyIndependentExactStructuredHunks(originalContent, hunks, options?.applyIndices);
    if (fastResult) return fastResult;

    // 为什么要把结构化 hunk 应用逻辑做成导出函数：工具入口和 DiffManager 块级接受/拒绝都需要同一套重放语义，不能各写一份。
    // 怎么改：逐 hunk 处理；先保持 exact 匹配原有语义，exact 为 0 时才启用行首缩进容错，并根据已应用 hunk 的行数变化维护偏移。
    // 目的：同时解决 JSON 转义误写、多个修改点行号漂移、AI 缩进误差、以及块级拒绝后重新计算内容的一致性问题。
    let currentContent = normalizeLineEndings(originalContent);
    let lineDelta = 0;

    const results: Array<{
        index: number;
        success: boolean;
        error?: string;
        startLine?: number;
        endLine?: number;
        matchCount?: number;
        candidateLines?: number[];
        matchKind?: StructuredMatchKind;
    }> = [];
    const blocks: Array<{ index: number; startLine: number; endLine: number }> = [];

    for (let i = 0; i < hunks.length; i++) {
        if (options?.applyIndices && !options.applyIndices.has(i)) {
            continue;
        }

        const hunk = hunks[i];
        if (!hunk || typeof hunk.oldContent !== 'string' || typeof hunk.newContent !== 'string') {
            results.push({
                index: i,
                success: false,
                error: `Structured hunk at index ${i} must contain string oldContent and newContent.`
            });
            continue;
        }

        const oldContent = normalizeLineEndings(hunk.oldContent);
        const newContent = normalizeLineEndings(hunk.newContent);

        if (!oldContent) {
            results.push({
                index: i,
                success: false,
                error: `Structured hunk at index ${i} has empty oldContent. Provide enough existing content to locate the change.`
            });
            continue;
        }

        const resolved = resolveStructuredHunkMatch(currentContent, oldContent, newContent, hunk, lineDelta);

        // 修改原因：当前 TypeScript 配置不会在 `!resolved.success` 下稳定收窄布尔字面量联合类型。
        // 修改方式：改用 `resolved.success === false`，让失败分支可以安全读取 error/matchCount/candidateLines。
        // 修改目的：保持匹配结果类型严格，同时避免为了通过编译而放宽成 any。
        if (resolved.success === false) {
            results.push({
                index: i,
                success: false,
                error: resolved.error,
                matchCount: resolved.matchCount,
                candidateLines: resolved.candidateLines
            });
            continue;
        }

        const { match } = resolved;
        const oldLineCount = countTextLines(match.matchedOldContent);
        const newLineCount = countTextLines(match.replacementContent);
        const endLine = match.startLine + Math.max(newLineCount, 1) - 1;

        // 修改原因：缩进 fallback 的真实替换范围可能不同于模型给出的 oldContent 字符串，不能再用 oldContent.length 拼接。
        // 修改方式：统一使用解析后的 startIndex/endIndex 和 replacementContent 执行 splice。
        // 修改目的：让 exact 与 indent_fallback 共享同一条安全替换路径，并保留 final newline 的真实范围。
        currentContent =
            currentContent.substring(0, match.startIndex) +
            match.replacementContent +
            currentContent.substring(match.endIndex);

        lineDelta += countLineBreaks(match.replacementContent) - countLineBreaks(match.matchedOldContent);
        results.push({
            index: i,
            success: true,
            startLine: match.startLine,
            endLine,
            matchCount: match.matchCount,
            candidateLines: match.candidateLines,
            matchKind: match.kind
        });
        blocks.push({ index: i, startLine: match.startLine, endLine });
    }

    const appliedCount = results.filter(x => x.success).length;
    const failedCount = results.length - appliedCount;

    return {
        newContent: currentContent,
        results,
        blocks,
        appliedCount,
        failedCount
    };
}

/**
 * Legacy：应用单个 search/replace diff
 */
export function applyDiffToContent(
    content: string,
    search: string,
    replace: string,
    startLine?: number
): {
    success: boolean;
    result: string;
    error?: string;
    matchCount: number;
    matchedLine?: number;
    /** 当匹配不唯一时，返回候选行号（1-based，最多返回部分） */
    candidateLines?: number[];
} {
    const normalizedContent = normalizeLineEndings(content);
    const normalizedSearch = normalizeLineEndings(search);
    const normalizedReplace = normalizeLineEndings(replace);

    if (!normalizedSearch) {
        return {
            success: false,
            result: normalizedContent,
            error: 'Search content is empty. Please provide enough context so the change can be located.',
            matchCount: 0
        };
    }

    // 如果提供了起始行号，从该行开始搜索
    if (startLine !== undefined && startLine > 0) {
        // 用单次扫描定位起始行字符偏移，避免全量 split 行数组 + substring 拷贝
        const charOffset = getCharOffsetForLine(normalizedContent, startLine);
        if (charOffset === undefined) {
            return {
                success: false,
                result: normalizedContent,
                error: `Start line ${startLine} is out of range. File has ${countLineBreaks(normalizedContent) + 1} lines.`,
                matchCount: 0
            };
        }

        // 从起始位置开始查找
        const matchIndex = normalizedContent.indexOf(normalizedSearch, charOffset);

        if (matchIndex === -1) {
            const diagnosis = buildClosestBlockDiagnosis(normalizedContent, normalizedSearch);
            return {
                success: false,
                result: normalizedContent,
                error: `No exact match found starting from line ${startLine}.${diagnosis ? '\n' + diagnosis : ''}`,
                matchCount: 0
            };
        }

        // 计算实际匹配的行号（单次扫描，避免 substring 拷贝 + split；matchIndex 已是完整内容中的绝对偏移）
        const actualMatchedLine = getLineNumberAtIndex(normalizedContent, matchIndex);

        // 执行替换
        const result =
            normalizedContent.substring(0, matchIndex) +
            normalizedReplace +
            normalizedContent.substring(matchIndex + normalizedSearch.length);

        return {
            success: true,
            result,
            matchCount: 1,
            matchedLine: actualMatchedLine
        };
    }

    // 没有提供起始行号，计算匹配次数（indexOf 循环替代 split，避免生成整个分割数组）
    const matches = countMatches(normalizedContent, normalizedSearch);

    if (matches === 0) {
        const diagnosis = buildClosestBlockDiagnosis(normalizedContent, normalizedSearch);
        return {
            success: false,
            result: normalizedContent,
            error: `No exact match found. Please verify the content matches exactly.${diagnosis ? '\n' + diagnosis : ''}`,
            matchCount: 0
        };
    }

    if (matches > 1) {
        const candidateLines = findAllExactMatchLineNumbers(normalizedContent, normalizedSearch, { limit: 20 });
        return {
            success: false,
            result: normalizedContent,
            error:
                `Multiple matches found (${matches}). Please provide 'start_line' parameter to specify which match to use.` +
                (candidateLines.length > 0 ? ` Candidate match lines: ${candidateLines.join(', ')}.` : ''),
            matchCount: matches,
            candidateLines
        };
    }

    // 计算实际匹配的行号
    const matchIndex = normalizedContent.indexOf(normalizedSearch);
    const actualMatchedLine = getLineNumberAtIndex(normalizedContent, matchIndex);

    // 精确替换（不能用 String.replace：replacement 字符串里的 $& / $` / $' / $$ 会被当作替换模式展开，
    // 模型输出的代码里恰好含有这些字符时会静默写坏文件。用切片拼接彻底绕开 replacement 模式语义）
    const result =
        normalizedContent.substring(0, matchIndex) +
        normalizedReplace +
        normalizedContent.substring(matchIndex + normalizedSearch.length);

    return {
        success: true,
        result,
        matchCount: 1,
        matchedLine: actualMatchedLine
    };
}

export function applyLegacyDiffsBestEffort(
    originalContent: string,
    diffs: LegacyDiffBlock[],
    options?: {
        /** 在错误信息中附加说明（用于统一 diff 的 loose fallback 场景） */
        errorSuffix?: string;
    }
): {
    newContent: string;
    results: Array<{
        index: number;
        success: boolean;
        error?: string;
        startLine?: number;
        endLine?: number;
        matchCount?: number;
        candidateLines?: number[];
    }>;
    blocks: Array<{ index: number; startLine: number; endLine: number }>;
    appliedCount: number;
    failedCount: number;
} {
    let currentContent = originalContent;
    // start_line 相对原始文件：前序 hunk 应用改变了行数后，后续 hunk 必须累计偏移，
    // 否则第二个及以后的 hunk 整体错位
    let lineDelta = 0;

    const results: Array<{
        index: number;
        success: boolean;
        error?: string;
        startLine?: number;
        endLine?: number;
        matchCount?: number;
        candidateLines?: number[];
    }> = [];
    const blocks: Array<{ index: number; startLine: number; endLine: number }> = [];

    for (let i = 0; i < diffs.length; i++) {
        const diff = diffs[i];
        if (typeof diff.search !== 'string' || diff.replace === undefined) {
            results.push({
                index: i,
                success: false,
                error: `Diff at index ${i} is missing 'search' or 'replace' field${options?.errorSuffix ? ` ${options.errorSuffix}` : ''}`
            });
            continue;
        }

        // start_line 相对原始文件：叠加前序 hunk 的行数偏移
        const adjustedStartLine = typeof diff.start_line === 'number' && diff.start_line > 0
            ? diff.start_line + lineDelta
            : diff.start_line;
        const r = applyDiffToContent(currentContent, diff.search, diff.replace, adjustedStartLine);
        let error = r.error;
        if (!r.success && error && options?.errorSuffix) {
            error = `${error} ${options.errorSuffix}`;
        }

        // 修改原因：旧实现用未归一化的 replace 行数计算 endLine，CRLF 内容会多算。
        // 修改方式：改用 countTextLines(normalizeLineEndings(...))，与结构化路径一致。
        const replaceLines = countTextLines(normalizeLineEndings(diff.replace));
        const startLine = r.matchedLine;
        // 空 replace 时行数为 0，endLine 会退化为 startLine - 1；用 Math.max 兜底为 startLine
        const endLine = startLine !== undefined ? startLine + Math.max(replaceLines, 1) - 1 : undefined;

        results.push({
            index: i,
            success: r.success,
            error,
            startLine,
            endLine,
            matchCount: r.matchCount,
            candidateLines: r.candidateLines
        });

        if (r.success) {
            currentContent = r.result;
            // 累计行数变化：replace 行数 - search 行数（基于规范化后的 LF 数量差）
            lineDelta += countLineBreaks(normalizeLineEndings(diff.replace)) - countLineBreaks(normalizeLineEndings(diff.search));
            if (startLine !== undefined && endLine !== undefined) {
                blocks.push({ index: i, startLine, endLine });
            }
        }
    }

    const appliedCount = results.filter(x => x.success).length;
    const failedCount = results.length - appliedCount;

    return {
        newContent: currentContent,
        results,
        blocks,
        appliedCount,
        failedCount
    };
}
