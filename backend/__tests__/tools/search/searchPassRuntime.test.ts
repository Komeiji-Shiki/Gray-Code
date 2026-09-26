/**
 * searchPassRuntime（search_in_files 搜索遍历）测试
 *
 * 覆盖：
 * - 文件/行/列顺序与 context 格式（与旧实现相同的输出形状）；
 * - 输出预算按行跳过、后续可容纳匹配仍会加入的语义；
 * - maxResults 探测上限、二进制与大小护栏在读取前跳过、读取失败记录顺序；
 * - 全文快速拒绝（无命中文件只读一次；否定断言模式禁用快速拒绝不漏匹配）；
 * - 与重构前串行逻辑的参考实现对照（模式 × 预算矩阵，含 budget=0 与恰好用尽）。
 */
import { createSearchPass, type SearchBudget, type SearchMatch, type SkippedFileInfo } from '../../../tools/search/searchPassRuntime';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../../modules/settings/types';
import { normalizeLineEndingsToLF } from '../../../tools/shared/textUtils';
import type { SearchFileHost, FileLocation } from '../../../tools/search/fileHost';

interface FakeFile {
    content?: string;
    binaryHeader?: boolean;
    readError?: string;
    sizeOverride?: number;
}

function makeHost(files: Record<string, FakeFile>) {
    const reads = new Map<string, number>();
    const host = {
        findFiles: async (_root: unknown, _pattern: string, _exclude: string, limit: number) =>
            Object.keys(files).slice(0, limit).map(fsPath => ({ fsPath, scheme: 'file' })),
        toRelativePath: (file: { fsPath: string }) => file.fsPath,
        stat: async (file: { fsPath: string }) => {
            const entry = files[file.fsPath] ?? {};
            return { size: entry.sizeOverride ?? Buffer.byteLength(entry.content ?? '', 'utf8'), type: 1 };
        },
        readFile: async (file: { fsPath: string }) => {
            reads.set(file.fsPath, (reads.get(file.fsPath) ?? 0) + 1);
            const entry = files[file.fsPath] ?? {};
            if (entry.readError) {
                throw new Error(entry.readError);
            }
            return Buffer.from(entry.content ?? '', 'utf8');
        },
        readHeader: async (file: { fsPath: string }, bytes: number) => {
            const entry = files[file.fsPath] ?? {};
            if (entry.binaryHeader) {
                return Buffer.alloc(16, 0);
            }
            return Buffer.from((entry.content ?? '').slice(0, Math.max(0, bytes)), 'utf8');
        }
    };
    return { host: host as unknown as SearchFileHost, reads };
}

async function runSearch(fake: ReturnType<typeof makeHost>, source: RegExp, budget?: SearchBudget, maxResults = 100) {
    const pass = createSearchPass(fake.host);
    const root: FileLocation = { fsPath: '/root', scheme: 'file' };
    return pass.searchInDirectory(root, '**/*', source, maxResults, null, '', DEFAULT_SEARCH_IN_FILES_CONFIG, budget);
}

// ==================== 参考实现（重构前逐文件串行逻辑，仅测试用） ====================

