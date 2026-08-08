<script lang="ts">
/**
 * MessageList UI 状态（H5/M2-1）：模块级保存与清理逻辑已提升到 messageListUiState.ts，
 * 避免 store 层（tabActions.closeTab 清理接线）与组件层循环导入；此处仅保留对外再导出。
 */
export type { RestoreNoticeState, MessageListUiState } from './messageListUiState'
export {
  messageListUiStateByTab,
  MESSAGE_LIST_UI_STATE_CAP,
  pruneMessageListUiStateByTab
} from './messageListUiState'
</script>

<script setup lang="ts">
/**
 * MessageList - 消息列表容器
 * 扁平化设计，简洁加载动画
 */

import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { CustomScrollbar, DeleteDialog, Tooltip, ConfirmDialog } from '../common'
import MessageItem, { pruneBackgroundTaskViewModes, pruneThoughtViewModes } from './MessageItem.vue'
import { pruneMediumTrimmedByMessageId } from './MessageRenderBlock.vue'
import SummaryMessage from './SummaryMessage.vue'
import { messageListUiStateByTab, MESSAGE_LIST_UI_STATE_CAP, type RestoreNoticeState } from './messageListUiState'
import { useChatStore } from '../../stores'
import { formatTime } from '../../utils/format'
import { useI18n } from '../../i18n'
import type { Message, CheckpointRecord, Attachment } from '../../types'
import { extractTodosFromPlan } from '../../utils/taskCards'
import {
  normalizeTodoStatus,
  type TodoStatus as BuildTodoStatus
} from '../../utils/todoList'
import { getPlanExecutionPrompt, getPlanUpdateMode } from '../../utils/toolContinuations'
import { resolveLoadedVisibleMessages } from './messageListUtils'
import { isRetryableError, recentInterruptDeliveries, clearInterruptDeliveries } from '../../stores/chat/messageActions'
import { clearLineDiffCache } from '../../utils/lineDiff'
import DirtyFilesConfirm from './DirtyFilesConfirm.vue'

const { t } = useI18n()

const props = defineProps<{
  messages: Message[]
  /** 标签页 ID，标识此 MessageList 实例所属的标签页 */
  tabId: string
}>()

// 从 store 读取等待状态
const chatStore = useChatStore()

// ============ Build（Plan 执行）顶部卡片 ============
type BuildTodoItem = { id: string; text: string; status: BuildTodoStatus }
const isBuildExpanded = ref(false)



const replayedBuildTodoState = computed(() => {
  return chatStore.todoSnapshot
})

const replayedBuildTodoList = computed(() => {
  return replayedBuildTodoState.value.todos
})

const todoBarItems = computed<BuildTodoItem[]>(() => {
  const list = replayedBuildTodoList.value
  if (!list || list.length === 0) return []

  return list
    .map(t => ({
      id: String(t.id),
      text: String(t.content || '').trim(),
      status: normalizeTodoStatus(t.status)
    }))
    .filter(t => t.text.length > 0)
})

// M2-2：删除实例级 todoExpandedMap，统一走模块级 messageListUiStateByTab（按 tabId），
// 避免与 uiStateByTab.todoExpanded 语义分叉（两个来源互相覆盖）。
const isTodoExpanded = ref(false)


function getMergedToolResult(tool: any): Record<string, unknown> {
  const fromTool = tool?.result && typeof tool.result === 'object' ? tool.result as Record<string, unknown> : {}
  const fromResponseRaw = typeof tool?.id === 'string' && tool.id
    ? chatStore.getToolResponseById(tool.id)
    : undefined
  const fromResponse = fromResponseRaw && typeof fromResponseRaw === 'object'
    ? fromResponseRaw as Record<string, unknown>
    : {}

  return { ...fromTool, ...fromResponse }
}

function hasConfirmedPlanExecution(tool: any): boolean {
  if (!tool) return false
  if (tool.name !== 'create_plan' && tool.name !== 'update_plan') return false
  const fromTool = tool.result && typeof tool.result === 'object' ? tool.result as Record<string, unknown> : undefined
  const fromResponseRaw = typeof tool.id === 'string' && tool.id
    ? chatStore.getToolResponseById(tool.id)
    : undefined
  const fromResponse = fromResponseRaw && typeof fromResponseRaw === 'object'
    ? fromResponseRaw as Record<string, unknown>
    : undefined
  const merged = {
    ...(fromTool || {}),
    ...(fromResponse || {})
  }

  return getPlanExecutionPrompt(merged).length > 0
}

function isTodoInitToolForSticky(tool: any): boolean {
  if (!tool) return false
  if (tool.name === 'todo_write') return true
  if (tool.name === 'create_plan') return hasConfirmedPlanExecution(tool)
  if (tool.name === 'update_plan') {
    return getPlanUpdateMode(getMergedToolResult(tool), tool.args) !== 'progress_sync' && hasConfirmedPlanExecution(tool)
  }
  return false
}

// 模块级常量：todo 相关工具名集合（todoStickyMeta 的轻量预过滤用，避免每次评估重建 Set）
const TODO_TOOL_NAME_SET = new Set(['todo_write', 'create_plan', 'update_plan'])

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

const allMessageIndexBounds = computed(() => {
  let firstIndexed: number | null = null
  let lastIndexed: number | null = null

  for (const message of chatStore.allMessages) {
    if (typeof message.backendIndex !== 'number' || !Number.isFinite(message.backendIndex)) continue
    if (firstIndexed === null) firstIndexed = message.backendIndex
    lastIndexed = message.backendIndex
  }

  return {
    firstIndexed,
    lastIndexed,
    nextFallbackIndex: chatStore.windowStartIndex + chatStore.allMessages.length
  }
})

const todoStickyMeta = computed(() => {
  const fallbackName = t('components.message.tool.todoWrite.label')
  const messages = chatStore.allMessages

  // 工具名先于昂贵的合并判定做轻量过滤：todo_write / create_plan / update_plan 之外的
  // 消息直接跳过（isTodoInitToolForSticky 含 getMergedToolResult + 确认文案判定，仅对有
  // 相关工具名的消息调用），窗口内没有任何相关工具名时直接返回空态
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !Array.isArray(msg.tools)) continue
    const hasTodoToolName = msg.tools.some(t => TODO_TOOL_NAME_SET.has(t.name))
    if (!hasTodoToolName) continue
    const initTool = msg.tools.find(tool => isTodoInitToolForSticky(tool))
    if (!initTool) continue

    let panelName = fallbackName
    if (initTool.name === 'create_plan' || initTool.name === 'update_plan') {
      const title = typeof (initTool.args as any)?.title === 'string' ? (initTool.args as any).title.trim() : ''
      if (title) {
        panelName = title
      } else {
        const path = typeof (initTool.args as any)?.path === 'string' ? (initTool.args as any).path.trim() : ''
        if (path) {
          const normalized = path.replace(/\\/g, '/')
          const name = normalized.split('/').filter(Boolean).pop() || path
          panelName = name.replace(/\.md$/i, '')
        } else {
          panelName = t('components.message.tool.createPlan.fallbackTitle')
        }
      }
    }

    const anchorBackendIndex =
      typeof msg.backendIndex === 'number' && Number.isFinite(msg.backendIndex)
        ? msg.backendIndex + 1
        : null

    return {
      hasTodoInitTool: true,
      anchorBackendIndex,
      panelName
    }
  }

  return {
    hasTodoInitTool: false,
    anchorBackendIndex: null,
    panelName: fallbackName
  }
})

const hasTodoInitTool = computed(() => todoStickyMeta.value.hasTodoInitTool)

// 仅保留一个会话级 TODO 条；有 activeBuild 时沿用 Build 条展示，避免双条重叠。
const showTodoBar = computed(() => {
  return (
    !showBuildBar.value &&
    hasTodoInitTool.value &&
    todoBarItems.value.length > 0
  )
})

const todoInitAnchorBackendIndex = computed<number | null>(() => todoStickyMeta.value.anchorBackendIndex)

