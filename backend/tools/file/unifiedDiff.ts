/**
 * Unified diff（统一 diff / unified diff format）解析与应用
 *
 * 目标：
 * - 支持解析形如：
 *   --- a/file
 *   +++ b/file
 *   @@ -oldStart,oldCount +newStart,newCount @@
 *   [ ' ' | '+' | '-' ] lines...
 * - 严格按上下文匹配应用到原文件内容，生成 newContent
 *
 * 说明：
 * - 这里只处理“单文件 patch”。若检测到 multi-file patch 或 /dev/null，将抛错。
 * - 换行统一按 LF 处理。
 */

export type UnifiedDiffLineType = 'context' | 'add' | 'del';

export interface UnifiedDiffLine {
    type: UnifiedDiffLineType;
    content: string;
    /** 原始行（包含前缀符号），用于调试/错误提示 */
    raw: string;
}

export interface UnifiedDiffHunk {
    /** 原文件起始行（1-based） */
    oldStart: number;
    /** 原文件行数 */
    oldLines: number;
    /** 新文件起始行（1-based） */
    newStart: number;
    /** 新文件行数 */
    newLines: number;
    /** hunk header 原文 */
    header: string;
    lines: UnifiedDiffLine[];
}

export interface ParsedUnifiedDiff {
    oldFile?: string;
    newFile?: string;
    hunks: UnifiedDiffHunk[];
}

export interface AppliedHunkRange {
    index: number;
    /** 在“应用后的内容”中的起始行号（1-based） */
    startLine: number;
    /** 在“应用后的内容”中的结束行号（1-based） */
    endLine: number;
}

export interface ApplyUnifiedDiffResult {
    newContent: string;
    appliedHunks: AppliedHunkRange[];
}

export interface UnifiedDiffHunkApplyResult {
    /** hunk index（0-based） */
    index: number;
    ok: boolean;
    /** 失败原因（仅 ok=false 时） */
    error?: string;
    /** 在“应用后的内容”中的范围（仅 ok=true 时） */
    startLine?: number;
    endLine?: number;
}

export interface ApplyUnifiedDiffBestEffortResult extends ApplyUnifiedDiffResult {
    /** 每个 hunk 的应用结果（与 hunks 顺序一一对应） */
    results: UnifiedDiffHunkApplyResult[];
}

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 对常见“AI 包裹/噪声行”做轻量去除，提升 unified diff 解析兼容性。
 *
 * 说明：
 * - 只移除「列首对齐」的包裹行，避免误伤 hunk 内合法内容（合法内容一定以 ' ', '+', '-' 开头）。
 * - 不做语义修复（如补全 @@ 行号）；只负责去掉明显不属于 unified diff 的外层壳。
 */
function sanitizeUnifiedDiffPatch(patch: string): string {
    const normalized = normalizeLineEndings(patch);
    const lines = normalized.split('\n');
    const out: string[] = [];

    for (const line of lines) {
        // Markdown code fences（``` / ```diff / ```patch）
        if (line.startsWith('```')) {
            continue;
        }

        // 常见 ApplyPatch 风格包裹（*** Begin Patch / *** Update File: / *** End Patch 等）
        if (line.startsWith('***')) {
            if (
                line === '***' ||
                line.startsWith('*** Begin Patch') ||
                line.startsWith('*** End Patch') ||
                line.startsWith('*** Update File:') ||
                line.startsWith('*** Add File:') ||
                line.startsWith('*** Delete File:') ||
                line.startsWith('*** End of File')
            ) {
                continue;
            }
        }

        out.push(line);
    }

    return out.join('\n');
}

function splitLinesPreserveTrailing(text: string): { lines: string[]; endsWithNewline: boolean } {
    const normalized = normalizeLineEndings(text);
    const endsWithNewline = normalized.endsWith('\n');
    const lines = normalized.split('\n');
    if (endsWithNewline) {
        // split 会产生最后一个空字符串，去掉以避免行号偏差
        lines.pop();
    }
    return { lines, endsWithNewline };
}

function joinLinesPreserveTrailing(lines: string[], endsWithNewline: boolean): string {
    const body = lines.join('\n');
    return endsWithNewline ? body + '\n' : body;
}

function parseFileHeaderPath(line: string, prefix: '---' | '+++'): string {
    // 形如："--- a/foo" / "+++ b/foo" / "--- /dev/null"
    // 也可能带时间戳："--- a/foo\t2020-..."
    const rest = line.slice(prefix.length).trim();
    // 去掉时间戳部分（tab 分隔）
    const p = rest.split('\t')[0]?.trim() || '';
    return p;
}

