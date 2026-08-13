/**
 * GrayCode - Memory cover 算法
 *
 * 用对齐的 2 的幂次方块覆盖 [0, T)，并尽量用尽剩余预算拆分大块。
 * 从 MemoryManager.ts 抽离（纯重构，行为不变）。
 */

/**
 * 用对齐的 2 的幂次方块覆盖 [0, T)。
 * alpha 越大 => 越粗糙 => 越少的行。
 */
function coverAligned(T: number, alpha: number): Array<[number, number]> {
    let root = 1;
    while (root < T) root *= 2;
    const out: Array<[number, number]> = [];
    const stack: Array<[number, number]> = [[0, root]];
    while (stack.length > 0) {
        const [lo, hi] = stack.pop()!;
        if (lo >= T) continue;
        const size = hi - lo;
        if (size > 1 && (hi > T || size > alpha * (T - lo))) {
            const mid = (lo + hi) >> 1;
            stack.push([mid, hi]);
            stack.push([lo, mid]);
        } else {
            out.push([lo, hi]);
        }
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
}

/**
 * 生成 wake 应该展示的块列表。
 * 最多 `budget` 个块，细节向现在递增。
 */
export function computeCover(T: number, budget: number): Array<[number, number]> {
    if (T <= 0) return [];
    if (T <= budget) {
        return Array.from({ length: T }, (_, i) => [i, i + 1] as [number, number]);
    }
    let lo = 0.0, hi = 1.0;
    // 32 次迭代即可把区间缩到 < 1e-9（60 次对阈值精度无增益，却多付约一倍 _cover 开销）；
    // 每次 _cover 最坏 O(块数)，记忆量大时浪费明显，区间足够窄时提前退出。
    for (let i = 0; i < 32; i++) {
        if (hi - lo < 1e-9) break;
        const mid = (lo + hi) / 2;
        if (coverAligned(T, mid).length > budget) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    const out = coverAligned(T, hi);
    // 用尽剩余预算：拆分最大的块。用最大堆按块大小选取，替代逐次线性扫描的 O(budget²)
    //（wakeLines 上限 10000 时旧实现最坏约 5×10⁷ 次迭代，B-5）。
    const result = [...out];
    if (result.length < budget) {
        const heap: Array<[number, number]> = result.slice();
        const sizeOf = (b: [number, number]): number => b[1] - b[0];
        const siftDown = (i: number, n: number): void => {
            while (true) {
                let largest = i;
                const l = 2 * i + 1;
                const r = 2 * i + 2;
                if (l < n && sizeOf(heap[l]) > sizeOf(heap[largest])) largest = l;
                if (r < n && sizeOf(heap[r]) > sizeOf(heap[largest])) largest = r;
                if (largest === i) return;
                [heap[i], heap[largest]] = [heap[largest], heap[i]];
                i = largest;
            }
        };
        const siftUp = (i: number): void => {
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (sizeOf(heap[parent]) >= sizeOf(heap[i])) return;
                [heap[parent], heap[i]] = [heap[i], heap[parent]];
                i = parent;
            }
        };
        for (let i = (heap.length >> 1) - 1; i >= 0; i -= 1) siftDown(i, heap.length);
        while (heap.length < budget) {
            if (sizeOf(heap[0]) <= 1) break;
            const [l, h] = heap[0];
            const m = (l + h) >> 1;
            heap[0] = [l, m];
            siftDown(0, heap.length);
            heap.push([m, h]);
            siftUp(heap.length - 1);
        }
        result.splice(0, result.length, ...heap);
    }
    // 堆按块大小组织，需按 lo 还原输出顺序（wake 依赖块按 lo 升序做连续原始块合并）
    result.sort((a, b) => a[0] - b[0]);
    return result;
}
