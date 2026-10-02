/**
 * history_search 模式处理器（search / read）
 *
 * 从 history_search.ts 拆分（模块化重构第一批）：
 * 负责在格式化后的虚拟文档上执行两种检索模式：
 * - search: 关键词/正则搜索，返回匹配的行号和上下文
 * - read:   按行号范围读取格式化后的历史内容
 *
 * 依赖 virtualDocument.ts 提供的格式化辅助函数；
 * 工具声明与 handler 装配仍在 history_search.ts。
 */

import type { ToolResult } from '../types';
import { DEFAULT_HISTORY_SEARCH_CONFIG } from '../../modules/settings/types';
import { t } from '../../i18n';
import { createSuspectedRegexSuggestion, detectSuspectedRegexIntent, escapeRegExp } from '../shared/textUtils';
import { validateRegexPattern } from '../../core/services/regexGuard';
import { addLineNumbers, truncateLineForDisplay } from './virtualDocument';

// ─── 默认常量（当 settingsManager 不可用时的 fallback） ───

const {
    maxResultChars: MAX_RESULT_CHARS
} = DEFAULT_HISTORY_SEARCH_CONFIG;

/** 运行时配置，handler 启动时从 settingsManager 加载 */
export interface RuntimeConfig {
    searchScope?: 'all' | 'summarized';
    maxSearchMatches: number;
    searchContextLines: number;
    maxReadLines: number;
    maxResultChars: number;
    lineDisplayLimit: number;
}

// ─── 模式实现 ───────────────────────────────────────────

function splitKeywordQuery(query: string): string[] {
    return Array.from(new Set(query.trim().split(/\s+/).filter(Boolean)));
}

function collectMatchingLineIndices(
    docLines: string[],
    maxMatches: number,
    testLine: (line: string) => boolean
): number[] {
    const matchLineIndices: number[] = [];
    for (let i = 0; i < docLines.length; i++) {
        if (testLine(docLines[i])) {
            matchLineIndices.push(i);
            if (matchLineIndices.length >= maxMatches) break;
        }
    }
    return matchLineIndices;
}

/**
 * search 模式：关键词搜索，返回匹配行号和上下文
 */
export function handleSearch(docLines: string[], query: string, isRegex: boolean, cfg: RuntimeConfig): ToolResult {
    let keywordFallbackTerms: string[] = [];
    let matchLineIndices: number[] = [];
    let displayPattern = new RegExp(escapeRegExp(query), 'i');
    try {
        if (isRegex) {
            // ReDoS 防护：长度上限 + 危险模式检测 + 构造异常捕获（共享 regexGuard）
            const guarded = validateRegexPattern(query, 'gi');
            if (!guarded.ok) {
                // 语法错误只传具体原因，避免与本地化前缀叠成两层；过长或危险模式的说明本身已完整。
                return {
                    success: false,
                    error: guarded.reason !== undefined ? t('tools.history.invalidRegex', { error: guarded.reason }) : guarded.error
                };
            }
            const pattern = guarded.regex;
            displayPattern = pattern;
            matchLineIndices = collectMatchingLineIndices(docLines, cfg.maxSearchMatches, line => {
                pattern.lastIndex = 0;
                return pattern.test(line);
            });
        } else {
            const exactPattern = new RegExp(escapeRegExp(query), 'gi');
            matchLineIndices = collectMatchingLineIndices(docLines, cfg.maxSearchMatches, line => {
                exactPattern.lastIndex = 0;
                return exactPattern.test(line);
            });

            const keywordTerms = splitKeywordQuery(query);
            if (matchLineIndices.length === 0 && keywordTerms.length > 1) {
                const keywordPatterns = keywordTerms.map(term => new RegExp(escapeRegExp(term), 'gi'));
                matchLineIndices = collectMatchingLineIndices(docLines, cfg.maxSearchMatches, line => {
                    return keywordPatterns.some(pattern => {
                        pattern.lastIndex = 0;
                        return pattern.test(line);
                    });
                });
                if (matchLineIndices.length > 0) {
                    keywordFallbackTerms = keywordTerms;
                    displayPattern = new RegExp(keywordTerms.map(escapeRegExp).join('|'), 'i');
                }
            }
        }
    } catch (e: any) {
        return {
            success: false,
            error: t('tools.history.invalidRegex', { error: e.message })
        };
    }

    if (matchLineIndices.length === 0) {
        const noMatchesMessage = t('tools.history.noMatchesFound', { query, totalLines: docLines.length });
        if (!isRegex) {
            const regexIntent = detectSuspectedRegexIntent(query);
            if (regexIntent.suspected) {
                return {
                    success: true,
                    data: `${noMatchesMessage}\n\n[suspected_regex] ${createSuspectedRegexSuggestion(regexIntent.signals, 'is_regex')}`
                };
            }
        }

        return {
            success: true,
            data: noMatchesMessage
        };
    }

    // 构建结果：每个匹配显示行号 + 上下文
    const resultParts: string[] = [];
    resultParts.push(t('tools.history.searchResultHeader', {
        count: matchLineIndices.length,
        query,
        totalLines: docLines.length
    }));
    if (keywordFallbackTerms.length > 0) {
        resultParts.push(t('tools.history.keywordFallbackNotice', {
            terms: keywordFallbackTerms.join(', ')
        }));
    }
    resultParts.push('');

    // 合并相邻的上下文范围，避免重复输出
    const ranges: Array<{ start: number; end: number; matchLines: number[] }> = [];
    for (const lineIdx of matchLineIndices) {
        const start = Math.max(0, lineIdx - cfg.searchContextLines);
        const end = Math.min(docLines.length - 1, lineIdx + cfg.searchContextLines);

        const lastRange = ranges[ranges.length - 1];
        if (lastRange && start <= lastRange.end + 1) {
            // 与前一个范围相邻或重叠，合并
            lastRange.end = Math.max(lastRange.end, end);
            lastRange.matchLines.push(lineIdx);
        } else {
            ranges.push({ start, end, matchLines: [lineIdx] });
        }
    }

    for (let ri = 0; ri < ranges.length; ri++) {
        const range = ranges[ri];
        const contextLines = docLines.slice(range.start, range.end + 1);
        const formatted = contextLines.map((line, idx) => {
            const lineNum = range.start + idx + 1; // 1-based
            const maxDigits = String(docLines.length).length;
            const numStr = String(lineNum).padStart(maxDigits, ' ');
            const isMatch = range.matchLines.includes(range.start + idx);
            displayPattern.lastIndex = 0;
            const matchIndex = isMatch ? displayPattern.exec(line)?.index ?? 0 : 0;
            const displayLine = truncateLineForDisplay(line, lineNum, cfg.lineDisplayLimit, matchIndex);
            const marker = isMatch ? '>' : ' ';
            return `${marker} ${numStr} | ${displayLine}`;
        }).join('\n');

        resultParts.push(formatted);
        // 只在 range 之间加分隔符，最后一组不加（避免看起来像被截断）
        if (ri < ranges.length - 1) {
            resultParts.push('  ...');
        }
    }

    if (matchLineIndices.length >= cfg.maxSearchMatches) {
        resultParts.push(t('tools.history.resultsLimited', { max: cfg.maxSearchMatches }));
    }

    const result = resultParts.join('\n');
    return {
        success: true,
        data: truncateResult(result, cfg.maxResultChars)
    };
}

