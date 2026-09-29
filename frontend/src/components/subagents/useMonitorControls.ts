import { ref, watch, onBeforeUnmount, type Ref } from 'vue'
import { useI18n } from '@/i18n'
import { sendToExtension } from '@/utils/vscode'
import type { MonitorRunStatus as RunStatus } from './monitorSoundCues'

/** 控制回执与耗时计时器独立于历史窗口加载；操作始终保留发起时的 runId。 */
export function useMonitorControls(focusedRun: Readonly<Ref<{ runId: string } | undefined>>, focusedRunIsActive: Readonly<Ref<boolean>>, activeRunIds: Ref<Set<string>>) {
  const { t } = useI18n()
  let disposed = false
  const now = ref(Date.now())
  let elapsedTicker: ReturnType<typeof setInterval> | undefined

  function formatElapsed(startMs?: number, endMs?: number): string {
    if (!startMs) return ''
    const end = endMs ?? now.value
    const seconds = Math.max(0, Math.floor((end - startMs) / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m${seconds % 60}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h${minutes % 60}m`
  }

  // 有活跃 run 时每秒刷新一次耗时显示（空闲时不跑 ticker，避免周期性开销）
  watch(() => activeRunIds.value.size, (size) => {
    if (size > 0 && !elapsedTicker) {
      now.value = Date.now()
      elapsedTicker = setInterval(() => { now.value = Date.now() }, 1000)
    } else if (size === 0 && elapsedTicker) {
      clearInterval(elapsedTicker)
      elapsedTicker = undefined
    }
  }, { immediate: true })

  function runElapsed(run: { createdAt: number; updatedAt: number; status: RunStatus }): string {
    const isActive = run.status === 'queued' || run.status === 'running'
      || run.status === 'paused' || run.status === 'awaiting_monitor_action'
    return formatElapsed(run.createdAt, isActive ? undefined : run.updatedAt)
  }

  const controlNotice = ref('')
  let controlNoticeTimer: ReturnType<typeof setTimeout> | undefined

  function showControlNotice(message: string) {
    controlNotice.value = message
    if (controlNoticeTimer) clearTimeout(controlNoticeTimer)
    controlNoticeTimer = setTimeout(() => {
      controlNotice.value = ''
      controlNoticeTimer = undefined
    }, 4000)
  }

  async function controlFocusedRun(action: 'pause' | 'resume' | 'exit') {
    const run = focusedRun.value
    if (!run || !focusedRunIsActive.value) return
    const type = action === 'pause'
      ? 'subagents.pauseRun'
      : action === 'resume'
        ? 'subagents.resumeRun'
        : 'subagents.exitRun'

    // 修改原因：Monitor 顶部按钮要控制当前活跃 run，而不是改前端本地状态。
    // 修改方式：把 pause/resume/exit 意图发送给后端 runController handler，等待事件总线回推新状态。
    // 修改目的：保持后端为控制语义的 source of truth，避免主工具 Promise 与 UI 状态不一致。
    const response = await sendToExtension<{ success?: boolean; active?: boolean; status?: RunStatus; pending?: boolean }>(type, {
      runId: run.runId,
      reason: action === 'exit' ? '用户主动终止 SubAgent 执行' : undefined
    })

    // 修改原因：控制请求失败时前端过去完全无反馈——按钮还在，点了却什么都不发生（run 刚好结束时必然如此）。
    // 修改方式：后端回传该 run 当前是否仍被运行控制器持有；不再活跃就本地摘掉控制按钮，并提示操作未生效。
    // 修改目的：按钮的可见性与可用性始终反映后端真实控制权。
    if (disposed) return
    if (response?.active === false || (action === 'exit' && response?.success === true)) {
      const next = new Set(activeRunIds.value)
      next.delete(run.runId)
      activeRunIds.value = next
    }
    if (focusedRun.value?.runId !== run.runId) return
    if (response?.success === false) {
      showControlNotice(t('components.subagents.monitor.controlUnavailable'))
    }
    if (response?.pending) showControlNotice('暂停请求已收到，将在当前模型请求或工具结束后暂停。')
  }

  function pauseFocusedRun() {
    void controlFocusedRun('pause').catch(error => { if (!disposed) showControlNotice(String(error)) })
  }

  function resumeFocusedRun() {
    void controlFocusedRun('resume').catch(error => { if (!disposed) showControlNotice(String(error)) })
  }

  function exitFocusedRun() {
    void controlFocusedRun('exit').catch(error => { if (!disposed) showControlNotice(String(error)) })
  }


  onBeforeUnmount(() => { disposed = true; clearInterval(elapsedTicker); clearTimeout(controlNoticeTimer) })
  return { formatElapsed, runElapsed, controlNotice, showControlNotice, pauseFocusedRun, resumeFocusedRun, exitFocusedRun }
}