const todoAnchorBackendIndex = computed<number | null>(() => {
  if (!showTodoBar.value) return null

  if (todoInitAnchorBackendIndex.value !== null) {
    return todoInitAnchorBackendIndex.value
  }

  const anchor = replayedBuildTodoState.value.anchorBackendIndex
  if (typeof anchor === 'number' && Number.isFinite(anchor)) return anchor

  if (allMessageIndexBounds.value.firstIndexed !== null) {
    return allMessageIndexBounds.value.firstIndexed
  }

  if (allMessageIndexBounds.value.lastIndexed !== null) {
    return allMessageIndexBounds.value.lastIndexed + 1
  }

  return allMessageIndexBounds.value.nextFallbackIndex
})

const todoPanelName = computed(() => todoStickyMeta.value.panelName)

const todoTotal = computed(() => todoBarItems.value.filter(t => t.status !== 'cancelled').length)
const todoCompleted = computed(() => todoBarItems.value.filter(t => t.status === 'completed').length)
const todoCurrentText = computed(() => {
  const inProgress = todoBarItems.value.find(t => t.status === 'in_progress')
  if (inProgress) return inProgress.text
  const next = todoBarItems.value.find(t => t.status === 'pending')
  if (next) return next.text
  return ''
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
      void chatStore.setActiveBuild({ ...chatStore.activeBuild, status: 'done' })
    }
  }
)

watch(
  () => activeBuildPlanSync.value?.signature,
  async () => {
    const build = chatStore.activeBuild
    const sync = activeBuildPlanSync.value
    if (!build || !sync) return

    if (sync.kind === 'revision') {
      await chatStore.setActiveBuild(null)
      return
    }

    if (sync.kind === 'progress_sync' && sync.content && sync.content !== build.planContent) {
      await chatStore.setActiveBuild({ ...build, planContent: sync.content })
    }
  },
  { immediate: true }
)

watch(showBuildBar, (visible) => {
  if (!visible) isBuildExpanded.value = false
})


/** 根据当前标签页的模块级 UI 状态恢复 TODO 展开状态（M2-2：单一数据源） */
function restoreTodoExpandedState() {
  if (!showTodoBar.value) return
  const saved = uiStateByTab.get(props.tabId)
  if (saved) {
    isTodoExpanded.value = saved.todoExpanded
  }
  // 无保存记录时保持当前 ref 值（组件实例生命周期内用户的选择不丢失）
}

// showTodoBar 变为可见时，恢复该对话记忆的展开状态
watch(showTodoBar, (visible) => {
  if (!visible) return
  restoreTodoExpandedState()
})

/** 切换 TODO 展开/折叠（M2-2：只更新 ref；写回 uiStateByTab 由切换标签页时 saveCurrentUiState 完成） */
function toggleTodoExpanded() {
  isTodoExpanded.value = !isTodoExpanded.value
  const saved = uiStateByTab.get(props.tabId)
  if (saved) {
    saved.todoExpanded = isTodoExpanded.value
  }
}

// 消息分页显示逻辑：解决消息过多导致的输入卡顿
const VISIBLE_INCREMENT = 40
// 连续空页上限：后端返回 loaded=true 但无新增消息时停止继续拉取，避免死循环
const MAX_EMPTY_LOAD_PAGES = 3
const visibleCount = ref(VISIBLE_INCREMENT)

// 是否还有更多“未加载到窗口”的历史消息
const hasMoreHistory = computed(() => chatStore.windowStartIndex > 0)
// 顶部加载指示器：后端有更多消息 或 前端还有已加载但未渲染的消息
const hasMore = computed(() => hasMoreHistory.value || visibleCount.value < props.messages.length)

// 增强的消息对象接口
interface EnhancedMessage {
  message: Message
  backendIndex: number
  beforeCheckpoints: CheckpointRecord[]
  afterCheckpoints: CheckpointRecord[]
}

// 预计算可见消息的增强信息，避免在模板中进行昂贵的计算
const checkpointsByMsgIndex = computed(() => chatStore.checkpointsByMessageIndex)

const mergeableCheckpointKeys = computed(() => {
  const keys = new Set<string>()
  if (!chatStore.mergeUnchangedCheckpoints) return keys

  for (const [messageIndex, group] of checkpointsByMsgIndex.value.entries()) {
    if (!group.before.length || !group.after.length) continue
    const beforeHashes = new Map<string, string>()
    for (const cp of group.before) {
      if (cp.contentHash) beforeHashes.set(cp.toolName, cp.contentHash)
    }
    for (const cp of group.after) {
      const beforeHash = beforeHashes.get(cp.toolName)
      if (beforeHash && cp.contentHash && beforeHash === cp.contentHash) {
        keys.add(`${messageIndex}:${cp.toolName}`)
      }
    }
  }

  return keys
})

const enhancedVisibleMessages = computed<EnhancedMessage[]>(() => {
  const visibleMessages = resolveLoadedVisibleMessages(props.messages, visibleCount.value)

  // 预先按消息索引对检查点进行分组
  return visibleMessages.map(message => {
    const backendIndex = typeof message.backendIndex === 'number' ? message.backendIndex : -1
    const cpGroup = backendIndex !== -1 ? checkpointsByMsgIndex.value.get(backendIndex) : null
    
    return {
      message,
      backendIndex,
      beforeCheckpoints: cpGroup?.before || [],
      afterCheckpoints: cpGroup?.after || []
    }
  })
})


type RenderRow =
  | { kind: 'build'; key: 'build-bar' }
  | { kind: 'message'; key: string; item: EnhancedMessage }
  | { kind: 'todo'; key: 'todo-bar' }
  | { kind: 'summarize-divider'; key: string }

function shouldInsertSticky(anchor: number | null, idx: number): boolean {
  return anchor === null || (typeof idx === 'number' && idx >= 0 && idx >= anchor)
}

const messageRenderRows = computed<RenderRow[]>(() => {
  const visible = enhancedVisibleMessages.value
  const rows: RenderRow[] = []
  const buildAnchor = buildAnchorBackendIndex.value
  const todoAnchor = todoAnchorBackendIndex.value

  let buildInserted = !showBuildBar.value
  let todoInserted = !showTodoBar.value

  // 逻辑截断：最后一个总结消息之后渲染横线，分隔「已总结区域」与「未总结区域」。
  // 被总结消息（isSummarized）原文照常显示（不折叠），横线作为两者边界。
  let lastSummaryBackendIndex: number | null = null
  for (const item of visible) {
    if (item.message.isSummary && typeof item.backendIndex === 'number') {
      lastSummaryBackendIndex = item.backendIndex
    }
  }

  for (const item of visible) {
    const idx = item.backendIndex
    if (!buildInserted && shouldInsertSticky(buildAnchor, idx)) {
      rows.push({ kind: 'build', key: 'build-bar' })
      buildInserted = true
    }

    if (!todoInserted && shouldInsertSticky(todoAnchor, idx)) {
      rows.push({ kind: 'todo', key: 'todo-bar' })
      todoInserted = true
    }

    rows.push({ kind: 'message', key: item.message.id, item })

    // 在最后一个总结消息之后插入分隔线（已总结 / 未总结分界）
    if (lastSummaryBackendIndex !== null && idx === lastSummaryBackendIndex) {
      rows.push({ kind: 'summarize-divider', key: `summarize-divider:${idx}` })
    }
  }

  if (!buildInserted && showBuildBar.value) {
    rows.push({ kind: 'build', key: 'build-bar' })
  }

  if (!todoInserted && showTodoBar.value) {
    rows.push({ kind: 'todo', key: 'todo-bar' })
  }

  return rows
})

// 是否正在加载更多（用于节流）
const viewportHeight = ref(0)

const isLoadingMore = ref(false)

