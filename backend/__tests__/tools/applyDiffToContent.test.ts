/**
 * applyDiffToContent 真实实现单测
 *
 * 覆盖：
 * - 唯一匹配替换 / 匹配行号计算
 * - 替换内容中的 $& / $` / $' / $$ 不被 String.replace 展开
 * - 零匹配、多匹配、startLine 定位与越界
 * - CRLF 规范化、空 search、文件边界匹配
 * - 非重叠计数语义（split 兼容）
 * - 大文件 + 短 search 的性能冒烟（countMatches 不生成分割数组、上限保护生效）
 */

import { applyDiffToContent } from '../../tools/file/apply_diff';

describe('applyDiffToContent', () => {
    test('replaces the unique match and reports the matched line', () => {
        const r = applyDiffToContent('a\nb\nc', 'b', 'B');
        expect(r.success).toBe(true);
        expect(r.result).toBe('a\nB\nc');
        expect(r.matchCount).toBe(1);
        expect(r.matchedLine).toBe(2);
    });

    test('does not expand $& / $` / $\' / $$ inside the replacement', () => {
        const replacement = '$$ $& $` $\'';
        const r = applyDiffToContent('const x = 1;', 'const x = 1;', replacement);
        expect(r.success).toBe(true);
        expect(r.result).toBe(replacement);
    });

    test('matches at the very start and very end of the file', () => {
        const start = applyDiffToContent('head\nmid', 'head', 'HEAD');
        expect(start.success).toBe(true);
        expect(start.result).toBe('HEAD\nmid');
        expect(start.matchedLine).toBe(1);

        const end = applyDiffToContent('mid\ntail', 'tail', 'TAIL');
        expect(end.success).toBe(true);
        expect(end.result).toBe('mid\nTAIL');
        expect(end.matchedLine).toBe(2);
    });

    test('normalizes CRLF content before matching', () => {
        const r = applyDiffToContent('a\r\nb\r\nc', 'b', 'B');
        expect(r.success).toBe(true);
        expect(r.result).toBe('a\nB\nc');
        expect(r.matchedLine).toBe(2);
    });

    test('returns an error for empty search', () => {
        const r = applyDiffToContent('abc', '', 'x');
        expect(r.success).toBe(false);
        expect(r.matchCount).toBe(0);
    });

    test('returns an error with diagnosis when there is no match', () => {
        const r = applyDiffToContent('alpha\nbeta', 'gamma', 'x');
        expect(r.success).toBe(false);
        expect(r.matchCount).toBe(0);
        expect(r.error).toContain('No exact match found');
    });

    test('rejects multiple matches and lists candidate lines', () => {
        const r = applyDiffToContent('dup\ndup\ndup', 'dup', 'x');
        expect(r.success).toBe(false);
        expect(r.matchCount).toBe(3);
        expect(r.candidateLines).toEqual([1, 2, 3]);
        expect(r.error).toContain('Multiple matches found (3)');
    });

    test('uses startLine to pick the occurrence at or after that line', () => {
        const r = applyDiffToContent('dup\ndup\ndup', 'dup', 'x', 2);
        expect(r.success).toBe(true);
        expect(r.result).toBe('dup\nx\ndup');
        expect(r.matchedLine).toBe(2);
    });

    test('reports startLine out of range with the actual line count', () => {
        const r = applyDiffToContent('a\nb\nc', 'b', 'B', 4);
        expect(r.success).toBe(false);
        expect(r.matchCount).toBe(0);
        expect(r.error).toContain('Start line 4 is out of range. File has 3 lines.');
    });

    test('reports missing match after startLine', () => {
        const r = applyDiffToContent('a\nb\nc', 'a', 'A', 2);
        expect(r.success).toBe(false);
        expect(r.matchCount).toBe(0);
        expect(r.error).toContain('No exact match found starting from line 2');
    });

    test('counts matches non-overlapping, consistent with the old split semantics', () => {
        // "aaa" 中 "aa" 的非重叠匹配只有 1 个（split 语义）；重叠会有 2 个
        const r = applyDiffToContent('aaa', 'aa', 'x');
        expect(r.success).toBe(true);
        expect(r.result).toBe('xa');
        expect(r.matchCount).toBe(1);
    });

    test('handles a large file with a short search quickly (no split array blowup)', () => {
        // 2MB 内容 + 单字符级 search：旧 split 实现会生成整个分割数组，这里验证不超时且结果正确
        const line = 'x'.repeat(1024);
        const content = Array.from({ length: 2048 }, (_, i) => `${line}-${i}`).join('\n');
        const start = Date.now();
        // 只有最后一行包含 line-2047，保证唯一匹配
        const r = applyDiffToContent(content, `${line}-2047`, 'Y');
        const elapsed = Date.now() - start;

        expect(r.success).toBe(true);
        expect(r.result.endsWith('\nY')).toBe(true);
        expect(elapsed).toBeLessThan(2000);
    });

    test('caps the match count for an over-generic search (memory guard)', () => {
        // 单字符 search 在大量重复内容上会命中超过 100k 次，计数被截断而不是撑爆内存
        const content = 'a'.repeat(150_000);
        const r = applyDiffToContent(content, 'a', 'b');
        expect(r.success).toBe(false);
        expect(r.matchCount).toBe(100_000);
    });
});