function truncateWithEllipsis(text: string, maxChars: number): string {
    const limit = Math.max(0, Math.floor(maxChars));
    if (limit <= 0) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function createMatchLineSnippet(line: string, matchStart: number, matchLength: number, maxChars: number): string {
    const limit = Math.max(0, Math.floor(maxChars));
    if (limit <= 0) return '';
    if (line.length <= limit) return line;
    const start = Math.max(0, matchStart);
    const end = Math.max(start, start + Math.max(0, matchLength));
    const half = Math.floor(limit / 2);
    let windowStart = Math.max(0, start - half);
    let windowEnd = windowStart + limit;
    if (windowEnd < end) {
        windowEnd = Math.min(line.length, end + half);
        windowStart = Math.max(0, windowEnd - limit);
    }
    if (windowEnd > line.length) {
        windowEnd = line.length;
        windowStart = Math.max(0, windowEnd - limit);
    }
    let snippet = line.slice(windowStart, windowEnd);
    if (windowStart > 0) snippet = `…${snippet}`;
    if (windowEnd < line.length) snippet = `${snippet}…`;
    return snippet;
}

async function referenceSearch(files: Record<string, FakeFile>, source: RegExp, maxResults: number, budget?: SearchBudget) {
    const config = DEFAULT_SEARCH_IN_FILES_CONFIG;
    const results: SearchMatch[] = [];
    const skippedFiles: SkippedFileInfo[] = [];
    const searchRegex = new RegExp(source.source, source.flags);
    const contextBefore = Math.floor(config.contextLinesBefore ?? 1);
    const contextAfter = Math.floor(config.contextLinesAfter ?? 1);
    const maxLinePreviewChars = Math.floor(config.maxLinePreviewChars ?? 300);
    const maxMatchPreviewChars = Math.floor(config.maxMatchPreviewChars ?? 220);
    const maxFileSizeBytes = config.maxFileSizeBytes ?? 5 * 1024 * 1024;

    for (const [filePath, entry] of Object.entries(files)) {
        if (results.length >= maxResults) break;
        if (budget && budget.remainingChars <= 0) { budget.truncated = true; break; }
        try {
            if (maxFileSizeBytes > 0 && typeof entry.sizeOverride === 'number' && entry.sizeOverride > maxFileSizeBytes) {
                skippedFiles.push({ file: filePath, reason: `File exceeds the search size limit (${entry.sizeOverride} > ${maxFileSizeBytes} bytes)` });
                continue;
            }
            if (entry.binaryHeader) continue;
            if (entry.readError) throw new Error(entry.readError);

            const text = normalizeLineEndingsToLF(entry.content ?? '');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (results.length >= maxResults) break;
                if (budget && budget.remainingChars <= 0) { budget.truncated = true; break; }
                const line = lines[i];
                let match: RegExpExecArray | null;
                searchRegex.lastIndex = 0;
                while ((match = searchRegex.exec(line)) !== null) {
                    if (results.length >= maxResults) break;
                    if (budget && budget.remainingChars <= 0) { budget.truncated = true; break; }
                    const rawMatchText = match[0] ?? '';
                    const matchText = rawMatchText.length > maxMatchPreviewChars ? truncateWithEllipsis(rawMatchText, maxMatchPreviewChars) : rawMatchText;
                    const contextLines: string[] = [];
                    const beforeStart = Math.max(0, i - contextBefore);
                    for (let j = beforeStart; j < i; j++) {
                        contextLines.push(`${j + 1}: ${truncateWithEllipsis(lines[j], maxLinePreviewChars)}`);
                    }
                    const matchLinePreview = createMatchLineSnippet(line, match.index ?? 0, rawMatchText.length, maxMatchPreviewChars);
                    contextLines.push(`${i + 1}: ${matchLinePreview}`);
                    const afterEnd = Math.min(lines.length - 1, i + contextAfter);
                    for (let j = i + 1; j <= afterEnd; j++) {
                        contextLines.push(`${j + 1}: ${truncateWithEllipsis(lines[j], maxLinePreviewChars)}`);
                    }
                    const context = contextLines.join('\n');
                    const cost = filePath.length + matchText.length + context.length + 80;
                    if (budget && budget.remainingChars - cost < 0) { budget.truncated = true; break; }
                    results.push({ file: filePath, workspace: undefined, line: i + 1, column: match.index + 1, match: matchText, context });
                    if (budget) budget.remainingChars -= cost;
                    if ((match[0] ?? '').length === 0) searchRegex.lastIndex++;
                }
            }
        } catch (e) {
            skippedFiles.push({ file: filePath, reason: `Failed to process: ${e instanceof Error ? e.message : String(e)}` });
        }
    }
    return { results, skippedFiles };
}

// ==================== 测试 ====================

describe('基础输出与顺序', () => {
    test('按文件与行顺序返回，context 使用旧格式', async () => {
        const fake = makeHost({ 'a.txt': { content: 'one\ntwo needle\n' }, 'b.txt': { content: 'needle again' } });
        const result = await runSearch(fake, /needle/gm);
        expect(result.skippedFiles).toEqual([]);
        expect(result.matches).toEqual([
            { file: 'a.txt', workspace: undefined, line: 2, column: 5, match: 'needle', context: '1: one\n2: two needle\n3: ' },
            { file: 'b.txt', workspace: undefined, line: 1, column: 1, match: 'needle', context: '1: needle again' }
        ]);
    });

    test('maxResults 达到探测上限后停止收集', async () => {
        const fake = makeHost({ 'a.txt': { content: 'n\nn\nn\nn\nn' } });
        const result = await runSearch(fake, /n/gm, undefined, 2);
        expect(result.matches.map(match => match.line)).toEqual([1, 2]);
    });

    test('达到结果上限后只等待已启动的预取，返回时没有残留读取', async () => {
        const fake = makeHost(Object.fromEntries(
            Array.from({ length: 20 }, (_, index) => [`${index}.txt`, { content: 'needle' }])
        ));
        const readFile = fake.host.readFile.bind(fake.host);
        let active = 0;
        let peak = 0;
        let completed = 0;
        fake.host.readFile = async file => {
            active++;
            peak = Math.max(peak, active);
            try {
                await new Promise<void>(resolve => { setImmediate(resolve); });
                return await readFile(file);
            } finally {
                active--;
                completed++;
            }
        };

        const result = await runSearch(fake, /needle/gm, undefined, 1);

        expect(result.matches.map(match => match.file)).toEqual(['0.txt']);
        expect(peak).toBe(8);
        expect(completed).toBe(8);
        expect(active).toBe(0);
        expect(fake.reads.size).toBe(8);
    });

    test('预算不足按行跳过，后续可容纳的匹配仍加入', async () => {
        const fake = makeHost({ 'f.txt': { content: 'm1\n\nx m2 xxxxx\n\nm3' }, 'g.txt': { content: 'm4' } });
        const budget: SearchBudget = { remainingChars: 200, truncated: false };
        const result = await runSearch(fake, /m./gm, budget);
        // f.txt：m1 成本 96 → 余 104；m2 成本 108 被跳过（truncated）；m3 成本 96 仍容纳 → 余 8；
        // g.txt：m4 成本 92 超出余量被跳过。
        expect(result.matches.map(match => [match.file, match.line, match.match])).toEqual([
            ['f.txt', 1, 'm1'],
            ['f.txt', 5, 'm3']
        ]);
        expect(budget.remainingChars).toBe(8);
        expect(budget.truncated).toBe(true);
    });
});

