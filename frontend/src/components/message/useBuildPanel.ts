/**
 * useBuildPanel - Build（Plan 执行）顶部卡片面板逻辑
 *
 * 从 MessageList.vue 拆分（S4 批次），纯重构不改行为：
 * - 重放后的 build todo 快照（replayedBuildTodoState / replayedBuildTodoList）
 * - buildTodoItems / showBuildBar / buildAnchorBackendIndex / 统计文案
 * - activeBuildPlanSync：update_plan 增量缓存同步（前缀指纹校验 + 尾部扫描）
 * - 面板展开状态与关联 watcher（build 切换折叠、等待结束定稿、签名同步、隐藏折叠）
 *
 * 与 todo 面板的共享状态（getMergedToolResult / allMessageIndexBounds）由 MessageList
 * 以参数注入，不搞全局。
 */

import { ref, computed, watch } from 'vue'
import type { ComputedRef } from 'vue'
import { useChatStore } from '../../stores'
import { extractTodosFromPlan } from '../../utils/taskCards'
import {
  normalizeTodoStatus,
  type TodoStatus as BuildTodoStatus
} from '../../utils/todoList'
import { getPlanUpdateMode } from '../../utils/toolContinuations'
import type { Message } from '../../types'

/** 全量消息 backendIndex 边界（todo/build 锚点计算共用，MessageList 提供） */
export interface MessageIndexBounds {
  firstIndexed: number | null
  lastIndexed: number | null
  nextFallbackIndex: number
}

export interface UseBuildPanelOptions {
  chatStore: ReturnType<typeof useChatStore>
  /** todo/build 共用的工具结果合并辅助（MessageList 提供） */
  getMergedToolResult: (tool: any) => Record<string, unknown>
  /** 全量消息 backendIndex 边界（todo/build 锚点计算共用） */
  allMessageIndexBounds: ComputedRef<MessageIndexBounds>
}

