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
 */
export function useDeferredSave(options: UseDeferredSaveOptions = {}) {
  const delay = options.delay ?? 400
  const flushOnUnmount = options.flushOnUnmount ?? true

  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: (() => void | Promise<void>) | null = null

  /** 调度一次延迟提交（会取消此前尚未触发的提交） */
  function schedule(commit: () => void | Promise<void>) {
    pending = commit
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const fn = pending
      pending = null
      void fn?.()
    }, delay)
  }

  /** 立即执行尚未触发的提交（无待提交时为空操作） */
  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const fn = pending
    pending = null
    void fn?.()
  }

  /** 取消尚未触发的提交（无待提交时为空操作） */
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
      flush()
    } else {
      cancel()
    }
  })

  return { schedule, flush, cancel, isPending }
}
