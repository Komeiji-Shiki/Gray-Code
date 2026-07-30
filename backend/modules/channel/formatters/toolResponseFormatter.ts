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
function formatResultItem(result: Record<string, unknown>): string {
    const textParts: string[] = [];
    const metaFields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(result)) {
        if (TEXT_CONTENT_KEYS.has(key) && typeof value === 'string' && value.length > 0) {
            textParts.push(value);
        } else if (value !== undefined && value !== null) {
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
        lines.push(text);
    }
    return lines.join('\n');
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

    const data = response.data as Record<string, unknown> | undefined;

    // 错误分支：优先提取错误信息，避免 JSON.stringify 包裹
    if (response.error && typeof response.error === 'string') {
        const parts: string[] = [`Error: ${response.error}`];
        if (response.cancelled) {
            parts.push('[cancelled by user]');
        }
        // 附上 data 中的输出文本（如 execute_command 的 stderr/stdout），
        // 避免 AI 只看到 "Command exited with code 1" 却不知道具体原因
        if (data?.output && typeof data.output === 'string' && data.output.trim()) {
            parts.push('');
            parts.push('Output:');
            parts.push(data.output.trimEnd());
        }
        return parts.join('\n');
    }

    // data.results 数组：read_file / search_in_files / write_file 等批量结果
    if (data?.results && Array.isArray(data.results) && data.results.length > 0) {
        const results = data.results as Array<Record<string, unknown>>;

        // 如果数组中每个元素都有 content 字段 → 按文本格式化
        if (results.every(r => typeof r === 'object' && r !== null && hasTextContentFields(r as Record<string, unknown>))) {
            const formatted = results.map(r => formatResultItem(r as Record<string, unknown>));
            // 去掉末尾多余空行
            return formatted.join('\n\n').trimEnd();
        }

        // 纯结构化数组（如 list_files 的文件列表）→ JSON（包含 data 中全部字段，而非仅 results）
        return JSON.stringify(data, null, 2);
    }

    // 检测顶层的 data 是否直接含文本字段
    if (data && typeof data === 'object' && hasTextContentFields(data as Record<string, unknown>)) {
        return formatResultItem(data as Record<string, unknown>);
    }

    // 兜底：纯结构化数据，用 JSON
    return JSON.stringify(response);
}