// 加载更多历史消息（先展示已加载的，再按需从后端拉更早一页）
async function loadMore() {
  if (isLoadingMore.value || !hasMore.value) return
  if (!scrollbarRef.value) return
  const container = scrollbarRef.value.getContainer()
  if (!container) return

  // 固化发起时的标签页与会话身份
  const originTabId = props.tabId

  isLoadingMore.value = true
  const oldScrollHeight = container.scrollHeight
  const oldScrollTop = container.scrollTop

  try {
    const needBackendLoad = hasMoreHistory.value
    const needFrontendExpand = visibleCount.value < props.messages.length

    // 优先展开前端已加载但未渲染的消息
    if (needFrontendExpand) {
      visibleCount.value += VISIBLE_INCREMENT
    }

    // 如果后端还有更多消息，再拉取
    if (needBackendLoad) {
      const prevLen = props.messages.length
      await nextTick()

      await chatStore.loadOlderMessagesPage()
      await nextTick()

      // 校验归属：await 期间可能已切换标签页或对话
      if (props.tabId !== originTabId) return

      if (props.messages.length <= prevLen) {
        // 如果这一页没有新增可见消息，继续尝试下一页
        // 连续空页上限：后端返回 loaded=true 但无新增（空页）时停止，避免死循环
        let emptyPages = 0
        while (hasMoreHistory.value && props.tabId === originTabId && emptyPages < MAX_EMPTY_LOAD_PAGES) {
          const currentLen = props.messages.length
          const loaded = await chatStore.loadOlderMessagesPage()
          await nextTick()

          if (props.tabId !== originTabId) break

          if (!loaded || props.messages.length > currentLen) {
            break
          }
          emptyPages++
        }
      }
    }
  } catch (error) {
    // 拉取失败：记录日志，加载标记在 finally 中复位
    console.error('[MessageList] Failed to load older messages:', error)
  } finally {
    // 无条件复位加载标记，避免切走标签页后该标签页上拉加载永久禁用（H4）
    isLoadingMore.value = false
    // 仅当标签页未切换时才修正滚动位置
    if (props.tabId === originTabId) {
      const newScrollHeight = container.scrollHeight
      container.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight)
    }
  }
}

// 滚动事件处理：实现自动加载
function handleScroll(e: Event) {
  const container = e.target as HTMLElement
  if (!container) return
  if (viewportHeight.value !== container.clientHeight) {
    viewportHeight.value = container.clientHeight
  }
  
  // 当滚动到距离顶部 100px 以内时自动加载
  if (hasMore.value && !isLoadingMore.value && container.scrollTop < 100) {
    loadMore()
  }
}

// CustomScrollbar 引用
const scrollbarRef = ref<InstanceType<typeof CustomScrollbar> | null>(null)

// 标记是否需要滚动到底部（切换对话时设置）
const needsScrollToBottom = ref(false)
const suppressConversationReset = ref(false)

// 使用模块级 Map（H5）：组件卸载后滚动位置/展开状态不丢失
const uiStateByTab = messageListUiStateByTab

/**
 * M1-1：收集「仍可能被渲染」的消息 ID 并集（当前窗口 + 各标签页快照），
 * 供 pruneBackgroundTaskViewModes 清理已删除/已关闭会话遗留的视图模式记录。
 */
function collectActiveBackgroundTaskMessageIds(): Set<string> {
  const ids = new Set<string>()
  for (const msg of chatStore.allMessages) {
    if (msg?.id) ids.add(msg.id)
  }
  for (const snapshot of chatStore.sessionSnapshots.values()) {
    for (const msg of snapshot.allMessages) {
      if (msg?.id) ids.add(msg.id)
    }
  }
  return ids
}

function saveCurrentUiState(tabId?: string) {
  if (!tabId) return
  // M2-1：已关闭的标签页不再保存（closeTab 已清理其 UI 状态，
  // 避免关闭活跃标签页后 watcher 又把旧记录写回造成泄漏）
  if (!chatStore.openTabs.some(t => t.id === tabId)) return
  const container = scrollbarRef.value?.getContainer()
  uiStateByTab.set(tabId, {
    scrollTop: container?.scrollTop || 0,
    visibleCount: visibleCount.value,
    buildExpanded: isBuildExpanded.value,
    todoExpanded: isTodoExpanded.value,
    restoreNotice: restoreNotice.value ? { ...restoreNotice.value } : null
  })
  // M2-1：容量上限兜底（优先淘汰最旧的非当前记录）
  if (uiStateByTab.size > MESSAGE_LIST_UI_STATE_CAP) {
    let overflow = uiStateByTab.size - MESSAGE_LIST_UI_STATE_CAP
    for (const key of Array.from(uiStateByTab.keys())) {
      if (key === tabId) continue
      uiStateByTab.delete(key)
      overflow--
      if (overflow <= 0) break
    }
  }
}

function restoreUiState(tabId?: string) {
  if (!tabId) return
  const saved = uiStateByTab.get(tabId)
  if (saved) {
    visibleCount.value = saved.visibleCount
    isBuildExpanded.value = saved.buildExpanded
    isTodoExpanded.value = saved.todoExpanded
    restoreNotice.value = saved.restoreNotice ?? null
    needsScrollToBottom.value = false
    nextTick(() => {
      const container = scrollbarRef.value?.getContainer()
      if (container) {
        container.scrollTop = saved.scrollTop
      }
      suppressConversationReset.value = false
    })
    return
  }

  visibleCount.value = VISIBLE_INCREMENT
  needsScrollToBottom.value = true
  restoreTodoExpandedState()
  nextTick(() => {
    tryScrollToBottom({ instant: true })
    suppressConversationReset.value = false
  })
}

// ResizeObserver 引用
let resizeObserver: ResizeObserver | null = null

watch(() => props.tabId, (newTabId, oldTabId) => {
  suppressConversationReset.value = true
  if (oldTabId && oldTabId !== newTabId) {
    saveCurrentUiState(oldTabId)
    // M1-1：对话/标签页切换时清理已不存在的消息视图模式（非渲染热路径，仅切换时执行）
    const activeIds = collectActiveBackgroundTaskMessageIds()
    pruneBackgroundTaskViewModes(activeIds)
    pruneThoughtViewModes(activeIds)
    pruneMediumTrimmedByMessageId(activeIds)
  }
  restoreUiState(newTabId)
}, { immediate: true })

// 监听对话切换：当前活跃标签页内加载新对话时，重置分页并滚动到底部
watch(() => chatStore.currentConversationId, (newId, oldId) => {
  if (suppressConversationReset.value) return
  if (newId === oldId) return

  // 重置分页计数（新对话从最后一页开始显示）
  visibleCount.value = VISIBLE_INCREMENT
  // 标记需要滚动到底部
  needsScrollToBottom.value = true
  nextTick(() => tryScrollToBottom({ instant: true }))
})

// 监听消息变化，当消息加载完成时尝试滚动
watch(() => props.messages, (newMessages) => {
  // 当消息加载完成时，尝试滚动
  // 如果容器还没有尺寸（display: none），ResizeObserver 会在可见时触发
  if (needsScrollToBottom.value && newMessages.length > 0) {
    tryScrollToBottom({ instant: true })
  }
}, { deep: false })

// 尝试滚动到底部（会检查容器是否准备好）
function tryScrollToBottom(options?: { instant?: boolean }) {
  if (!scrollbarRef.value) return
  
  const container = scrollbarRef.value.getContainer()
  if (!container) return
  
  // 检查容器是否有尺寸（可见状态）
  if (container.scrollHeight > 0 && container.clientHeight > 0) {
    if (needsScrollToBottom.value) {
      needsScrollToBottom.value = false
      scrollbarRef.value.scrollToBottom(options?.instant ? { instant: true } : undefined)
    }
  }
  // 如果容器还没有尺寸，ResizeObserver 会在可见时触发
}

// 设置 ResizeObserver 监听容器尺寸变化
onMounted(() => {
  // 使用 nextTick 确保 scrollbarRef 已经绑定
  nextTick(() => {
    if (!scrollbarRef.value) return
    
    const container = scrollbarRef.value.getContainer()
    if (!container) return
    
    // 添加滚动事件监听以支持自动加载
    viewportHeight.value = container.clientHeight
    container.addEventListener('scroll', handleScroll, { passive: true })
    
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { height } = entry.contentRect
        if (height > 0) {
          viewportHeight.value = height
        }
        
        // 当容器从 0 高度变为有高度时，尝试滚动
        if (height > 0 && needsScrollToBottom.value) {
          // 使用 requestAnimationFrame 确保布局完成
          requestAnimationFrame(() => {
            tryScrollToBottom({ instant: true })
          })
        }
      }
    })
    
    resizeObserver.observe(container)
  })
})