/**
 * 解析 unified diff patch（单文件）
 */
export function parseUnifiedDiff(patch: string): ParsedUnifiedDiff {
    const normalized = sanitizeUnifiedDiffPatch(patch);
    const lines = normalized.split('\n');

    let oldFile: string | undefined;
    let newFile: string | undefined;
    const hunks: UnifiedDiffHunk[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (line.startsWith('diff --git ')) {
            // 只允许出现一次文件块；若已经解析到 hunks/headers，再次出现则视为 multi-file
            if (hunks.length > 0 || oldFile || newFile) {
                throw new Error('Multi-file patch is not supported. Please split into one apply_diff call per file.');
            }
            i++;
            continue;
        }

        if (line.startsWith('--- ')) {
            if (oldFile && (hunks.length > 0 || newFile)) {
                // 第二个 --- 说明可能是 multi-file
                throw new Error('Multi-file patch is not supported. Please split into one apply_diff call per file.');
            }
            oldFile = parseFileHeaderPath(line, '---');
            i++;
            continue;
        }

        if (line.startsWith('+++ ')) {
            if (newFile && hunks.length > 0) {
                throw new Error('Multi-file patch is not supported. Please split into one apply_diff call per file.');
            }
            newFile = parseFileHeaderPath(line, '+++');
            i++;
            continue;
        }

        if (line.startsWith('@@')) {
            const header = line;
            const m = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
            if (!m) {
                throw new Error(
                    `Invalid hunk header: ${header}. ` +
                    `Expected format: @@ -oldStart,oldCount +newStart,newCount @@ ` +
                    `(oldCount/newCount optional, but start line numbers are required).`
                );
            }

            const oldStart = parseInt(m[1], 10);
            const oldCount = m[2] ? parseInt(m[2], 10) : 1;
            const newStart = parseInt(m[3], 10);
            const newCount = m[4] ? parseInt(m[4], 10) : 1;

            const hunkLines: UnifiedDiffLine[] = [];
            i++;
            while (i < lines.length) {
                const l = lines[i];

                if (l.startsWith('@@') || l.startsWith('diff --git ')) {
                    break;
                }

                // `--- `/`+++ ` 在 hunk 内也可能是内容行：删除行内容以 "-- " 开头时
                // 原始行为 "--- foo"，增加行内容以 "++ " 开头时原始行为 "+++ foo"，
                // 不能作为中断条件（旧实现把删除行误判为文件头 → 整包被当成 multi-file 拒绝）。
                // 只有成对出现的 "--- a/x" + "+++ b/x" 才是下一个文件的头；
                // 真实文件头对后必跟 "@@"（hunk 头），而 hunk 内相邻的
                // "--- x"（删除行）+ "+++ y"（增加行）内容对后面是普通内容行——
                // 据此消歧，避免把相邻删除/增加行误判为 multi-file 整包拒绝。
                if (l.startsWith('--- ')
                    && (lines[i + 1] ?? '').startsWith('+++ ')
                    && (lines[i + 2] ?? '').startsWith('@@')) {
                    break;
                }

                // patch 末尾通常会有一个空行（最后一个换行导致 split 出来），直接忽略；
                // 但 hunk 中间出现裸空行（无前缀）是非法格式：静默跳过会掩盖模型生成的坏 patch。
                // 仅当空行后不再跟随 hunk 内容行（' '、'+'、'-' 前缀）时按尾部空行容忍。
                if (l === '') {
                    const nextLine = lines[i + 1];
                    const isNextFileHeaderPair = nextLine?.startsWith('--- ')
                        && (lines[i + 2] ?? '').startsWith('+++ ');
                    const isNextHunkBody = nextLine !== undefined
                        && !isNextFileHeaderPair
                        && (nextLine.startsWith(' ') || nextLine.startsWith('+') || nextLine.startsWith('-'));
                    if (isNextHunkBody) {
                        throw new Error("Invalid hunk line: bare empty line inside hunk body. Each hunk body line must start with ' ', '+' or '-' (context/add/delete).");
                    }
                    i++;
                    continue;
                }

                // 特殊行："\\ No newline at end of file"
                if (l.startsWith('\\')) {
                    i++;
                    continue;
                }

                const prefix = l[0];
                const content = l.length > 0 ? l.slice(1) : '';

                if (prefix === ' ') {
                    hunkLines.push({ type: 'context', content, raw: l });
                } else if (prefix === '+') {
                    hunkLines.push({ type: 'add', content, raw: l });
                } else if (prefix === '-') {
                    hunkLines.push({ type: 'del', content, raw: l });
                } else {
                    // 非法前缀
                    throw new Error(`Invalid hunk line prefix '${prefix}' in line: ${l}`);
                }
                i++;
            }

            hunks.push({
                oldStart,
                oldLines: oldCount,
                newStart,
                newLines: newCount,
                header,
                lines: hunkLines
            });
            continue;
        }

        i++;
    }

    if (oldFile === '/dev/null' || newFile === '/dev/null') {
        throw new Error('Patches creating/deleting files via /dev/null are not supported. Use write_file/delete_file instead.');
    }

    if (hunks.length === 0) {
        throw new Error('No hunks (@@ ... @@) found in patch. Please provide a valid unified diff.');
    }

    return { oldFile, newFile, hunks };
}

