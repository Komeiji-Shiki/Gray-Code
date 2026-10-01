/**
 * 工具响应序列化 — 避免 JSON-in-JSON 二次编码
 *
 * 根因：anthropic.ts / openai.ts 两处 formatter 用 JSON.stringify(resp.response)
 * 把 ToolResult 整体拍平成字符串。请求体本身还会被 HTTP 层再序列化一次，
 * 造成 content 字段里的反斜杠经历两轮转义，LLM 看到的就是 \\\\ 而不是 \\。
 *
 * 修复方向：文本内容以原始字符串形式进入消息体。元数据用纯文本前缀，
 * 不嵌套在 JSON 对象里。
 */

/** 提取对象中可能是大段文本内容的关键字段名 */
const TEXT_CONTENT_KEYS = new Set(['content', 'originalContent', 'newContent', 'search', 'replace', 'oldContent', 'lineContent', 'context', 'output']);

/**
 * 递归检测对象中是否有「可能包含原始文本」的字段。
 * 用于判断要不要跳过 JSON.stringify，改为纯文本格式化。
 */
function hasTextContentFields(obj: Record<string, unknown>): boolean {
    for (const key of Object.keys(obj)) {
        if (TEXT_CONTENT_KEYS.has(key) && typeof obj[key] === 'string' && obj[key].length > 0) {
            return true;
        }
        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
            if (hasTextContentFields(obj[key] as Record<string, unknown>)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 格式化单个结果条目（data.results 数组中的元素）。
 * 把文本字段原样输出，剩余字段用 JSON 摘要。
 */
function formatResultItem(result: unknown): string {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return JSON.stringify(result) ?? String(result);
    const textParts: Array<{ key: string; value: string }> = [];
    const metaFields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(result)) {
        if (TEXT_CONTENT_KEYS.has(key) && typeof value === 'string' && value.length > 0) {
            textParts.push({ key, value });
        } else if (value !== undefined) {
            metaFields[key] = value;
        }
    }

    // 构建摘要行：path + 行数信息优先
    const summaryParts: string[] = [];
    if (metaFields.path) {
        summaryParts.push(String(metaFields.path));
        delete metaFields.path;
    }
    if (metaFields.lineCount !== undefined) {
        summaryParts.push(`${metaFields.lineCount} lines`);
        delete metaFields.lineCount;
    }
    if (metaFields.startLine !== undefined && metaFields.endLine !== undefined) {
        summaryParts.push(`L${metaFields.startLine}-${metaFields.endLine}`);
        delete metaFields.startLine;
        delete metaFields.endLine;
    }
    if (metaFields.totalLines !== undefined) {
        summaryParts.push(`of ${metaFields.totalLines}`);
        delete metaFields.totalLines;
    }
    if (metaFields.success !== undefined) {
        if (metaFields.success === false) {
            summaryParts.push('FAILED');
        }
        delete metaFields.success;
    }

    // 剩余元数据 → JSON 片段
    const remainingKeys = Object.keys(metaFields);
    let header = summaryParts.length > 0 ? summaryParts.join(', ') : '';
    if (remainingKeys.length > 0) {
        const metaStr = JSON.stringify(metaFields);
        header = header ? `${header} | ${metaStr}` : metaStr;
    }

    const lines: string[] = [];
    if (header) {
        lines.push(`[${header}]`);
    }
    for (const text of textParts) {
        // 修改前后、搜索和替换同时返回时，字段名是判断操作含义的必要信息。
        if (textParts.length > 1) lines.push(`${text.key}:`);
        lines.push(text.value);
    }
    return lines.join('\n');
}

/**
 * 提取批量统计字段（successCount / failCount / totalCount）为单行摘要。
 */
function formatBatchSummary(data: Record<string, unknown>): string {
    const counts: string[] = [];
    for (const key of ['successCount', 'failCount', 'totalCount']) {
        if (typeof data[key] === 'number') {
            counts.push(`${key}=${data[key]}`);
        }
    }
    return counts.length > 0 ? `[${counts.join(', ')}]` : '';
}

/**
 * 格式化错误场景下的部分成功结果块：
 * "Partial results:" + 批量统计 + 逐项格式化后的结果。
 */
function formatPartialResultsBlock(data: Record<string, unknown>): string {
    const results = (data.results as Array<Record<string, unknown>>) || [];
    const summary = formatBatchSummary(data);
    const header = summary ? `Partial results:\n${summary}` : 'Partial results:';
    const formatted = results.map(r => formatResultItem(r as Record<string, unknown>));
    return `${header}\n\n${formatted.join('\n\n').trimEnd()}`;
}

function remainingFields(value: Record<string, unknown>, consumed: string[]): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => !consumed.includes(key) && item !== undefined));
}

function metadataLine(value: Record<string, unknown>): string {
    return Object.keys(value).length ? `[${JSON.stringify(value)}]` : '';
}

