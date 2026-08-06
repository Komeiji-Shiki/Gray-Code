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

    // 错误分支：错误信息始终保留在最前，同时继续序列化部分成功结果（F-02）。
    // 修改原因：批量工具部分失败时，以前这里直接返回顶层错误，
    // 成功结果（data.results / data.message）全部丢失，模型会重复执行已完成的操作。
    if (response.error && typeof response.error === 'string') {
        const parts: string[] = [`Error: ${response.error}`];
        if (response.cancelled) {
            parts.push('[cancelled by user]');
        }

        if (data && typeof data === 'object') {
            // 命令执行输出（execute_command 的 stderr/stdout），保持原有格式
            if (typeof data.output === 'string' && data.output.trim()) {
                parts.push('', 'Output:', data.output.trimEnd());
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
                    // 纯结构化数组（如 list_files 的文件列表）→ JSON
                    parts.push('', JSON.stringify(data, null, 2));
                }
            }

            // 可读信息（删除/创建目录/补丁工具返回的 data.message）
            if (typeof data.message === 'string' && data.message.trim()) {
                parts.push('', `Message: ${data.message.trim()}`);
            }

            // 子代理工具使用信息（subagents 失败/部分响应路径）：
            // 与成功路径（兜底 JSON.stringify 完整保留）对齐，主模型在失败时也能看到
            // 子代理是否调用过工具及调用了哪些（空数组 = 未调用任何工具）。
            if (typeof data.steps === 'number' || Array.isArray(data.toolsUsed)) {
                parts.push('', `Progress: steps=${JSON.stringify(data.steps ?? 0)}, toolsUsed=${JSON.stringify(data.toolsUsed ?? [])}`);
            }
            if (typeof data.partialResponse === 'string' && data.partialResponse.trim()) {
                parts.push('', 'Partial response:', data.partialResponse.trimEnd());
            }
        }
        return parts.join('\n');
    }

    // data.results 数组：read_file / search_in_files / write_file 等批量结果
    if (data?.results && Array.isArray(data.results) && data.results.length > 0) {
        const results = data.results as Array<Record<string, unknown>>;

        // 只要存在文本字段就逐项格式化（混合数组也逐项，避免 JSON 二次转义）
        if (results.some(r => typeof r === 'object' && r !== null && hasTextContentFields(r as Record<string, unknown>))) {
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
