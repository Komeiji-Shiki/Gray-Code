/**
 * apply_diff 的解析与定位层：hunk/补丁解析、行号计算与匹配扫描。
 *
 * 模块化重构第三批：从 backend/tools/file/apply_diff.ts 拆分而来，内容逐字保留。
 * - normalizeLineEndings / countLineBreaks 为对外导出（apply_diff.ts 壳 re-export）
 * - 其余函数供 diff/ 子目录内部使用
 */

import type { LegacyDiffBlock } from './types';
import type { UnifiedDiffHunk } from '../unifiedDiff';

/**
 * 规范化换行符为 LF
 */
export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

export function findAllExactMatchLineNumbers(
    normalizedContent: string,
    normalizedSearch: string,
    options?: {
        /** 最多返回多少个候选（避免返回体过大） */
        limit?: number;
    }
): number[] {
    if (!normalizedSearch) return [];

    const limit = options?.limit ?? 20;

    const result: number[] = [];
    let fromIndex = 0;
    let scanIndex = 0;
    let currentLine = 1;

    while (result.length < limit) {
        const pos = normalizedContent.indexOf(normalizedSearch, fromIndex);
        if (pos === -1) {
            break;
        }

        // 从 scanIndex 扫描到 pos，累计行号（scanIndex 单调递增，整体 O(n)）
        for (; scanIndex < pos; scanIndex++) {
            if (normalizedContent.charCodeAt(scanIndex) === 10) {
                currentLine++;
            }
        }

        result.push(currentLine);

        // 继续往后找（按非重叠匹配推进，避免候选行噪声）
        fromIndex = pos + Math.max(1, normalizedSearch.length);
    }

    return result;
}

/** 精确匹配候选索引上限：超过后 oldContent 过于泛化（如单字符 " "），继续收集只会浪费内存 */
export const MAX_EXACT_MATCH_INDEXES = 100_000;

export function findAllExactMatchIndexes(normalizedContent: string, normalizedSearch: string): number[] | null {
    // 为什么要单独返回索引：结构化 hunks 需要先判断 oldContent 是否唯一，唯一时必须忽略 startLine，避免 stale line number 让本来正确的内容替换失败。
    // 怎么改：使用重叠 indexOf 扫描（每次只推进 1 个字符），重叠出现的 oldContent 也必须计入候选。
    // 目的：旧实现按 match.length 非重叠推进，会把 "aaa" 中两个重叠的 "aa" 误判为唯一匹配并忽略 startLine；
    // 完整索引数组同时服务于唯一性计数与 startLine 定位，二者必须看到同一份真实匹配集。
    // 候选上限：1 字符级 oldContent（如 " "）在 5MB 文件上可产生数百万索引，全量收集会撑爆内存；
    // 超过 MAX_EXACT_MATCH_INDEXES 时返回 null，由调用方按“歧义过多”处理（与现有 multiple matches 错误口径一致）。
    if (!normalizedSearch) return [];

    const result: number[] = [];
    let fromIndex = 0;

    while (fromIndex <= normalizedContent.length) {
        const pos = normalizedContent.indexOf(normalizedSearch, fromIndex);
        if (pos === -1) break;

        result.push(pos);
        if (result.length >= MAX_EXACT_MATCH_INDEXES) {
            return null;
        }
        fromIndex = pos + 1;
    }

    return result;
}

/**
 * 非重叠匹配计数（带上限保护）。
 * 用途：applyDiffToContent 统计匹配次数时替代 split(search)，
 * split 会生成整个分割数组——大文件 + 短 search 时产生大量中间字符串；
 * indexOf 循环只扫描不分配，内存 O(1)，超短 search 也受 MAX_MATCH_COUNT 限制。
 */
export const MAX_MATCH_COUNT = 100_000;

export function countMatches(normalizedContent: string, normalizedSearch: string): number {
    if (!normalizedSearch) return 0;

    let count = 0;
    let fromIndex = 0;
    while (fromIndex <= normalizedContent.length) {
        const pos = normalizedContent.indexOf(normalizedSearch, fromIndex);
        if (pos === -1) break;
        count++;
        if (count >= MAX_MATCH_COUNT) return count;
        fromIndex = pos + Math.max(1, normalizedSearch.length);
    }
    return count;
}

