export interface RenderWindow {
  start: number;
  end: number;
}

/** start/end 使用数组下标，end 为不包含的边界；裁剪是窗口计算的一部分。 */
export function boundedRenderWindow(total: number, start: number, limit: number): RenderWindow {
  const boundedStart = Math.min(total, Math.max(0, start));
  return { start: boundedStart, end: Math.min(total, boundedStart + limit) };
}

export function trailingWindowStart(total: number, limit: number): number {
  return Math.max(0, total - limit);
}

/** 调用方先量化首行，滚动未跨行时不会重新裁剪数组；额外一行覆盖视口的部分行。 */
export function fixedRowRenderWindow(
  total: number, firstVisibleRow: number, viewportRows: number, overscanRows: number
): RenderWindow {
  return boundedRenderWindow(total, firstVisibleRow - overscanRows, viewportRows + 2 * overscanRows + 1);
}

/** 前缀位置有 rows + 1 项，末项是总高度。 */
export function rowAtOffset(positions: readonly number[], offset: number): number {
  let low = 0;
  let high = positions.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (positions[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, Math.max(0, positions.length - 2));
}

export function measuredRowRenderWindow(
  positions: readonly number[], scrollTop: number, viewportHeight: number, overscanPixels: number
): RenderWindow {
  const start = rowAtOffset(positions, Math.max(0, scrollTop - overscanPixels));
  const end = rowAtOffset(positions, scrollTop + viewportHeight + overscanPixels) + 1;
  return boundedRenderWindow(positions.length - 1, start, end - start);
}