function computeHunkNewLen(hunk: UnifiedDiffHunk): number {
    // newLen = context + add
    return hunk.lines.reduce((acc, l) => acc + (l.type === 'del' ? 0 : 1), 0);
}

/**
 * 对原内容应用 hunks（可选只应用部分索引）
 *
 * - 默认按 hunk.oldStart 及已应用 hunk 的 delta 来定位
 * - 严格匹配 context/del 行
 */
export function applyUnifiedDiffHunks(
    originalContent: string,
    hunks: UnifiedDiffHunk[],
    options?: {
        /** 只应用这些 hunk index（0-based，按原 hunks 顺序） */
        applyIndices?: Set<number>;
    }
): ApplyUnifiedDiffResult {
    const { lines, endsWithNewline } = splitLinesPreserveTrailing(originalContent);

    let delta = 0;
    const appliedHunks: AppliedHunkRange[] = [];

    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
        if (options?.applyIndices && !options.applyIndices.has(hunkIndex)) {
            continue;
        }

        const hunk = hunks[hunkIndex];
        if (hunk.oldStart < 0) {
            throw new Error(`Invalid hunk oldStart: ${hunk.oldStart}`);
        }

        // 统一 diff 的行号是 1-based；oldStart=0 只在特殊情况下出现，这里按插入到文件头处理
        const baseOldStart = Math.max(1, hunk.oldStart);
        const startIndex = baseOldStart - 1 + delta;

        if (startIndex < 0 || startIndex > lines.length) {
            throw new Error(`Hunk start is out of range. ${hunk.header}`);
        }

        let idx = startIndex;
        let removed = 0;
        let added = 0;
        // hunk 输出段：context 行原样保留、del 行删除、add 行插入。
        // 收集完成后一次性 splice，避免逐行 splice 的 O(n) 数组移位（hunk 行数多时退化为 O(n·m)）。
        const hunkOutput: string[] = [];

        for (const line of hunk.lines) {
            if (line.type === 'context') {
                const actual = lines[idx];
                if (actual !== line.content) {
                    throw new Error(
                        `Hunk context mismatch at ${hunk.header}.\nExpected: ${JSON.stringify(line.content)}\nActual:   ${JSON.stringify(actual)}`
                    );
                }
                hunkOutput.push(actual);
                idx++;
                continue;
            }

            if (line.type === 'del') {
                const actual = lines[idx];
                if (actual !== line.content) {
                    throw new Error(
                        `Hunk delete mismatch at ${hunk.header}.\nExpected: ${JSON.stringify(line.content)}\nActual:   ${JSON.stringify(actual)}`
                    );
                }
                idx++;
                removed++;
                continue;
            }

            // add
            hunkOutput.push(line.content);
            added++;
        }

        // 一次性替换 [startIndex, idx) 区间：context 行重新写回、del 行真正移除、add 行插入，
        // 与逐行 splice 的最终结果逐字节一致。
        lines.splice(startIndex, idx - startIndex, ...hunkOutput);

        const newLen = computeHunkNewLen(hunk);
        const startLine = startIndex + 1;
        const endLine = startLine + Math.max(newLen, 1) - 1;
        appliedHunks.push({ index: hunkIndex, startLine, endLine });

        delta += added - removed;
    }

    return {
        newContent: joinLinesPreserveTrailing(lines, endsWithNewline),
        appliedHunks
    };
}

/**
 * 应用完整 patch（单文件）
 */
