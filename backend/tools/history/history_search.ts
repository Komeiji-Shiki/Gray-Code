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
        const scopeText = scope === 'summarized' ? '只包括已压缩或总结过的历史' : '完整的对话历史';
        return `搜索和读取对话历史（不是工作区文件）。当前设置允许的搜索范围：${scopeText}。适合查找更早的对话轮次、之前的工具调用和结果，以及用户做过的决定；仓库里的文件请用 search_in_files 或 find_files。\n\n` +
            `历史会整理成一份带行号的文档，工具结果按模型当时收到的文本逐行展开；行号只用于定位，不属于原文。每轮开头有 "══ Round 3 (L45-L88) ══" 这样的标题，标出这一轮的行范围；一轮里有多次模型回复时，每次回复及其工具结果还有 "── Step 2 (L60-L75) ──" 这样的标题。\n\n` +
            `mode="search" 查找关键词或正则，返回匹配的行号和上下文，结果只用于定位，不是完整内容。mode="read" 用 start_line/end_line 读取指定行范围，每次最多 ${MAX_READ_LINES} 行；注意这里的参数是 snake_case，不是 read_file 的 startLine/endLine。通常先用 search 定位，再用 read 读取相关行，或按轮次、步骤标题上的范围读取完整内容。单个长行（例如工具调用参数或结构化结果）可以用 start_line=N、end_line=N 读取，单行读取不会被截断。`;
    }
    const scopeText = scope === 'summarized' ? 'only compressed or summarized history' : 'the entire conversation history';
    return `Search and read the conversation history (not workspace files). The current settings allow searching ${scopeText}. Use it to find earlier turns, previous tool calls and results, and decisions the user made; for repository files, use search_in_files or find_files.\n\n` +
        `The history is laid out as a document with line numbers, and tool results are expanded line by line exactly as the model received them; the line numbers are only for navigation and are not part of the original text. Each round starts with a header such as "══ Round 3 (L45-L88) ══" showing its line range, and when a round has several model replies, each reply and its tool results get a header such as "── Step 2 (L60-L75) ──".\n\n` +
        `mode="search" finds keywords or regex matches and returns line numbers with context; the output only locates content and is not the full text. mode="read" reads a line range with start_line/end_line, up to ${MAX_READ_LINES} lines per call; note that these are snake_case, not read_file's startLine/endLine. Usually you search first, then read the relevant lines or the range shown in a round or step header. To get one long line in full, such as tool call arguments or a structured result, read it with start_line=N and end_line=N; single-line reads are never truncated.`;
}

// ─── 工具声明与处理器 ───────────────────────────────────

export function createHistorySearchToolDeclaration(config?: () => HistorySearchToolConfig): ToolDeclaration {
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
                        ? '操作模式："search" 搜索，"read" 按行范围读取。'
                        : 'Operation mode: "search" to search, "read" to read a line range.',
                    enum: ['search', 'read']
                },
                query: {
                    type: 'string',
                    description: isZh
                        ? '仅 search 模式：要搜索的关键词、短语或正则表达式。查询里用到正则语法（如 "|"、".*"、".+"、"\\."、"\\d"、"[]"、"()"、"^" 或 "$"）时，请设 is_regex=true。'
                        : 'Search mode only: keyword, phrase or regular expression to search for. If the query uses regex syntax such as "|", ".*", ".+", "\\.", "\\d", "[]", "()", "^" or "$", set is_regex=true.'
                },
                is_regex: {
                    type: 'boolean',
                    description: isZh
                        ? '仅 search 模式：是否把 query 当作正则表达式，默认 false；为 false 时正则符号按字面搜索。'
                        : 'Search mode only: whether query is a regular expression; default false, in which case regex symbols are searched literally.'
                },
                start_line: {
                    type: 'integer',
                    minimum: 1,
                    description: isZh
                        ? '仅 read 模式：历史文档中的起始行号，从 1 开始，包含这一行。'
                        : 'Read mode only: first line to read in the history document, 1-based and inclusive.'
                },
                end_line: {
                    type: 'integer',
                    minimum: 1,
                    description: isZh
                        ? '仅 read 模式：历史文档中的结束行号，从 1 开始，包含这一行。'
                        : 'Read mode only: last line to read in the history document, 1-based and inclusive.'
                }
            },
            required: ['mode']
        }
    };

    Object.defineProperty(declaration, 'description', {
        get() {
            const scope = config?.().searchScope ?? getGlobalSettingsManager()?.getHistorySearchConfig()?.searchScope ?? 'all';
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
    context?: ToolContext,
    configuration?: HistorySearchToolConfig
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
            ...(configuration ?? userCfg ?? {})
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

export function createHistorySearchTool(config?: () => HistorySearchToolConfig): Tool {
    return {
        declaration: createHistorySearchToolDeclaration(config),
        handler: (args, context) => historySearchHandler(args, context, config?.())
    };
}

export function registerHistorySearch(): Tool {
    return createHistorySearchTool();
}
