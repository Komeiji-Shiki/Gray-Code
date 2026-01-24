/**
 * 轻量性能埋点工具（默认关闭）
 *
 * 启用方式（Webview DevTools 控制台执行其一）：
 * - localStorage.setItem('limcode.perf', '1')
 * - localStorage.removeItem('limcode.perf')
 */
export function isPerfEnabled(): boolean {
  try {
    return localStorage.getItem('limcode.perf') === '1'
  } catch {
    return false
  }
}

export function perfNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function perfLog(event: string, data?: Record<string, unknown>): void {
  if (!isPerfEnabled()) return
  // eslint-disable-next-line no-console
  console.debug(`[perf] ${event}`, data || {})
}

export function perfMeasure<T>(
  event: string,
  fn: () => T,
  data?: Record<string, unknown>
): T {
  if (!isPerfEnabled()) {
    return fn()
  }
  const start = perfNow()
  try {
    return fn()
  } finally {
    const end = perfNow()
    // eslint-disable-next-line no-console
    console.debug(`[perf] ${event}`, { ms: Math.round((end - start) * 100) / 100, ...(data || {}) })
  }
}

export async function perfMeasureAsync<T>(
  event: string,
  fn: () => Promise<T>,
  data?: Record<string, unknown>
): Promise<T> {
  if (!isPerfEnabled()) {
    return await fn()
  }
  const start = perfNow()
  try {
    return await fn()
  } finally {
    const end = perfNow()
    // eslint-disable-next-line no-console
    console.debug(`[perf] ${event}`, { ms: Math.round((end - start) * 100) / 100, ...(data || {}) })
  }
}
