/**
 * progress.md 写互斥
 *
 * 修改原因：所有 progress.md 更新都是无锁的「读 → 改 → 写」，并行子代理同时执行
 *          create_design / update_plan / update_progress / record_progress_milestone
 *          时，各自基于同一份旧盘面计算新内容再写回，后写者覆盖先写者，丢失对方的
 *          activeArtifacts / todos / log 更新。
 * 修改方式：模块级 per-path Promise 队列，把整段「读 → 改 → 写」串行化——
 *          后一个写操作总是等前一个完成后，重新读取当前盘面再合并写回。
 * 修改目的：同一 progress 文件的写操作按调用顺序排队执行，互不覆盖；不同文件
 *          （多工作区）之间互不阻塞。
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * 归一化互斥 key：与 fileWriteLockManager 的路径归一化保持同一语义
 * （反斜杠转斜杠、去尾部斜杠、小写），保证各调用点传入的不同写法落到同一队列。
 */
function normalizeProgressPathKey(progressPath: string): string {
  return String(progressPath || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

/**
 * 在 per-path 写锁内执行 `fn`。
 *
 * `fn` 内必须包含完整的「读 → 改 → 写」，否则读改写仍会交叉。
 * 返回 `fn` 的结果；`fn` 抛错时该 Promise 以同样错误拒绝（调用方自行处理）。
 */
export function withProgressWriteLock<T>(progressPath: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizeProgressPathKey(progressPath);
  const previous = queues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(fn);
  queues.set(key, next);
  // 队列排空后清理条目，避免 Map 随会话数无限增长；next 的拒绝已由调用方处理，
  // 这里只为清理链挂一个不会产生 unhandled rejection 的尾巴。
  next
    .finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    })
    .catch(() => undefined);
  return next;
}

/** 测试与诊断用：当前仍有排队/在途写操作的文件数。 */
export function getProgressWriteQueueSize(): number {
  return queues.size;
}