const BATCH_COUNTS = ['successCount', 'failCount', 'totalCount'];

/**
 * find_files 的 files 数组只为旧界面保留，路径已全部在 fileDetails 里；
 * 两者路径集合完全一致时模型只看 fileDetails，不一致时保留原样，避免丢路径。
 */
function withoutDuplicateFileList(result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const item = result as Record<string, unknown>;
    if (!Array.isArray(item.files) || !Array.isArray(item.fileDetails) || item.files.length !== item.fileDetails.length) return result;
    const detailPaths = new Set(item.fileDetails.map(detail => (detail as { path?: unknown } | null)?.path));
    if (detailPaths.size !== item.files.length || !item.files.every(file => detailPaths.has(file))) return result;
    const { files: _files, ...rest } = item;
    return rest;
}

/** 搜索策略和界面操作保留在原回执中，模型只接收实际需要的覆盖规则与续查游标。 */
function compactSearchResponse(toolName: string, response: Record<string, unknown>): Record<string, unknown> {
    if (!['search_in_files', 'search_files', 'find_files'].includes(toolName)) return response;
    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return response;
    let compact = { ...data } as Record<string, unknown>;
    if (compact.excludeSource !== 'argument') delete compact.effectiveExclude;

    if (toolName === 'search_files' && (compact.nextOffset !== undefined || compact.nextScanOffset !== undefined)) {
        delete compact.nextPage;
        delete compact.nextActions;
        delete compact.continuationHint;
    }
    if (toolName === 'find_files') {
        compact = withoutDuplicateFileList(compact) as Record<string, unknown>;
        if (Array.isArray(compact.results)) compact.results = compact.results.map(withoutDuplicateFileList);
    }
    return { ...response, data: compact };
}

interface SearchLineResult {
    file: string;
    line: number;
    column: number;
    columns?: number[];
    columnsTruncated?: boolean;
    context: string;
}

function isSearchLineResult(value: unknown): value is SearchLineResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return typeof item.file === 'string' && Number.isSafeInteger(item.line) && Number.isSafeInteger(item.column)
        && typeof item.context === 'string';
}

/**
 * search_in_files 搜索模式按文件分组输出（类似 `rg -n --column -C`）：
 * 路径只写一次；命中行 `行:列: 内容`，上下文 `行- 内容`，不相邻片段用 `--` 分隔，
 * 相邻命中的上下文窗口合并。任一条上下文无法解析时返回 undefined，由调用方沿用通用格式。
 */
function formatSearchLineResults(results: unknown[]): string | undefined {
    if (!results.length || !results.every(isSearchLineResult)) return undefined;
    const files = new Map<string, Map<number, { text: string; columns?: string }>>();
    for (const result of results) {
        let lines = files.get(result.file);
        if (!lines) files.set(result.file, lines = new Map());
        const contextLines = result.context.split('\n');
        let sawHitLine = false;
        for (const raw of contextLines) {
            const parsed = /^(\d+): ([\s\S]*)$/.exec(raw);
            if (!parsed) return undefined;
            const lineNumber = Number(parsed[1]);
            if (lineNumber === result.line) {
                sawHitLine = true;
                const columns = (result.columns?.length ? result.columns : [result.column]).join(',') + (result.columnsTruncated ? ',…' : '');
                lines.set(lineNumber, { text: parsed[2], columns });
            } else if (!lines.has(lineNumber)) {
                lines.set(lineNumber, { text: parsed[2] });
            }
        }
        if (!sawHitLine) return undefined;
    }
    const blocks: string[] = [];
    for (const [file, lines] of files) {
        const body: string[] = [file];
        let previous: number | undefined;
        for (const lineNumber of [...lines.keys()].sort((a, b) => a - b)) {
            if (previous !== undefined && lineNumber > previous + 1) body.push('--');
            const line = lines.get(lineNumber)!;
            body.push(line.columns ? `${lineNumber}:${line.columns}: ${line.text}` : `${lineNumber}- ${line.text}`);
            previous = lineNumber;
        }
        blocks.push(body.join('\n'));
    }
    return blocks.join('\n\n');
}

/**
 * 将 ToolResult.response 序列化为适合发给 LLM 的纯文本字符串。
 *
 * - read_file / search_in_files 等含大段原始文本的工具 → 文本原样透出
 * - 纯结构化数据（如 list_files 的数组）→ JSON.stringify
 * - 错误对象 → 提取 error 字段输出
 */
