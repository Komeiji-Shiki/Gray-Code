/**
 * history_search 工具
 *
 * 允许 AI 检索被上下文总结压缩掉的原始对话内容。
 *
 * 核心思路：将被压缩的历史消息格式化为一个带行号的"虚拟文档"，
 * AI 可以像操作文件一样通过 search + read 两种模式来检索：
 *
 * - search: 关键词/正则搜索，返回匹配的行号和上下文
 * - read:   按行号范围读取格式化后的历史内容
 *
 * 格式化后的文档样例：
 * ```
 *    1 | ══ Round 1 (L1-L13) ══════════
 *    2 | 👤 User:
 *    3 | 帮我实现一个 WebSocket 连接
 *    4 |
 *    5 | 🤖 Model:
 *    6 | 好的，我来帮你实现...
 *    7 | ```typescript
 *    8 | const ws = new WebSocket(...)
 *    9 | ```
 *   10 |
 *   11 | 🤖 Model [tool_call]:
 *   12 | write_file({"path": "src/ws.ts", ...})
 *   13 |
 *   14 | ══ Round 2 (L14-L16) ══════════
 *   15 | 👤 User:
 *   16 | 连接断开后怎么重连？
 * ```
 *
 * 数据来源：ConversationManager.getHistory() 获取完整历史，
 * 然后只处理带 isSummarized 标记（已被总结覆盖）的消息。
 * 逻辑截断语义下被总结的原文完整保留，因此可以检索到完整原始内容。
 *
 * 模块结构（模块化重构第一批拆分）：
 * - virtualDocument.ts：虚拟文档格式化引擎（formatMessage/formatToDocument/addLineNumbers 等）
 * - historySearch.ts：search/read 模式处理器（handleSearch/handleRead）
 * - 本文件：工具声明（含动态 description getter）+ handler 装配
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import type { Content } from '../../modules/conversation/types';
import type { HistorySearchToolConfig } from '../../modules/settings/types';
import { DEFAULT_HISTORY_SEARCH_CONFIG } from '../../modules/settings/types';
import { t, getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { formatToDocument, getSummarizedMessages } from './virtualDocument';
import { handleRead, handleSearch } from './historySearch';
import type { RuntimeConfig } from './historySearch';

// ─── 默认常量（当 settingsManager 不可用时的 fallback） ───

const {
    maxSearchMatches: MAX_SEARCH_MATCHES,
    searchContextLines: SEARCH_CONTEXT_LINES,
    maxReadLines: MAX_READ_LINES,
    maxResultChars: MAX_RESULT_CHARS,
    lineDisplayLimit: LINE_DISPLAY_LIMIT
} = DEFAULT_HISTORY_SEARCH_CONFIG;

/**
 * history_search 顶层描述缓存（性能优化）：description getter 之前每次访问都全量拼接长文案；
 * getAllDeclarations/getAvailableDeclarations 一次请求遍历全部工具声明时会反复触发。
 * 缓存键 = 语言（zh-CN → 中文，en/ja → 英文）+ searchScope；任一变化即失效重建。
 */
let historySearchDescriptionCache: { key: string; value: string } | null = null;

