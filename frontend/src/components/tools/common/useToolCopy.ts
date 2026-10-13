import { onBeforeUnmount, ref } from 'vue'
import { t } from '@/i18n'
import { copyToClipboard } from '@/utils/format'
import { showNotification } from '@/utils/vscode'

type CopyKey = string | number

/** 按条目管理复制反馈；内容转换与空内容语义仍由各工具决定。 */
export function useToolCopy() {
  const copiedItems = ref(new Set<CopyKey>())
  const timers = new Map<CopyKey, ReturnType<typeof setTimeout>>()
  let disposed = false

  async function copyItem(key: CopyKey, content: string): Promise<boolean> {
    const ok = await copyToClipboard(content)
    // 剪贴板调用可能晚于卡片卸载，不能在卸载后再建立反馈定时器。
    if (disposed) return ok
    if (!ok) {
      await showNotification(t('common.copyFailed'), 'error')
      return false
    }
    copiedItems.value.add(key)
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => {
      copiedItems.value.delete(key)
      timers.delete(key)
    }, 1000))
    return true
  }

  onBeforeUnmount(() => {
    disposed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  })

  return { copyItem, isCopied: (key: CopyKey) => copiedItems.value.has(key) }
}
