import type { expandReplacementTemplate } from './regexReplacement';

export interface TextMatch {
    fragment: number;
    index: number;
    length: number;
    text: string;
    context?: string;
    /** fileSearch 同一行的全部命中起点（0-based）；只有一处命中时省略。 */
    indexes?: number[];
    /** 同一行命中数超过记录上限时为 true，indexes 只保留前面的部分。 */
    indexesTruncated?: boolean;
}
interface Pattern { source: string; flags: string; limit: number; previewChars: number }
export type TextSearchInput = Pattern & (
    { kind: 'scan'; fragments: string[]; offset?: number }
    | { kind: 'replace'; text: string; replacement: string; literal?: boolean }
    | { kind: 'fileSearch'; fragments: string[]; offset?: number; path: string; remainingChars?: number;
        contextBefore: number; contextAfter: number; linePreviewChars: number; startFragment?: number; endFragment?: number; lineOffset?: number }
);
export interface TextSearchResult {
    matches: TextMatch[];
    skipped: number;
    count: number;
    changed: number;
    truncated: boolean;
    text?: string;
    seen?: number;
    remainingChars?: number;
    budgetTruncated?: boolean;
}

/** 片段格式和成本一起计算，正文预算可在扫描过程中应用，而不必收集整文件的命中。 */
export function presentToolMatch(input: Extract<TextSearchInput, { kind: 'fileSearch' }>, lineIndex: number, index: number, length: number, text: string) {
    const match = text.length <= input.previewChars ? text : input.previewChars > 0 ? text.slice(0, input.previewChars - 1) + '…' : '';
    const lines = input.fragments, line = lines[lineIndex], context: string[] = [];
    const before = Math.max(0, lineIndex - input.contextBefore), after = Math.min(lines.length - 1, lineIndex + input.contextAfter);
    for (let current = before; current <= after; current++) {
        let preview: string;
        if (current !== lineIndex) {
            const limit = input.linePreviewChars, value = lines[current];
            preview = limit <= 0 ? '' : value.length <= limit ? value : value.slice(0, limit - 1) + '…';
        } else if (input.previewChars <= 0) preview = '';
        else if (line.length <= input.previewChars) preview = line;
        else {
            const half = Math.floor(input.previewChars / 2);
            let start = Math.max(0, index - half), end = start + input.previewChars;
            if (end < index + length) { end = Math.min(line.length, index + length + half); start = Math.max(0, end - input.previewChars); }
            if (end > line.length) { end = line.length; start = Math.max(0, end - input.previewChars); }
            preview = (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
        }
        context.push(String((input.lineOffset ?? 0) + current + 1) + ': ' + preview);
    }
    const body = context.join('\n');
    return { text: match, context: body, cost: input.path.length + match.length + body.length + 80 };
}

/**
 * 同步和线程共用的纯计算入口。线程会序列化此函数，运行时依赖只能通过参数传入；
 * 不在函数内引用模块变量或声明具名回调，以兼容扩展构建的 keepNames。
 */
export function evaluateTextSearch(input: TextSearchInput, expand: typeof expandReplacementTemplate, present: typeof presentToolMatch): TextSearchResult {
    const expression = new RegExp(input.source, input.flags);
    const result: TextSearchResult = { matches: [], skipped: 0, count: 0, changed: 0, truncated: false };
    if (input.kind === 'replace') {
        result.text = input.text.replace(expression, (...values: any[]) => {
            const named = typeof values[values.length - 1] === 'object' ? values.pop() as Record<string, string | undefined> : undefined;
            const fullText = values.pop() as string, index = values.pop() as number, match = values.shift() as string;
            const replacement = input.literal ? input.replacement : expand(input.replacement, match, index, fullText, values, named);
            result.count++;
            if (replacement !== match) result.changed++;
            if (result.matches.length < input.limit) result.matches.push({ fragment: 0, index, length: match.length, text: match.slice(0, input.previewChars + 1) });
            else result.truncated = true;
            return replacement;
        });
        return result;
    }
    const offset = input.offset ?? 0;
    if (input.kind === 'fileSearch') {
        // 结果、分页和预算都以“命中行”为单位：同一行多处命中只输出一次上下文，
        // 其余起点记在 indexes 里。上限常量必须内联，线程序列化时不能引用模块变量。
        const maxIndexesPerLine = 50;
        result.seen = 0; result.remainingChars = input.remainingChars;
        for (let fragment = input.startFragment ?? 0; fragment < (input.endFragment ?? input.fragments.length); fragment++) {
            if (result.matches.length >= input.limit) break;
            if (result.remainingChars !== undefined && result.remainingChars <= 0) { result.budgetTruncated = true; break; }
            let first: RegExpMatchArray | undefined;
            const indexes: number[] = [];
            let indexesTruncated = false;
            for (const match of input.fragments[fragment].matchAll(expression)) {
                if (!first) first = match;
                if (indexes.length < maxIndexesPerLine) indexes.push(match.index!);
                else { indexesTruncated = true; break; }
            }
            if (!first) continue;
            result.seen++;
            if (result.skipped < offset) { result.skipped++; continue; }
            const view = present(input, fragment, first.index!, first[0].length, first[0]);
            // 保留原来的逐行预算规则：过大的命中行被跳过，后续短行仍可提供结果。
            if (result.remainingChars !== undefined && result.remainingChars < view.cost) { result.budgetTruncated = true; continue; }
            result.matches.push({ fragment, index: first.index!, length: first[0].length, text: view.text, context: view.context,
                ...(indexes.length > 1 ? { indexes } : {}), ...(indexesTruncated ? { indexesTruncated } : {}) });
            result.count++;
            if (result.remainingChars !== undefined) result.remainingChars -= view.cost;
        }
        return result;
    }
    if (input.limit <= 0) return result;
    for (let fragment = 0; fragment < input.fragments.length; fragment++) {
        for (const match of input.fragments[fragment].matchAll(expression)) {
            if (result.skipped < offset) { result.skipped++; continue; }
            if (result.matches.length >= input.limit) return result;
            result.matches.push({ fragment, index: match.index, length: match[0].length, text: match[0].slice(0, input.previewChars + 1) });
            result.count++;
            if (result.matches.length >= input.limit) return result;
        }
    }
    return result;
}
