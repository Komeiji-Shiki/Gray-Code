import { onUnmounted } from 'vue'

export interface UseDeferredSaveOptions {
  /** 防抖延迟（ms）。默认 400，与设置页各处 scheduleConfigSave 的 400ms 一致。 */
  delay?: number
  /**
   * 卸载时是否立即 flush 尚未触发的提交。
   * 保存类场景应保持默认 true（避免最后一次编辑丢失）；
   * 防抖校验类场景应设为 false（卸载时取消，与原「清定时器不执行」行为一致）。
   */
  flushOnUnmount?: boolean
}

/**
 * 通用「防抖延迟提交」原语（F-07 建议的 useDeferredSave）。
 *
 * 统一设置页重复出现的 scheduleConfigSave 模式：每次 schedule 都清掉上一个待触发
 * 提交，延迟后执行最新一次提交；卸载时按 flushOnUnmount 决定 flush 或 cancel。
 * 提交回调既可以是同步函数也可以是异步函数（返回 Promise）。
 *
 * flush() 返回 Promise：
 * - 立即触发尚未触发的提交（若有），并等待最新提交完成；重叠提交会按触发顺序串行；
 * - 提交执行期间继续 schedule，后续 flush 仍会提交最新一次调度（不会被吞掉）；
 * - 提交被拒绝时 rejection 会传播给 await flush() 的调用方；timer 触发的提交若被拒绝，
 *   内部已挂接空 catch，不会产生 unhandled rejection。
 */
export function useDeferredSave(options: UseDeferredSaveOptions = {}) {
  const delay = options.delay ?? 400
  const flushOnUnmount = options.flushOnUnmount ?? true

  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: (() => void | Promise<void>) | null = null
  /**
   * 串行提交链：后一次提交必须等前一次 settle 后再执行，避免旧值请求晚于新值请求完成，
   * 反向覆盖已经保存的新值。前一次失败不会阻断后续提交。
   */
  let executionTail: Promise<void> = Promise.resolve()
  let queuedCommitCount = 0
  /** 最近一次已触发的提交；无新待提交时 flush 用它等待/传播最近一次结果。 */
  let latestRun: Promise<void> | null = null

  /**
   * 把一次提交接到串行链尾。队列空闲时立即调用回调，保持 flush/卸载保存的既有同步触发语义；
   * 只有与在途提交重叠时才排队。timer 路径无人 await 时也不会产生未处理拒绝。
   */
  function runCommit(fn: () => void | Promise<void>): Promise<void> {
    const runImmediately = queuedCommitCount === 0
    queuedCommitCount += 1

    let result: Promise<void>
    if (runImmediately) {
      try {
        result = Promise.resolve(fn())
      } catch (error) {
        result = Promise.reject(error)
      }
    } else {
      result = executionTail.then(() => fn())
    }

    executionTail = result.catch(() => undefined)
    latestRun = result
    const markSettled = () => {
      queuedCommitCount = Math.max(0, queuedCommitCount - 1)
    }
    void result.then(markSettled, markSettled)
    void result.catch(() => undefined)
    return result
  }

  /** 调度一次延迟提交（会取消此前尚未触发的提交） */
  function schedule(commit: () => void | Promise<void>) {
    pending = commit
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const fn = pending
      pending = null
      if (fn) {
        void runCommit(fn)
      }
    }, delay)
  }

  /**
   * 立即执行尚未触发的提交，并等待它完成；提交按调用顺序串行。
   * 没有新待提交时，等待并传播最近一次已触发提交的结果。
   */
  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const fn = pending
    pending = null

    if (fn) {
      // 新提交会在旧提交 settle 后执行；旧提交失败不会阻断本次最新值落盘。
      return runCommit(fn)
    }
    return latestRun ?? Promise.resolve()
  }

  /** 取消尚未触发的提交（无待提交时为空操作；已触发的提交无法取消） */
  function cancel() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  function isPending(): boolean {
    return timer !== null
  }

  onUnmounted(() => {
    if (flushOnUnmount) {
      // 卸载时触发尚未提交的内容；rejection 无人等待，挂空 catch 避免 unhandled rejection
      void flush().catch(() => {})
    } else {
      cancel()
    }
  })

  return { schedule, flush, cancel, isPending }
}
