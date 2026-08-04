import { applyStructuredDiffHunksBestEffort } from '../../tools/file/apply_diff';
import { applyUnifiedDiffBestEffort, parseUnifiedDiff } from '../../tools/file/unifiedDiff';

describe('diff application algorithms', () => {
    it('applies multiple ordered structured hunks and preserves reported output ranges', () => {
        const original = [
            'const first = 1;',
            'middle',
            'const second = 2;',
            'tail'
        ].join('\n');

        const result = applyStructuredDiffHunksBestEffort(original, [
            { oldContent: 'const first = 1;', newContent: 'const first = 10;' },
            { oldContent: 'const second = 2;', newContent: 'const second = 20;\nconst third = 30;' }
        ]);

        expect(result.failedCount).toBe(0);
        expect(result.newContent).toBe([
            'const first = 10;',
            'middle',
            'const second = 20;',
            'const third = 30;',
            'tail'
        ].join('\n'));
        expect(result.blocks).toEqual([
            { index: 0, startLine: 1, endLine: 1 },
            { index: 1, startLine: 3, endLine: 4 }
        ]);
    });

    it('keeps sequential semantics when a later structured hunk targets earlier replacement content', () => {
        const result = applyStructuredDiffHunksBestEffort('alpha\nbeta', [
            { oldContent: 'alpha', newContent: 'gamma' },
            { oldContent: 'gamma', newContent: 'delta' }
        ]);

        expect(result.failedCount).toBe(0);
        expect(result.newContent).toBe('delta\nbeta');
    });

    it('applies a unified hunk with mixed context, deletes, and additions', () => {
        const parsed = parseUnifiedDiff([
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,4 +1,4 @@',
            ' alpha',
            '-beta',
            '+bravo',
            ' gamma',
            ' tail'
        ].join('\n'));

        const result = applyUnifiedDiffBestEffort('alpha\nbeta\ngamma\ntail', parsed);

        expect(result.results).toEqual([{ index: 0, ok: true, startLine: 1, endLine: 4 }]);
        expect(result.newContent).toBe('alpha\nbravo\ngamma\ntail');
    });

    it('finds a uniquely relocated unified hunk through fallback search', () => {
        const parsed = parseUnifiedDiff([
            '@@ -1,2 +1,2 @@',
            ' target',
            '-old',
            '+new'
        ].join('\n'));

        const result = applyUnifiedDiffBestEffort('prefix\ntarget\nold\nsuffix', parsed);

        expect(result.results[0]).toEqual({ index: 0, ok: true, startLine: 2, endLine: 3 });
        expect(result.newContent).toBe('prefix\ntarget\nnew\nsuffix');
    });
});