function buildHistorySearchDescription(scope: string, isZh: boolean): string {
    if (isZh) {
        const scopeText = scope === 'summarized' ? '仅压缩/总结过的历史' : '完整对话历史';
        return `搜索并读取对话历史，不是工作区文件。当前设置允许搜索范围：[${scopeText}]。` +
            `用于查找更早的对话轮次、之前的工具调用、工具结果和用户决策；仓库文件请使用 search_in_files 或 find_files。` +
            `历史以带行号的虚拟文档形式呈现。` +
            `行号标记仅用于导航，不属于原文正文。` +
            `每个轮次标题显示其行范围，例如 "══ Round 3 (L45-L88) ══"。` +
            `两种模式：\n` +
            `"search" — 在历史中查找关键词/正则并返回带上下文的匹配行号。搜索输出是定位器，不是完整内容。如果查询使用了正则语法，请设置 is_regex=true；否则这些字符按字面量处理。` +
            `"read" — 使用 start_line/end_line（snake_case，每次最多 ${MAX_READ_LINES} 行）从格式化历史中读取指定行范围。这里不要使用 read_file 风格的 startLine/endLine。` +
            `典型流程：先用 search 定位相关行，再用 read 获取这些行或从轮次标题读取整个轮次范围的完整内容。\n` +
            `提示：要获取单个长行（例如工具响应）的完整内容，使用 start_line=N end_line=N 读取——单行读取永不截断。`;
    }
    const scopeText = scope === 'summarized' ? 'compressed/summarized history ONLY' : 'ENTIRE conversation history';
    return `Search and read conversation history, not workspace files. CURRENT SETTINGS ALLOW SEARCHING: [${scopeText}]. ` +
        `Use this tool for earlier chat turns, previous tool calls, tool results, and user decisions; use search_in_files or find_files for repository files. ` +
        `The history is formatted as a virtual document with line numbers. ` +
        `The line number markers are for navigation and are not part of the original message body. ` +
        `Each round header shows its line range, e.g. "══ Round 3 (L45-L88) ══". ` +
        `Two modes:\n` +
        `"search" — find keywords/regex in history and return matching line numbers with context. Search output is a locator, not the full content. If the query uses regex syntax, set is_regex=true; otherwise those characters are treated literally. ` +
        `"read" — read a specific line range from the formatted history using start_line/end_line (snake_case, max ${MAX_READ_LINES} lines per read). Do not use read_file-style startLine/endLine here. ` +
        `Typical workflow: use search to locate relevant lines, then use read to get the complete content around those lines or an entire round range from the round header.\n` +
        `Tip: to get the full content of a single long line (e.g. a tool response), use read with start_line=N end_line=N — single-line reads are never truncated.`;
}

// ─── 工具声明与处理器 ───────────────────────────────────

export function createHistorySearchToolDeclaration(): ToolDeclaration {
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    const declaration: ToolDeclaration = {
        name: 'history_search',
        readOnly: true,
        description: '', // Will be overridden by getter
        category: 'history',
        parameters: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    description: isZh
                        ? '操作模式。' +
                            '"search"：搜索关键词/正则，返回匹配的行号和上下文。' +
                            '"read"：按行号范围读取。'
                        : 'Operation mode. ' +
                            '"search": search for keywords/regex, returns line numbers and context. ' +
                            '"read": read lines by line number range.',
                    enum: ['search', 'read']
                },
                query: {
                    type: 'string',
                    description: isZh
                        ? '[搜索模式] 搜索关键词、精确短语、空格分隔的关键词或正则表达式。如果查询包含正则语法（如 "|"、".*"、".+"、"\\."、"\\d"、"[]"、"()"、"^" 或 "$"），请设置 is_regex=true。搜索结果是带上下文的定位器，不是完整历史内容。'
                        : '[search mode] Search keyword, exact phrase, space-separated keywords, or regular expression. If query contains regex syntax such as "|", ".*", ".+", "\\.", "\\d", "[]", "()", "^", or "$", set is_regex=true. Search results are locators with context, not complete history content.'
                },
                is_regex: {
                    type: 'boolean',
                    description: isZh
                        ? '[搜索模式] 是否将 query 视为正则表达式。默认：false。为 false 时，正则样式的字符按字面量搜索。'
                        : '[search mode] Whether to treat query as a regular expression. Default: false. When false, regex-looking characters are searched literally.'
                },
                start_line: {
                    type: 'integer',
                    minimum: 1,
                    description: isZh
                        ? '[读取模式] 虚拟历史文档中的起始行号（1-based，包含）。使用 snake_case 的 start_line，不要用 read_file 风格的 startLine。'
                        : '[read mode] Start line number from the virtual history document (1-based, inclusive). Use snake_case start_line, not read_file-style startLine.'
                },
                end_line: {
                    type: 'integer',
                    minimum: 1,
                    description: isZh
                        ? '[读取模式] 虚拟历史文档中的结束行号（1-based，包含）。每次最多读取 ' + MAX_READ_LINES + ' 行。要获取单个完整长行，请让 end_line 等于 start_line。'
                        : '[read mode] End line number from the virtual history document (1-based, inclusive). Max ' + MAX_READ_LINES + ' lines per read. For one complete long line, set end_line equal to start_line.'
                }
            },
            required: ['mode']
        }
    };

    Object.defineProperty(declaration, 'description', {
        get() {
            const scope = getGlobalSettingsManager()?.getHistorySearchConfig()?.searchScope ?? 'all';
            const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
            const cacheKey = `${isZh ? 'zh' : 'en'}|${scope}`;
            if (historySearchDescriptionCache && historySearchDescriptionCache.key === cacheKey) {
                return historySearchDescriptionCache.value;
            }
            const value = buildHistorySearchDescription(scope, isZh);
            historySearchDescriptionCache = { key: cacheKey, value };
            return value;
        },
        enumerable: true
    });

    return declaration;
}

