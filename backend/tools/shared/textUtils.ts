// 从 utils.ts 拆分而来（文本工具 + 正则工具）

// ==================== 文本工具（换行符统一） ====================

export const IS_WINDOWS = process.platform === 'win32';

/**
 * 检查文件字节是否为安全的 UTF-8 文本编码。
 *
 * UTF-16（含 BOM）与 GBK 等非 UTF-8 编码被按 UTF-8 解码后会产生乱码，
 * diff 类工具（apply_diff/insert_code/delete_code）读-改-写会把原编码
 * 永久损坏。命中即返回错误描述，由调用方拒绝处理该文件。
 */
export function detectNonUtf8Encoding(buffer: Buffer): string | null {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return null;
    }
    if (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        if ((b0 === 0xFF && b1 === 0xFE) || (b0 === 0xFE && b1 === 0xFF)) {
            return 'file is UTF-16 encoded (unsupported by diff tools)';
        }
    }
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return null;
    } catch {
        return 'file is not valid UTF-8 text (possibly GBK/other legacy encoding)';
    }
}

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

/**
 * 归一化为单行文本：空白（含换行）压缩为单个空格并去除首尾空白；非字符串返回空串。
 */
export function normalizeSingleLineText(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
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

/**
 * 正则灾难性回溯（ReDoS）粗筛。
 *
 * 检测最常见的危险结构：分组内含量词、且分组后紧跟量词（如 `(a+)+`、
 * `(x+x+)+y`、`(a*)*`、`(a+){2,}`），以及组内含重叠分支且组后跟量词
 * （如 `(a|aa)+`、`(a|ab)+`）、超长模式/超大重复次数、无锚点的贪婪前缀。
 * 命中即拒绝，避免在主线程上对长文本执行指数级回溯。
 */
export function isRegexPotentiallyCatastrophic(pattern: string): boolean {
    if (typeof pattern !== 'string' || pattern.length === 0) {
        return false;
    }
    if (pattern.length > 200) {
        return true;
    }
    // 剥离转义序列与字符类后做结构分析
    const stripped = pattern
        .replace(/\\./g, '')
        .replace(/\[[^\]]*\]/g, '');
    // 分组内含量词，且分组后跟量词/限量词：(a+)+、(x+x+)+、(a+){2,}
    if (/(\([^()]*[+*][^()]*\))([+*]|\{[0-9,]+\})/.test(stripped)) {
        return true;
    }
    // 组内含两个以上备选分支（重叠交替）且组后跟量词：(a|aa)+、(a|ab)+、(ab|a)*
    // 交替分支间存在公共前缀时，回溯可能呈指数级增长。
    if (/\([^()]*\|[^()]*\)([+*]|\{[0-9,]+\})/.test(stripped)) {
        return true;
    }
    // 单个非捕获组自身嵌套分组后跟量词：((a)+)+ 由内层规则捕获，外层兜底
    if (/\([^()]*\([^()]*\)[^()]*\)[+*{]/.test(stripped)) {
        return true;
    }
    // 极大的重复次数上限（如 a{1000000}）
    const largeRepeat = stripped.match(/\{[0-9]+,([0-9]+)\}/);
    if (largeRepeat && Number(largeRepeat[1]) > 10000) {
        return true;
    }
    // 贪婪前缀且无锚点：.* 或 (?:.|\n)* 等开头（剥离后形如 .*、(?:.|)*）
    // 会先吞掉尽可能多的输入，失败后再逐字符回退，放大后续分组的回溯代价。
    // 已用 ^ 锚定（剥离不删除 ^）时回退范围受限，风险显著降低，不判高风险。
    if (!/^\^/.test(pattern) && !/\$$/.test(pattern)) {
        const greedyPrefixMatch = stripped.match(/^(\.\*|\([^()]*\.\|[^()]*\)\*)/);
        if (greedyPrefixMatch) {
            return true;
        }
    }
    return false;
}