// 清理监听器
onBeforeUnmount(() => {
  if (scrollbarRef.value) {
    const container = scrollbarRef.value.getContainer()
    if (container) {
      container.removeEventListener('scroll', handleScroll)
    }
  }

  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  saveCurrentUiState(props.tabId)

  // A-M2：消息列表卸载后不再有 diff 面板消费方，主动释放模块级行级差分缓存
  clearLineDiffCache()
})

const emit = defineEmits<{
  edit: [messageId: string, newContent: string, attachments: Attachment[], mode?: 'branch' | 'keep']
  delete: [messageId: string]
  retry: [messageId: string]
  copy: [content: string]
  restoreCheckpoint: [checkpointId: string]
  restoreAndRetry: [messageId: string, checkpointId: string]
  restoreAndEdit: [messageId: string, newContent: string, attachments: Attachment[], checkpointId: string]
}>()

// 删除确认对话框状态
const showDeleteConfirm = ref(false)
const pendingDeleteMessageId = ref<string | null>(null)
const pendingDeleteBackendIndex = ref<number | null>(null)

// 恢复检查点确认对话框状态
// CP-09: 所有恢复入口（普通恢复 / 回档并重试 / 回档并删除 / 回档并编辑）
// 先预览（计算待删除文件清单），确认框展示清单，用户确认后才真正执行恢复。
interface PendingRestoreAction {
  kind: 'restore' | 'retry' | 'delete' | 'edit'
  /** M-8: 发起预览时固化的对话身份；确认时校验，避免恢复错误对话的存档 */
  conversationId: string
  checkpointId: string
  messageId?: string
  newContent?: string
  attachments?: Attachment[]
  preview: Awaited<ReturnType<typeof chatStore.previewRestore>>
}
const showRestoreConfirm = ref(false)
const pendingRestoreAction = ref<PendingRestoreAction | null>(null)

// 确认框展示的删除清单上限（超出显示省略计数）
const RESTORE_DELETE_LIST_LIMIT = 30
const isRestorePreviewing = computed(() => chatStore.isRestorePreviewing)
// L-1: 当前正在预览的检查点 ID——只对发起预览的那个恢复按钮显示 spinner，避免全局转圈
const previewingCheckpointId = ref<string | null>(null)

// H-3: 恢复类结果（失败/部分失败/警告/成功）用独立提示样式展示，不再塞入 chatStore.error，
// 避免错误条“重试”按钮误触发 retryAfterError → LLM 重新生成。
const restoreNotice = ref<RestoreNoticeState | null>(null)

function showRestoreNotice(kind: RestoreNoticeState['kind'], message: string) {
  restoreNotice.value = { kind, message }
}

const restoreNoticeIconClass = computed(() => {
  switch (restoreNotice.value?.kind) {
    case 'partial': return 'codicon-warning'
    case 'warning': return 'codicon-info'
    case 'success': return 'codicon-check'
    default: return 'codicon-error'
  }
})

const restoreNoticeTitle = computed(() => {
  switch (restoreNotice.value?.kind) {
    case 'partial': return t('components.message.checkpoint.restoreResultPartialTitle')
    case 'warning': return t('components.message.checkpoint.restoreResultWarningTitle')
    case 'success': return t('components.message.checkpoint.restoreResultSuccessTitle')
    default: return t('components.message.checkpoint.restoreResultErrorTitle')
  }
})

// ============ U1 忙时投递（M3-1）轻量回显 ============
// 忙时发送的用户消息改走 chat.sendInterruptMessage（主会话 inbox），窗口内无痕迹；
// 这里读取 messageActions 记录的「最近投递 / 投递失败」状态，在消息区给出轻量提示。
const interruptNotices = computed(() => {
  const convId = chatStore.currentConversationId
  if (!convId) return []
  return recentInterruptDeliveries.value.filter(n => n.conversationId === convId)
})

// 当前回合结束（流式与等待均结束）时，清除本会话的投递提示——
// 提示文案承诺「将在当前回合结束后处理」，回合结束即失效。
watch(
  [() => chatStore.isStreaming, () => chatStore.isWaitingForResponse],
  ([streaming, waiting]) => {
    if (!streaming && !waiting) {
      const convId = chatStore.currentConversationId
      if (convId) clearInterruptDeliveries(convId)
    }
  }
)


// 计算要删除的消息数量（使用 allMessages）
const deleteCount = computed(() => {
  if (pendingDeleteBackendIndex.value === null) return 0
  // backendIndex 为绝对索引：删除数量 = total - index
  const total = chatStore.totalMessages || 0
  const idx = pendingDeleteBackendIndex.value
  if (idx < 0) return 0
  return Math.max(0, total - idx)
})


// 处理编辑
function handleEdit(messageId: string, newContent: string, attachments: Attachment[], mode: 'branch' | 'keep' = 'branch') {
  emit('edit', messageId, newContent, attachments, mode)
}

// 处理删除 - 显示确认对话框
function handleDelete(messageId: string) {
  pendingDeleteMessageId.value = messageId
  const msg = chatStore.allMessages.find(m => m.id === messageId)
  pendingDeleteBackendIndex.value = typeof msg?.backendIndex === 'number' ? msg.backendIndex : null
  showDeleteConfirm.value = true
}

// 确认删除 - 使用 allMessages 中的真实索引
function confirmDelete() {
  if (!pendingDeleteMessageId.value) return
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === pendingDeleteMessageId.value)
  if (actualIndex !== -1) {
    chatStore.deleteMessage(actualIndex)
  }
  pendingDeleteMessageId.value = null
  pendingDeleteBackendIndex.value = null
}

// 取消删除
function cancelDelete() {
  pendingDeleteMessageId.value = null
  pendingDeleteBackendIndex.value = null
}

// 获取用于删除消息的最新检查点
// 之前消息的存档点：包含所有阶段（before/after），因为这些代表已完成的操作状态
// 当前消息的存档点：只包含 before 阶段，因为用户要撤销的是这条消息的效果
// 与重试使用相同的策略
const deleteCheckpoints = computed<CheckpointRecord[]>(() => {
  if (pendingDeleteBackendIndex.value === null) return []
  const messageIndex = pendingDeleteBackendIndex.value
  
  return chatStore.checkpoints
    .filter(cp => {
      if (cp.messageIndex < messageIndex) return true          // 之前的消息：包含所有阶段
      if (cp.messageIndex === messageIndex && cp.phase === 'before') return true  // 当前消息：只包含 before
      return false
    })
})

// 处理回档并删除
async function handleRestoreAndDelete(checkpointId: string) {
  if (!pendingDeleteMessageId.value) return
  
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === pendingDeleteMessageId.value)
  if (actualIndex === -1) return
  
  // 先预览恢复（待删除文件清单），确认后才执行
  await openRestoreConfirm({ kind: 'delete', checkpointId, messageId: pendingDeleteMessageId.value })
}

// 处理重试 - 直接调用 store 方法（确认已在 MessageItem 的 RetryDialog 中完成）
function handleRetry(messageId: string) {
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
  if (actualIndex !== -1) chatStore.retryFromMessage(actualIndex)
}

// 从某条消息创建分支对话
async function handleBranch(messageId: string) {
  const msg = chatStore.allMessages.find(m => m.id === messageId)
  const backendIndex = msg?.backendIndex
  if (typeof backendIndex !== 'number' || !Number.isFinite(backendIndex)) {
    return
  }
  await chatStore.branchFromMessage(backendIndex)
}

// 处理复制
function handleCopy(content: string) {
  emit('copy', content)
}

// 处理错误后重试
function handleErrorRetry() {
  chatStore.retryAfterError()
}

// 处理继续对话（工具执行后中断时）
function handleContinue() {
  chatStore.retryAfterError()
}

// 处理恢复检查点
function handleRestoreCheckpoint(checkpointId: string) {
  const checkpoint = chatStore.checkpoints.find(cp => cp.id === checkpointId)
  if (checkpoint) {
    restoreCheckpoint(checkpoint)
  }
}

// 处理回档并重试
async function handleRestoreAndRetry(messageId: string, checkpointId: string) {
  // 找到消息在 allMessages 中的索引
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
  if (actualIndex === -1) return
  
  // 先预览恢复（待删除文件清单），确认后才执行
  await openRestoreConfirm({ kind: 'retry', checkpointId, messageId })
}

