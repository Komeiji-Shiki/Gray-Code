/**
 * 格式化工具函数
 */

// 格式化相对时间（如"刚刚"、"3分钟前"）
export function formatRelativeTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  
  // 小于1分钟
  if (diff < 60000) {
    return '刚刚'
  }
  
  // 小于1小时
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000)
    return `${minutes}分钟前`
  }
  
  // 小于1天
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000)
    return `${hours}小时前`
  }
  
  // 小于7天
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000)
    return `${days}天前`
  }
  
  // 显示完整日期
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 格式化时间戳（支持自定义格式）
export function formatTime(timestamp: number, format = 'YYYY-MM-DD HH:mm:ss'): string {
  const date = new Date(timestamp)
  
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  
  return format
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds)
}

// 格式化完整时间
export function formatFullTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

// 截断文本
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '...'
}

// 高亮搜索关键词
export function highlightText(text: string, keyword: string): string {
  if (!keyword) return text
  
  const regex = new RegExp(`(${escapeRegExp(keyword)})`, 'gi')
  return text.replace(regex, '<mark>$1</mark>')
}

// 转义正则表达式特殊字符
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 计算文本哈希
export function hashText(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

// 生成随机颜色
export function generateColor(seed: string): string {
  const hash = hashText(seed)
  const hue = parseInt(hash, 36) % 360
  return `hsl(${hue}, 70%, 60%)`
}

// 复制到剪贴板
// 优先 navigator.clipboard（secure context 可用时）；VSCode Webview（vscode-webview://
// 非 secure context）中 clipboard API 可能缺失/被拒，回退 textarea + execCommand('copy')。
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1) 现代剪贴板 API（用户手势下通常可用）
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (error) {
    console.warn('clipboard API 复制失败，尝试 execCommand 回退:', error)
  }

  // 2) execCommand 回退：临时 textarea 选中后执行 copy 命令
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    // 移出可视区域（避免页面跳动），但保留可选中状态
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.left = '-9999px'
    textarea.setAttribute('readonly', '')
    document.body.appendChild(textarea)
    const selection = document.getSelection()
    const prevRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    const ok = document.execCommand('copy')
    // 恢复原选区（若有），避免破坏用户正在进行的文本选择
    if (prevRange && selection) {
      selection.removeAllRanges()
      selection.addRange(prevRange)
    }
    document.body.removeChild(textarea)
    if (ok) return true
  } catch (error) {
    console.error('execCommand 复制失败:', error)
  }

  return false
}

type DebouncedFunction<T extends (...args: any[]) => any> = ((...args: Parameters<T>) => void) & { cancel: () => void }

// 防抖函数
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): DebouncedFunction<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const debounced = function (...args: Parameters<T>) {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => {
      timeoutId = undefined
      fn(...args)
    }, delay)
  } as DebouncedFunction<T>

  debounced.cancel = () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    timeoutId = undefined
  }
  return debounced
}

// 节流函数
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0
  let trailingTimer: ReturnType<typeof setTimeout> | undefined
  let trailingArgs: Parameters<T> | undefined

  return function (...args: Parameters<T>) {
    const now = Date.now()
    const remaining = delay - (now - lastCall)

    if (remaining <= 0) {
      if (trailingTimer !== undefined) clearTimeout(trailingTimer)
      trailingTimer = undefined
      trailingArgs = undefined
      lastCall = now
      fn(...args)
      return
    }

    trailingArgs = args
    if (trailingTimer !== undefined) return
    trailingTimer = setTimeout(() => {
      trailingTimer = undefined
      lastCall = Date.now()
      const pending = trailingArgs
      trailingArgs = undefined
      if (pending) fn(...pending)
    }, remaining)
  }
}

// 延迟执行
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 生成唯一ID
export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

// 判断是否为空值
export function isEmpty(value: any): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (value instanceof Date) return false
  if (value instanceof Map || value instanceof Set) return value.size === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

// 深度克隆
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj
  
  if (obj instanceof Date) return new Date(obj.getTime()) as any
  if (obj instanceof Array) return obj.map(item => deepClone(item)) as any
  
  const clonedObj = {} as T
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      clonedObj[key] = deepClone(obj[key])
    }
  }
  
  return clonedObj
}

// 格式化数字（添加千分位分隔符，始终保留一位小数）
export function formatNumber(num: number): string {
  if (!Number.isFinite(num)) return '0'
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K'
  }
  return num.toLocaleString()
}

/**
 * 解码文本中的 \uXXXX Unicode 转义序列（用于流式 JSON 参数预览）。
 *
 * 为什么需要：部分模型在 function calling 中以 ASCII-safe 形式输出 JSON
 * （等价于 Python 的 ensure_ascii=True），中文会变成 \u4e2d\u6587。
 * 解析层 JSON.parse 不受影响，但流式预览直接展示原始文本会满屏转义符。
 *
 * 解码规则：
 * 1. 成对的反斜杠 `\\` 原样保留，避免把字面量 "\\u0041" 误解码；
 * 2. 只解码完整的 \uXXXX（恰好 4 位十六进制），流式截断的尾部（如 "\u4e"）
 *    保持原样，等下一帧数据补全后全量重解；
 * 3. 代理对（如 \ud83d\ude00）逐个解码为 UTF-16 code unit 后，
 *    由 JS 字符串自然组合为完整字符（emoji 等）。
 */
export function decodeUnicodeEscapes(text: string): string {
  if (!text.includes('\\u')) return text
  return text.replace(/\\\\|\\u([0-9a-fA-F]{4})/g, (match, hex: string | undefined) =>
    hex === undefined ? match : String.fromCharCode(parseInt(hex, 16))
  )
}