/**
 * read 模式：按行号范围读取格式化后的历史内容。
 *
 * 当 start_line === end_line（单行读取）时，不做字符数截断，保证完整返回该行。
 */
export function handleRead(docLines: string[], startLine: number, endLine: number, cfg: RuntimeConfig,
    characters?: { start: number; end?: number }): ToolResult {
    const totalLines = docLines.length;

    // 边界修正（用户传入 1-based）
    const start0 = Math.max(0, startLine - 1);           // 转为 0-based
    const end0 = Math.min(totalLines - 1, endLine - 1);  // 转为 0-based

    if (start0 > end0 || start0 >= totalLines) {
        return {
            success: false,
            error: t('tools.history.invalidRange', {
                start: startLine,
                end: endLine,
                totalLines
            })
        };
    }

    // 限制单次读取行数
    let actualEnd0 = Math.min(end0, start0 + cfg.maxReadLines - 1);
    const isSingleLine = start0 === end0;
    const bodyBudget = Math.max(1, cfg.maxResultChars - 200);
    let formatted: string;
    let nextChar: number | undefined;
    if (characters || !isSingleLine && docLines[start0].length > bodyBudget) {
        const line = docLines[start0], start = (characters?.start ?? 1) - 1;
        if (start >= line.length) return { success: false, error: `start_char exceeds line ${start0 + 1} (${line.length} characters).` };
        const end = Math.min(line.length, characters?.end ?? line.length, start + bodyBudget);
        formatted = `${start0 + 1} | ${line.slice(start, end)}\n[Characters ${start + 1}-${end} of ${line.length}]`;
        actualEnd0 = start0;
        if (end < line.length) nextChar = end + 1;
    } else {
        // 读取以完整行为单位消耗总预算；搜索的预览长度不再限制明确请求读取的正文。
        let used = 0, end = start0;
        for (; end <= actualEnd0; end++) {
            const cost = docLines[end].length + String(end + 1).length + 4;
            if (!isSingleLine && used + cost > bodyBudget) break;
            used += cost;
        }
        actualEnd0 = Math.max(start0, end - 1);
        formatted = addLineNumbers(docLines.slice(start0, actualEnd0 + 1), start0 + 1);
    }
    const wasTruncated = actualEnd0 < end0;

    const parts: string[] = [];
    parts.push(t('tools.history.readResultHeader', {
        start: start0 + 1,
        end: actualEnd0 + 1,
        totalLines
    }));
    parts.push('');
    parts.push(formatted);

    if (nextChar !== undefined) {
        parts.push('', `[Continue with mode="read", start_line=${start0 + 1}, end_line=${start0 + 1}, start_char=${nextChar}.]`);
        if (wasTruncated) parts.push(`[After this line, continue with start_line=${actualEnd0 + 2}, end_line=${end0 + 1}.]`);
    } else if (wasTruncated) {
        parts.push('');
        parts.push(`[Read budget reached. Continue with mode="read", start_line=${actualEnd0 + 2}, end_line=${end0 + 1}.]`);
    }

    const result = parts.join('\n');
    return {
        success: true,
        data: result
    };
}

// ─── 辅助 ───────────────────────────────────────────────

/**
 * 安全地截断结果字符串
 */
function truncateResult(result: string, maxChars: number = MAX_RESULT_CHARS): string {
    if (result.length <= maxChars) return result;
    return result.substring(0, maxChars)
        + '\n\n[Result truncated. Try a narrower line range or more specific query.]';
}