// 处理回档并编辑
async function handleRestoreAndEdit(messageId: string, newContent: string, attachments: Attachment[], checkpointId: string) {
  // 找到消息在 allMessages 中的索引
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
  if (actualIndex === -1) return
  
  // 先预览恢复（待删除文件清单），确认后才执行
  await openRestoreConfirm({ kind: 'edit', checkpointId, messageId, newContent, attachments })
}

// 检查特定工具的检查点是否需要合并显示（前后内容一致时合并）
function shouldMergeForTool(messageIndex: number, toolName: string): boolean {
  if (!chatStore.mergeUnchangedCheckpoints) return false
  return mergeableCheckpointKeys.value.has(`${messageIndex}:${toolName}`)
}

// 恢复检查点 - 先预览（计算待删除文件清单），确认框展示清单
async function restoreCheckpoint(checkpoint: CheckpointRecord) {
  await openRestoreConfirm({ kind: 'restore', checkpointId: checkpoint.id })
}

// 预览恢复并打开确认框；预览失败（链断裂/存档缺失等）时直接展示错误，不弹确认
async function openRestoreConfirm(action: Omit<PendingRestoreAction, 'preview' | 'conversationId'>) {
  if (chatStore.isRestorePreviewing) return
  // M-8: 固化对话身份——预览与确认之间可能切换对话，确认时据此校验
  const conversationId = chatStore.currentConversationId
  if (!conversationId) return
  restoreNotice.value = null
  previewingCheckpointId.value = action.checkpointId
  chatStore.isRestorePreviewing = true
  try {
    const preview = await chatStore.previewRestore(action.checkpointId)
    if (!preview.success) {
      showRestoreNotice('error', preview.error || t('components.message.checkpoint.restorePreviewFailed'))
      return
    }
    pendingRestoreAction.value = { ...action, conversationId, preview }
    showRestoreConfirm.value = true
  } catch (err: any) {
    showRestoreNotice('error', err?.message || t('components.message.checkpoint.restorePreviewFailed'))
  } finally {
    chatStore.isRestorePreviewing = false
    previewingCheckpointId.value = null
  }
}

// 确认恢复检查点：按入口类型执行真正的恢复 / 回档操作
async function confirmRestore() {
  const action = pendingRestoreAction.value
  if (!action) return
  showRestoreConfirm.value = false
  pendingRestoreAction.value = null
  restoreNotice.value = null

  // M-8: 校验对话身份——预览/确认期间若用户切换对话，丢弃本次恢复，
  // 避免把恢复/回档执行到错误对话上。
  if (action.conversationId !== chatStore.currentConversationId) {
    showRestoreNotice('error', t('components.message.checkpoint.restoreConversationChanged'))
    return
  }

  const { kind, checkpointId } = action

  if (kind === 'restore') {
    // 用户在确认框中已确认待删除文件清单（含快照后新建文件）→ deleteUntrackedFiles: true
    const result = await chatStore.restoreCheckpoint(checkpointId, true)

    // CP-10 / H-3: 恢复结果用独立提示分级展示（成功/部分成功/警告/失败），
    // 不再塞入 chatStore.error，避免错误条“重试”误触发 LLM 重新生成。
    if (result && !result.success) {
      showRestoreNotice('error', result.error || t('components.message.checkpoint.restoreResultFailed'))
    } else if (result?.failures && result.failures.length > 0) {
      const shown = result.failures.slice(0, 5).map(f => `${f.path}: ${f.reason}`).join('；')
      showRestoreNotice('partial', result.failures.length > 5
        ? t('components.message.checkpoint.restoreResultPartialMore', { files: shown, count: result.failures.length })
        : t('components.message.checkpoint.restoreResultPartial', { files: shown }))
    } else if (result?.unbackedPaths && result.unbackedPaths.length > 0) {
      // 快照时未备份（超限/不可读）的文件不会被本次恢复删除或恢复，明确告知
      const shown = result.unbackedPaths.slice(0, 5).join('、')
      showRestoreNotice('warning', result.unbackedPaths.length > 5
        ? t('components.message.checkpoint.restoreResultUnbackedMore', { paths: shown, count: result.unbackedPaths.length })
        : t('components.message.checkpoint.restoreResultUnbacked', { paths: shown }))
    } else {
      const pruned = result?.autoPrunedCheckpointCount || 0
      showRestoreNotice('success', pruned > 0
        ? t('components.message.checkpoint.restoreResultSuccessWithPrune', { count: result?.restored ?? 0, pruned })
        : t('components.message.checkpoint.restoreResultSuccess', { count: result?.restored ?? 0 }))
    }
    return
  }

  if (action.messageId === undefined) return
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === action.messageId)
  if (actualIndex === -1) return

  if (kind === 'retry') {
    // 用户在确认框中已确认待删除文件清单 → 允许删除快照后新建文件
    await chatStore.restoreAndRetry(actualIndex, checkpointId, true)
  } else if (kind === 'delete') {
    await chatStore.restoreAndDelete(actualIndex, checkpointId, true)
    pendingDeleteMessageId.value = null
    pendingDeleteBackendIndex.value = null
    // R3-#7: 回档并删除确认后关闭删除确认对话框（此前 DeleteDialog 残留打开）
    showDeleteConfirm.value = false
  } else if (kind === 'edit') {
    await chatStore.restoreAndEdit(actualIndex, action.newContent || '', action.attachments, checkpointId, true)
  }
}

// 取消恢复确认：清理暂存的预览/动作状态，避免残留旧清单
function cancelRestoreConfirm() {
  pendingRestoreAction.value = null
}

// 确认框动态文案（按入口类型）
const restoreConfirmTitle = computed(() => {
  if (!pendingRestoreAction.value) return ''
  const kind = pendingRestoreAction.value.kind
  if (kind === 'retry') return t('components.message.checkpoint.restoreConfirmRetryTitle')
  if (kind === 'delete') return t('components.message.checkpoint.restoreConfirmDeleteTitle')
  if (kind === 'edit') return t('components.message.checkpoint.restoreConfirmEditTitle')
  return t('components.message.checkpoint.restoreConfirmTitle')
})

const restoreConfirmMessage = computed(() => {
  const preview = pendingRestoreAction.value?.preview
  if (!preview) return ''
  // 旧版存档（无 fileHashes）：预览无法预知数量，恢复以备份目录内容为准
  if (preview.legacy) {
    return t('components.message.checkpoint.restorePreviewLegacy')
  }
  const parts: string[] = []
  if (preview.restored > 0) parts.push(t('components.message.checkpoint.restorePreviewFilesUpdated', { count: preview.restored }))
  if (preview.deleted > 0) parts.push(t('components.message.checkpoint.restorePreviewFilesDeleted', { count: preview.deleted }))
  if (preview.skipped > 0) parts.push(t('components.message.checkpoint.restorePreviewFilesUnchanged', { count: preview.skipped }))
  return parts.length > 0 ? parts.join('，') : t('components.message.checkpoint.restorePreviewNoChanges')
})

// 待删除文件清单：快照记录过的（deletablePaths）+ 快照后新建、需确认后删除的（untrackedPaths）
const restoreDeletablePaths = computed(() => {
  const preview = pendingRestoreAction.value?.preview
  if (!preview) return []
  return [...preview.deletablePaths, ...preview.untrackedPaths]
})
const restoreHasUntrackedPaths = computed(() => (pendingRestoreAction.value?.preview.untrackedPaths.length || 0) > 0)
const restoreShownDeletablePaths = computed(() => restoreDeletablePaths.value.slice(0, RESTORE_DELETE_LIST_LIMIT))
const restoreHiddenDeletableCount = computed(() => Math.max(0, restoreDeletablePaths.value.length - RESTORE_DELETE_LIST_LIMIT))

const restoreUnbackedPaths = computed(() => pendingRestoreAction.value?.preview.unbackedPaths || [])

