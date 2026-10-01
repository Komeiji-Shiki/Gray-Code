import { evaluateTextSearch, presentToolMatch, type TextSearchInput } from '../../../shared/textSearch';
import { expandReplacementTemplate } from '../../../shared/regexReplacement';
import type { TextSearchWorker } from './textSearchWorker';
import * as path from 'path';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../modules/settings/types';
import type { SearchInFilesToolConfig } from '../../modules/settings/types';
import { buildExcludePattern, DEFAULT_EXCLUDE_PATTERN } from '../shared/globUtils';
import { normalizeLineEndingsToLF, escapeRegExp } from '../shared/textUtils';
import { createTextReader, detectTextFromHeader, decodeTextBytes, type TextDetectionResult } from './textEncodingRuntime';
import type { SearchFileHost, FileLocation } from './fileHost';

export interface SearchMatch {
    file: string;
    workspace?: string;
    line: number;
    column: number;
    match: string;
    context: string;
    /** 同一行有多处命中时的全部列号（1-based，含 column）；单处命中时省略。 */
    columns?: number[];
    /** 同行命中超过记录上限，columns 只列出前面的部分。 */
    columnsTruncated?: boolean;
}
export interface SearchBudget {
    remainingChars: number;
    truncated: boolean;
}
export interface SearchPageState {
    /** 跨文件/工作区共享；跳过的命中不占本页输出预算。 */
    remaining: number;
    matchesSeen: number;
}
export interface SearchPassResult {
    results: SearchMatch[];
    matchesSeen: number;
    /** 结果条数达到 maxResults 上限（maxResults+1 探测判定，恰好等于 maxResults 时不置位） */
    matchesTruncated: boolean;
    budgetTruncated: boolean;
    /** 处理失败/被大小护栏跳过的文件及原因（与 replacePass 的 SkippedFileInfo 同构） */
    skippedFiles: SkippedFileInfo[];
    /** getSearchRootAndPattern 的 stat 失败降级说明（路径不存在/不可访问时按目录处理） */
    pathWarning?: SearchPathWarningInfo;
}
export interface SkippedFileInfo {
    file: string;
    reason: string;
}
export interface SearchQueryFallbackInfo {
    applied: boolean;
    originalQuery: string;
    keywords: string[];
    reason?: 'whitespace_keyword_or' | 'suspected_regex';
    suggestion?: string;
    signals?: string[];
}
export interface SearchPathWarningInfo {
    type: 'possible_multiple_paths' | 'stat_failed_treated_as_directory';
    path: string;
    candidates: string[];
    message: string;
}
/** 搜索遍历的文件预取并发：单线程下收益来自重叠文件 IO，过大反而增加内存峰值。 */
const SEARCH_FILE_CONCURRENCY = 8;

/** 并发预取阶段产出的单文件结果；消费端按文件顺序处理。 */
type PreparedFile =
    | { kind: 'skipped'; skipped: SkippedFileInfo }
    | { kind: 'binary' }
    | { kind: 'failed'; skipped: SkippedFileInfo }
    | { kind: 'noMatch' }
    | { kind: 'ready'; relativePath: string; lines: string[] };

