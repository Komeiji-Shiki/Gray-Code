import { MAX_REFERENCE_CONTENT_CHARS, parseReferencePageOptions } from './referencePage';

export function parseDefinitionPageOptions(args: Record<string, unknown>) {
    const { maxResults, offset } = parseReferencePageOptions({ maxResults: args.maxResults, offset: args.offset });
    return { maxResults, offset };
}

/** 先限制片段构造，避免把一个超长定义全部拼接后才截断。行号范围继续指向源码。 */
export function definitionSnippet(lineAt: (line: number) => string, start: number, end: number) {
    let content = '';
    let lineCount = 0;
    for (let line = start; line <= end; line++) {
        const prefix = `${line > start ? '\n' : ''}${String(line + 1).padStart(4)} | `;
        const text = lineAt(line);
        const remaining = MAX_REFERENCE_CONTENT_CHARS - content.length;
        if (prefix.length + text.length > remaining) {
            if (remaining) lineCount++;
            return { content: content + (prefix + text.slice(0, remaining)).slice(0, remaining), lineCount, contentTruncated: true };
        }
        content += prefix + text; lineCount++;
    }
    return { content, lineCount };
}

export async function createDefinitionPage<T, R extends { content: string; contentTruncated?: boolean }>(
    locations: readonly T[], options: ReturnType<typeof parseDefinitionPageOptions>, readContent: (location: T) => Promise<R>
) {
    const definitions: R[] = [];
    let contentChars = 0;
    let outputBudgetReached = false;
    let contentTruncated = false;
    // 定义提供器可能按相关性排列，保留原顺序；分页只打开本页需要的文档。
    const end = Math.min(locations.length, options.offset + options.maxResults);
    for (let index = options.offset; index < end; index++) {
        if (contentChars >= MAX_REFERENCE_CONTENT_CHARS) { outputBudgetReached = true; break; }
        const definition = await readContent(locations[index]);
        if (definitions.length && (definition.contentTruncated || contentChars + definition.content.length > MAX_REFERENCE_CONTENT_CHARS)) {
            // 完整定义留给下一页；不能输出一半后把续查位置移到再下一个定义。
            outputBudgetReached = true; break;
        }
        const clipped = definition.contentTruncated || definition.content.length > MAX_REFERENCE_CONTENT_CHARS;
        const content = definition.content.slice(0, MAX_REFERENCE_CONTENT_CHARS);
        definitions.push({ ...definition, content, ...(clipped ? { contentTruncated: true } : {}) });
        contentChars += content.length; contentTruncated ||= clipped;
    }
    const nextOffset = options.offset + definitions.length < locations.length ? options.offset + definitions.length : undefined;
    const truncationReasons = [
        ...(nextOffset !== undefined && !outputBudgetReached ? ['maxResults'] : []),
        ...(outputBudgetReached || contentTruncated ? ['outputBudget'] : [])
    ];
    return { ...options, definitionCount: definitions.length, totalCount: locations.length, definitions,
        truncated: truncationReasons.length > 0,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(truncationReasons.length ? { truncationReasons, continuationHint: [
            ...(nextOffset !== undefined ? [`Continue with offset=${nextOffset} and unchanged query parameters; restart at offset=0 if files or the language index changed.`] : []),
            ...(contentTruncated ? ['A definition has contentTruncated=true; use read_file at its path/line/endLine to inspect the omitted code.'] : [])
        ].join(' ') } : {}) };
}