export function applyUnifiedDiff(originalContent: string, parsed: ParsedUnifiedDiff): ApplyUnifiedDiffResult {
    return applyUnifiedDiffHunks(originalContent, parsed.hunks);
}

/**
 * best-effort：逐 hunk 尝试应用。
 *
 * - 每个 hunk 要么完整应用，要么完全不生效（原子回滚）
 * - 行号定位失败时，自动 fallback 到全局搜索 context+del 行文本块：
 *   - 提取 hunk 中 context + del 行组成的连续文本
 *   - 在当前文件内容中全局搜索
 *   - 唯一匹配 → 用匹配位置重新应用该 hunk
 *   - 多处匹配 → 报错（无法确定目标位置）
 *   - 无匹配 → 报错
 * - 用于“部分成功”的工具体验（避免 1 个 hunk 失败导致整次 apply_diff 失败）
 */
export function applyUnifiedDiffBestEffort(originalContent: string, parsed: ParsedUnifiedDiff): ApplyUnifiedDiffBestEffortResult {
    const { lines, endsWithNewline } = splitLinesPreserveTrailing(originalContent);

    let delta = 0;
    const appliedHunks: AppliedHunkRange[] = [];
    const results: UnifiedDiffHunkApplyResult[] = [];

    for (let hunkIndex = 0; hunkIndex < parsed.hunks.length; hunkIndex++) {
        const hunk = parsed.hunks[hunkIndex];
        const oldLines = hunk.lines
            .filter(line => line.type === 'context' || line.type === 'del')
            .map(line => line.content);
        const replacementLines = hunk.lines
            .filter(line => line.type === 'context' || line.type === 'add')
            .map(line => line.content);

        const matchesAt = (startIndex: number): boolean => {
            if (startIndex < 0 || startIndex + oldLines.length > lines.length) return false;
            for (let offset = 0; offset < oldLines.length; offset++) {
                if (lines[startIndex + offset] !== oldLines[offset]) return false;
            }
            return true;
        };

        const applyAt = (startIndex: number): void => {
            lines.splice(startIndex, oldLines.length, ...replacementLines);
        };

        const recordSuccess = (startIndex: number): void => {
            const startLine = startIndex + 1;
            const endLine = startLine + Math.max(replacementLines.length, 1) - 1;
            appliedHunks.push({ index: hunkIndex, startLine, endLine });
            results.push({ index: hunkIndex, ok: true, startLine, endLine });
            delta += replacementLines.length - oldLines.length;
        };

        let applied = false;
        if (hunk.oldStart >= 0) {
            const baseOldStart = Math.max(1, hunk.oldStart);
            const startIndex = baseOldStart - 1 + delta;
            if (matchesAt(startIndex)) {
                applyAt(startIndex);
                recordSuccess(startIndex);
                applied = true;
            }
        }

        let fallbackMatches: number[] = [];
        if (!applied && oldLines.length > 0) {
            const firstLine = oldLines[0];
            const scanLimit = lines.length - oldLines.length;
            for (let startIndex = 0; startIndex <= scanLimit; startIndex++) {
                if (lines[startIndex] === firstLine && matchesAt(startIndex)) {
                    fallbackMatches.push(startIndex);
                    // 只需区分 0 / 1 / ≥2 三种情况：找到第 2 个即可停止，避免大文件全量扫描
                    if (fallbackMatches.length >= 2) {
                        break;
                    }
                }
            }

            if (fallbackMatches.length === 1) {
                const startIndex = fallbackMatches[0];
                applyAt(startIndex);
                recordSuccess(startIndex);
                applied = true;
            }
        }

        if (!applied) {
            let error: string;
            if (oldLines.length === 0) {
                error = `Hunk context mismatch at ${hunk.header}. A pure-add hunk cannot be relocated without a valid line number.`;
            } else if (fallbackMatches.length === 0) {
                error = `Hunk context mismatch at ${hunk.header}. Line-number match failed and global search found no match for the context/delete block (${oldLines.length} lines).`;
            } else {
                const candidateLines = fallbackMatches.map(index => index + 1);
                error = `Hunk context mismatch at ${hunk.header}. Line-number match failed and global search found ${fallbackMatches.length} matches (ambiguous). Candidate lines: ${candidateLines.join(', ')}.`;
            }
            results.push({ index: hunkIndex, ok: false, error });
      }
    }

    return {
        newContent: joinLinesPreserveTrailing(lines, endsWithNewline),
        appliedHunks,
        results
    };
}
