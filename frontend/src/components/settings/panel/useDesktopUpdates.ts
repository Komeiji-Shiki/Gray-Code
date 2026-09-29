import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { actualLanguage, t } from '@/i18n'
import { sendToExtension } from '@/utils/vscode'

export interface Installation {
  kind: 'installed' | 'portable'
  currentVersion: string
  rootDirectory?: string
  busy: boolean
  progress?: { phase: string; percent?: number }
  ready?: { version: string }
  recovery?: { version: string; targetVersion: string; createdAt: string; backupPath: string }
  transitionResult?: string
}

/** 同一时刻只保留一条状态请求和一个轮询计时器；操作结束后补读最终状态。 */
export function useDesktopUpdates() {
  const installation = ref<Installation>()
  const working = ref(false), message = ref(''), failed = ref(false)
  const busy = computed(() => working.value || installation.value?.busy === true)
  const percent = computed(() => {
    const value = installation.value?.progress?.percent
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined
  })
  const phase = computed(() => {
    const value = installation.value?.progress?.phase
    return t(`desktop.${value && ['checking', 'downloading', 'backup'].includes(value) ? value : 'preparing'}`)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  let disposed = false
  function stopTimer() { if (timer) clearTimeout(timer); timer = undefined }
  function schedule() {
    stopTimer()
    if (!disposed && !document.hidden && busy.value) timer = setTimeout(() => { void refresh().catch(() => {}) }, 1000)
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (pending) return pending
    stopTimer()
    pending = sendToExtension<Installation>('desktop.updates.status', {}).then(result => {
      if (!disposed) installation.value = result
    }).finally(() => { pending = undefined; schedule() })
    return pending
  }
  function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
  async function action(method: string) {
    // 查看发行页和恢复目录不影响下载状态，也不应被下载按钮的互斥状态禁用。
    if (method === 'openUpdatePage' || method === 'desktop.updates.openRecovery') {
      try { await sendToExtension(method, {}) }
      catch (error) { if (!disposed) { failed.value = true; message.value = errorMessage(error) } }
      return
    }
    if (disposed || busy.value) return
    working.value = true; failed.value = false; message.value = ''
    void refresh().catch(() => {})
    try {
      const result = await sendToExtension<any>(method, {})
      if (disposed || result?.cancelled) return
      message.value = result?.message || (result?.downloaded ? t('desktop.downloaded', { version: result.version })
        : result?.alreadyUpToDate ? t('desktop.alreadyCurrent')
        : result?.restarting ? t('desktop.restarting')
        : result?.status?.message || (result?.status?.update ? t('desktop.available', { version: result.status.update.version }) : ''))
    } catch (error) { if (!disposed) { failed.value = true; message.value = errorMessage(error) } }
    finally {
      if (!disposed) {
        working.value = false; stopTimer()
        // 操作期间的旧快照不能作为完成态，等待它结算后再读取一次。
        await pending?.catch(() => {})
        if (!disposed) await refresh().catch(error => { if (!disposed) { failed.value = true; message.value = errorMessage(error) } })
      }
    }
  }
  function visibilityChanged() { if (document.hidden) stopTimer(); else void refresh().catch(() => {}) }
  function formatDate(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(actualLanguage.value) : t('desktop.unknownDate') }
  onMounted(() => {
    document.addEventListener('visibilitychange', visibilityChanged)
    void refresh().catch(error => { if (!disposed) { failed.value = true; message.value = errorMessage(error) } })
  })
  onBeforeUnmount(() => { disposed = true; stopTimer(); document.removeEventListener('visibilitychange', visibilityChanged) })
  return { installation, working, busy, message, failed, percent, phase, action, formatDate }
}