// 获取检查点标签
function getCheckpointLabel(cp: CheckpointRecord, phase: 'before' | 'after'): string {
  if (cp.toolName === 'user_message') {
    return phase === 'before' ? t('components.message.checkpoint.userMessageBefore') : t('components.message.checkpoint.userMessageAfter')
  }
  if (cp.toolName === 'model_message') {
    return phase === 'before' ? t('components.message.checkpoint.assistantMessageBefore') : t('components.message.checkpoint.assistantMessageAfter')
  }
  if (cp.toolName === 'tool_batch') {
    return phase === 'before' ? t('components.message.checkpoint.toolBatchBefore') : t('components.message.checkpoint.toolBatchAfter')
  }
  return phase === 'before' ? t('components.message.checkpoint.toolBatchBefore') : t('components.message.checkpoint.toolBatchAfter')
}

// 获取合并后的标签文案
function getMergedLabel(cp: CheckpointRecord): string {
  if (cp.toolName === 'user_message') {
    return t('components.message.checkpoint.userMessageUnchanged')
  }
  if (cp.toolName === 'model_message') {
    return t('components.message.checkpoint.assistantMessageUnchanged')
  }
  if (cp.toolName === 'tool_batch') {
    return t('components.message.checkpoint.toolBatchUnchanged')
  }
  return t('components.message.checkpoint.toolExecutionUnchanged')
}

// 格式化检查点时间（精确到秒，支持友好显示）
function formatCheckpointTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  
  // 判断是否是今天
  const isToday = date.toDateString() === now.toDateString()
  
  // 时间部分 HH:mm:ss
  const timeStr = formatTime(timestamp, 'HH:mm:ss')
  
  if (isToday) {
    // 今天：只显示时间
    return timeStr
  }
  
  // 计算天数差
  const daysDiff = Math.floor(diff / (1000 * 60 * 60 * 24))
  
  if (daysDiff === 1) {
    // 昨天
    return `${t('components.message.checkpoint.yesterday')} ${timeStr}`
  }
  
  if (daysDiff < 7) {
    // 一周内
    return `${t('components.message.checkpoint.daysAgo', { days: daysDiff })} ${timeStr}`
  }
  
  // 超过一周：显示完整日期
  return formatTime(timestamp, 'YYYY-MM-DD HH:mm:ss')
}
</script>