export function getCharOffsetForLine(normalizedContent: string, line: number): number | undefined {
    // 为什么要从行号转换为字符偏移：重复 oldContent 时 startLine 只是定位提示，最终替换仍然是字符串精确替换。
    // 怎么改：按 LF 扫描到指定 1-based 行的开头，超出文件范围时返回 undefined。
    // 目的：兼容现有 legacy start_line“从某行开始搜索”的用户心智，同时避免在内容唯一时依赖行号。
    if (!Number.isFinite(line) || line < 1) return undefined;
    if (line === 1) return 0;

    let currentLine = 1;
    for (let i = 0; i < normalizedContent.length; i++) {
        if (normalizedContent.charCodeAt(i) === 10) {
            currentLine++;
            if (currentLine === line) {
                return i + 1;
            }
        }
    }

    return undefined;
}

export function getLineNumberAtIndex(normalizedContent: string, index: number): number {
    // 为什么要反算行号：前端 diff 面板和块级接受/拒绝需要知道每个 hunk 实际应用在哪一行。
    // 怎么改：只统计 index 之前的 LF 数量，得到 1-based 行号。
    // 目的：返回真实匹配位置，而不是盲信模型给出的 startLine。
    let line = 1;
    for (let i = 0; i < index; i++) {
        if (normalizedContent.charCodeAt(i) === 10) {
            line++;
        }
    }
    return line;
}

export function getLineNumbersAtIndexes(normalizedContent: string, indexes: number[]): number[] {
    // 为什么要单次扫描：结构化 hunk 的候选索引可能很多（重叠扫描进一步放大候选集），逐个 getLineNumberAtIndex 反算是 O(n·m)。
    // 怎么改：indexes 由 indexOf 扫描产生、天然升序，用单调游标一遍扫出全部行号，总复杂度 O(n + m)。
    // 目的：多匹配场景的行号计算不再产生平方级开销。
    const result: number[] = [];
    if (indexes.length === 0) return result;

    let line = 1;
    let cursor = 0;

    for (const index of indexes) {
        while (cursor < index) {
            if (normalizedContent.charCodeAt(cursor) === 10) {
                line++;
            }
            cursor++;
        }
        result.push(line);
    }

    return result;
}

/** 错误消息中最多展示的候选行号数量 */
export const CANDIDATE_LINES_MESSAGE_LIMIT = 20;

export function formatCandidateLinesForMessage(candidateLines: number[]): string {
    // 修改原因：重叠扫描后候选行号可能成百上千，全量拼进错误消息会撑爆返回给模型的工具响应。
    // 修改方式：仅在生成错误消息时截断展示（前 20 个 + 剩余数量）；matches 完整集合仍用于 startLine 定位。
    // 修改目的：限制错误消息体积，同时不破坏“从完整匹配集里按 startLine 选块”的定位语义。
    if (candidateLines.length <= CANDIDATE_LINES_MESSAGE_LIMIT) {
        return candidateLines.join(', ');
    }
    const shown = candidateLines.slice(0, CANDIDATE_LINES_MESSAGE_LIMIT).join(', ');
    return `${shown}, ... and ${candidateLines.length - CANDIDATE_LINES_MESSAGE_LIMIT} more`;
}

export function countTextLines(normalizedText: string): number {
    // 为什么要统一计算展示行数：diff block 的 endLine 需要描述替换内容在审阅面板里的可见范围。
    // 怎么改：按 normalize 后的 LF 分割计算展示意义上的行数，空字符串按 0 行处理；lineDelta 另用 countLineBreaks 计算真实行号偏移。
    // 目的：区分“展示范围”和“后续 startLine 偏移”，避免删除整行时把后续定位多减一行。
    if (!normalizedText) return 0;
    return normalizedText.split('\n').length;
}

export function countLineBreaks(normalizedText: string): number {
    // 修改原因：startLine 的 lineDelta 表示后续原始行号被前序 hunk 推动了多少行，真实变化取决于 LF 数量差，而不是展示行数差。
    // 修改方式：单独统计文本中的 LF 字符数量，避免删除 `first\n` 到空字符串时把行号多减一。
    // 修改目的：让前序插入、删除和替换都能正确调整后续重复 oldContent 的 startLine 定位。
    let count = 0;
    for (let i = 0; i < normalizedText.length; i++) {
        if (normalizedText.charCodeAt(i) === 10) count++;
    }
    return count;
}

/**
 * 对常见“AI 包裹/噪声行”做轻量去除，提升 loose patch 解析兼容性。
 *
 * 说明：
 * - 这是 unifiedDiff.ts 中 sanitize 的轻量副本，避免引入跨模块依赖。
 * - 仅移除明显不属于 patch 的外层壳；不做语义修复。
 */
