import { onUnmounted } from 'vue'

/**
 * 一次性定时器：schedule 一个延迟回调，重复 schedule 会先取消前一个；
 * 组件卸载时自动取消，避免卸载后仍修改状态。
 *
 * 用于设置页「保存成功消息 / toast 自动消失」类计时（SettingsPanel / PromptSettings 共用）。
 */
export function useOneShotTimer() {
  let timer: ReturnType<typeof setTimeout> | null = null

  /** 安排一次延迟回调（取消并替换此前尚未触发的回调） */
  function schedule(delayMs: number, callback: () => void) {
    cancel()
    timer = setTimeout(() => {
      timer = null
      callback()
    }, delayMs)
  }

  /** 取消尚未触发的回调 */
  function cancel() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function isPending(): boolean {
    return timer !== null
  }

  onUnmounted(cancel)

  return { schedule, cancel, isPending }
}