<template>
  <div class="message-list">
    <div class="message-scroll-area">
      <CustomScrollbar ref="scrollbarRef" sticky-bottom show-jump-buttons marker-selector=".user-message, .summary-message" :width="10" :marker-height="10">
      <div class="messages-container">
        <!-- 自动加载更多指示器 -->
        <div v-if="hasMore" class="load-more-container">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span v-if="chatStore.historyFolded" class="load-more-text">
            更早消息已折叠（已丢弃 {{ chatStore.foldedMessageCount }} 条），继续上拉可加载
          </span>
        </div>

        <template v-for="row in messageRenderRows" :key="row.key">
          <div v-if="row.kind === 'build'" class="build-sticky-shell">
            <div class="build-bar" :class="{ expanded: isBuildExpanded }">
              <div class="build-header" @click="isBuildExpanded = !isBuildExpanded">
                <div class="build-title">
                  <i class="codicon codicon-tools build-icon"></i>
                  <span class="build-label">{{ buildPanelLabel }}</span>
                  <span class="build-sep">·</span>
                  <span class="build-name">{{ buildPanelName }}</span>
                </div>

                <div class="build-actions">
                  <span v-if="buildTotal > 0" class="build-progress">{{ buildCompleted }}/{{ buildTotal }}</span>
                  <span v-else class="build-progress">—</span>

                  <button
                    class="build-btn"
                    :title="isBuildExpanded ? t('common.collapse') : t('common.expand')"
                    @click.stop="isBuildExpanded = !isBuildExpanded"
                  >
                    <i class="codicon" :class="isBuildExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down'"></i>
                  </button>
                </div>
              </div>

              <div v-if="!isBuildExpanded && buildCurrentText" class="build-current">
                {{ buildCurrentText }}
              </div>

              <div v-if="isBuildExpanded" class="build-body">
                <div v-if="buildTodoItems.length === 0" class="build-empty">
                  <i class="codicon codicon-info"></i>
                  <span>{{ t('components.message.tool.todoPanel.empty') }}</span>
                </div>

                <div v-else class="build-todos">
                  <div
                    v-for="t in buildTodoItems"
                    :key="t.id"
                    class="build-todo"
                    :class="`status-${t.status}`"
                  >
                    <span class="todo-dot" :class="t.status"></span>
                    <span class="todo-text">{{ t.text }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <template v-else-if="row.kind === 'message'">
            <!-- 消息前的检查点（或合并显示） -->
            <template v-if="row.item.beforeCheckpoints.length > 0">
              <div
                v-for="cp in row.item.beforeCheckpoints"
                :key="cp.id"
                class="checkpoint-bar"
                :class="shouldMergeForTool(row.item.backendIndex, cp.toolName) ? 'checkpoint-merged' : 'checkpoint-before'"
              >
                <div class="checkpoint-icon">
                  <i class="codicon" :class="shouldMergeForTool(row.item.backendIndex, cp.toolName) ? 'codicon-check' : 'codicon-archive'"></i>
                </div>
                <div class="checkpoint-info">
                  <span class="checkpoint-label">
                    {{ shouldMergeForTool(row.item.backendIndex, cp.toolName) ? getMergedLabel(cp) : getCheckpointLabel(cp, 'before') }}
                  </span>
                  <span class="checkpoint-meta">{{ t('components.message.checkpoint.fileCount', { count: cp.fileCount }) }}</span>
                </div>
                <span class="checkpoint-time">{{ formatCheckpointTime(cp.timestamp) }}</span>
                <Tooltip :text="t('components.message.checkpoint.restoreTooltip')">
                  <button class="checkpoint-action" :disabled="isRestorePreviewing || showRestoreConfirm" @click="restoreCheckpoint(cp)">
                    <i v-if="isRestorePreviewing && previewingCheckpointId === cp.id" class="codicon codicon-loading codicon-modifier-spin"></i>
                    <i v-else class="codicon codicon-discard"></i>
                  </button>
                </Tooltip>
              </div>
            </template>
            
            <!-- 总结消息使用专用组件 -->
            <SummaryMessage
              v-if="row.item.message.isSummary"
              :message="row.item.message"
            :message-index="row.item.backendIndex"
            />
            
            <!-- 普通消息使用 MessageItem -->
            <MessageItem
              v-else
              :message="row.item.message"
            :message-index="row.item.backendIndex"
              @edit="handleEdit"
              @delete="handleDelete"
              @retry="handleRetry"
              @copy="handleCopy"
              @branch="handleBranch"
              @restore-checkpoint="handleRestoreCheckpoint"
              @restore-and-retry="handleRestoreAndRetry"
              @restore-and-edit="handleRestoreAndEdit"
            />

            <!-- 消息操作栏内已包含候选切换器（与复制 / 重试同一行） -->
            
            <!-- 消息后的检查点（仅当该工具的内容有变化时显示） -->
            <template v-if="row.item.afterCheckpoints.length > 0">
              <template v-for="cp in row.item.afterCheckpoints" :key="cp.id">
                <!-- 只有当该工具没有被合并时才显示 after 检查点 -->
                <div
                  v-if="!shouldMergeForTool(row.item.backendIndex, cp.toolName)"
                  class="checkpoint-bar checkpoint-after"
                >
                  <div class="checkpoint-icon">
                    <i class="codicon codicon-archive"></i>
                  </div>
                  <div class="checkpoint-info">
                    <span class="checkpoint-label">{{ getCheckpointLabel(cp, 'after') }}</span>
                    <span class="checkpoint-meta">{{ t('components.message.checkpoint.fileCount', { count: cp.fileCount }) }}</span>
                  </div>
                  <span class="checkpoint-time">{{ formatCheckpointTime(cp.timestamp) }}</span>
                  <Tooltip :text="t('components.message.checkpoint.restoreTooltip')">
                    <button class="checkpoint-action" :disabled="isRestorePreviewing || showRestoreConfirm" @click="restoreCheckpoint(cp)">
                      <i v-if="isRestorePreviewing && previewingCheckpointId === cp.id" class="codicon codicon-loading codicon-modifier-spin"></i>
                      <i v-else class="codicon codicon-discard"></i>
                    </button>
                  </Tooltip>
                </div>
              </template>
            </template>
          </template>

          <!-- 已总结区域 / 未总结区域分隔线（逻辑截断：原文保留，仅视觉分界）。
          滚动条黄色标记由每条 SummaryMessage 自身提供，使多次总结都能独立定位。 -->
          <div
            v-else-if="row.kind === 'summarize-divider'"
            class="summarize-divider"
            aria-hidden="true"
          >
            <div class="summarize-divider-line"></div>
          </div>

          <div v-else-if="row.kind === 'todo'" class="todo-sticky-shell">
            <div class="build-bar todo-snapshot-bar" :class="{ expanded: isTodoExpanded }">
              <div class="build-header" @click="toggleTodoExpanded()">
                <div class="build-title">
                  <i class="codicon codicon-checklist build-icon todo-snapshot-icon"></i>
                  <span class="build-label">{{ t('components.message.tool.todoWrite.label') }}</span>
                  <span class="build-sep">·</span>
                  <span class="build-name">{{ todoPanelName }}</span>
                </div>

                <div class="build-actions">
                  <span v-if="todoTotal > 0" class="build-progress">{{ todoCompleted }}/{{ todoTotal }}</span>
                  <span v-else class="build-progress">—</span>

                  <button
                    class="build-btn"
                    :title="isTodoExpanded ? t('common.collapse') : t('common.expand')"
                    @click.stop="toggleTodoExpanded()"
                  >
                    <i class="codicon" :class="isTodoExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down'"></i>
                  </button>
                </div>
              </div>

              <div v-if="!isTodoExpanded && todoCurrentText" class="build-current">
                {{ todoCurrentText }}
              </div>

              <div v-if="isTodoExpanded" class="build-body">
                <div v-if="todoBarItems.length === 0" class="build-empty">
                  <i class="codicon codicon-info"></i>
                  <span>{{ t('components.message.tool.todoPanel.empty') }}</span>
                </div>

                <div v-else class="build-todos">
                  <div v-for="t in todoBarItems" :key="t.id" class="build-todo" :class="`status-${t.status}`">
                    <span class="todo-dot" :class="t.status"></span>
                    <span class="todo-text">{{ t.text }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
        
        <!-- 继续对话提示 - 当最后一条是工具响应时显示 -->
        <div v-if="chatStore.needsContinueButton" class="continue-message">
          <div class="continue-icon">
            <i class="codicon codicon-debug-pause"></i>
          </div>
          <div class="continue-content">
            <div class="continue-title">{{ t('components.message.continue.title') }}</div>
            <div class="continue-text">{{ t('components.message.continue.description') }}</div>
          </div>
          <div class="continue-actions">
            <button class="continue-btn" @click="handleContinue">
              <span class="codicon codicon-play"></span>
              <span class="btn-text">{{ t('components.message.continue.button') }}</span>
            </button>
          </div>
        </div>
        
        <!-- 错误提示 - 显示在消息末尾 -->
        <div v-if="chatStore.error" class="error-message">
          <div class="error-header">
            <div class="error-icon">⚠</div>
            <div class="error-title">{{ t('components.message.error.title') }}</div>
            <div class="error-actions">
              <!-- H-3: 重试按钮仅在可重试错误码（STREAM_ERROR 等流式生成错误）时显示，
                   恢复/预览类错误（RESTORE_ERROR 等）走独立提示，不触发 LLM 重新生成 -->
              <button
                v-if="isRetryableError(chatStore.error)"
                class="error-retry"
                @click="handleErrorRetry"
                :title="t('components.message.error.retry')"
              >
                <span class="codicon codicon-refresh"></span>
              </button>
              <button class="error-dismiss" @click="chatStore.dismissError()" :title="t('components.message.error.dismiss')">
                ✕
              </button>
            </div>
          </div>
          <div class="error-body">
            <CustomScrollbar :max-height="120" :width="4">
              <pre class="error-text-code">{{ chatStore.error.code }}: {{ chatStore.error.message }}</pre>
            </CustomScrollbar>
          </div>
        </div>

        <!-- 恢复结果提示（H-3）：恢复类结果独立展示，不占用错误条，也不提供 LLM 重试 -->
        <div v-if="restoreNotice" class="restore-notice" :class="`restore-notice-${restoreNotice.kind}`">
          <div class="restore-notice-header">
            <div class="restore-notice-icon">
              <i class="codicon" :class="restoreNoticeIconClass"></i>
            </div>
            <div class="restore-notice-title">{{ restoreNoticeTitle }}</div>
            <div class="restore-notice-actions">
              <button class="restore-notice-dismiss" @click="restoreNotice = null" :title="t('components.message.error.dismiss')">
                ✕
              </button>
            </div>
          </div>
          <div class="restore-notice-body">
            <pre class="restore-notice-text">{{ restoreNotice.message }}</pre>
          </div>
        </div>

        <!-- U1 忙时投递（M3-1）轻量回显：已投递 / 投递失败，不占用错误条 -->
        <div v-if="interruptNotices.length > 0" class="interrupt-notices">
          <div
            v-for="notice in interruptNotices"
            :key="notice.createdAt"
            class="interrupt-notice"
            :class="`interrupt-notice-${notice.kind}`"
          >
            <i class="codicon" :class="notice.kind === 'delivered' ? 'codicon-check' : 'codicon-warning'"></i>
            <span class="interrupt-notice-text">
              {{
                notice.kind === 'delivered'
                  ? t('components.message.interrupt.delivered', { text: notice.text })
                  : t('components.message.interrupt.deliverFailed', { detail: notice.errorMessage || notice.errorCode || '' })
              }}
            </span>
          </div>
        </div>
      </div>
      </CustomScrollbar>
    </div>
    
    <!-- 删除确认对话框 -->
    <DeleteDialog
      v-model="showDeleteConfirm"
      :checkpoints="deleteCheckpoints"
      :delete-count="deleteCount"
      @delete="confirmDelete"
      @restore-and-delete="handleRestoreAndDelete"
      @cancel="cancelDelete"
    />

    <!-- BCP-05（决策 11）：恢复 / 切换恢复的未保存文件确认框（常驻挂载，不随分支切换器显隐） -->
    <DirtyFilesConfirm />
    
    <!-- 恢复检查点确认对话框（CP-09: 展示待删除文件清单，确认后才执行恢复） -->
    <ConfirmDialog
      v-model="showRestoreConfirm"
      :title="restoreConfirmTitle"
      :message="restoreConfirmMessage"
      :confirm-text="t('components.message.checkpoint.restoreConfirmBtn')"
      is-danger
      @confirm="confirmRestore"
      @cancel="cancelRestoreConfirm"
    >
      <div v-if="restoreDeletablePaths.length > 0" class="restore-delete-section">
        <div class="restore-delete-title">
          {{ t('components.message.checkpoint.restoreDeleteListTitle', { count: restoreDeletablePaths.length }) }}
        </div>
        <div v-if="restoreHasUntrackedPaths" class="restore-delete-untracked-note">
          {{ t('components.message.checkpoint.restoreDeleteUntrackedNote') }}
        </div>
        <div class="restore-delete-items">
          <div v-for="path in restoreShownDeletablePaths" :key="path" class="restore-delete-item">
            <i class="codicon codicon-close"></i>
            <span class="restore-delete-path">{{ path }}</span>
          </div>
          <div v-if="restoreHiddenDeletableCount > 0" class="restore-delete-more">
            {{ t('components.message.checkpoint.restoreDeleteListMore', { count: restoreHiddenDeletableCount }) }}
          </div>
        </div>
      </div>
      <div v-else class="restore-delete-empty">
        {{ t('components.message.checkpoint.restoreDeleteListEmpty') }}
      </div>
      <div v-if="restoreUnbackedPaths.length > 0" class="restore-unbacked-tip">
        {{ t('components.message.checkpoint.restoreUnbackedTip', { paths: restoreUnbackedPaths.slice(0, 5).join('、') }) }}
      </div>
    </ConfirmDialog>
    
  </div>
</template>

<style scoped>
.message-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.message-scroll-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ============ Build 顶部卡片（Cursor-like，保持 GrayCode 面板风格） ============ */
.build-sticky-shell {
  position: sticky;
  top: 0;
  z-index: 6;
  padding: 8px var(--spacing-md, 16px) 0;
  background: var(--vscode-editor-background);
}


.todo-sticky-shell {
  position: sticky;
  top: 0;
  z-index: 5;
  padding: 8px var(--spacing-md, 16px) 0;
  background: var(--vscode-editor-background);
}

.todo-snapshot-icon {
  color: var(--vscode-charts-blue, #3794ff);
}

.build-bar {
  margin: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
  background: var(--vscode-editor-background);
  flex-shrink: 0;
}

.build-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm, 8px);
  padding: 6px 10px;
  background: var(--vscode-editor-inactiveSelectionBackground);
  cursor: pointer;
  user-select: none;
}

.build-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.build-icon {
  font-size: 12px;
  color: var(--vscode-charts-orange, #e69500);
  flex-shrink: 0;
}

.build-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-foreground);
  flex-shrink: 0;
}

