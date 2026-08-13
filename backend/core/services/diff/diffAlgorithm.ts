/**
 * Myers 按行差分纯算法层（从 DiffManager 抽离）。
 *
 * 本模块只包含与 VSCode 无关的纯计算：
 * - 公共前后缀裁剪
 * - 行 ID 化 + Int32Array 状态的 Myers 差分（含回溯）
 * - 删除行数快速统计（diff 警戒专用）
 *
 * 不 import vscode，不读写文件，不做任何副作用编排。
 */

import { toLineIds } from './lineId';

/**
 * 差分操作。
 */
export type DiffOp = {
    type: 'equal' | 'insert' | 'delete';
    line: string;
};

/**
 * Myers 差分的运算预算：
 * - 精确 Myers 的时间开销随编辑距离 D 增长（O((N+M)·D)），带回溯 trace 时内存也随层数累积；
 * - write_file 全量重写大文件时 D 接近 N+M，旧实现（逐层拷贝 Map 状态）会同步阻塞 extension host 数秒；
 * - 超过预算时走线性开销的估算/降级路径，保证任何输入下都不会卡住 UI。
 * countDeletedLines 无需 trace（内存 O(D)），预算可以给得更高；带回溯的 myersDiffCore 每层保留状态快照，预算更保守。
 */
const MYERS_COUNT_D_LIMIT = 2048;
const MYERS_TRACE_D_LIMIT = 1024;

/**
 * 裁剪公共前后缀，返回前缀/后缀行数（后缀不与前缀重叠）。
 * 绝大多数 diff 的变化集中在文件局部，先裁剪能把核心差分的输入规模降低几个量级。
 */
function trimCommonEdges(a: string[], b: string[]): { prefix: number; suffix: number } {
    const minLen = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < minLen && a[prefix] === b[prefix]) {
        prefix++;
    }

    let suffix = 0;
    const maxSuffix = minLen - prefix;
    while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
        suffix++;
    }

    return { prefix, suffix };
}

/**
 * 快速统计“被删除的行数”（diff 警戒专用）。
 *
 * 为什么不复用 myersDiffLines：警戒只需要删除行数，而删除数可由编辑距离直接推出
 * （delete + insert = D 且 delete - insert = N - M，故 deleted = (D + N - M) / 2），
 * 无需保留每层状态做回溯，内存从随层数累积降到单个 O(D) 数组。
 * 编辑距离超出预算（超大规模重写）时用 multiset 差集估算，退化为 O(N+M)；
 * 该场景下行级删除量与 multiset 结果几乎一致，用于警戒百分比精度足够。
 */
export function countDeletedLines(aAll: string[], bAll: string[]): number {
    const { prefix, suffix } = trimCommonEdges(aAll, bAll);
    const n = aAll.length - prefix - suffix;
    const m = bAll.length - prefix - suffix;
    if (n <= 0) {
        return 0;
    }
    if (m <= 0) {
        return n;
    }

    const a = aAll.slice(prefix, aAll.length - suffix);
    const b = bAll.slice(prefix, bAll.length - suffix);
    const { aIds, bIds } = toLineIds(a, b);

    const dLimit = Math.min(n + m, MYERS_COUNT_D_LIMIT);
    const offset = dLimit;
    const v = new Int32Array(2 * dLimit + 1);

    for (let d = 0; d <= dLimit; d++) {
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1]; // down
            } else {
                x = v[offset + k - 1] + 1; // right
            }
            let y = x - k;

            while (x < n && y < m && aIds[x] === bIds[y]) {
                x++;
                y++;
            }

            v[offset + k] = x;

            if (x >= n && y >= m) {
                return (d + n - m) >> 1;
            }
        }
    }

    // 编辑距离超出预算：multiset 差集估算（不再区分行移动；大规模重写的警戒判断足够）
    const counts = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        counts.set(aIds[i], (counts.get(aIds[i]) ?? 0) + 1);
    }
    for (let j = 0; j < m; j++) {
        const remain = counts.get(bIds[j]);
        if (remain !== undefined && remain > 0) {
            counts.set(bIds[j], remain - 1);
        }
    }
    let deleted = 0;
    for (const remain of counts.values()) {
        deleted += remain;
    }
    return deleted;
}

