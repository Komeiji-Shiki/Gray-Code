/**
 * 变更查看面板 Store（内嵌面板，非独立窗口）
 *
 * 运行逻辑与子代理 Monitor 内嵌面板一致：
 * - 面板开关为会话内状态（不持久化），由 host.openDiffPreview 命令驱动打开；
 * - 请求复用同一 IPC 通道（diff.accept / diff.reject），前端按 requestId 匹配响应；
 * - 后端 diff.statusChanged 推送同步面板内状态与删除警戒信息。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { sendToExtension } from '../utils/vscode'

export type DiffEntryStatus = 'pending' | 'accepted' | 'rejected'

export interface DiffViewerEntry {
  /** 预览标识（vscode.diff 拦截时透传，用于去重） */
  previewId: string
  /** 后端 pending diff id（diff-*），accept/reject 需要它 */
  sessionId?: string
  title: string
  filePath: string
  originalContent: string
  newContent: string
  status: DiffEntryStatus
  busy: boolean
  error?: string
  diffGuardWarning?: string
  diffGuardDeletePercent?: number
}

export interface PendingDiffStatus {
  id: string
  status: string
  filePath?: string
  toolId?: string
  diffGuardWarning?: string
  diffGuardDeletePercent?: number
}

/** 推送方（host.openDiffPreview）提供的字段；status/busy 等状态字段由 store 管理 */
export type DiffViewerEntryInput = Omit<
  DiffViewerEntry,
  'status' | 'busy' | 'error' | 'diffGuardWarning' | 'diffGuardDeletePercent'
>

export const useDiffStore = defineStore('diffViewer', () => {
  // 面板开关（仅会话内状态）
  const open = ref(false)
  // 待审变更列表（可多条：一次工具调用产生多个文件 diff）
  const entries = ref<DiffViewerEntry[]>([])
  const selectedIndex = ref(0)

  const selectedEntry = computed<DiffViewerEntry | null>(
    () => entries.value[selectedIndex.value] ?? null
  )

  const pendingCount = computed(
    () => entries.value.filter((e) => e.status === 'pending' && !e.busy).length
  )

/** 接收 host.openDiffPreview 命令推送的变更 */
function push(entry: DiffViewerEntryInput) {
  const idx = entries.value.findIndex(
    (e) =>
      (entry.previewId && e.previewId === entry.previewId) ||
      (entry.sessionId && e.sessionId === entry.sessionId)
  )
  if (idx >= 0) {
    entries.value[idx] = { ...entry, status: 'pending', busy: false }
    selectedIndex.value = idx
  } else {
    entries.value.push({ ...entry, status: 'pending', busy: false })
    selectedIndex.value = entries.value.length - 1
  }
  open.value = true
}

  function select(index: number) {
    if (index >= 0 && index < entries.value.length) {
      selectedIndex.value = index
    }
  }

  function close() {
    open.value = false
    entries.value = []
    selectedIndex.value = 0
  }

  async function act(index: number, accept: boolean): Promise<boolean> {
    const entry = entries.value[index]
    if (!entry || entry.busy || entry.status !== 'pending') return false
    if (!entry.sessionId) {
      entry.error = 'NO_SESSION'
      return false
    }
    entry.busy = true
    entry.error = undefined
    try {
      const response = await sendToExtension<any>(accept ? 'diff.accept' : 'diff.reject', {
        sessionId: entry.sessionId
      })
      entry.status = response?.status === 'accepted' ? 'accepted' : 'rejected'
      return true
    } catch (error: any) {
      entry.error = error?.message || String(error)
      return false
    } finally {
      entry.busy = false
    }
  }

  function accept(index: number) {
    return act(index, true)
  }

  function reject(index: number) {
    return act(index, false)
  }

  async function acceptAll() {
    const indexes = entries.value
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.status === 'pending' && !e.busy)
      .map(({ i }) => i)
    for (const i of indexes) {
      await accept(i)
    }
  }

  async function rejectAll() {
    const indexes = entries.value
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.status === 'pending' && !e.busy)
      .map(({ i }) => i)
    for (const i of indexes) {
      await reject(i)
    }
  }

  /** 后端 diff.statusChanged 推送 → 同步面板内条目状态与删除警戒 */
  function syncStatuses(pendingDiffs: PendingDiffStatus[] | undefined) {
    if (!Array.isArray(pendingDiffs)) return
    const byId = new Map(pendingDiffs.map((d) => [d.id, d]))
    for (const entry of entries.value) {
      if (!entry.sessionId) continue
      const backend = byId.get(entry.sessionId)
      if (!backend) continue
      if (backend.status === 'accepted' || backend.status === 'rejected') {
        entry.status = backend.status
      }
      if (backend.diffGuardWarning) {
        entry.diffGuardWarning = backend.diffGuardWarning
        entry.diffGuardDeletePercent = backend.diffGuardDeletePercent ?? 0
      }
    }
  }

  return {
    open,
    entries,
    selectedIndex,
    selectedEntry,
    pendingCount,
    push,
    select,
    close,
    accept,
    reject,
    acceptAll,
    rejectAll,
    syncStatuses
  }
})
