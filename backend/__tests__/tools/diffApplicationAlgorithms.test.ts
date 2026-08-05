import { applyStructuredDiffHunksBestEffort, normalizeLineEndings } from '../../tools/file/apply_diff';
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

    it('returns a reusable plan from the fast path and replays any hunk subset identically to rescanning', () => {
        const original = [
            'const first = 1;',
            'middle',
            'const second = 2;',
            'const third = 3;',
            'tail'
        ].join('\n');
        const hunks = [
            { oldContent: 'const first = 1;', newContent: 'const first = 10;' },
            { oldContent: 'const second = 2;', newContent: 'const second = 20;' },
            { oldContent: 'const third = 3;', newContent: 'const third = 30;\nconst fourth = 40;' }
        ];

        const applied = applyStructuredDiffHunksBestEffort(original, hunks);
        expect(applied.plan).toBeDefined();
        expect(applied.plan!.entries.map(e => e.index)).toEqual([0, 1, 2]);
        expect(applied.plan!.normalizedOriginal).toBe(normalizeLineEndings(original));
        expect(applied.newContent).toBe([
            'const first = 10;',
            'middle',
            'const second = 20;',
            'const third = 30;',
            'const fourth = 40;',
            'tail'
        ].join('\n'));

        // 任意子集（含空集与全量）重放：有 plan 与无 plan 的结果必须逐字段一致
        const subsets = [new Set<number>(), new Set([1]), new Set([0, 2]), new Set([0, 1, 2])];
        for (const subset of subsets) {
            const withPlan = applyStructuredDiffHunksBestEffort(original, hunks, {
                applyIndices: subset,
                plan: applied.plan
            });
            const withoutPlan = applyStructuredDiffHunksBestEffort(original, hunks, {
                applyIndices: subset
            });
            expect(withPlan.newContent).toBe(withoutPlan.newContent);
            expect(withPlan.results).toEqual(withoutPlan.results);
            expect(withPlan.blocks).toEqual(withoutPlan.blocks);
            expect(withPlan.appliedCount).toBe(withoutPlan.appliedCount);
            expect(withPlan.failedCount).toBe(withoutPlan.failedCount);
        }
    });

    it('reuses a plan produced with a subset of applyIndices', () => {
        const original = 'a\nb\nc\n';
        const hunks = [
            { oldContent: 'a', newContent: 'A' },
            { oldContent: 'b', newContent: 'B' },
            { oldContent: 'c', newContent: 'C' }
        ];

        const applied = applyStructuredDiffHunksBestEffort(original, hunks, { applyIndices: new Set([0, 2]) });
        expect(applied.plan).toBeDefined();
        expect(applied.plan!.entries.map(e => e.index)).toEqual([0, 2]);
        expect(applied.newContent).toBe('A\nb\nC\n');

        const replay = applyStructuredDiffHunksBestEffort(original, hunks, {
            applyIndices: new Set([0, 2]),
            plan: applied.plan
        });
        expect(replay.newContent).toBe(applied.newContent);
        expect(replay.newContent).toBe('A\nb\nC\n');
    });

    it('ignores a stale plan when the original content no longer matches', () => {
        const original = 'alpha\nbeta';
        const changed = 'ALPHA\nbeta';
        const hunks = [{ oldContent: 'alpha', newContent: 'gamma' }];

        const applied = applyStructuredDiffHunksBestEffort(original, hunks);
        expect(applied.plan).toBeDefined();

        const withStalePlan = applyStructuredDiffHunksBestEffort(changed, hunks, { plan: applied.plan });
        const rescan = applyStructuredDiffHunksBestEffort(changed, hunks);

        // 起始内容不一致：必须回退到重新扫描，结果与不传 plan 完全一致
        expect(withStalePlan.newContent).toBe(rescan.newContent);
        expect(withStalePlan.results).toEqual(rescan.results);
        expect(withStalePlan.blocks).toEqual(rescan.blocks);
        expect(withStalePlan.failedCount).toBe(1);
    });

    it('falls back to rescanning when the plan does not cover the required applyIndices', () => {
        // 顺序语义 hunk（第二个 hunk 依赖第一个 hunk 的替换产物）使 fast path 无法产出全量计划
        const original = 'alpha\nbeta';
        const hunks = [
            { oldContent: 'alpha', newContent: 'gamma' },
            { oldContent: 'gamma', newContent: 'delta' }
        ];

        const applied = applyStructuredDiffHunksBestEffort(original, hunks);
        expect(applied.plan).toBeUndefined();
        expect(applied.newContent).toBe('delta\nbeta');

        // 传入只覆盖 index 0 的计划：所需 applyIndices 未被覆盖，必须回退到重新扫描
        const partialPlan = {
            normalizedOriginal: normalizeLineEndings(original),
            entries: [
                { index: 0, startIndex: 0, endIndex: 5, originalStartLine: 1, oldContent: 'alpha', newContent: 'gamma' }
            ]
        };
        const r = applyStructuredDiffHunksBestEffort(original, hunks, {
            applyIndices: new Set([0, 1]),
            plan: partialPlan
        });
        expect(r.newContent).toBe('delta\nbeta');
        expect(r.appliedCount).toBe(2);
        expect(r.failedCount).toBe(0);
    });
});
