/**
 * apply_diff 的上下文匹配层：结构化 hunk 的精确匹配与缩进容错 fallback、
 * 行级对齐、缩进重映射与失败诊断。
 *
 * 模块化重构第三批：从 backend/tools/file/apply_diff.ts 拆分而来，内容逐字保留。
 * resolveStructuredHunkMatch / buildClosestBlockDiagnosis 供 diff/apply.ts 使用。
 */

import {
    findAllExactMatchIndexes,
    MAX_EXACT_MATCH_INDEXES,
    getLineNumberAtIndex,
    getLineNumbersAtIndexes,
    getCharOffsetForLine,
    formatCandidateLinesForMessage
} from './parse';
import type {
    StructuredDiffHunk,
    StructuredLineSpan,
    StructuredMatchCandidate,
    ResolvedStructuredMatch
} from './types';

function tokenizeNormalizedLinesWithSpans(normalizedText: string): StructuredLineSpan[] {
    // 修改原因：缩进容错必须在“完整连续行窗口”上匹配，不能退化成不安全的任意子串 fuzzy 匹配。
    // 修改方式：把已规范化为 LF 的文本切成带起止字符偏移、行号和末尾换行标记的逻辑行。
    // 修改目的：后续 fallback 能用真实字符范围 splice，同时保留 final newline 的精确语义。
    const lines: StructuredLineSpan[] = [];
    if (!normalizedText) return lines;

    let startIndex = 0;
    let lineNumber = 1;

    while (startIndex < normalizedText.length) {
        const newlineIndex = normalizedText.indexOf('\n', startIndex);
        if (newlineIndex === -1) {
            lines.push({
                content: normalizedText.slice(startIndex),
                newline: '',
                startIndex,
                endIndex: normalizedText.length,
                lineNumber
            });
            break;
        }

        lines.push({
            content: normalizedText.slice(startIndex, newlineIndex),
            newline: '\n',
            startIndex,
            endIndex: newlineIndex + 1,
            lineNumber
        });

        startIndex = newlineIndex + 1;
        lineNumber++;
    }

    return lines;
}

function getLeadingHorizontalWhitespace(line: string): string {
    // 修改原因：AI 最常见的 oldContent 失败来自每行行首缩进误差，而不是代码主体变化。
    // 修改方式：只识别空格和 tab 组成的行首横向缩进，不触碰行内空白或其它字符。
    // 修改目的：把容错边界限制在缩进层面，避免字符串内容、参数间空格等语义内容被误忽略。
    return line.match(/^[ \t]*/)?.[0] ?? '';
}

function stripLeadingHorizontalWhitespace(line: string): string {
    return line.slice(getLeadingHorizontalWhitespace(line).length);
}

function hasNonWhitespaceBody(lines: StructuredLineSpan[]): boolean {
    // 修改原因：只包含空行或缩进的 oldContent 在缩进容错下信息量为零，自动应用风险过高。
    // 修改方式：要求至少一行在去掉行首缩进后仍有非空主体。
    // 修改目的：阻止纯空白块通过 fallback 命中任意空白区域。
    return lines.some(line => stripLeadingHorizontalWhitespace(line.content).trim().length > 0);
}

/** 缩进 fallback 的 oldContent 行数上限：超大块（模型提交整文件）匹配成本高且误落风险大，直接禁用 */
const MAX_FALLBACK_SEARCH_LINES = 1000;