export function useBuildPanel(options: UseBuildPanelOptions) {
  const { chatStore, getMergedToolResult, allMessageIndexBounds } = options

  // ============ Build（Plan 执行）顶部卡片 ============
  type BuildTodoItem = { id: string; text: string; status: BuildTodoStatus }
  const isBuildExpanded = ref(false)

  const replayedBuildTodoState = computed(() => {
    return chatStore.todoSnapshot
  })

  const replayedBuildTodoList = computed(() => {
    return replayedBuildTodoState.value.todos
  })

  const buildTodoItems = computed<BuildTodoItem[]>(() => {
    // 1) 优先显示“重放后”的 todo 列表（兼容 todo_write 精简 result + todo_update 增量更新）
    if (replayedBuildTodoList.value && replayedBuildTodoList.value.length > 0) {
      return replayedBuildTodoList.value
        .map(t => ({
          id: String(t.id),
          text: String(t.content || '').trim(),
          status: normalizeTodoStatus(t.status)
        }))
        .filter(t => t.text.length > 0)
    }

    // 2) 若确实没有任何 todo 工具轨迹，且仍处于 Build 运行中，则临时 fallback 到计划 markdown
    // （避免刚启动执行时列表短暂为空）
    if (chatStore.activeBuild?.status !== 'running') {
      return []
    }

    const planContent = chatStore.activeBuild?.planContent || ''
    const planTodos = extractTodosFromPlan(planContent)

    return planTodos.map((t, idx) => ({
      id: `plan:${idx}`,
      text: t.text,
      status: t.completed ? 'completed' : 'pending'
    }))
  })

  const showBuildBar = computed(() => {
    const build = chatStore.activeBuild
    if (!build) return false

    // 运行中始终展示；已结束时仅在存在可展示 TODO 时展示，
    // 避免回退后出现“暂无 TODO”的空 Build 壳。
    if (build.status === 'running') return true
    return buildTodoItems.value.length > 0
  })

  const buildAnchorBackendIndex = computed<number | null>(() => {
    const build = chatStore.activeBuild

    if (!build) return null

    if (typeof build.anchorBackendIndex === 'number' && Number.isFinite(build.anchorBackendIndex)) {
      return build.anchorBackendIndex
    }

    const startedAt = typeof build.startedAt === 'number' ? build.startedAt : 0
    const firstAfterStart = chatStore.allMessages.find(m =>
      typeof m.backendIndex === 'number' &&
      (startedAt <= 0 || (typeof m.timestamp === 'number' && m.timestamp >= startedAt))
    )
    if (typeof firstAfterStart?.backendIndex === 'number') return firstAfterStart.backendIndex

    if (allMessageIndexBounds.value.lastIndexed !== null) {
      return allMessageIndexBounds.value.lastIndexed + 1
    }
    return allMessageIndexBounds.value.nextFallbackIndex
  })

  const buildPanelLabel = computed(() => 'Build')
  const buildPanelName = computed(() => chatStore.activeBuild?.title || '')

  const buildTotal = computed(() => buildTodoItems.value.filter(t => t.status !== 'cancelled').length)
  const buildCompleted = computed(() => buildTodoItems.value.filter(t => t.status === 'completed').length)
  const buildCurrentText = computed(() => {
    const list = buildTodoItems.value
    const inProgress = list.find(t => t.status === 'in_progress')
    if (inProgress) return inProgress.text
    const next = list.find(t => t.status === 'pending')
    if (next) return next.text
    return ''
  })

  /**
   * activeBuildPlanSync 增量缓存：以 build 对象引用 + 前缀消息引用快照作指纹。
   * 指纹不变时仅扫描尾部新增消息（含旧尾消息——流式期间其 tools 会被原地改写），
   * 其余结构变更/build 变更自动回退全量扫描。chatStore 是单例，模块级缓存跨实例共享安全。
   */
  let activeBuildPlanSyncCache: {
    build: unknown
    scannedCount: number
    messagesRef: Message[]
    latest: { kind: 'revision' | 'progress_sync'; content?: string; order: number } | null
  } | null = null

  const activeBuildPlanSync = computed<null | {
    kind: 'revision' | 'progress_sync'
    content?: string
    signature: string
  }>(() => {
    const build = chatStore.activeBuild
    if (!build?.planPath) {
      activeBuildPlanSyncCache = null
      return null
    }

    const buildAnchor = typeof build.anchorBackendIndex === 'number' ? build.anchorBackendIndex : null
    let latest: { kind: 'revision' | 'progress_sync'; content?: string; order: number } | null = null

    const messages = chatStore.allMessages
    const len = messages.length
    let fromIndex = 0

    // 前缀引用校验：同一 build 且缓存窗口是当前窗口的前缀（含尾消息原地替换）时只扫尾部
    const cache = activeBuildPlanSyncCache
    if (cache !== null && cache.build === build && cache.messagesRef.length <= len) {
      let prefixOk = true
      for (let i = 0; i < cache.scannedCount; i++) {
        if (messages[i] !== cache.messagesRef[i]) {
          prefixOk = false
          break
        }
      }
      if (prefixOk) {
        latest = cache.latest
        fromIndex = cache.scannedCount
      }
    }

    for (let i = fromIndex; i < len; i++) {
      const msg = messages[i]
      if (msg.role !== 'assistant' || !Array.isArray(msg.tools) || msg.tools.length === 0) continue

      const isAfterBuildStart = (
        typeof msg.backendIndex === 'number' && buildAnchor !== null
          ? msg.backendIndex >= buildAnchor
          : typeof msg.timestamp === 'number'
            ? msg.timestamp >= build.startedAt
            : false
      )
      if (!isAfterBuildStart) continue

      for (const tool of msg.tools) {
        if (tool.name !== 'update_plan') continue

        const mergedResult = getMergedToolResult(tool)
        if (tool.status === 'error' || mergedResult.success === false) continue

        const toolPath = typeof (mergedResult as any)?.data?.path === 'string'
          ? String((mergedResult as any).data.path).trim()
          : typeof (tool.args as any)?.path === 'string'
            ? String((tool.args as any).path).trim()
            : ''
        if (!toolPath || toolPath !== build.planPath) continue

        const updateMode = getPlanUpdateMode(mergedResult, tool.args)
        const order = typeof msg.backendIndex === 'number' ? msg.backendIndex : (msg.timestamp || 0)
        if (updateMode === 'revision') {
          latest = { kind: 'revision', order }
          continue
        }

        const content = typeof (mergedResult as any)?.data?.content === 'string' ? String((mergedResult as any).data.content) : ''
        if (!content) continue
        latest = { kind: 'progress_sync', content, order }
      }
    }

    // 尾消息可能在流式期间原地变更（tools 追加/状态改写），始终不纳入缓存
    activeBuildPlanSyncCache = {
      build,
      scannedCount: Math.max(0, len - 1),
      messagesRef: messages,
      latest
    }

    if (!latest) return null
    return latest.kind === 'revision'
      ? { kind: 'revision', signature: `revision:${latest.order}` }
      : { kind: 'progress_sync', content: latest.content, signature: `progress_sync:${latest.order}:${latest.content || ''}` }
  })

  watch(
    () => chatStore.activeBuild?.id,
    (id, prev) => {
      if (id && id !== prev) {
        isBuildExpanded.value = false
      }
    }
  )

  watch(
    () => chatStore.isWaitingForResponse,
    (waiting) => {
      if (!waiting && chatStore.activeBuild && chatStore.activeBuild.status === 'running') {
        void chatStore.setActiveBuild({ ...chatStore.activeBuild, status: 'done' }).catch(error => {
          console.error('[MessageList] Failed to finalize active build:', error)
        })
      }
    }
  )

  watch(
    () => activeBuildPlanSync.value?.signature,
    async () => {
      const build = chatStore.activeBuild
      const sync = activeBuildPlanSync.value
      if (!build || !sync) return

      try {
        if (sync.kind === 'revision') {
          await chatStore.setActiveBuild(null)
          return
        }

        if (sync.kind === 'progress_sync' && sync.content && sync.content !== build.planContent) {
          await chatStore.setActiveBuild({ ...build, planContent: sync.content })
        }
      } catch (error) {
        console.error('[MessageList] Failed to synchronize active build:', error)
      }
    },
    { immediate: true }
  )

  watch(showBuildBar, (visible) => {
    if (!visible) isBuildExpanded.value = false
  })

  return {
    isBuildExpanded,
    replayedBuildTodoState,
    replayedBuildTodoList,
    buildTodoItems,
    showBuildBar,
    buildAnchorBackendIndex,
    buildPanelLabel,
    buildPanelName,
    buildTotal,
    buildCompleted,
    buildCurrentText,
    activeBuildPlanSync
  }
}
