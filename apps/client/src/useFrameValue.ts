import { onBeforeUnmount } from 'vue';

/** 高频坐标只提交最新值；结束拖动时同步提交末尾坐标，不等待下一帧。 */
export function useFrameValue(apply: (value: number) => void) {
  let pending: number | undefined;
  let frame: number | undefined;
  function commit() {
    const value = pending;
    pending = undefined;
    if (value !== undefined) apply(value);
  }
  function schedule(value: number) {
    pending = value;
    frame ??= requestAnimationFrame(() => {
      frame = undefined;
      commit();
    });
  }
  function flush(value?: number) {
    if (value !== undefined) pending = value;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    commit();
  }
  function cancel() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    pending = undefined;
  }
  onBeforeUnmount(cancel);
  return { schedule, flush, cancel };
}
