/**
 * 格式化工具函数
 */

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

// 截断文本
// 转义正则表达式特殊字符
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

// 生成唯一ID
export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
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