export function serializeToolResultForLLM(
    toolName: string,
    response: Record<string, unknown> | undefined
): string {
    if (response === undefined || response === null) {
        return '';
    }

    // 已经是纯字符串？直接返回（意外情况，兜底）
    if (typeof response === 'string') {
        return response;
    }

    if (typeof response !== 'object') {
        return String(response);
    }

    response = compactSearchResponse(toolName, response);
    const data = response.data as Record<string, unknown> | undefined;
    // success=true 已由正常返回表达，其余顶层状态不能在展开 data 时丢失。
    const metadata = remainingFields(response, ['data', 'error', ...(response.success === true ? ['success'] : [])]);

    // 错误分支：错误信息始终保留在最前，同时继续序列化部分成功结果（F-02）。
    // 修改原因：批量工具部分失败时，以前这里直接返回顶层错误，
    // 成功结果（data.results / data.message）全部丢失，模型会重复执行已完成的操作。
    if (response.error && typeof response.error === 'string') {
        const parts: string[] = [`Error: ${response.error}`];
        if (response.cancelled) {
            parts.push('[cancelled by user]');
        }
        const errorMetadata = remainingFields(metadata, ['success', ...(response.cancelled ? ['cancelled'] : [])]);
        const errorHeader = metadataLine(errorMetadata);
        if (errorHeader) parts.push(errorHeader);

        if (data && typeof data === 'object' && !Array.isArray(data)) {
            const consumed: string[] = [];
            // 命令执行输出（execute_command 的 stderr/stdout），保持原有格式
            if (typeof data.output === 'string' && data.output.trim()) {
                parts.push('', 'Output:', data.output.trimEnd());
                consumed.push('output');
            }

            // 批量结果数组：只要存在文本项就逐项格式化，避免 JSON 二次转义
            if (Array.isArray(data.results) && data.results.length > 0) {
                const results = data.results as Array<Record<string, unknown>>;
                const hasAnyText = results.some(r =>
                    typeof r === 'object' && r !== null && hasTextContentFields(r as Record<string, unknown>)
                );
                if (hasAnyText) {
                    parts.push('', formatPartialResultsBlock(data));
                } else {
                    parts.push('', 'Partial results:', formatBatchSummary(data), JSON.stringify(results));
                }
                consumed.push('results', ...BATCH_COUNTS);
            }

            // 可读信息（删除/创建目录/补丁工具返回的 data.message）
            if (typeof data.message === 'string' && data.message.trim()) {
                parts.push('', `Message: ${data.message.trim()}`);
                consumed.push('message');
            }

            // 子代理工具使用信息（subagents 失败/部分响应路径）：
            // 与成功路径（兜底 JSON.stringify 完整保留）对齐，主模型在失败时也能看到
            // 子代理是否调用过工具及调用了哪些（空数组 = 未调用任何工具）。
            if (typeof data.steps === 'number' || Array.isArray(data.toolsUsed)) {
                parts.push('', `Progress: steps=${JSON.stringify(data.steps ?? 0)}, toolsUsed=${JSON.stringify(data.toolsUsed ?? [])}`);
                consumed.push('steps', 'toolsUsed');
            }
            if (typeof data.partialResponse === 'string' && data.partialResponse.trim()) {
                parts.push('', 'Partial response:', data.partialResponse.trimEnd());
                consumed.push('partialResponse');
            }
            // 保留退出码、游标、截断原因等未专门展示的字段，让模型知道怎样继续。
            const remaining = metadataLine(remainingFields(data, consumed));
            if (remaining) parts.push('', remaining);
        } else if (data !== undefined) {
            parts.push('', JSON.stringify(data));
        }
        return parts.join('\n');
    }

    // data.results 数组：read_file / search_in_files / write_file 等批量结果
    if (data?.results && Array.isArray(data.results) && data.results.length > 0) {
        const results = data.results as Array<Record<string, unknown>>;

        if (toolName === 'search_in_files' && data.isReplaceMode !== true) {
            const grouped = formatSearchLineResults(results);
            if (grouped !== undefined) {
                return [metadataLine(metadata), metadataLine(remainingFields(data, ['results'])), grouped].filter(Boolean).join('\n\n');
            }
        }

        // 只要存在文本字段就逐项格式化（混合数组也逐项，避免 JSON 二次转义）
        if (results.some(r => typeof r === 'object' && r !== null && hasTextContentFields(r as Record<string, unknown>))) {
            const formatted = results.map(r => formatResultItem(r as Record<string, unknown>));
            // 去掉末尾多余空行
            return [metadataLine(metadata), metadataLine(remainingFields(data, ['results'])), ...formatted].filter(Boolean).join('\n\n').trimEnd();
        }

        // 纯结构化数组（如 list_files 的文件列表）→ JSON（包含 data 中全部字段，而非仅 results）
        return JSON.stringify(Object.keys(metadata).length ? { ...metadata, data } : data);
    }

    // 检测顶层的 data 是否直接含文本字段
    if (data && typeof data === 'object' && hasTextContentFields(data as Record<string, unknown>)) {
        return [metadataLine(metadata), formatResultItem(data)].filter(Boolean).join('\n');
    }

    // 兜底：纯结构化数据，用 JSON
    return JSON.stringify(response);
}