function sanitizeLooseUnifiedPatch(patch: string): string {
    const normalized = normalizeLineEndings(patch);
    const lines = normalized.split('\n');
    const out: string[] = [];

    for (const line of lines) {
        // Markdown code fences（``` / ```diff / ```patch）
        if (line.startsWith('```')) {
            continue;
        }

        // 常见 ApplyPatch 风格包裹（*** Begin Patch / *** Update File: / *** End Patch 等）
        if (line.startsWith('***')) {
            if (
                line === '***' ||
                line.startsWith('*** Begin Patch') ||
                line.startsWith('*** End Patch') ||
                line.startsWith('*** Update File:') ||
                line.startsWith('*** Add File:') ||
                line.startsWith('*** Delete File:') ||
                line.startsWith('*** End of File')
            ) {
                continue;
            }
        }

        out.push(line);
    }

    return out.join('\n');
}

/**
 * 将“裸 @@”的 unified diff hunks 解析为 legacy search/replace diffs。
 *
 * 兜底语义：
 * - 每个 hunk 头以 `@@` 开始（不要求带行号）
 * - hunk 内：
 *   - search = context(' ') + del('-')
 *   - replace = context(' ') + add('+')
 */
export function parseLooseUnifiedPatchToLegacyDiffs(patch: string): LegacyDiffBlock[] {
    const normalized = sanitizeLooseUnifiedPatch(patch);
    const lines = normalized.split('\n');

    const diffs: LegacyDiffBlock[] = [];

    let inHunk = false;
    let searchLines: string[] = [];
    let replaceLines: string[] = [];

    const flush = () => {
        if (!inHunk) return;
        const search = searchLines.join('\n');
        const replace = replaceLines.join('\n');

        // 没有 search 无法定位（裸 @@ 没有行号），直接拒绝
        if (!search.trim()) {
            throw new Error('Loose @@ hunk has empty search block. Please provide context lines so it can be matched uniquely.');
        }

        diffs.push({ search, replace });
        searchLines = [];
        replaceLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 新 hunk
        if (line.startsWith('@@')) {
            flush();
            inHunk = true;
            continue;
        }

        if (!inHunk) {
            // 跳过 file header / diff header 等
            continue;
        }

        // 结束条件：遇到文件头/新的 diff 块
        if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
            // flush 当前 hunk，然后回到非 hunk 状态
            flush();
            inHunk = false;
            continue;
        }

        // 统一 diff 里常见的特殊行："\\ No newline at end of file"
        if (line.startsWith('\\')) {
            continue;
        }

        // 忽略纯空行（一般是 patch 末尾 split 出来的噪声）
        if (line === '') {
            continue;
        }

        const prefix = line[0];
        const content = line.length > 0 ? line.slice(1) : '';

        if (prefix === ' ') {
            searchLines.push(content);
            replaceLines.push(content);
        } else if (prefix === '-') {
            searchLines.push(content);
        } else if (prefix === '+') {
            replaceLines.push(content);
        } else {
            // 兜底：AI 可能会漏掉前缀，将其视为 context 行
            searchLines.push(line);
            replaceLines.push(line);
        }
    }

    flush();

    if (diffs.length === 0) {
        throw new Error('No hunks (@@) found in patch.');
    }

    return diffs;
}

export function convertUnifiedHunksToLegacyDiffs(hunks: UnifiedDiffHunk[]): LegacyDiffBlock[] {
    return hunks.map(h => {
        // 为 unified fallback 提供行号锚点，避免全局 search 在重复上下文中出现“多处匹配”歧义。
        // 这里使用 oldStart（1-based）作为起点提示：
        // - 与 hunk 在原文件中的定位语义一致
        // - 即使 search 很短（如仅 "}"），也能优先命中预期区域的首个匹配
        const startLineHint = Number.isFinite(h.oldStart) ? Math.max(1, h.oldStart) : undefined;

        const searchLines: string[] = [];
        const replaceLines: string[] = [];

        for (const l of h.lines) {
            if (l.type === 'context') {
                searchLines.push(l.content);
                replaceLines.push(l.content);
                continue;
            }

            if (l.type === 'del') {
                searchLines.push(l.content);
                continue;
            }

            // add
            replaceLines.push(l.content);
        }

        return {
            search: searchLines.join('\n'),
            replace: replaceLines.join('\n'),
            start_line: startLineHint
        };
    });
}