/**
 * Myers 差分（按行），返回操作序列。
 *
 * 性能设计（对齐 countDeletedLines 的预算思路）：
 * - 先裁剪公共前后缀并直接以 equal 补齐，核心差分只处理中间变化区；
 * - 行 id 化 + Int32Array 状态数组，替换旧版逐层拷贝 Map 的 O(D²) 分配；
 * - 编辑距离超过预算时降级为“整段删除 + 整段插入”，避免超大重写阻塞主线程。
 */
export function myersDiffLines(a: string[], b: string[]): DiffOp[] {
    const { prefix, suffix } = trimCommonEdges(a, b);

    const ops: DiffOp[] = [];
    for (let i = 0; i < prefix; i++) {
        ops.push({ type: 'equal', line: a[i] });
    }

    ops.push(...myersDiffCore(
        a.slice(prefix, a.length - suffix),
        b.slice(prefix, b.length - suffix)
    ));

    for (let i = a.length - suffix; i < a.length; i++) {
        ops.push({ type: 'equal', line: a[i] });
    }
    return ops;
}

function myersDiffCore(a: string[], b: string[]): DiffOp[] {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0) {
        return [];
    }
    if (n === 0) {
        return b.map(line => ({ type: 'insert' as const, line }));
    }
    if (m === 0) {
        return a.map(line => ({ type: 'delete' as const, line }));
    }

    const { aIds, bIds } = toLineIds(a, b);
    const dLimit = Math.min(n + m, MYERS_TRACE_D_LIMIT);
    const offset = dLimit;
    let v = new Int32Array(2 * dLimit + 1);
    // trace[d] 保存进入第 d 层前的状态（未被更高层写过的位置保持 0，与旧版 Map 缺省值语义一致）
    const trace: Int32Array[] = [];

    let foundD = -1;
    for (let d = 0; d <= dLimit && foundD < 0; d++) {
        trace.push(v);
        const vNext = v.slice();

        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1]; // down
            } else {
                x = v[offset + k - 1] + 1; // right
            }
            let y = x - k;

            while (x < n && y < m && aIds[x] === bIds[y]) {
                x++;
                y++;
            }

            vNext[offset + k] = x;

            if (x >= n && y >= m) {
                foundD = d;
                break;
            }
        }

        v = vNext;
    }

    if (foundD < 0) {
        // 编辑距离超出预算：降级为整段替换，保证不阻塞主线程
        const fallback: DiffOp[] = [];
        for (const line of a) {
            fallback.push({ type: 'delete', line });
        }
        for (const line of b) {
            fallback.push({ type: 'insert', line });
        }
        return fallback;
    }

    // backtrack
    const ops: DiffOp[] = [];
    let bx = n;
    let by = m;

    for (let bd = foundD; bd >= 0; bd--) {
        const vv = trace[bd];
        const kk = bx - by;

        let prevK: number;
        if (kk === -bd || (kk !== bd && vv[offset + kk - 1] < vv[offset + kk + 1])) {
            prevK = kk + 1;
        } else {
            prevK = kk - 1;
        }

        const prevX = vv[offset + prevK];
        const prevY = prevX - prevK;

        while (bx > prevX && by > prevY) {
            ops.push({ type: 'equal', line: a[bx - 1] });
            bx--;
            by--;
        }

        if (bd === 0) {
            break;
        }

        if (bx === prevX) {
            // insert
            ops.push({ type: 'insert', line: b[by - 1] });
            by--;
        } else {
            // delete
            ops.push({ type: 'delete', line: a[bx - 1] });
            bx--;
        }
    }

    ops.reverse();
    return ops;
}
