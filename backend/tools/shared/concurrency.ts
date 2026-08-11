// 从 utils.ts 拆分而来（并发控制）

/**
 * 带并发上限的 map：按输入顺序返回结果，同时最多 runner 个任务在飞。
 *
 * 修改原因：find_files 对最多 500 个文件用裸 Promise.all 无上限并发读取，
 * list_files 则完全串行；两者都需要一个统一的受控并发工具。
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4;
    // 至少保留 1 个 runner：limit 为 0/非法值时不会静默产出全 undefined 的结果数组
    const runnerCount = Math.max(1, Math.min(normalizedLimit, items.length));
    const runners = Array.from({ length: runnerCount }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) {
                break;
            }
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}