export function createSearchPass(host: SearchFileHost) {
const {tryGetFileSizeBytes,readHeaderBytes}=createTextReader(host);

function getSearchInFilesConfig(): Readonly<SearchInFilesToolConfig> {
    return host.searchConfig();
}

function getExcludePattern(config: Readonly<SearchInFilesToolConfig>): string {
    return buildExcludePattern(config.excludePatterns, DEFAULT_EXCLUDE_PATTERN);
}

function splitWhitespaceFallbackKeywords(query: string): string[] {
    const seen = new Set<string>();
    const keywords: string[] = [];

    for (const rawKeyword of query.trim().split(/\s+/)) {
        const keyword = rawKeyword.trim();
        if (!keyword) continue;

        const dedupeKey = keyword.toLocaleLowerCase();
        if (seen.has(dedupeKey)) continue;

        seen.add(dedupeKey);
        keywords.push(keyword);
    }

    return keywords.length > 1 ? keywords : [];
}

function createFallbackKeywordRegex(keywords: string[], flags: string): RegExp {
    return new RegExp(keywords.map(escapeRegExp).join('|'), flags);
}

function clampNonNegativeNumber(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return value < 0 ? 0 : value;
}

function truncateWithEllipsis(text: string, maxChars: number): string {
    const limit = Math.max(0, Math.floor(maxChars));
    if (limit <= 0) {
        return '';
    }
    if (text.length <= limit) {
        return text;
    }
    // 留一个字符给省略号
    const sliceLen = Math.max(0, limit - 1);
    return `${text.slice(0, sliceLen)}…`;
}

async function searchInDirectory(
    searchRoot: FileLocation,
    filePattern: string,
    searchRegexInput: RegExp,
    maxResults: number,
    workspaceName: string | null,
    excludePattern: string,
    config: Readonly<SearchInFilesToolConfig>,
    budget?: SearchBudget,
    page?: SearchPageState,
    execution?: { computation?: TextSearchWorker; signal?: AbortSignal; includeIgnored?: boolean }
): Promise<{ matches: SearchMatch[]; skippedFiles: SkippedFileInfo[] }> {
    // 本地克隆：g 标志正则携带可变 lastIndex 状态，共享实例跨函数/跨循环传递
    // 全靠每处使用前手动重置，极其脆弱；克隆后状态完全局限在本函数内。
    const searchRegex = new RegExp(searchRegexInput.source, searchRegexInput.flags);
    const results: SearchMatch[] = [];
    const skippedFiles: SkippedFileInfo[] = [];
    // 文件发现不再按 maxFindFiles 截断；该配置仍限制替换模式，不能让只读搜索漏掉后面的文件。
    // Node 宿主直接流式遍历，扩展宿主通过完整 findFiles 结果沿用自己的发现顺序。
    const discovery = { includeIgnored: execution?.includeIgnored };
    const files = host.iterateFiles
        ? host.iterateFiles(searchRoot, filePattern, excludePattern, Number.MAX_SAFE_INTEGER, discovery)
        : (async function* () {
            yield* await host.findFiles(searchRoot, filePattern, excludePattern, Number.MAX_SAFE_INTEGER, discovery);
        })();
    const iterator = files[Symbol.asyncIterator]();

    const enableHeaderTextCheck = config.enableHeaderTextCheck !== false;
    const headerSampleBytes = Math.max(64, clampNonNegativeNumber(config.headerSampleBytes, 4096));
    const maxFileSizeBytes = clampNonNegativeNumber(config.maxFileSizeBytes, 5 * 1024 * 1024);
    const contextBefore = Math.floor(clampNonNegativeNumber(config.contextLinesBefore, 1));
    const contextAfter = Math.floor(clampNonNegativeNumber(config.contextLinesAfter, 1));
    const maxLinePreviewChars = Math.floor(clampNonNegativeNumber(config.maxLinePreviewChars, 300));
    const maxMatchPreviewChars = Math.floor(clampNonNegativeNumber(config.maxMatchPreviewChars, 220));
    
    // 并发预取 + 顺序消费（语义与逐文件串行完全一致）：
    // 修改原因：旧实现对每个文件串行执行 stat → 读文件头 → 读全文，单线程大量
    //          时间在等待磁盘；大工作区实测 900 个小文件约 258ms。
    // 修改方式：最多提前 SEARCH_FILE_CONCURRENCY 个文件并发准备（大小护栏、二进制
    //          探测、读全文、解码、归一化、全文无命中快速拒绝）；消费端仍按原顺序
    //          逐行、逐匹配应用预算，结果、截断标志与 skippedFiles 顺序保持不变；
    //          提前中断时最多多读几个已启动的文件（有界）。
    // 修改目的：重叠文件 IO 等待，保持原有确定性输出。
    const probeRegex = new RegExp(searchRegexInput.source, searchRegexInput.flags);
    // 正则任务的快速探测也必须在线程内，不能在预取阶段重新引入主线程回溯。
    // 全文快速拒绝的适用条件（每次调用只需判定一次）：
    // - 正则带 m 标志（搜索模式固定 'gm'）：^/$ 才能与逐行语义对齐；
    // - 源码不含否定断言（(?! / (?<!）：断言可跨行边界读取相邻行，
    //   逐行有命中而全文 test 无命中是可能的，此时禁用优化、退回逐行扫描
    //   （仅影响性能）。
    // 其余构造（含 ^/$、\b、正向环视、跨行模式）已用随机对照验证：逐行命中
    // 集合是全文 test 的子集，快速拒绝不会漏掉任何真实匹配。
    const canRejectByFullTextScan = !execution?.computation && probeRegex.multiline
        && !probeRegex.source.includes('(?!')
        && !probeRegex.source.includes('(?<!');
    const prepareFile = async (fileUri: FileLocation): Promise<PreparedFile> => {
        try {
            // 文件大小护栏（避免读入超大文件）
            if (maxFileSizeBytes > 0) {
                const size = await tryGetFileSizeBytes(fileUri);
                if (typeof size === 'number' && size > maxFileSizeBytes) {
                    return {
                        kind: 'skipped',
                        skipped: {
                            file: host.toRelativePath(fileUri, workspaceName !== null),
                            reason: `File exceeds the search size limit (${size} > ${maxFileSizeBytes} bytes)`
                        }
                    };
                }
            }

            // 文件头文本检测（跳过二进制）
            let detection: TextDetectionResult = { isText: true, encoding: 'utf-8', bomLength: 0 };
            if (enableHeaderTextCheck) {
                try {
                    const header = await readHeaderBytes(fileUri, headerSampleBytes);
                    detection = detectTextFromHeader(header);
                    if (!detection.isText) {
                        return { kind: 'binary' };
                    }
                } catch {
                    // header 检测失败时退化为旧行为（仍有大小/输出护栏）
                    detection = { isText: true, encoding: 'utf-8', bomLength: 0 };
                }
            }

            const content = await host.readFile(fileUri);
            const text = normalizeLineEndingsToLF(decodeTextBytes(content, detection));

            // 全文快速拒绝：只会跳过确定零命中的文件，不会漏掉真实匹配
            // （适用条件见上方 canRejectByFullTextScan 注释）。
            if (canRejectByFullTextScan) {
                probeRegex.lastIndex = 0;
                const hasPossibleMatch = probeRegex.test(text);
                probeRegex.lastIndex = 0;
                if (!hasPossibleMatch) {
                    return { kind: 'noMatch' };
                }
            }

            // 使用支持多工作区的相对路径（每文件只计算一次）
            return {
                kind: 'ready',
                relativePath: host.toRelativePath(fileUri, workspaceName !== null),
                lines: text.split('\n')
            };
        } catch (e) {
            // 处理失败不再静默吞掉：与 replacePass 一致记录原因，
            // 让模型能区分“没匹配”和“处理失败”（EACCES/IO 等）。
            return {
                kind: 'failed',
                skipped: {
                    file: host.toRelativePath(fileUri, workspaceName !== null),
                    reason: `Failed to process: ${e instanceof Error ? e.message : String(e)}`
                }
            };
        }
    };

    const prepared: Array<Promise<PreparedFile>> = [];
    let exhausted = false;
    const startPrepareAhead = async () => {
        while (!exhausted && prepared.length < SEARCH_FILE_CONCURRENCY) {
            execution?.signal?.throwIfAborted();
            const next = await iterator.next();
            if (next.done) { exhausted = true; break; }
            const task = prepareFile(next.value);
            // 在顺序消费前挂拒绝处理；退出时仍等待已启动的读取，避免遗留文件句柄。
            task.catch(() => { /* 消费端负责处理拒绝 */ });
            prepared.push(task);
        }
    };

    try {
        for (;;) {
            if (results.length >= maxResults) {
                break;
            }
            if (budget && budget.remainingChars <= 0) {
                budget.truncated = true;
                break;
            }

            execution?.signal?.throwIfAborted();
            await startPrepareAhead();
            if (!prepared.length) break;
            const outcome = await prepared.shift()!;
            execution?.signal?.throwIfAborted();
            if (outcome.kind === 'skipped' || outcome.kind === 'failed') {
                skippedFiles.push(outcome.skipped);
                continue;
            }
            if (outcome.kind === 'binary' || outcome.kind === 'noMatch') {
                continue;
            }

            const relativePath = outcome.relativePath;
            const lines = outcome.lines;
            try {
                const input: TextSearchInput = { kind: 'fileSearch', source: searchRegex.source, flags: searchRegex.flags,
                    fragments: lines, path: relativePath, offset: page?.remaining, limit: maxResults - results.length,
                    remainingChars: budget?.remainingChars, previewChars: maxMatchPreviewChars, linePreviewChars: maxLinePreviewChars,
                    contextBefore, contextAfter };
                const computed = execution?.computation ? await execution.computation.run(input) : evaluateTextSearch(input, expandReplacementTemplate, presentToolMatch);
                if (page) { page.remaining -= computed.skipped; page.matchesSeen += computed.seen!; }
                if (budget) { budget.remainingChars = computed.remainingChars!; budget.truncated ||= computed.budgetTruncated === true; }
                for (const match of computed.matches) results.push({ file: relativePath, workspace: workspaceName || undefined,
                    line: match.fragment + 1, column: match.index + 1, match: match.text, context: match.context!,
                    ...(match.indexes ? { columns: match.indexes.map(index => index + 1) } : {}),
                    ...(match.indexesTruncated ? { columnsTruncated: true } : {}) });
            } catch (e) {
                execution?.signal?.throwIfAborted();
                // 处理失败不再静默吞掉：与 replacePass 一致记录原因，
                // 让模型能区分“没匹配”和“处理失败”（EACCES/IO 等）。
                skippedFiles.push({
                    file: relativePath,
                    reason: `Failed to process: ${e instanceof Error ? e.message : String(e)}`
                });
            }
        }

    } finally {
        // 取消和异常也关闭发现游标，并等待预取释放句柄。
        try { await iterator.return?.(); }
        finally { await Promise.allSettled(prepared); }
    }
    
    return { matches: results, skippedFiles };
}

async function getSearchRootAndPattern(
    rootUri: FileLocation,
    relativePath: string,
    filePattern: string
): Promise<{ searchRoot: FileLocation; effectivePattern: string; pathWarning?: SearchPathWarningInfo }> {
    // 空路径或当前目录，直接用 workspace 根目录
    if (!relativePath || relativePath === '.' || relativePath === './') {
        return { searchRoot: rootUri, effectivePattern: filePattern };
    }

    const fullUri = host.joinPath(rootUri, relativePath);

    try {
        const stat = await host.stat(fullUri);
        if (stat.type === 1) {
            // 是单个文件：搜索根为所在目录，pattern 为文件名
            const fsPath = fullUri.fsPath;
            const dirPath = path.dirname(fsPath);
            const fileName = path.basename(fsPath);
            return {
                searchRoot: host.file(dirPath),
                effectivePattern: fileName

            };
        }
    } catch {
        // stat 失败（路径不存在或权限问题），按目录处理；附 pathWarning 让模型知道
        // 根路径可能写错，而不是把「无结果」静默归因于没有匹配。
        return {
            searchRoot: fullUri,
            effectivePattern: filePattern,
            pathWarning: {
                type: 'stat_failed_treated_as_directory',
                path: relativePath,
                candidates: [],
                message: `Could not stat "${relativePath}" (it may not exist or may not be accessible), so it was searched as a directory. If you meant a single file, check the path spelling.`
            }
        };
    }

    // 默认按目录处理
    return {
        searchRoot: fullUri,
        effectivePattern: filePattern
    };
}
return {getSearchInFilesConfig,getExcludePattern,splitWhitespaceFallbackKeywords,createFallbackKeywordRegex,clampNonNegativeNumber,truncateWithEllipsis,searchInDirectory,getSearchRootAndPattern};
}