function findIndentFallbackCandidates(
    normalizedContent: string,
    normalizedOldContent: string
): { candidates: StructuredMatchCandidate[]; disabledReason?: string } {
    // 修改原因：精确匹配失败时需要兜底 AI 写错缩进的 oldContent，但不能引入通用 fuzzy 匹配的误落点风险。
    // 修改方式：按连续完整行窗口扫描；比较时只忽略每行行首空格/tab，行内空白、空行数量和换行结尾保持严格。
    // 修改目的：让缩进错误可以自动恢复，同时保留候选唯一性/startLine 这条安全边界。
    const contentLines = tokenizeNormalizedLinesWithSpans(normalizedContent);
    const searchLines = tokenizeNormalizedLinesWithSpans(normalizedOldContent);

    if (searchLines.length === 0) {
        return { candidates: [], disabledReason: 'oldContent has no logical lines.' };
    }

    if (searchLines.length > MAX_FALLBACK_SEARCH_LINES) {
        return {
            candidates: [],
            disabledReason: `oldContent has too many lines (${searchLines.length}, maximum ${MAX_FALLBACK_SEARCH_LINES}) for indentation fallback; provide a smaller context block.`
        };
    }

    if (!hasNonWhitespaceBody(searchLines)) {
        return {
            candidates: [],
            disabledReason: 'oldContent contains only blank or indentation-only lines; provide non-whitespace context.'
        };
    }

    if (searchLines.length > contentLines.length) {
        return { candidates: [] };
    }

    // 首行预筛：按「去行首缩进后的首行」哈希索引候选起点，只在这些位置上做完整行窗口验证，
    // 避免大文件上每行都进入内层循环（最坏 O(N·M) 退化为仅首行命中位置做 O(M) 验证）。
    // 索引按行号升序构建，候选顺序与旧实现一致。
    const firstSearchBody = stripLeadingHorizontalWhitespace(searchLines[0].content);
    const maxStartLineIndex = contentLines.length - searchLines.length;
    const startLineIndexesByFirstBody = new Map<string, number[]>();
    for (let startLineIndex = 0; startLineIndex <= maxStartLineIndex; startLineIndex++) {
        const body = stripLeadingHorizontalWhitespace(contentLines[startLineIndex].content);
        let indexes = startLineIndexesByFirstBody.get(body);
        if (!indexes) {
            indexes = [];
            startLineIndexesByFirstBody.set(body, indexes);
        }
        indexes.push(startLineIndex);
    }

    const candidates: StructuredMatchCandidate[] = [];
    const candidateStarts = startLineIndexesByFirstBody.get(firstSearchBody) ?? [];

    for (const startLineIndex of candidateStarts) {
        let ok = true;

        for (let offset = 0; offset < searchLines.length; offset++) {
            const searchLine = searchLines[offset];
            const contentLine = contentLines[startLineIndex + offset];

            if (stripLeadingHorizontalWhitespace(searchLine.content) !== stripLeadingHorizontalWhitespace(contentLine.content)) {
                ok = false;
                break;
            }

            if (searchLine.newline === '\n' && contentLine.newline !== '\n') {
                ok = false;
                break;
            }
        }

        if (!ok) continue;

        const firstLine = contentLines[startLineIndex];
        const lastSearchLine = searchLines[searchLines.length - 1];
        const lastContentLine = contentLines[startLineIndex + searchLines.length - 1];
        const endIndex = lastSearchLine.newline === '\n'
            ? lastContentLine.endIndex
            : lastContentLine.startIndex + lastContentLine.content.length;

        candidates.push({
            startIndex: firstLine.startIndex,
            endIndex,
            startLine: firstLine.lineNumber,
            matchedOldContent: normalizedContent.slice(firstLine.startIndex, endIndex)
        });
    }

    return { candidates };
}