describe('跳过与失败路径', () => {
    test('二进制文件在读取前跳过', async () => {
        const fake = makeHost({ 'bin.dat': { binaryHeader: true, content: 'hidden needle' }, 'ok.txt': { content: 'needle' } });
        const result = await runSearch(fake, /needle/gm);
        expect(result.matches.map(match => match.file)).toEqual(['ok.txt']);
        expect(fake.reads.has('bin.dat')).toBe(false);
    });

    test('大小护栏跳过的文件不读取并记录原因', async () => {
        const maxSize = DEFAULT_SEARCH_IN_FILES_CONFIG.maxFileSizeBytes ?? 5 * 1024 * 1024;
        const fake = makeHost({ 'big.txt': { content: 'needle', sizeOverride: maxSize + 1 } });
        const result = await runSearch(fake, /needle/gm);
        expect(result.matches).toEqual([]);
        expect(result.skippedFiles).toEqual([{ file: 'big.txt', reason: expect.stringContaining('size limit') }]);
        expect(fake.reads.has('big.txt')).toBe(false);
    });

    test('读取失败按文件顺序记录 skippedFiles', async () => {
        const fake = makeHost({
            'bad1.txt': { readError: 'EACCES' },
            'good.txt': { content: 'needle' },
            'bad2.txt': { readError: 'EACCES' }
        });
        const result = await runSearch(fake, /needle/gm);
        expect(result.matches.map(match => match.file)).toEqual(['good.txt']);
        expect(result.skippedFiles).toEqual([
            { file: 'bad1.txt', reason: 'Failed to process: EACCES' },
            { file: 'bad2.txt', reason: 'Failed to process: EACCES' }
        ]);
    });

    test('无命中文件被快速拒绝且只读取一次', async () => {
        const fake = makeHost({ 'no.txt': { content: 'nothing here' }, 'has.txt': { content: 'needle' } });
        const result = await runSearch(fake, /needle/gm);
        expect(result.matches.map(match => match.file)).toEqual(['has.txt']);
        expect(result.skippedFiles).toEqual([]);
        expect(fake.reads.get('no.txt')).toBe(1);
        expect(fake.reads.get('has.txt')).toBe(1);
    });

    test('否定断言模式禁用全文快速拒绝，逐行命中不丢失', async () => {
        const fake = makeHost({ 'edge.txt': { content: '\na' } });
        const result = await runSearch(fake, /(?<!\n)./gm);
        expect(result.matches).toEqual([
            { file: 'edge.txt', workspace: undefined, line: 2, column: 1, match: 'a', context: '1: \n2: a' }
        ]);
    });
});

describe('与重构前逻辑的参考实现一致', () => {
    test('模式 × 预算矩阵', async () => {
        const fileSet: Record<string, FakeFile> = {
            'a.txt': { content: 'needle x needle\nplain\nNEEDLE' },
            'b.txt': { content: 'no hits here' },
            'c.txt': { content: 'm1\nm2\nm3\nx+xx' },
            'd.txt': { content: 'a.b? literal?\nneedle' },
            'e.bin': { binaryHeader: true, content: 'needle' },
            'one.txt': { content: 'needle' },
            'two.txt': { content: 'needle' }
        };
        const sources = [/needle/gm, /^m\d/gm, /x+/gm, /./gmi, /needle$/gm, /a\.b\?/gm];
        const budgets = [undefined, 0, 102, 150, 600, 20000];

        for (const source of sources) {
            for (const budgetInit of budgets) {
                const budgetA = budgetInit === undefined ? undefined : { remainingChars: budgetInit, truncated: false };
                const actual = await runSearch(makeHost(fileSet), source, budgetA);
                const budgetB = budgetInit === undefined ? undefined : { remainingChars: budgetInit, truncated: false };
                const expected = await referenceSearch(fileSet, source, 100, budgetB);
                const label = `${source} budget=${String(budgetInit)}`;

                if (JSON.stringify(actual.matches) !== JSON.stringify(expected.results)) {
                    throw new Error(`matches 不一致：${label}\nactual=${JSON.stringify(actual.matches)}\nexpected=${JSON.stringify(expected.results)}`);
                }
                if (JSON.stringify(actual.skippedFiles) !== JSON.stringify(expected.skippedFiles)) {
                    throw new Error(`skippedFiles 不一致：${label}\nactual=${JSON.stringify(actual.skippedFiles)}\nexpected=${JSON.stringify(expected.skippedFiles)}`);
                }
                expect(budgetA?.remainingChars).toBe(budgetB?.remainingChars);
                expect(budgetA?.truncated).toBe(budgetB?.truncated);
            }
        }
    });
});
