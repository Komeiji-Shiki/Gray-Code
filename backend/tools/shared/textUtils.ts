// 从 utils.ts 拆分而来（文本工具 + 正则工具）

// ==================== 文本工具（换行符统一） ====================

export const IS_WINDOWS = process.platform === 'win32';

/**
 * 统一换行符为 LF（\n）。
 *
 * - Windows CRLF (\r\n) -> \n
 * - legacy CR (\r) -> \n
 */
export function normalizeLineEndingsToLF(text: string): string {
    // 单次扫描同时处理 CRLF 与孤立 CR，避免两次全量 replace 各复制一遍字符串
    return text.replace(/\r\n?/g, '\n');
}

/**
 * 转义正则表达式特殊字符。
 */
export function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RegexIntentDetection {
    suspected: boolean;
    signals: string[];
}

/**
 * 检测非正则查询里是否包含明显的正则语法。
 *
 * 只返回诊断信号，不自动把字面量搜索改成正则搜索，避免误伤 Markdown 表格、TypeScript union、Shell 管道等普通文本。
 */
export function detectSuspectedRegexIntent(query: string): RegexIntentDetection {
    const signals: string[] = [];

    if (query.includes('.*')) signals.push('.*');
    if (query.includes('.+')) signals.push('.+');
    if (/\\\./.test(query)) signals.push('\\.');
    if (/\\[dDwWsSbB]/.test(query)) signals.push('\\d/\\w/\\s');
    if (/\[[^\]\n]+\]/.test(query)) signals.push('[]');
    if (/\([^()\n]*\|[^()\n]*\)/.test(query)) signals.push('(...) with |');
    if (/\{\d+(,\d*)?\}/.test(query)) signals.push('{n,m}');
    if (query.startsWith('^')) signals.push('^');
    if (query.endsWith('$')) signals.push('$');

    for (let i = 0; i < query.length; i++) {
        if (query[i] !== '|') continue;
        const previous = i > 0 ? query[i - 1] : '';
        const next = i + 1 < query.length ? query[i + 1] : '';
        if (previous && next && !/\s/.test(previous) && !/\s/.test(next)) {
            signals.push('|');
            break;
        }
    }

    return {
        suspected: signals.length > 0,
        signals: Array.from(new Set(signals))
    };
}

export function createSuspectedRegexSuggestion(signals: string[], regexFlagName: string = 'isRegex'): string {
    const signalText = signals.length > 0 ? signals.join(', ') : 'regex-like syntax';
    return `Query contains regex-like syntax (${signalText}), but ${regexFlagName}=false, so these characters were searched literally. Retry with ${regexFlagName}=true if this was intended as regex OR/wildcard/escaped-dot search. The tool does not automatically reinterpret literal queries as regex.`;
}
