/**
 * 轻量性能埋点工具（默认关闭）
 *
 * 启用方式（Webview DevTools 控制台执行其一，之后需刷新 Webview 生效）：
 * - localStorage.setItem('graycode.perf', '1')
 * - localStorage.removeItem('graycode.perf')
 */

// 首读后缓存布尔值：埋点路径高频调用 isPerfEnabled，避免每次都同步访问 localStorage
let perfEnabledCache: boolean | null = null

export function isPerfEnabled(): boolean {
  if (perfEnabledCache === null) {
    try {
      perfEnabledCache = localStorage.getItem('graycode.perf') === '1'
    } catch {
      perfEnabledCache = false
    }
  }
  return perfEnabledCache
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
