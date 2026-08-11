/**
 * diffManager 行级差分算法单测
 *
 * 覆盖：
 * - myersDiffLines：正确性（重建原文/新文）、公共前后缀裁剪、超预算降级
 * - countDeletedLines：与完整 diff 的 delete 计数一致性、multiset 估算降级
 * - 性能冒烟：大文件全量重写不允许卡死（旧实现 O(D²) Map 拷贝会超时/爆内存）
 */

jest.mock('fs', () => ({
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    existsSync: jest.fn(),
    unlinkSync: jest.fn()
}));

jest.mock('../../tools/file/DiffCodeLensProvider', () => ({
    getDiffCodeLensProvider: () => ({
        removeSession: jest.fn(),
        getSession: jest.fn(),
        getSessionByFilePath: jest.fn()
    })
}));

jest.mock('../../core/settingsContext', () => ({
    getGlobalSettingsManager: () => null
}));

jest.mock('../../tools/file/apply_diff', () => ({
    applyDiffToContent: jest.fn()
}));

jest.mock('../../tools/file/unifiedDiff', () => ({
    applyUnifiedDiffHunks: jest.fn()
}));

import { myersDiffLines, countDeletedLines, type DiffOp } from '../../core/services/diffManager';

/** 用 ops 重建原始行序列（equal + delete） */
function rebuildOriginal(ops: DiffOp[]): string[] {
    return ops.filter(op => op.type !== 'insert').map(op => op.line);
}

/** 用 ops 重建新行序列（equal + insert） */
function rebuildNew(ops: DiffOp[]): string[] {
    return ops.filter(op => op.type !== 'delete').map(op => op.line);
}

function countDeletes(ops: DiffOp[]): number {
    return ops.filter(op => op.type === 'delete').length;
}

describe('myersDiffLines', () => {
    test('相同输入返回全 equal', () => {
        const lines = ['a', 'b', 'c'];
        const ops = myersDiffLines(lines, lines);
        expect(ops).toHaveLength(3);
        expect(ops.every(op => op.type === 'equal')).toBe(true);
    });

    test('空输入', () => {
        expect(myersDiffLines([], [])).toEqual([]);
        expect(myersDiffLines(['a'], [])).toEqual([{ type: 'delete', line: 'a' }]);
        expect(myersDiffLines([], ['b'])).toEqual([{ type: 'insert', line: 'b' }]);
    });

    test('中间替换保持前后缀 equal', () => {
        const a = ['head', 'x', 'tail'];
        const b = ['head', 'y', 'tail'];
        const ops = myersDiffLines(a, b);

        expect(rebuildOriginal(ops)).toEqual(a);
        expect(rebuildNew(ops)).toEqual(b);
        expect(ops[0]).toEqual({ type: 'equal', line: 'head' });
        expect(ops[ops.length - 1]).toEqual({ type: 'equal', line: 'tail' });
        expect(countDeletes(ops)).toBe(1);
    });

    test('多处分散修改可正确重建两侧内容', () => {
        const a = Array.from({ length: 50 }, (_, i) => `line-${i}`);
        const b = [...a];
        b[5] = 'changed-5';
        b.splice(20, 2);          // 删除两行
        b.splice(30, 0, 'ins-1', 'ins-2'); // 插入两行

        const ops = myersDiffLines(a, b);
        expect(rebuildOriginal(ops)).toEqual(a);
        expect(rebuildNew(ops)).toEqual(b);
    });

    test('重复行内容不会混淆（行 id 化正确性）', () => {
        const a = ['dup', 'dup', 'unique', 'dup'];
        const b = ['dup', 'other', 'dup'];
        const ops = myersDiffLines(a, b);
        expect(rebuildOriginal(ops)).toEqual(a);
        expect(rebuildNew(ops)).toEqual(b);
    });

    test('超大全量重写走降级路径且不超时', () => {
        const a = Array.from({ length: 5000 }, (_, i) => `old-${i}`);
        const b = Array.from({ length: 5000 }, (_, i) => `new-${i}`);

        const start = Date.now();
        const ops = myersDiffLines(a, b);
        const elapsed = Date.now() - start;

        // 无公共行 → 降级为整段删除 + 整段插入
        expect(rebuildOriginal(ops)).toEqual(a);
        expect(rebuildNew(ops)).toEqual(b);
        expect(countDeletes(ops)).toBe(5000);
        // 旧实现（逐层 Map 拷贝）在该规模下需要数十秒/爆内存；新实现应远快于 3s
        expect(elapsed).toBeLessThan(3000);
    });

    test('大文件小改动走精确路径且快速', () => {
        const a = Array.from({ length: 20000 }, (_, i) => `line-${i}`);
        const b = [...a];
        b[10000] = 'modified';

        const start = Date.now();
        const ops = myersDiffLines(a, b);
        const elapsed = Date.now() - start;

        expect(rebuildOriginal(ops)).toEqual(a);
        expect(rebuildNew(ops)).toEqual(b);
        expect(countDeletes(ops)).toBe(1);
        expect(elapsed).toBeLessThan(500);
    });
});

describe('countDeletedLines', () => {
    test('无变化返回 0', () => {
        const lines = ['a', 'b', 'c'];
        expect(countDeletedLines(lines, lines)).toBe(0);
        expect(countDeletedLines([], [])).toBe(0);
    });

    test('纯删除返回删除行数', () => {
        expect(countDeletedLines(['a', 'b', 'c'], ['a'])).toBe(2);
        expect(countDeletedLines(['a', 'b'], [])).toBe(2);
    });

    test('纯插入返回 0', () => {
        expect(countDeletedLines(['a'], ['a', 'b', 'c'])).toBe(0);
    });

    test('替换计为真实删除行数而非净变化（3 删 1 插 = 3）', () => {
        const a = ['keep', 'del-1', 'del-2', 'del-3', 'keep-2'];
        const b = ['keep', 'ins-1', 'keep-2'];
        expect(countDeletedLines(a, b)).toBe(3);
    });

    test('与 myersDiffLines 的 delete 计数一致（随机样例）', () => {
        // 固定种子的伪随机，保证测试可复现
        let seed = 42;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };

        for (let round = 0; round < 20; round++) {
            const a = Array.from({ length: 30 + Math.floor(rand() * 40) }, (_, i) =>
                `l-${Math.floor(rand() * 20)}-${i % 7}`
            );
            const b = a
                .filter(() => rand() > 0.25)
                .flatMap(line => (rand() > 0.85 ? [line, `new-${Math.floor(rand() * 10)}`] : [line]));

            const expected = countDeletes(myersDiffLines(a, b));
            expect(countDeletedLines(a, b)).toBe(expected);
        }
    });

    test('超大全量重写走 multiset 估算且不超时', () => {
        const a = Array.from({ length: 10000 }, (_, i) => `old-${i}`);
        const b = Array.from({ length: 10000 }, (_, i) => `new-${i}`);

        const start = Date.now();
        const deleted = countDeletedLines(a, b);
        const elapsed = Date.now() - start;

        // 完全重写：所有原始行都被删除
        expect(deleted).toBe(10000);
        expect(elapsed).toBeLessThan(3000);
    });

    test('大文件小改动精确且快速', () => {
        const a = Array.from({ length: 50000 }, (_, i) => `line-${i}`);
        const b = [...a];
        b.splice(25000, 3, 'x');

        const start = Date.now();
        const deleted = countDeletedLines(a, b);
        const elapsed = Date.now() - start;

        expect(deleted).toBe(3);
        expect(elapsed).toBeLessThan(500);
    });
});