function buildNewToOldLineAlignment(oldLines: StructuredLineSpan[], newLines: StructuredLineSpan[]): Array<number | undefined> {
    // 修改原因：fallback 命中后，newContent 的缩进也可能跟 oldContent 一样是模型误写的，不能按同一行号硬套真实缩进。
    // 修改方式：先用去行首缩进后的主体做 LCS 找稳定锚点，再在锚点之间按顺序配对 changed chunk。
    // 修改目的：插入、删除、替换混合出现时，缩进重映射仍能依赖相对可靠的行级对应关系。
    const oldBodies = oldLines.map(line => stripLeadingHorizontalWhitespace(line.content));
    const newBodies = newLines.map(line => stripLeadingHorizontalWhitespace(line.content));

    // 行数护栏：LCS DP 为 O(n·m) 全矩阵，超大输入（模型提交超大 oldContent/newContent）会分配海量内存并阻塞主线程。
    // 超过护栏（min(n,m) > 200 或 n*m > 40_000）跳过 DP，退化为锚点配对：
    // 用「去行首缩进后的行内容」首次出现索引找公共锚点行，锚点之间按顺序配对；
    // 找不到任何锚点时退化为顺序配对（旧实现行为）。
    // 正常小 hunk 路径完全不受影响。
    const n = oldBodies.length;
    const m = newBodies.length;
    if (Math.min(n, m) > 200 || n * m > 40_000) {
        const firstOldIndexByBody = new Map<string, number>();
        for (let i = 0; i < n; i++) {
            if (!firstOldIndexByBody.has(oldBodies[i])) {
                firstOldIndexByBody.set(oldBodies[i], i);
            }
        }
        const anchors: Array<{ oldIndex: number; newIndex: number }> = [];
        let lastOldIndex = -1;
        for (let j = 0; j < m; j++) {
            const oldIndex = firstOldIndexByBody.get(newBodies[j]);
            if (oldIndex !== undefined && oldIndex > lastOldIndex) {
                anchors.push({ oldIndex, newIndex: j });
                lastOldIndex = oldIndex;
            }
        }

        const alignment: Array<number | undefined> = Array(m).fill(undefined);
        let previousOld = -1;
        let previousNew = -1;
        for (const anchor of [...anchors, { oldIndex: n, newIndex: m }]) {
            const oldGapStart = previousOld + 1;
            const newGapStart = previousNew + 1;
            const oldGapLength = anchor.oldIndex - oldGapStart;
            const newGapLength = anchor.newIndex - newGapStart;
            const pairedGapLength = Math.min(oldGapLength, newGapLength);
            for (let i = 0; i < pairedGapLength; i++) {
                alignment[newGapStart + i] = oldGapStart + i;
            }
            if (anchor.newIndex < m) {
                alignment[anchor.newIndex] = anchor.oldIndex;
            }
            previousOld = anchor.oldIndex;
            previousNew = anchor.newIndex;
        }
        return alignment;
    }

    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

    for (let i = oldBodies.length - 1; i >= 0; i--) {
        for (let j = newBodies.length - 1; j >= 0; j--) {
            dp[i][j] = oldBodies[i] === newBodies[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const anchors: Array<{ oldIndex: number; newIndex: number }> = [];
    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < oldBodies.length && newIndex < newBodies.length) {
        if (oldBodies[oldIndex] === newBodies[newIndex]) {
            anchors.push({ oldIndex, newIndex });
            oldIndex++;
            newIndex++;
        } else if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
            oldIndex++;
        } else {
            newIndex++;
        }
    }

    const alignment: Array<number | undefined> = Array(newLines.length).fill(undefined);
    let previousOld = -1;
    let previousNew = -1;

    for (const anchor of [...anchors, { oldIndex: oldLines.length, newIndex: newLines.length }]) {
        const oldGapStart = previousOld + 1;
        const newGapStart = previousNew + 1;
        const oldGapLength = anchor.oldIndex - oldGapStart;
        const newGapLength = anchor.newIndex - newGapStart;
        const pairedGapLength = Math.min(oldGapLength, newGapLength);

        for (let i = 0; i < pairedGapLength; i++) {
            alignment[newGapStart + i] = oldGapStart + i;
        }

        if (anchor.newIndex < newLines.length) {
            alignment[anchor.newIndex] = anchor.oldIndex;
        }

        previousOld = anchor.oldIndex;
        previousNew = anchor.newIndex;
    }

    return alignment;
}

function findNearestAlignedOldIndex(alignment: Array<number | undefined>, newLineIndex: number): number | undefined {
    for (let i = newLineIndex - 1; i >= 0; i--) {
        if (alignment[i] !== undefined) return alignment[i];
    }

    for (let i = newLineIndex + 1; i < alignment.length; i++) {
        if (alignment[i] !== undefined) return alignment[i];
    }

    return undefined;
}

function findFirstNonEmptyLineIndex(lines: StructuredLineSpan[]): number | undefined {
    const index = lines.findIndex(line => stripLeadingHorizontalWhitespace(line.content).trim().length > 0);
    return index === -1 ? undefined : index;
}

function remapNewContentIndentation(
    normalizedOldContent: string,
    normalizedNewContent: string,
    matchedOldContent: string
): string {
    // 修改原因：缩进 fallback 找到真实块以后，如果直接写入模型的 newContent，会把同样错误的缩进带进目标文件。
    // 修改方式：基于 oldContent/newContent 的行级 alignment，把 newContent 每行的“相对模型缩进”平移到真实匹配块的缩进上。
    // 修改目的：既自动修正 AI 的整体缩进偏差，又保留新增嵌套行相对锚点更深一层的缩进。
    const oldLines = tokenizeNormalizedLinesWithSpans(normalizedOldContent);
    const newLines = tokenizeNormalizedLinesWithSpans(normalizedNewContent);
    const matchedLines = tokenizeNormalizedLinesWithSpans(matchedOldContent);

    if (newLines.length === 0) return '';

    const alignment = buildNewToOldLineAlignment(oldLines, newLines);
    const fallbackOldIndex = findFirstNonEmptyLineIndex(oldLines);

    return newLines.map((line, newLineIndex) => {
        if (stripLeadingHorizontalWhitespace(line.content).trim().length === 0) {
            return line.content + line.newline;
        }

        const oldLineIndex = alignment[newLineIndex]
            ?? findNearestAlignedOldIndex(alignment, newLineIndex)
            ?? fallbackOldIndex;

        if (oldLineIndex === undefined || !oldLines[oldLineIndex] || !matchedLines[oldLineIndex]) {
            return line.content + line.newline;
        }

        const modelAnchorIndent = getLeadingHorizontalWhitespace(oldLines[oldLineIndex].content);
        const realAnchorIndent = getLeadingHorizontalWhitespace(matchedLines[oldLineIndex].content);
        const modelLineIndent = getLeadingHorizontalWhitespace(line.content);

        if (!modelLineIndent.startsWith(modelAnchorIndent)) {
            // 修改原因：有些修改是有意 outdent，强行重映射会改变用户想要的结构。
            // 修改方式：当前行无法证明是相对锚点的缩进时保留原样，只修正可证明的整体缩进偏移。
            // 修改目的：让 fallback 保守地修正常见 AI 缩进偏差，而不是替用户猜测语义级缩进调整。
            return line.content + line.newline;
        }

        return realAnchorIndent + line.content.slice(modelAnchorIndent.length) + line.newline;
    }).join('');
}

/**
 * 检测 oldContent 中 AI 常见的 JSON 转义过度问题。
 * 当 oldContent 包含字面 "\\n" / "\\t" / "\\"" 序列时，很可能是模型在 JSON 参数中多转义了一层，
 * 导致实际匹配的是反斜杠字面量而非换行/制表/引号。
 */
function detectEscapeIssues(text: string): string | undefined {
    const issues: string[] = [];
    if (/\\n/.test(text)) {
        issues.push('literal "\\n" (backslash-n) found in oldContent — if the file uses real newlines, you may have double-escaped: remove the extra backslash before "n"');
    }
    if (/\\t/.test(text)) {
        issues.push('literal "\\t" (backslash-t) found in oldContent — if the file uses real tab characters, you may have double-escaped');
    }
    if (/\\"/.test(text)) {
        issues.push('literal "\\"" found in oldContent — in JSON string values double quotes should be just \", but the file content likely has plain " characters');
    }
    if (issues.length === 0) return undefined;
    return `Escape hint: ${issues.join('; ')}.`;
}

/** 诊断用：截断并转义单行内容（JSON 字符串风格，避免控制字符破坏错误消息） */
function truncateForDiagnosis(text: string, maxLength = 80): string {
    const escaped = JSON.stringify(text);
    if (escaped.length <= maxLength) return escaped;
    return `${escaped.slice(0, maxLength)}...`;
}

/** 返回两个字符串第一个不同字符的索引（-1 表示完全一致） */
function firstDiffCharIndex(a: string, b: string): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return i;
    }
    return a.length === b.length ? -1 : len;
}

