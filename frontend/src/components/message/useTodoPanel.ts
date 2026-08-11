/**
 * useTodoPanel - TODO 快照面板（todoStickyMeta / todoBarItems / 锚点 / 展开状态）
 *
 * 从 MessageList.vue 拆分（S4 批次），纯重构不改行为：
 * - todoStickyMeta：最近 todo 初始化工具的 sticky 元信息（hasTodoInitTool / 面板名 / 锚点）
 * - todoBarItems / showTodoBar / todoAnchorBackendIndex 与统计文案
 * - 展开状态（isTodoExpanded）恢复 / 切换（M2-2：单一数据源 messageListUiStateByTab）
 *
 * 与 build 面板的共享状态（showBuildBar / replayedBuildTodoState / replayedBuildTodoList /
 * allMessageIndexBounds / getMergedToolResult）一律由 MessageList 以参数注入，不搞全局。
 */

import { ref, computed, watch } from 'vue'
import type { ComputedRef } from 'vue'
import { useChatStore } from '../../stores'
import { messageListUiStateByTab } from './messageListUiState'
import {
  normalizeTodoStatus,
  type TodoStatus as BuildTodoStatus,
  type TodoItem,
  type ReplayTodoState
} from '../../utils/todoList'
import { getPlanExecutionPrompt, getPlanUpdateMode } from '../../utils/toolContinuations'
import type { Message } from '../../types'
import type { MessageIndexBounds } from './useBuildPanel'

export interface UseTodoPanelOptions {
  chatStore: ReturnType<typeof useChatStore>
  t: (key: string, params?: Record<string, any>) => string
  props: { tabId: string }
  /** 当前界面语言（todoStickyMeta 面板名回退文案随语言切换需要重算） */
  actualLanguage: ComputedRef<string>
  /** build 面板：Build 条可见性（与 TODO 条互斥展示） */
  showBuildBar: ComputedRef<boolean>
  /** build 面板：重放后的 todo 快照（todoBarItems / 锚点计算共用） */
  replayedBuildTodoState: ComputedRef<ReplayTodoState>
  /** build 面板：重放后的 todo 列表 */
  replayedBuildTodoList: ComputedRef<TodoItem[] | null>
  /** 全量消息 backendIndex 边界（todo/build 锚点计算共用） */
  allMessageIndexBounds: ComputedRef<MessageIndexBounds>
  /** todo/build 共用的工具结果合并辅助（MessageList 提供） */
  getMergedToolResult: (tool: any) => Record<string, unknown>
}

export function useTodoPanel(options: UseTodoPanelOptions) {
  const {
    chatStore,
    t,
    props,
    actualLanguage,
    showBuildBar,
    replayedBuildTodoState,
    replayedBuildTodoList,
    allMessageIndexBounds,
    getMergedToolResult
  } = options

  // M2-2：删除实例级 todoExpandedMap，统一走模块级 messageListUiStateByTab（按 tabId），
  // 避免与 uiStateByTab.todoExpanded 语义分叉（两个来源互相覆盖）。
  const isTodoExpanded = ref(false)

  type BuildTodoItem = { id: string; text: string; status: BuildTodoStatus }

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
   * todoStickyMeta 增量缓存（M-3）：引用指纹 + 尾部增量 + 尾消息不纳入缓存。
   * 只缓存 [0, scannedCount) 的扫描结果；尾消息在流式期间可能被原地改写（tools 追加），
   * 因此始终重新扫描尾消息，前缀元素引用逐一校验，任何结构变更回退全量扫描。
   * i18n 语言纳入缓存键：panelName 的回退文案随语言切换需要重算。
   */
  let todoStickyMetaCache: {
    messagesRef: Message[]
    scannedCount: number
    language: string
    meta: { hasTodoInitTool: boolean; anchorBackendIndex: number | null; panelName: string }
  } | null = null

  /** 由某条已确认的 todo 初始化消息构建 sticky meta */
  function buildTodoStickyMetaFromMessage(msg: Message, initTool: any, fallbackName: string) {
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

  const todoStickyMeta = computed(() => {
    const fallbackName = t('components.message.tool.todoWrite.label')
    const language = actualLanguage.value
    const messages = chatStore.allMessages
    const len = messages.length

    // 引用指纹 + 尾部增量：前缀 [0, scannedCount) 逐元素校验，命中时只扫新增尾部
    const cache = todoStickyMetaCache
    let latest = cache?.meta ?? null
    let fromIndex = 0
    let prefixOk = false
    if (cache !== null && cache.language === language && cache.messagesRef.length <= len) {
      prefixOk = true
      for (let i = 0; i < cache.scannedCount; i++) {
        if (messages[i] !== cache.messagesRef[i]) {
          prefixOk = false
          break
        }
      }
      if (prefixOk) {
        latest = cache.meta
        fromIndex = cache.scannedCount
      }
    }

    // 工具名先于昂贵的合并判定做轻量过滤：todo_write / create_plan / update_plan 之外的
    // 消息直接跳过（isTodoInitToolForSticky 含 getMergedToolResult + 确认文案判定，仅对有
    // 相关工具名的消息调用），窗口内没有任何相关工具名时直接返回空态
    let found: { hasTodoInitTool: boolean; anchorBackendIndex: number | null; panelName: string } | null = null
    for (let i = len - 1; i >= fromIndex; i--) {
      const msg = messages[i]
      if (msg.role !== 'assistant' || !Array.isArray(msg.tools)) continue
      const hasTodoToolName = msg.tools.some(t => TODO_TOOL_NAME_SET.has(t.name))
      if (!hasTodoToolName) continue
      const initTool = msg.tools.find(tool => isTodoInitToolForSticky(tool))
      if (!initTool) continue
      found = buildTodoStickyMetaFromMessage(msg, initTool, fallbackName)
      break
    }

    const meta = found ?? latest ?? {
      hasTodoInitTool: false,
      anchorBackendIndex: null,
      panelName: fallbackName
    }

    // 尾消息可能在流式期间原地变更（tools 追加/状态改写），始终不纳入缓存
    todoStickyMetaCache = {
      messagesRef: messages,
      scannedCount: Math.max(0, len - 1),
      language,
      meta
    }

    return meta
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

  // 使用模块级 Map（H5）：组件卸载后滚动位置/展开状态不丢失
  const uiStateByTab = messageListUiStateByTab

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

  return {
    todoBarItems,
    isTodoExpanded,
    showTodoBar,
    todoAnchorBackendIndex,
    todoPanelName,
    todoTotal,
    todoCompleted,
    todoCurrentText,
    restoreTodoExpandedState,
    toggleTodoExpanded
  }
}
