/** 两种语言服务宿主共用分页边界，避免相同 offset 在桌面与扩展得到不同语义。 */
export const MAX_REFERENCES_PER_PAGE = 500;
export const MAX_REFERENCE_CONTENT_CHARS = 60_000;

export interface ReferencePageOptions {
    maxResults: number;
    offset: number;
    countOnly: boolean;
}

export interface ReferencePosition {
    path: string;
    line: number;
    column: number;
}

export interface ReferenceContent {
    content: string;
    contentTruncated?: boolean;
}

export function parseReferencePageOptions(args: Record<string, unknown>): ReferencePageOptions {
    const maxResults = args.maxResults === undefined ? MAX_REFERENCES_PER_PAGE : args.maxResults;
    const offset = args.offset === undefined ? 0 : args.offset;
    const countOnly = args.countOnly === undefined ? false : args.countOnly;
    if (typeof maxResults !== 'number' || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_REFERENCES_PER_PAGE) {
        throw new Error(`maxResults must be an integer between 1 and ${MAX_REFERENCES_PER_PAGE}.`);
    }
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('offset must be a non-negative safe integer.');
    }
    if (typeof countOnly !== 'boolean') throw new Error('countOnly must be a boolean.');
    return { maxResults, offset, countOnly };
}

/** 只限制返回的代码片段，不改变行列；超长单行不应让一条引用绕过整页预算。 */
export function referenceSnippet(lineCount: number, lineAt: (index: number) => string, line: number, context: number): ReferenceContent {
    const start = Math.max(0, line - context);
    const end = Math.min(lineCount - 1, line + context);
    let content = '';
    for (let index = start; index <= end; index++) {
        const prefix = `${index > start ? '\n' : ''}${index === line ? '>' : ' '}${String(index + 1).padStart(4)} | `;
        const text = lineAt(index);
        const remaining = MAX_REFERENCE_CONTENT_CHARS - content.length;
        if (prefix.length + text.length > remaining) {
            // 不先拼接完整长行，限制临时分配；contentTruncated 提醒调用方用 read_file 定位。
            return { content: content + (prefix + text.slice(0, remaining)).slice(0, remaining), contentTruncated: true };
        }
        content += prefix + text;
    }
    return { content };
}

export async function createReferencePage<T extends ReferencePosition>(
    locations: readonly T[], options: ReferencePageOptions, readContent: (location: T) => Promise<ReferenceContent>
) {
    const totalCount = locations.length;
    const totalFileCount = new Set(locations.map(location => location.path)).size;
    const groups = new Map<string, Array<{ line: number; column: number } & ReferenceContent>>();
    let returnedCount = 0;
    let contentChars = 0;
    let outputBudgetReached = false;
    let contentTruncated = false;
    if (!options.countOnly) {
        // Provider 顺序可能随请求变化。先按路径/源位置稳定排序，再取连续片段，才能沿用搜索工具
        // 的 offset/nextOffset 契约；不去重、不缓存快照，文件或索引变化后必须从 offset=0 重查。
        const sorted = [...locations].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
            || left.line - right.line || left.column - right.column);
        const end = Math.min(totalCount, options.offset + options.maxResults);
        for (let index = options.offset; index < end; index++) {
            if (contentChars >= MAX_REFERENCE_CONTENT_CHARS) { outputBudgetReached = true; break; }
            const location = sorted[index];
            const snippet = await readContent(location);
            if (returnedCount && (snippet.contentTruncated || contentChars + snippet.content.length > MAX_REFERENCE_CONTENT_CHARS)) {
                // 整条留给下一页，不跳过中间引用；因此 nextOffset 总能准确续读。
                outputBudgetReached = true;
                break;
            }
            const clipped = snippet.contentTruncated || snippet.content.length > MAX_REFERENCE_CONTENT_CHARS;
            const content = snippet.content.slice(0, MAX_REFERENCE_CONTENT_CHARS);
            const values = groups.get(location.path) ?? [];
            values.push({ line: location.line, column: location.column, content, ...(clipped ? { contentTruncated: true } : {}) });
            groups.set(location.path, values);
            returnedCount++;
            contentChars += content.length;
            contentTruncated ||= clipped;
        }
    }
    const nextOffset = !options.countOnly && options.offset + returnedCount < totalCount ? options.offset + returnedCount : undefined;
    const references = [...groups].map(([path, values]) => ({ path, count: values.length, references: values }))
        .sort((left, right) => right.count - left.count);
    const truncationReasons = [
        ...(nextOffset !== undefined && !outputBudgetReached ? ['maxResults'] : []),
        ...(outputBudgetReached || contentTruncated ? ['outputBudget'] : [])
    ];
    return {
        totalCount, totalFileCount, fileCount: references.length, returnedCount, ...options, references,
        truncated: truncationReasons.length > 0,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(truncationReasons.length ? { truncationReasons, continuationHint: [
            ...(nextOffset !== undefined ? [`Continue with offset=${nextOffset} and unchanged query parameters; restart at offset=0 if files or the language index changed.`] : []),
            ...(contentTruncated ? ['A reference has contentTruncated=true; use read_file at its path/line to inspect the omitted code.'] : [])
        ].join(' ') } : {})
    };
}