/**
 * 为「oldContent 无法匹配」生成定位诊断：
 * 在文件中定位与 oldContent 最接近的行块，逐行列出差异（含首差异字符列），
 * 帮助调用方快速修正参数而不是盲猜。带规模护栏，避免大文件 O(m×n) 扫描卡死。
 */
function buildClosestBlockDiagnosis(currentContent: string, oldContent: string): string | undefined {
    // 1. 规模护栏：超大文件或超长块跳过诊断，避免引入 O(m×n) 卡死
    const fileLines = currentContent.split('\n');
    const blockLines = oldContent.split('\n');
    if (fileLines.length > 20000 || blockLines.length > 200) return undefined;

    // 2. 依次尝试块内足够长的非空行作为锚点，取第一个能在文件中找到匹配的。
    //    锚点行本身有差异（如全角/半角、大小写）时继续尝试后续行，避免首行不匹配就整体失效。
    const anchorLines: Array<{ index: number; text: string }> = [];
    for (let i = 0; i < blockLines.length; i++) {
        const trimmed = blockLines[i].trim();
        if (trimmed.length >= 4) anchorLines.push({ index: i, text: trimmed });
    }
    if (anchorLines.length === 0) return undefined;

    const candidateStarts: number[] = [];
    for (const anchorLine of anchorLines) {
        for (let i = 0; i < fileLines.length; i++) {
            if (fileLines[i].trim() === anchorLine.text) {
                // 候选起点 = 锚点在文件中的行号 - 锚点在块中的行号（对齐块首）
                const start = i - anchorLine.index;
                if (start >= 0) candidateStarts.push(start);
            }
        }
        if (candidateStarts.length > 0) break;
    }
    if (candidateStarts.length === 0) return undefined;

    // 3. 对每个候选起点统计逐行匹配数（trim 比较），取最佳
    let bestStart = -1;
    let bestMatched = -1;
    for (const start of candidateStarts) {
        let matched = 0;
        const limit = Math.min(blockLines.length, fileLines.length - start);
        for (let k = 0; k < limit; k++) {
            if (fileLines[start + k].trim() === blockLines[k].trim()) matched++;
        }
        if (matched > bestMatched) {
            bestMatched = matched;
            bestStart = start;
        }
    }
    if (bestStart === -1 || bestMatched === blockLines.length) return undefined;

    // 4. 逐行列出差异（最多 5 行）
    const details: string[] = [];
    const compareLen = Math.max(blockLines.length, Math.min(fileLines.length - bestStart, blockLines.length));
    for (let k = 0; k < compareLen && details.length < 5; k++) {
        const expected = blockLines[k];
        const actual = fileLines[bestStart + k];
        if (actual === undefined) {
            details.push(`  line ${bestStart + k + 1}: expected ${truncateForDiagnosis(expected)} but the block extends beyond the end of the file`);
        } else if (expected === undefined) {
            details.push(`  line ${bestStart + k + 1}: extra line in file: ${truncateForDiagnosis(actual)}`);
        } else if (expected.trim() !== actual.trim()) {
            const diffAt = firstDiffCharIndex(expected, actual);
            const diffSuffix = diffAt >= 0
                ? ` (first difference at character ${diffAt + 1}: ${truncateForDiagnosis(expected[diffAt] ?? '')} vs ${truncateForDiagnosis(actual[diffAt] ?? '')})`
                : ' (line-length or leading-whitespace difference)';
            details.push(`  line ${bestStart + k + 1}: expected ${truncateForDiagnosis(expected)} but found ${truncateForDiagnosis(actual)}${diffSuffix}`);
        }
    }

    return [
        `Closest block starts at line ${bestStart + 1} (${bestMatched} of ${blockLines.length} lines match):`,
        ...details,
        'Check for full-width vs half-width characters, whitespace differences, or content that was already modified.'
    ].join('\n');
}

