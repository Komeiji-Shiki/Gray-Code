/**
 * useFilePickerDialog - 附件文件选择对话框 Composable
 *
 * 从 App.vue 拆分（F-06）：
 * - 动态创建 <input type="file"> 并触发系统文件选择
 * - 动态 input 生命周期清理（onchange 正常路径 / cancel 事件 / 失焦定时兜底）
 * - 保证「选择完成后 change 事件仍能派发到游离 input 并取回文件」
 *
 * 文件选中后的处理由调用方通过 onFiles 注入（如 useAttachments.addAttachments）。
 */

export interface FilePickerDialogOptions {
  /** 用户选中文件后的回调；由调用方负责错误处理（如附件上传失败提示） */
  onFiles: (files: File[]) => void | Promise<void>
}

export function useFilePickerDialog(options: FilePickerDialogOptions) {
  async function openFilePicker(): Promise<void> {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.txt'

    // 动态 input 清理：onchange 正常路径在 finally 中执行；用户取消（Esc/取消按钮）时
    // onchange 不会触发，依赖 'cancel' 事件与失焦定时兜底，避免 input 元素残留在 DOM。
    // 注意：Chromium 中文件选择框打开瞬间输入框即失焦（blur 早于 change），0ms 定时清理
    // 会在用户选择完成前执行——因此清理绝不能置空 input.onchange，否则 change 派发到
    // 无 handler 的游离 input，所选文件被静默丢弃。这里用 cleaned 标志防重复处理；
    // change 事件在已移除的 input 上仍会正常派发，handler 照常读取 e.target.files。
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null
    let cleaned = false
    const cleanupInput = () => {
      if (cleaned) return
      cleaned = true
      if (cleanupTimer) {
        clearTimeout(cleanupTimer)
        cleanupTimer = null
      }
      input.remove()
      // 保留 input.onchange：change 可能晚于失焦清理派发（用户仍在选择文件），
      // 游离 input 上 change 事件仍会触发本 handler 取回文件；处理完由 handler 自清理。
      input.oncancel = null
      input.onblur = null
    }

    input.onchange = async (e) => {
      try {
        const files = Array.from((e.target as HTMLInputElement).files || [])
        if (files.length > 0) {
          await options.onFiles(files)
        }
      } finally {
        cleanupInput()
      }
    }

    // 取消兜底：Chromium/Firefox 在用户取消文件选择时触发 'cancel'（onchange 不触发）
    input.oncancel = cleanupInput
    // 失焦兜底：部分环境不派发 'cancel'，对话框关闭后 input 失焦即清理；
    // 延迟 0ms 确保同一任务内先执行 onchange（选择文件的路径不会漏处理）。
    // Chromium 中 blur 在选择框打开瞬间即触发，此路径只移除 DOM 与 cancel/blur handler，
    // 保留 onchange 供用户选择完成后取文件（见 cleanupInput 注释）。
    input.onblur = () => {
      if (cleaned) return
      if (cleanupTimer) clearTimeout(cleanupTimer)
      cleanupTimer = setTimeout(cleanupInput, 0)
    }

    document.body.appendChild(input)
    try {
      input.click()
    } catch (err) {
      // 非用户手势上下文调用 click() 可能被浏览器拒绝：清理并提示，避免 input 泄漏
      console.error('打开文件选择器失败:', err)
      cleanupInput()
    }
  }

  return {
    openFilePicker
  }
}