.build-sep {
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  flex-shrink: 0;
}

.build-name {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.build-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.build-progress {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
  min-width: 42px;
  text-align: right;
}

.build-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.build-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.build-current {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.build-body {
  max-height: min(40vh, 320px);
  padding: 8px 10px 10px;
  background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border);
  overflow: auto;
  overscroll-behavior: contain;
}

.build-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
  padding: 6px 2px;
}

.build-todos {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 6px;
}

.build-todo {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.todo-dot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 999px;
  background: var(--vscode-panel-border);
  flex-shrink: 0;
}

.todo-dot.pending {
  background: color-mix(in srgb, var(--vscode-foreground) 25%, transparent);
}

.todo-dot.in_progress {
  background: var(--vscode-charts-blue, #3794ff);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-charts-blue) 18%, transparent);
}

.todo-dot.completed {
  background: var(--vscode-testing-iconPassed);
}

.todo-dot.cancelled {
  background: var(--vscode-testing-iconFailed);
}

.build-todo.status-completed .todo-text {
  color: var(--vscode-descriptionForeground);
  text-decoration: line-through;
  opacity: 0.85;
}

.build-todo.status-cancelled .todo-text {
  color: var(--vscode-descriptionForeground);
  text-decoration: line-through;
  opacity: 0.6;
}

.todo-text {
  line-height: 1.35;
  word-break: break-word;
}

.messages-container {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* 加载更多指示器 */
.load-more-container {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.load-more-container .codicon {
  font-size: 16px;
}

.load-more-text {
  font-size: 11px;
  line-height: 1.3;
  max-width: 90%;
  text-align: center;
  white-space: normal;
}

/* 错误提示 - 扁平化设计，类似重试面板样式 */
.error-message {
  display: flex;
  flex-direction: column;
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  flex-shrink: 0;
  overflow: hidden;
}

.error-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.1);
  border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.2));
}

.error-icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--vscode-errorForeground, #f48771);
}

.error-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.error-body {
  padding: 12px;
}

.error-text-code {
  font-size: 11px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(0, 0, 0, 0.15);
  padding: 8px;
  border-radius: 4px;
  margin: 0;
}

.error-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.error-retry,
.error-dismiss {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  opacity: 0.6;
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  transition: opacity 0.2s, background 0.2s;
}

.error-retry:hover,
.error-dismiss:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.error-retry .codicon {
  font-size: 14px;
}

/* 恢复结果提示（H-3）：独立于错误条，按成功/部分成功/警告/失败分级着色 */
.restore-notice {
  display: flex;
  flex-direction: column;
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  flex-shrink: 0;
  overflow: hidden;
}

.restore-notice-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.1);
  border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.2));
}

.restore-notice-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.restore-notice-error .restore-notice-icon {
  color: var(--vscode-errorForeground, #f48771);
}

.restore-notice-partial .restore-notice-icon {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.restore-notice-warning .restore-notice-icon {
  color: var(--vscode-descriptionForeground);
}

.restore-notice-success .restore-notice-icon {
  color: var(--vscode-testing-iconPassed, #89d185);
}

.restore-notice-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.restore-notice-body {
  padding: 12px;
}

.restore-notice-text {
  font-size: 11px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(0, 0, 0, 0.15);
  padding: 8px;
  border-radius: 4px;
  margin: 0;
}

.restore-notice-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.restore-notice-dismiss {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  opacity: 0.6;
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  transition: opacity 0.2s, background 0.2s;
}

.restore-notice-dismiss:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

/* U1 忙时投递（M3-1）轻量回显：细条提示，随消息区滚动，不占错误条 */
.interrupt-notices {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  flex-shrink: 0;
}

.interrupt-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 4px;
}

.interrupt-notice .codicon {
  flex-shrink: 0;
  font-size: 13px;
}

.interrupt-notice-delivered .codicon {
  color: var(--vscode-testing-iconPassed, #89d185);
}

.interrupt-notice-error .codicon {
  color: var(--vscode-errorForeground, #f48771);
}

.interrupt-notice-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 继续对话提示 */
.continue-message {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-md, 16px);
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 2px;
  flex-shrink: 0;
}

.continue-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--vscode-descriptionForeground);
}

.continue-icon .codicon {
  font-size: 16px;
}

.continue-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.continue-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.continue-text {
  font-size: 11px;
  line-height: 1.4;
  color: var(--vscode-descriptionForeground);
}

.continue-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.continue-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--vscode-toolbar-activeBackground, rgba(127, 127, 127, 0.2));
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.continue-btn:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.3));
}

.continue-btn .codicon {
  font-size: 12px;
}

.btn-text {
  font-weight: 500;
}

/* 检查点条 */
.checkpoint-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 0;
  background: var(--vscode-editor-background);
  border-left: 2px solid var(--vscode-charts-yellow, #ddb92f);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* 已总结区域 / 未总结区域分隔线（逻辑截断：原文保留，仅视觉分界） */
.summarize-divider {
  display: flex;
  align-items: center;
  padding: 6px 16px;
}

.summarize-divider-line {
  flex: 1;
  height: 1px;
  background: var(--vscode-editor-lineHighlightBorder, rgba(128, 128, 128, 0.35));
}

.checkpoint-bar.checkpoint-before {
  border-left-color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-bar.checkpoint-after {
  border-left-color: var(--vscode-charts-green, #89d185);
}

.checkpoint-bar.checkpoint-merged {
  border-left-color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.checkpoint-before .checkpoint-icon {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-after .checkpoint-icon {
  color: var(--vscode-charts-green, #89d185);
}

.checkpoint-merged .checkpoint-icon {
  color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-icon .codicon {
  font-size: 14px;
}

.checkpoint-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.checkpoint-label {
  font-weight: 500;
}

.checkpoint-before .checkpoint-label {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-after .checkpoint-label {
  color: var(--vscode-charts-green, #89d185);
}

.checkpoint-merged .checkpoint-label {
  color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-meta {
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
}

.checkpoint-time {
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  font-size: 11px;
  flex-shrink: 0;
  margin-left: auto;
}

.checkpoint-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 4px;
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}

.checkpoint-action:hover {
  opacity: 1;
  background: var(--vscode-list-hoverBackground);
}

.checkpoint-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: transparent;
}

.checkpoint-action .codicon {
  font-size: 14px;
}

/* ============ 恢复确认：待删除文件清单（CP-09） ============ */
.restore-delete-section {
  margin-top: 10px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  border-radius: 4px;
}

.restore-delete-title {
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-errorForeground);
  background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  position: sticky;
  top: 0;
}

.restore-delete-untracked-note {
  padding: 5px 10px;
  font-size: 12px;
  color: var(--vscode-editorWarning-foreground);
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
}

.restore-delete-items {
  padding: 4px 0;
}

.restore-delete-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.restore-delete-item .codicon {
  font-size: 12px;
  color: var(--vscode-errorForeground);
  flex-shrink: 0;
}

.restore-delete-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.restore-delete-more {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.restore-delete-empty {
  margin-top: 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.restore-unbacked-tip {
  margin-top: 10px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  border: 1px dashed var(--vscode-panel-border);
  border-radius: 4px;
}
</style>