async function historySearchHandler(
    args: Record<string, unknown>,
    context?: ToolContext
): Promise<ToolResult> {
    if (!context) {
        return { success: false, error: t('tools.history.errors.contextRequired') };
    }

    const conversationId = context.conversationId as string | undefined;
    const conversationStore = context.conversationStore;

    if (!conversationId) {
        return { success: false, error: t('tools.history.errors.conversationIdRequired') };
    }
    if (!conversationStore) {
        return { success: false, error: t('tools.history.errors.conversationStoreRequired')};
    }
    // conversationStore 实际上就是 ConversationManager 实例
    if (typeof conversationStore.getHistory !== 'function') {
        return { success: false, error: t('tools.history.errors.getHistoryNotAvailable') };
    }

    const mode = args.mode as string;
    if (!['search', 'read'].includes(mode)) {
        return {
            success: false,
            error: t('tools.history.errors.invalidMode', { mode })
        };
    }

    try {
        // 获取全局 settingsManager
        const settingsManager = getGlobalSettingsManager();
        const userCfg: HistorySearchToolConfig | undefined =
            settingsManager
                ? settingsManager.getHistorySearchConfig()
                : undefined;
        const cfg: RuntimeConfig = {
            ...DEFAULT_HISTORY_SEARCH_CONFIG,
            ...(userCfg || {})
        };

        // 获取完整对话历史（判空：getHistory 可能返回 null/undefined，
        // 直接 filter 会抛 TypeError 被包装成笼统的 "Search failed"）
        const rawHistory = await conversationStore.getHistory(conversationId);
        if (!Array.isArray(rawHistory)) {
            return {
                success: false,
                error: t('tools.history.noHistory')
            };
        }
        const fullHistory = rawHistory as Content[];

        const targetMessages = cfg.searchScope === 'summarized' ? getSummarizedMessages(fullHistory) : fullHistory;

        if (targetMessages.length === 0) {
            return {
                success: true,
                data: cfg.searchScope === 'summarized' 
                    ? t('tools.history.noSummarizedHistory') 
                    : t('tools.history.noHistory')
            };
        }

        // 格式化为虚拟文档
        const docLines = formatToDocument(targetMessages);

        switch (mode) {
            case 'search': {
                const query = args.query as string;
                if (!query || typeof query !== 'string' || !query.trim()) {
                    return {
                        success: false,
                        error: t('tools.history.errors.queryRequired')
                    };
                }
                const isRegex = args.is_regex === true;
                return handleSearch(docLines, query.trim(), isRegex, cfg);
            }

            case 'read': {
                // 入口校验：start_line/end_line 必须是正整数（NaN/小数/Infinity 会穿透 typeof number 检查）
                const rawStartLine = args.start_line;
                const rawEndLine = args.end_line;
                const isInvalidLine = (v: unknown): boolean =>
                    v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 1);
                if (isInvalidLine(rawStartLine) || isInvalidLine(rawEndLine)) {
                    return {
                        success: false,
                        error: 'start_line and end_line must be positive integers (1-based)'
                    };
                }
                const startLine = typeof rawStartLine === 'number' ? rawStartLine : 1;
                const endLine = typeof rawEndLine === 'number' ? rawEndLine : startLine + cfg.maxReadLines - 1;
                return handleRead(docLines, startLine, endLine, cfg);
            }

            default:
                return {
                    success: false,
                    error: t('tools.history.errors.invalidMode', { mode })
                };
        }
    } catch (e: any) {
        return {
            success: false,
            error: t('tools.history.errors.searchFailed', { error: e?.message || String(e) })
        };
    }
}

// ─── 导出 ───────────────────────────────────────────────

export function createHistorySearchTool(): Tool {
    return {
        declaration: createHistorySearchToolDeclaration(),
        handler: historySearchHandler
    };
}

export function registerHistorySearch(): Tool {
    return createHistorySearchTool();
}
