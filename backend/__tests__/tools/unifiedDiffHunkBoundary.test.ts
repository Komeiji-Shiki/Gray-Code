/**
 * unifiedDiff hunk 内 “--- /+++ 内容行 + 下一个 hunk 头” 消歧回归测试。
 *
 * 修复背景：旧实现把 hunk 内“删除行内容以 '- ' 开头 + 增加行内容以 '+ ' 开头 + 下一行是 @@”
 *          误判为下一个文件头并 break，导致这两行内容被静默丢弃。
 */

import { parseUnifiedDiff } from '../../tools/file/unifiedDiff';

describe('parseUnifiedDiff hunk 边界消歧', () => {
    it('hunk 末尾恰为 "--- "删除行 + "+++ "增加行、后接新 hunk 头时，内容不被丢弃', () => {
        // 删除行内容以 "-- " 开头、增加行内容以 "++ " 开头时，原始行形如 "--- ..."/"+++ ..."，
        // 旧实现会把这对内容行误判为下一个文件头并 break，内容被静默丢弃。
        const patch = [
            '--- a/file.ts',
            '+++ b/file.ts',
            '@@ -1,3 +1,3 @@',
            ' line1',
            ' line2',
            '--- old item',
            '+++ new item',
            '@@ -10,2 +10,3 @@',
            ' context',
            '+ added'
        ].join('\n');

        const parsed = parseUnifiedDiff(patch);
        expect(parsed.hunks).toHaveLength(2);

        // 第一个 hunk 必须保留末尾的删除/增加内容对
        const firstHunk = parsed.hunks[0];
        const lastTwo = firstHunk.lines.slice(-2);
        expect(lastTwo[0]).toMatchObject({ type: 'del', content: '-- old item' });
        expect(lastTwo[1]).toMatchObject({ type: 'add', content: '++ new item' });
        // 第二个 hunk 正常解析
        expect(parsed.hunks[1].lines).toHaveLength(2);
    });

    it('普通内容对（后接普通行）不受影响', () => {
        const patch = [
            '--- a/file.ts',
            '+++ b/file.ts',
            '@@ -1,4 +1,4 @@',
            ' line1',
            '--- old item',
            '+++ new item',
            ' line2'
        ].join('\n');

        const parsed = parseUnifiedDiff(patch);
        expect(parsed.hunks).toHaveLength(1);
        const lines = parsed.hunks[0].lines;
        expect(lines).toHaveLength(4);
        expect(lines[1]).toMatchObject({ type: 'del', content: '-- old item' });
        expect(lines[2]).toMatchObject({ type: 'add', content: '++ new item' });
    });

    it('单文件基础解析仍正常', () => {
        const patch = [
            '--- a/file.ts',
            '+++ b/file.ts',
            '@@ -1,2 +1,2 @@',
            ' old',
            '+ new'
        ].join('\n');

        const parsed = parseUnifiedDiff(patch);
        expect(parsed.hunks).toHaveLength(1);
        expect(parsed.hunks[0].lines.map(l => l.type)).toEqual(['context', 'add']);
    });
});