function resolveStructuredHunkMatch(
    currentContent: string,
    oldContent: string,
    newContent: string,
    hunk: StructuredDiffHunk,
    lineDelta: number
): { success: true; match: ResolvedStructuredMatch } | {
    success: false;
    error: string;
    matchCount?: number;
    candidateLines?: number[];
} {
    // 修改原因：结构化 hunk 需要同时支持精确匹配和缩进容错 fallback，二者必须共享 startLine、lineDelta 和候选歧义规则。
    // 修改方式：先执行原有 exact indexOf 逻辑；仅当 exact 为 0 时，才进入完整行窗口的 indent fallback。
    // 修改目的：保持历史成功路径完全不变，同时把 AI 缩进误差收敛到一个可审计的匹配解析函数。
    const matches = findAllExactMatchIndexes(currentContent, oldContent);
    if (matches === null) {
        // 候选超限（> MAX_EXACT_MATCH_INDEXES）：oldContent 过于泛化，继续处理只会浪费内存，按现有歧义处理返回可读错误。
        return {
            success: false,
            error: `Too many exact matches found (more than ${MAX_EXACT_MATCH_INDEXES}). oldContent is too generic to locate safely; add more context to oldContent or provide startLine.`,
            matchCount: MAX_EXACT_MATCH_INDEXES
        };
    }

    if (matches.length === 1) {
        const startIndex = matches[0];
        return {
            success: true,
            match: {
                kind: 'exact',
                startIndex,
                endIndex: startIndex + oldContent.length,
                startLine: getLineNumberAtIndex(currentContent, startIndex),
                matchCount: 1,
                matchedOldContent: oldContent,
                replacementContent: newContent
            }
        };
    }

    if (matches.length > 1) {
        const candidateLines = getLineNumbersAtIndexes(currentContent, matches);
        if (hunk.startLine === undefined) {
            return {
                success: false,
                error: `Multiple matches found (${matches.length}). Provide startLine to choose which oldContent occurrence to replace. Candidate match lines: ${formatCandidateLinesForMessage(candidateLines)}.`,
                matchCount: matches.length,
                candidateLines
            };
        }

        const adjustedStartLine = hunk.startLine + lineDelta;
        const startOffset = getCharOffsetForLine(currentContent, adjustedStartLine);
        if (startOffset === undefined) {
            return {
                success: false,
                error: `startLine ${hunk.startLine} adjusted to ${adjustedStartLine}, which is outside the current file after previous hunks.`,
                matchCount: matches.length,
                candidateLines
            };
        }

        const startIndex = matches.find(index => index >= startOffset);
        if (startIndex === undefined) {
            return {
                success: false,
                error: `Multiple matches found (${matches.length}), but none occur at or after startLine ${hunk.startLine} after line-offset adjustment. Candidate match lines: ${formatCandidateLinesForMessage(candidateLines)}.`,
                matchCount: matches.length,
                candidateLines
            };
        }

        return {
            success: true,
            match: {
                kind: 'exact',
                startIndex,
                endIndex: startIndex + oldContent.length,
                startLine: getLineNumberAtIndex(currentContent, startIndex),
                matchCount: matches.length,
                candidateLines,
                matchedOldContent: oldContent,
                replacementContent: newContent
            }
        };
    }

    const escapeDiagnosis = detectEscapeIssues(oldContent);
    const blockDiagnosis = buildClosestBlockDiagnosis(currentContent, oldContent);

    const fallback = findIndentFallbackCandidates(currentContent, oldContent);
    if (fallback.disabledReason) {
        return {
            success: false,
            error: `No exact match found for oldContent. Indentation fallback was not attempted: ${fallback.disabledReason}.${blockDiagnosis ? '\n' + blockDiagnosis : ''}${escapeDiagnosis ? ' ' + escapeDiagnosis : ''}`,
            matchCount: 0
        };
    }

    if (fallback.candidates.length === 0) {
        return {
            success: false,
            error: `No exact match found for oldContent. Also tried indentation-tolerant line matching (leading spaces/tabs only), but no candidate block matched.${blockDiagnosis ? '\n' + blockDiagnosis : ''}${escapeDiagnosis ? ' ' + escapeDiagnosis : ''}`,
            matchCount: 0
        };
    }

    const candidateLines = fallback.candidates.map(candidate => candidate.startLine);
    let candidate: StructuredMatchCandidate | undefined;

    if (fallback.candidates.length === 1) {
        candidate = fallback.candidates[0];
    } else {
        if (hunk.startLine === undefined) {
            return {
                success: false,
                error: `No exact match found for oldContent. Indentation fallback found multiple candidates (${fallback.candidates.length}). Provide startLine to choose which occurrence to replace. Candidate match lines: ${formatCandidateLinesForMessage(candidateLines)}.`,
                matchCount: fallback.candidates.length,
                candidateLines
            };
        }

        const adjustedStartLine = hunk.startLine + lineDelta;
        const startOffset = getCharOffsetForLine(currentContent, adjustedStartLine);
        if (startOffset === undefined) {
            return {
                success: false,
                error: `No exact match found for oldContent. Indentation fallback found candidates, but startLine ${hunk.startLine} adjusted to ${adjustedStartLine}, which is outside the current file after previous hunks.`,
                matchCount: fallback.candidates.length,
                candidateLines
            };
        }

        candidate = fallback.candidates.find(item => item.startIndex >= startOffset);
        if (!candidate) {
            return {
                success: false,
                error: `No exact match found for oldContent. Indentation fallback found multiple candidates (${fallback.candidates.length}), but none occur at or after startLine ${hunk.startLine} after line-offset adjustment. Candidate match lines: ${formatCandidateLinesForMessage(candidateLines)}.`,
                matchCount: fallback.candidates.length,
                candidateLines
            };
        }
    }

    return {
        success: true,
        match: {
            kind: 'indent_fallback',
            startIndex: candidate.startIndex,
            endIndex: candidate.endIndex,
            startLine: candidate.startLine,
            matchCount: fallback.candidates.length,
            candidateLines: fallback.candidates.length > 1 ? candidateLines : undefined,
            matchedOldContent: candidate.matchedOldContent,
            replacementContent: remapNewContentIndentation(oldContent, newContent, candidate.matchedOldContent)
        }
    };
}

export { resolveStructuredHunkMatch, buildClosestBlockDiagnosis };
