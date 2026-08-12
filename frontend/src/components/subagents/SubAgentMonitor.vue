<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { useI18n } from '@/i18n'
import { CustomScrollbar } from '../common'
import MessageItem from '../message/MessageItem.vue'
import { contentToMessageEnhanced } from '@/stores/chat/parsers'
import { applyStreamChunkToContents } from '@/stores/agentRun/contentDelta'
import { onMessageFromExtension, sendToExtension } from '@/utils/vscode'
import { setVscodeWindowFocused } from '@/services/soundEventController'
import { shouldApplyEventFocus } from './monitorFocusPolicy'
import { compareMonitorRunsByStableCreationOrder } from './monitorRunOrdering'
import {
  createPreviousRunWindowRequestOptions,
  isRunContentWindowStale,
  isRunWindowTailAuthoritative,
  prependRunContentWindow,
  replaceRunContentWindow,
  replaceRunContentWindowPreservingPrefix,
  type SubAgentRunContentWindowState
} from './monitorWindowState'
import {
  applyMonitorToolOverlay,
  reduceMonitorToolStatusOverlay,
  type MonitorToolStatusOverlay
} from './monitorToolStatusOverlay'
import {
  DEFAULT_MONITOR_LIVE_DELTA_BUFFER_LIMIT,
  enqueueMonitorLiveDelta,
  getMonitorLiveDeltaRevision,
  getMonitorLiveDeltaSequence,
  hasRenderableMonitorLiveDelta,
  selectReplayableMonitorLiveDeltas,
  type MonitorLiveDeltaEvent
} from './monitorLiveDeltaBuffer'
import type { Content, ContentPart, Message, ToolUsage } from '@/types'
import {
  getRunRetryEventCue,
  getRunStatusTransitionCue,
  playMonitorSubagentCue,
  type MonitorRunStatus
} from './monitorSoundCues'

// 修改原因：Monitor 需要区分暂停、等待用户处理和扩展重载中断，不能把它们都展示成失败。
// 修改方式：与后端 SubAgentRunStatus 保持同构的联合类型（定义见 monitorSoundCues.ts，供提示音迁移检测复用）。
// 修改目的：后续顶部控制按钮可以根据状态判断是否允许继续、退出或仅查看历史。
type RunStatus = MonitorRunStatus

interface SubAgentRunEvent {
  runId: string
  agentName?: string
  type: string
  timestamp: number
  toolId?: string
  toolName?: string
  eventSequence?: number
  contentRevision?: number
  payload?: any
}

interface SubAgentRunManifest {
  runId: string
  agentName?: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  conversationId?: string
  contentCount: number
  eventCount: number
  contentRevision?: number
  eventSequence?: number
  preview?: string
  lastMessageRole?: Content['role']
}

type SubAgentRunContentWindow = SubAgentRunContentWindowState

interface SubAgentRunSnapshot {
  runId: string
  agentName?: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  contents: Content[]
  events: SubAgentRunEvent[]
  conversationId?: string
  contentRevision?: number
  eventSequence?: number
}

const { t } = useI18n()

// 修改原因：桌面版需要把 Monitor 内嵌到主窗口（同一 webview），而不是独立窗口。
// 修改方式：新增 embedded/visible/focusRunId 三个 prop——embedded 控制面板式布局
//          （高度铺满容器 + 头部关闭按钮）；visible 通知后端事件推送开关；
//          focusRunId 由主窗口在“打开详情”时传入并导航聚焦。
// 修改目的：主窗口分区方案复用同一组件，独立窗口（view mode）模式不受影响。
const props = withDefaults(defineProps<{
  visible?: boolean
  focusRunId?: string
  embedded?: boolean
}>(), {
  visible: true,
  focusRunId: undefined,
  embedded: false
})

const emit = defineEmits<{
  close: []
}>()

const DEFAULT_RUN_WINDOW_LIMIT = 20

/** 距底部多少像素以内视为"贴着底部"，用于决定是否自动跟随新内容 */
const AUTO_FOLLOW_THRESHOLD_PX = 80

// 修改原因：Monitor 首屏不再接收完整 snapshots，否则大输出会卡在传输、反序列化、Vue state 和 Markdown 渲染。
// 修改方式：状态拆成轻量 manifests 与按 run 缓存的 transcript window，只有聚焦 run 才加载 Content[]。
// 修改目的：保持 Content[]/MessageItem 渲染语义不分叉，同时把首屏 payload 限制为 run 列表元数据。
const manifests = ref<SubAgentRunManifest[]>([])
const windowsByRunId = ref<Record<string, SubAgentRunContentWindow>>({})
const eventsByRunId = ref<Record<string, SubAgentRunEvent[]>>({})
// 修改原因：工具状态是运行时事件状态，不能只从窗口内 functionResponse 反推，否则刷新丢失时工具卡会卡住。
// 修改方式：为每个 run 维护 toolId -> ToolUsage 状态 overlay，事件到达时用纯 reducer 更新。
// 修改目的：让 tool_started/tool_completed/tool_failed 实时驱动工具卡，同时仍由 functionResponse 做最终结果校准。
const toolStatusOverlaysByRunId = ref<Record<string, MonitorToolStatusOverlay>>({})
const loadingRunWindows = ref<Set<string>>(new Set())
// 修改原因：“加载更早消息”是按 run 维度的分页请求，必须单独记录 loading 以避免用户重复点击造成重叠 prepend。
// 修改方式：使用 Set<runId> 表示正在向前加载历史的 run，不复用聚焦尾部窗口 loading。
// 修改目的：尾部校准和历史分页可以并行建模，UI 上按钮能准确禁用。
const loadingOlderRunWindows = ref<Set<string>>(new Set())
// 修改原因：强制尾部校准请求可能在已有 getRunWindow 请求进行中到达，旧逻辑直接 return 会永久丢失校准意图。
// 修改方式：用普通 Set 记录 dirty run，请求完成后自动补发一次 force refresh；requestSeq 防止旧响应覆盖新窗口。
// 修改目的：保证 content_snapshot/run_completed 等边界事件最终一定校准当前窗口。
const pendingForcedRunWindowRefreshes = new Set<string>()
// 修改原因：Monitor 在流式中途打开时，llm_delta 可能早于 getRunWindow 响应到达，旧逻辑会直接丢弃这些正文增量。
// 修改方式：为每个 run 维护有界 live delta 缓冲；窗口可用且 revision 匹配后按 eventSequence 回放。
// 修改目的：不恢复 full snapshot 传输，也能让实时打开 Monitor 的显示最终追上同一轮流式输出。
const liveDeltaBuffersByRunId = new Map<string, MonitorLiveDeltaEvent[]>()
const latestRunWindowRequestSeq = new Map<string, number>()
let runWindowRequestSeq = 0
const focusedRunId = ref<string | undefined>((window as any).__GRAYCODE_INITIAL_RUN_ID || undefined)// 修改原因：顶部控制按钮只能作用于后端仍持有活跃主工具 Promise 的 run。
// 修改方式：由 SubAgentMonitorPanel 随 ready/manifest/event 消息下发 activeRunIds，前端只按该集合决定按钮可见性。
// 修改目的：历史 run 不会错误显示“中止/退出”等会影响主工具的操作。
const activeRunIds = ref<Set<string>>(new Set())
// 修改原因：实时事件会反复携带打开面板时的 focusRunId，并发 run 更新时会覆盖用户在 tab 上的手动选择。
// 修改方式：记录用户是否已经在 Monitor 内主动选中过 run，实时 event 只在用户未选择前应用后端焦点。
// 修改目的：从主窗口打开详情仍能自动定位，但 Monitor 内部切换不会被后续事件拉回旧 run。
const hasUserSelectedRun = ref(false)
let disposeMessageListener: (() => void) | undefined

// 修改原因：llm_delta 是高频流式事件（流式输出时每秒可达数十个），若每个事件都立即触发
//          manifests/windowsByRunId 的响应式替换，Vue 更新频率会远超渲染帧率，叠加 renderMessages
//          全量重建与 MessageItem 重渲染，Monitor 即使只有一个 run 也会卡顿。
// 修改方式：事件回调只把 delta 写入非响应式队列，由 rAF（setTimeout 兜底）批量 flush，
//          每帧至多提交一次完整状态更新。
// 修改目的：UI 更新频率与渲染帧对齐，流式成本从“每 chunk 一次全量更新”降为“每帧一次合并更新”。
const pendingLlmDeltaEvents = new Map<string, SubAgentRunEvent[]>()
let llmDeltaFlushScheduled = false
let llmDeltaFlushFallbackTimer: ReturnType<typeof setTimeout> | undefined
let llmDeltaFlushGeneration = 0

const orderedRuns = computed(() => {
  // 修改原因：updatedAt 会被每个 llm_delta 和工具事件刷新，并发 run 按 updatedAt 排序会导致 tab 顺序不停跳动。
  // 修改方式：Run tab 改用创建时间的稳定顺序；updatedAt 仍只用于展示最近更新时间。
  // 修改目的：Monitor 在流式提前执行和多 SubAgent 并发时不再出现“跑马灯”式重排。
  return [...manifests.value].sort(compareMonitorRunsByStableCreationOrder)
})

const focusedManifest = computed(() => {
  if (focusedRunId.value) {
    const found = orderedRuns.value.find(run => run.runId === focusedRunId.value)
    if (found) return found
  }
  return orderedRuns.value[0]
})

const focusedRun = computed<SubAgentRunSnapshot | undefined>(() => {
  const manifest = focusedManifest.value
  if (!manifest) return undefined
  const contentWindow = windowsByRunId.value[manifest.runId]
  return {
    runId: manifest.runId,
    agentName: manifest.agentName,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    conversationId: manifest.conversationId,
    contents: contentWindow?.contents || [],
    events: eventsByRunId.value[manifest.runId] || [],
    contentRevision: contentWindow?.contentRevision ?? manifest.contentRevision,
    eventSequence: contentWindow?.eventSequence ?? manifest.eventSequence
  }
})

function upsertManifest(manifest: SubAgentRunManifest | undefined) {
  if (!manifest?.runId) return
  const index = manifests.value.findIndex(item => item.runId === manifest.runId)
  if (index >= 0) {
    const next = [...manifests.value]
    next[index] = { ...next[index], ...manifest }
    manifests.value = next
  } else {
    manifests.value = [manifest, ...manifests.value]
  }
}

// ============ 子代理提示音：run 状态迁移检测 ============

// 修改原因：Monitor 面板也承担“子代理跑完/失败/重试”的提醒职责，但过去完全不播提示音。
// 修改方式：跟踪每个 run 最近一次状态，只在「非终态 → 终态」迁移时经子代理独立开关播放一次；
//          打开面板时已存在的 run 只播种不播报（历史 run 不应补响）。
// 修改目的：状态迁移语义与事件回放天然幂等——重同步不会重复响铃；
//          续跑（completed → running → completed）是第二次真实完成，会再次响铃，符合预期。
const lastSeenRunStatus = new Map<string, MonitorRunStatus>()
let runStatusSoundSeeded = false

watch(
  () => manifests.value,
  (list) => {
    const nextStatuses = new Map<string, MonitorRunStatus>()
    for (const manifest of list) {
      if (manifest?.runId) nextStatuses.set(manifest.runId, manifest.status)
    }

    if (!runStatusSoundSeeded) {
      runStatusSoundSeeded = true
      for (const [runId, status] of nextStatuses) {
        lastSeenRunStatus.set(runId, status)
      }
      return
    }

    for (const [runId, status] of nextStatuses) {
      const prev = lastSeenRunStatus.get(runId)
      // 首播之后新出现的 run 不播报（可能来自 manifest 重同步的历史 run）
      if (prev === undefined) {
        lastSeenRunStatus.set(runId, status)
        continue
      }
      lastSeenRunStatus.set(runId, status)
      const cue = getRunStatusTransitionCue(prev, status)
      if (cue) playMonitorSubagentCue(cue)
    }

    // 容量上限：长会话 run 数无界，Map 不能随 run 数无限增长；只保留仍在 manifests 中的 run
    if (lastSeenRunStatus.size > 500) {
      const liveRunIds = new Set(nextStatuses.keys())
      for (const runId of Array.from(lastSeenRunStatus.keys())) {
        if (!liveRunIds.has(runId)) lastSeenRunStatus.delete(runId)
      }
    }
  }
)

// ============ 子代理提示音：重试事件去重 ============

const monitorSoundPlayedKeys = new Set<string>()
/** 去重集合容量上限：超出后整体清空，防止随会话运行无限增长 */
const MONITOR_SOUND_PLAYED_KEYS_LIMIT = 500

function handleMonitorRunSoundEvent(event: SubAgentRunEvent): void {
  if (!event?.runId) return
  const cue = getRunRetryEventCue(String(event.type || ''))
  if (!cue) return

  // 同一 run 的同一事件（按 attempt 区分）只播一次；attempt 缺失时整 run 只播一次
  const attempt = typeof event.payload?.attempt === 'number' ? event.payload.attempt : undefined
  const key = attempt !== undefined ? `${event.runId}:${event.type}:${attempt}` : `${event.runId}:${event.type}`
  if (monitorSoundPlayedKeys.has(key)) return

  monitorSoundPlayedKeys.add(key)
  if (monitorSoundPlayedKeys.size > MONITOR_SOUND_PLAYED_KEYS_LIMIT) {
    monitorSoundPlayedKeys.clear()
  }
  playMonitorSubagentCue(cue, event.timestamp)
}

function applyManifestPayload(data: any) {
  // 修改原因：monitorReady/subagentMonitor.manifest 的协议已从 snapshots 切换为 manifests，前端不能再把全量 contents 放入首屏 state。
  // 修改方式：只接收 manifests，并同步焦点与 activeRunIds；窗口内容保留已有按需缓存。
  // 修改目的：重新打开已有面板时也不会因一次全量替换触发 Markdown 大渲染。
  manifests.value = Array.isArray(data?.manifests) ? data.manifests : []
  if (data?.focusRunId) {
    // 修改原因：manifest/monitorReady 代表打开详情或重新同步，是显式导航事件，应该能覆盖旧选择。
    // 修改方式：应用后端 focusRunId，同时清除“用户已手动选择”标记，让新的显式入口成为默认焦点。
    // 修改目的：用户从主聊天再次打开另一个 run 时，Monitor 能正确跳转到新 run。
    focusedRunId.value = data.focusRunId
    hasUserSelectedRun.value = false
  }
  updateActiveRunIds(data?.activeRunIds)
}

function upsertWindow(contentWindow: SubAgentRunContentWindow | undefined, options?: { preservePrefix?: boolean }) {
  if (!contentWindow?.runId) return
  const current = windowsByRunId.value[contentWindow.runId]
  const replacement = options?.preservePrefix
    ? replaceRunContentWindowPreservingPrefix(contentWindow, current)
    : replaceRunContentWindow(contentWindow, current)
  if (!replacement) return
  windowsByRunId.value = {
    ...windowsByRunId.value,
    [contentWindow.runId]: replacement
  }
}

function prependWindow(contentWindow: SubAgentRunContentWindow | undefined) {
  if (!contentWindow?.runId) return
  const merged = prependRunContentWindow(windowsByRunId.value[contentWindow.runId], contentWindow)
  if (!merged) return
  windowsByRunId.value = {
    ...windowsByRunId.value,
    [contentWindow.runId]: merged
  }
}

function applyToolStatusEvent(event: SubAgentRunEvent) {
  if (!event?.runId) return
  const current = toolStatusOverlaysByRunId.value[event.runId] || {}
  const next = reduceMonitorToolStatusOverlay(current, event)
  if (next === current) return
  toolStatusOverlaysByRunId.value = {
    ...toolStatusOverlaysByRunId.value,
    [event.runId]: next
  }
}

// 修改原因：事件数组只增不减且每次 append 都整体复制，长 run 的事件累积会让复制成本随事件数增长。
// 修改方式：与后端事件 journal 上限（MAX_EVENTS_PER_RUN=500）对齐，超过后丢弃最旧事件。
// 修改目的：前端事件列表有界，审计与重试展示只依赖最近事件。
const MAX_MONITOR_EVENTS_PER_RUN = 500

function appendEvent(event: SubAgentRunEvent) {
  if (!event?.runId || event.type === 'llm_delta') return
  const current = eventsByRunId.value[event.runId] || []
  const next = [...current, event]
  if (next.length > MAX_MONITOR_EVENTS_PER_RUN) {
    next.splice(0, next.length - MAX_MONITOR_EVENTS_PER_RUN)
  }
  eventsByRunId.value = {
    ...eventsByRunId.value,
    [event.runId]: next
  }
  // 修改原因：工具事件不仅用于审计列表，还必须实时推进 MessageItem 内的工具卡状态。
  // 修改方式：事件入库后同步喂给 run 级工具状态 overlay reducer。
  // 修改目的：窗口刷新或 functionResponse 暂未到达时，工具卡仍能显示 executing/success/error。
  applyToolStatusEvent(event)
}

function isRunWindowStale(runId: string): boolean {
  return isRunContentWindowStale(
    windowsByRunId.value[runId],
    manifests.value.find(item => item.runId === runId)
  )
}

async function requestRunWindow(runId: string | undefined, force = false) {
  if (!runId) return
  if (!force && !isRunWindowStale(runId)) return
  if (loadingRunWindows.value.has(runId)) {
    if (force) {
      // 修改原因：强制校准通常由 content_snapshot/run_completed 触发，不能因为已有请求在飞就丢弃。
      // 修改方式：把 run 标记为 dirty，当前请求结束后再自动补发一次 force refresh。
      // 修改目的：保证窗口最终追上后端 transcript 真源，避免旧窗口继续接收下一轮 delta。
      pendingForcedRunWindowRefreshes.add(runId)
    }
    return
  }

  const requestSeq = ++runWindowRequestSeq
  latestRunWindowRequestSeq.set(runId, requestSeq)
  const loading = new Set(loadingRunWindows.value)
  loading.add(runId)
  loadingRunWindows.value = loading
  try {
    const manifest = manifests.value.find(item => item.runId === runId)
    // 修改原因：聚焦 run 才需要 Content[]，请求窗口时携带 conversationId 允许后端先从 metadata 恢复历史 run。
    // 修改方式：调用 Monitor 专属 getRunWindow 协议，默认尾部 20 条；返回 manifest 用于同步 contentCount/status。
    // 修改目的：20k token 完成报告不会在 monitorReady 阶段一次性进入前端。
    const response = await sendToExtension<{
      window?: SubAgentRunContentWindow
      manifest?: SubAgentRunManifest
      activeRunIds?: string[]
    }>(MESSAGE_NAMES['subagents.monitor.getRunWindow'], {
      runId,
      conversationId: manifest?.conversationId,
      options: { limit: DEFAULT_RUN_WINDOW_LIMIT, fromTail: true }
    }, { clientId: 'subagent-monitor' })
    if (latestRunWindowRequestSeq.get(runId) !== requestSeq) {
      // 修改原因：Webview request/response 没有业务顺序保证，旧响应可能晚于后续强制刷新返回。
      // 修改方式：每个 tail window 请求带本地递增 seq，只有当前最新请求允许写入窗口缓存。
      // 修改目的：防止 stale response 覆盖已校准窗口。
      return
    }
    if (response?.manifest) upsertManifest(response.manifest)
    if (response?.window) {
      // P3：尾部校准窗口保留用户已 prepend 的更早历史，不整体替换回最新页
      upsertWindow(response.window, { preservePrefix: true })
      // 修改原因：窗口响应可能是 Monitor 打开后第一次可用的 transcript 基线，之前到达的 llm_delta 不能再丢弃。
      // 修改方式：窗口写入缓存后立即尝试回放同 run 的有界 live delta 缓冲。
      // 修改目的：解决流式过程中打开 Monitor 时正文或工具调用只在结束后才恢复的问题。
      replayBufferedLiveDeltas(response.window.runId)
    }
    updateActiveRunIds(response?.activeRunIds)
  } finally {
    const nextLoading = new Set(loadingRunWindows.value)
    nextLoading.delete(runId)
    loadingRunWindows.value = nextLoading
    if (pendingForcedRunWindowRefreshes.delete(runId)) {
      // 修改原因：加载中发生的 force refresh 已被 dirty 标记记录，需要在当前请求释放后补偿执行。
      // 修改方式：finally 阶段消费 dirty 标记并递归发起一次强制刷新；若刷新期间又变 dirty，会继续排队。
      // 修改目的：把“强制校准不丢失”固化为窗口请求状态机不变量。
      void requestRunWindow(runId, true)
    }
  }
}

async function loadOlderMessages() {
  const run = focusedRun.value
  if (!run) return
  let currentWindow = windowsByRunId.value[run.runId]
  if (!currentWindow) {
    // 修改原因：如果用户在窗口尚未加载完时点击加载历史，没有 current.startIndex 可作为分页锚点。
    // 修改方式：先沿用聚焦 run 的尾部窗口加载逻辑，拿到尾部窗口后再允许下一次点击加载更早。
    // 修改目的：所有分页都以真实 backendIndex 为锚，不用可见数组下标猜测。
    await requestRunWindow(run.runId)
    currentWindow = windowsByRunId.value[run.runId]
  }
  if (!currentWindow?.hasMoreBefore) return
  if (loadingOlderRunWindows.value.has(run.runId)) return

  const loading = new Set(loadingOlderRunWindows.value)
  loading.add(run.runId)
  loadingOlderRunWindows.value = loading
  try {
    // 修改原因：后端 window.endIndex 使用完整 Content[] 的半开区间索引；加载更早时应请求当前 startIndex 之前的一页。
    // 修改方式：传 endIndex=currentWindow.startIndex 且 limit=20，后端从该位置向前取窗口。
    // 修改目的：prepend 后每条 content.index 仍是全局真实索引，删除/重试不会因分页错位。
    const response = await sendToExtension<{
      window?: SubAgentRunContentWindow
      manifest?: SubAgentRunManifest
      activeRunIds?: string[]
    }>(MESSAGE_NAMES['subagents.monitor.getRunWindow'], {
      runId: run.runId,
      conversationId: run.conversationId,
      options: createPreviousRunWindowRequestOptions(currentWindow, DEFAULT_RUN_WINDOW_LIMIT)
    }, { clientId: 'subagent-monitor' })
    if (response?.manifest) upsertManifest(response.manifest)
    if (response?.window) prependWindow(response.window)
    updateActiveRunIds(response?.activeRunIds)
  } catch (error) {
    // 修改原因：请求失败时旧实现只留下一个未处理的 rejection，用户看到按钮转完就没反应，不知道发生了什么。
    // 修改方式：失败转为顶部一次性提示，加载状态仍由 finally 释放，可以直接重试。
    // 修改目的：加载历史失败是可见、可重试的状态。
    showControlNotice(error instanceof Error ? error.message : String(error))
  } finally {
    const nextLoading = new Set(loadingOlderRunWindows.value)
    nextLoading.delete(run.runId)
    loadingOlderRunWindows.value = nextLoading
  }
}

function setLiveDeltaBuffer(runId: string, buffer: MonitorLiveDeltaEvent[]) {
  // 修改原因：缓冲区是 Map，Vue 不需要追踪它；但必须集中删除空数组，避免长期打开 Monitor 后残留空 run key。
  // 修改方式：空缓冲直接 delete，非空缓冲替换为新数组引用。
  // 修改目的：让有界缓冲的生命周期清晰，避免后台 run 持续占用内存。
  if (buffer.length === 0) {
    liveDeltaBuffersByRunId.delete(runId)
  } else {
    liveDeltaBuffersByRunId.set(runId, buffer)
  }
}

function bufferLiveDeltaEvent(event: SubAgentRunEvent) {
  if (!event.runId || !hasRenderableMonitorLiveDelta(event)) return
  const current = liveDeltaBuffersByRunId.get(event.runId)
  setLiveDeltaBuffer(
    event.runId,
    enqueueMonitorLiveDelta(current, event, DEFAULT_MONITOR_LIVE_DELTA_BUFFER_LIMIT)
  )
}

function clearSupersededLiveDeltaBuffer(runId: string, revision: number | undefined) {
  const current = liveDeltaBuffersByRunId.get(runId)
  if (!current || typeof revision !== 'number') return
  // 修改原因：content_snapshot 表示后端 transcript 已进入更新 revision，旧 revision 的 live delta 已被权威窗口取代。
  // 修改方式：低于新 revision 的缓冲 delta 提前淘汰，等于或高于 revision 的 delta 继续等待匹配窗口。
  // 修改目的：流结束或工具结果写入后，不让旧实时片段重新追加到新窗口。
  setLiveDeltaBuffer(runId, current.filter(event => getMonitorLiveDeltaRevision(event) >= revision))
}

type MonitorLiveDeltaFreshness = Pick<SubAgentRunManifest, 'contentCount' | 'eventSequence'>

function applyLiveDeltaToWindow(
  event: MonitorLiveDeltaEvent,
  contentWindow: SubAgentRunContentWindow,
  manifest?: MonitorLiveDeltaFreshness
): SubAgentRunContentWindow | undefined {
  if (!event.runId || !hasRenderableMonitorLiveDelta(event)) return contentWindow
  const eventRevision = getMonitorLiveDeltaRevision(event)
  const windowRevision = typeof contentWindow.contentRevision === 'number' ? contentWindow.contentRevision : 0
  if (eventRevision < windowRevision) return contentWindow

  const freshness = {
    contentCount: manifest?.contentCount ?? contentWindow.totalCount,
    contentRevision: eventRevision,
    eventSequence: getMonitorLiveDeltaSequence(event) ?? manifest?.eventSequence ?? contentWindow.eventSequence
  }
  if (!isRunWindowTailAuthoritative(contentWindow, freshness)) return undefined

  // 修改原因：后端不再为每个 SubAgent llm_delta 附带完整 snapshot，否则大输出会造成 postMessage 与事件数组 O(n²) 膨胀。
  // 修改方式：当事件仍携带轻量可渲染 delta 且窗口已确认是同 revision 尾部时，Monitor 前端用共享 Content[] delta reducer 本地更新已加载 run。
  // 修改目的：兼容旧协议实时输出，同时新瘦身协议不会把大正文塞进 event。
  const timestamp = event.timestamp || Date.now()
  const nextContents = applyStreamChunkToContents(contentWindow.contents || [], event.payload, timestamp, contentWindow.startIndex || 0)
  const sequence = getMonitorLiveDeltaSequence(event)
  return {
    ...contentWindow,
    contents: nextContents,
    endIndex: Math.max(contentWindow.endIndex, contentWindow.startIndex + nextContents.length),
    totalCount: Math.max(contentWindow.totalCount, contentWindow.startIndex + nextContents.length),
    contentRevision: eventRevision,
    eventSequence: Math.max(contentWindow.eventSequence || 0, sequence ?? manifest?.eventSequence ?? 0)
  }
}

function replayBufferedLiveDeltas(runId: string) {
  const currentWindow = windowsByRunId.value[runId]
  const currentBuffer = liveDeltaBuffersByRunId.get(runId)
  if (!currentWindow || !currentBuffer?.length) return

  const { replayable, remaining } = selectReplayableMonitorLiveDeltas(currentBuffer, currentWindow)
  if (replayable.length === 0) {
    setLiveDeltaBuffer(runId, remaining)
    return
  }

  let workingWindow = currentWindow
  const stillBlocked: MonitorLiveDeltaEvent[] = []
  for (const event of replayable) {
    const nextWindow = applyLiveDeltaToWindow(event, workingWindow, {
      contentCount: workingWindow.totalCount,
      eventSequence: getMonitorLiveDeltaSequence(event) ?? workingWindow.eventSequence
    })
    if (!nextWindow) {
      stillBlocked.push(event)
      continue
    }
    workingWindow = nextWindow
  }

  windowsByRunId.value = {
    ...windowsByRunId.value,
    [runId]: workingWindow
  }
  setLiveDeltaBuffer(runId, [...stillBlocked, ...remaining])
}

function enqueueLlmDelta(event: SubAgentRunEvent) {
  if (!event?.runId) return
  const list = pendingLlmDeltaEvents.get(event.runId)
  if (list) {
    list.push(event)
  } else {
    pendingLlmDeltaEvents.set(event.runId, [event])
  }
  scheduleLlmDeltaFlush()
}

function scheduleLlmDeltaFlush() {
  if (llmDeltaFlushScheduled) return
  llmDeltaFlushScheduled = true
  const generation = ++llmDeltaFlushGeneration
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (generation !== llmDeltaFlushGeneration) return
      finishLlmDeltaFlush()
    })
  }
  // rAF 在面板隐藏等极端场景可能不触发，setTimeout 兜底保证队列不会无限堆积
  llmDeltaFlushFallbackTimer = setTimeout(() => {
    if (generation !== llmDeltaFlushGeneration) return
    finishLlmDeltaFlush()
  }, 100)
}

function finishLlmDeltaFlush() {
  llmDeltaFlushScheduled = false
  if (llmDeltaFlushFallbackTimer) {
    clearTimeout(llmDeltaFlushFallbackTimer)
    llmDeltaFlushFallbackTimer = undefined
  }
  flushPendingLlmDeltas()
}

function flushPendingLlmDeltas() {
  if (pendingLlmDeltaEvents.size === 0) return
  const batches = Array.from(pendingLlmDeltaEvents.entries())
  pendingLlmDeltaEvents.clear()

  let nextManifests: SubAgentRunManifest[] | undefined
  let nextWindows: Record<string, SubAgentRunContentWindow> | undefined
  const needWindowRefresh: string[] = []

  for (const [runId, events] of batches) {
    const existingManifest = manifests.value.find(item => item.runId === runId)
    const lastEvent = events[events.length - 1]
    const timestamp = lastEvent.timestamp || Date.now()

    // 合并 manifest：以最后一个事件为准，整批只提交一次
    const mergedManifest: SubAgentRunManifest = {
      runId,
      agentName: lastEvent.agentName || existingManifest?.agentName,
      status: existingManifest?.status || 'running',
      createdAt: existingManifest?.createdAt || timestamp,
      updatedAt: timestamp,
      conversationId: existingManifest?.conversationId,
      contentCount: lastEvent.payload?.contentCount ?? existingManifest?.contentCount ?? windowsByRunId.value[runId]?.totalCount ?? 0,
      eventCount: existingManifest?.eventCount || 0,
      contentRevision: lastEvent.contentRevision ?? lastEvent.payload?.contentRevision ?? existingManifest?.contentRevision,
      eventSequence: lastEvent.eventSequence ?? lastEvent.payload?.eventSequence ?? existingManifest?.eventSequence,
      preview: existingManifest?.preview,
      lastMessageRole: existingManifest?.lastMessageRole
    }

    // 窗口应用：在同一个工作副本上依次应用本批全部 delta，最后只提交一次
    let workingWindow = windowsByRunId.value[runId]
    let buffered = false
    for (const event of events) {
      if (!hasRenderableMonitorLiveDelta(event)) continue
      if (!workingWindow) {
        const isFocusedLiveRun = event.runId === focusedRunId.value || event.runId === focusedManifest.value?.runId
        if (isFocusedLiveRun) {
          bufferLiveDeltaEvent(event)
          buffered = true
        }
        continue
      }
      const nextWindow = applyLiveDeltaToWindow(event, workingWindow, mergedManifest)
      if (!nextWindow) {
        bufferLiveDeltaEvent(event)
        buffered = true
        continue
      }
      workingWindow = nextWindow
    }

    if (!nextManifests) nextManifests = [...manifests.value]
    const index = nextManifests.findIndex(item => item.runId === runId)
    if (index >= 0) {
      nextManifests[index] = { ...nextManifests[index], ...mergedManifest }
    } else {
      nextManifests.unshift(mergedManifest)
    }
    if (workingWindow) {
      if (!nextWindows) nextWindows = { ...windowsByRunId.value }
      nextWindows[runId] = workingWindow
    }
    if (buffered) needWindowRefresh.push(runId)
  }

  if (nextManifests) manifests.value = nextManifests
  if (nextWindows) windowsByRunId.value = nextWindows
  for (const runId of needWindowRefresh) {
    void requestRunWindow(runId, true)
  }
}

function getFunctionResponseMap(contents: Content[]): Map<string, NonNullable<ContentPart['functionResponse']>> {
  const map = new Map<string, NonNullable<ContentPart['functionResponse']>>()
  for (const content of contents) {
    const parts = content.parts || []
    for (const part of parts) {
      const response = part.functionResponse
      if (response?.id) {
        map.set(response.id, response)
      }
    }
  }
  return map
}

function deriveToolStatus(result: unknown): ToolUsage['status'] {
  const r = result as any
  if (r?.success === false || r?.error || r?.cancelled || r?.rejected) return 'error'
  const data = r?.data
  if (data && typeof data === 'object') {
    if ((data as any).status === 'pending') return 'awaiting_apply'
    // 部分接受（用户拒绝了部分块或手动编辑内容）→ warning；与主聊天状态推导一致
    if ((data as any).partial === true || (data as any).status === 'partial') return 'warning'
    const appliedCount = (data as any).appliedCount
    const failedCount = (data as any).failedCount
    if (typeof appliedCount === 'number' && typeof failedCount === 'number' && appliedCount > 0 && failedCount > 0) {
      return 'warning'
    }
  }
  return 'success'
}

// 修改原因：renderMessages 每次窗口更新都会对所有消息重新调用 contentToMessageEnhanced 生成新 Message 对象，
//          MessageItem 收到新的 props 引用后即使内容未变也会重新渲染（包括重新解析 Markdown），
//          流式输出时每个 delta 都触发窗口内全部消息的重渲染，这是 Monitor 卡顿的主要来源之一。
// 修改方式：按 run 维护 contentIndex -> { content 引用, overlay 引用, message } 缓存；只有 content、
//          工具 overlay 引用或 streaming 状态翻转时才重建对应消息。
// 修改目的：未变化的楼层保持 Message 对象引用稳定，MessageItem 直接跳过渲染，流式更新成本与窗口长度解耦。
interface RenderMessageCacheEntry {
  contentRef: Content
  overlayRef: MonitorToolStatusOverlay | undefined
  message: Message
}
const renderMessageCacheByRun = new Map<string, Map<number, RenderMessageCacheEntry>>()
const MAX_RENDER_MESSAGE_CACHE_ENTRIES_PER_RUN = 200

// 修改原因：renderMessageCacheByRun 只在单 run 超限（>200 条）时整表删除，run 结束后缓存一直保留，
//          长期会话内存随 run 数线性增长。
// 修改方式：run 进入终态（completed/failed/cancelled）且不再被后端持有（不在 activeRunIds）时，
//          显式删除该 run 的缓存；仍保留单 run 超限的全局容量上限逻辑。
// 修改目的：终态 run 的 Message 引用不再参与渲染（重新查看时按需重建），及时释放内存。
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['completed', 'failed', 'cancelled'])
const terminalInactiveRunIds = computed(() => {
  const runIds: string[] = []
  for (const manifest of manifests.value) {
    if (TERMINAL_RUN_STATUSES.has(manifest.status) && !activeRunIds.value.has(manifest.runId)) {
      runIds.push(manifest.runId)
    }
  }
  return runIds
})

watch(terminalInactiveRunIds, runIds => {
  for (const runId of runIds) {
    renderMessageCacheByRun.delete(runId)
  }
}, { immediate: true })

function toRenderableMessages(run: SubAgentRunSnapshot | undefined): Message[] {
  if (!run) return []
  const responseMap = getFunctionResponseMap(run.contents || [])
  const toolOverlay = toolStatusOverlaysByRunId.value[run.runId]
  const contentWindow = windowsByRunId.value[run.runId]
  const isLiveRun = activeRunIds.value.has(run.runId)
    && (run.status === 'queued' || run.status === 'running' || run.status === 'paused' || run.status === 'awaiting_monitor_action')

  let cache = renderMessageCacheByRun.get(run.runId)
  if (!cache) {
    cache = new Map()
    renderMessageCacheByRun.set(run.runId, cache)
  }

  const contents = run.contents || []
  const tailContentIndex = Math.max(0, (contentWindow?.totalCount || 0) - 1)
  const messages: Message[] = []
  for (let windowOffset = 0; windowOffset < contents.length; windowOffset++) {
    const content = contents[windowOffset]
    if (content.isFunctionResponse === true) continue
    // 修改原因：Monitor 现在只加载 transcript window，可见数组下标既不等于完整 Content[] 索引，也可能跳过 functionResponse。
    // 修改方式：优先使用后端 content.index，缺失时用窗口 startIndex + offset 还原真实 contentIndex，并写入 backendIndex。
    // 修改目的：删除/重试时仍传给后端真实 contentIndex，不会误删窗口内相邻消息。
    const contentIndex = typeof content.index === 'number'
      ? content.index
      : (contentWindow?.startIndex || 0) + windowOffset

    const cached = cache.get(contentIndex)
    if (cached && cached.contentRef === content && cached.overlayRef === toolOverlay) {
      const shouldStream = isLiveRun
        && content.role === 'model'
        && contentWindow?.hasMoreAfter !== true
        && contentIndex === tailContentIndex
      if (cached.message.streaming !== shouldStream) {
        // streaming 状态翻转时浅复制一次（content/parts 引用不变），只在 run 状态转换时发生
        const corrected = { ...cached.message, streaming: shouldStream }
        cache.set(contentIndex, { ...cached, message: corrected })
        messages.push(corrected)
      } else {
        messages.push(cached.message)
      }
      continue
    }

    const message = contentToMessageEnhanced(content, `${run.runId}_${contentIndex}`)
    message.backendIndex = contentIndex

    // 修改原因：Monitor 复用 MessageItem 但过去没有给活跃尾部 model 消息标记 streaming，导致它不走主窗口同一流式 Markdown 策略。
    // 修改方式：当当前窗口覆盖 transcript 尾部，且 run 仍由后端 active controller 管理时，只把尾部 model 楼层投影为 streaming。
    // 修改目的：SubAgent Monitor 与主聊天共享“活跃尾部消息流式渲染、历史消息完成态渲染”的统一契约。
    if (
      isLiveRun &&
      content.role === 'model' &&
      contentWindow?.hasMoreAfter !== true &&
      contentIndex === tailContentIndex
    ) {
      message.streaming = true
    }

    if (message.tools && message.tools.length > 0) {
      message.tools = message.tools.map(tool => {
        const response = responseMap.get(tool.id)
        if (!response) return applyMonitorToolOverlay(tool, toolOverlay)
        const result = response.response as Record<string, unknown>
        return {
          ...applyMonitorToolOverlay(tool, toolOverlay),
          result,
          status: deriveToolStatus(result)
        }
      })
    }

    cache.set(contentIndex, { contentRef: content, overlayRef: toolOverlay, message })
    messages.push(message)
  }

  // 分页历史累积时缓存条目可能超过窗口大小，超限直接清空该 run 缓存（下次重建，属少见路径）
  if (cache.size > MAX_RENDER_MESSAGE_CACHE_ENTRIES_PER_RUN) {
    renderMessageCacheByRun.delete(run.runId)
  }
  return messages
}

const renderMessages = computed(() => toRenderableMessages(focusedRun.value))

// 修改原因：Monitor 是实时监视面板，但过去从不跟随新内容，用户必须一直手动往下拖才能看到 SubAgent 正在输出什么。
// 修改方式：复用主聊天 MessageList 的做法——监听滚动容器判断是否贴底，贴底时随尾部内容增长自动滚到底部。
// 修改目的：默认跟随实时输出，同时用户一旦向上翻阅历史就不再被强行拽回底部。
const scrollbarRef = ref<{ scrollToBottom: (options?: { instant?: boolean }) => void; getContainer: () => HTMLElement | undefined } | null>(null)
const shouldAutoFollow = ref(true)
let detachScrollListener: (() => void) | undefined

function handleScroll() {
  const container = scrollbarRef.value?.getContainer()
  if (!container) return
  const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  shouldAutoFollow.value = distanceToBottom <= AUTO_FOLLOW_THRESHOLD_PX
}

/**
 * 尾部内容指纹。
 *
 * 使用尾部消息的全局 index 而不是窗口内数组长度，这样「加载更早消息」向前 prepend 时指纹不变，
 * 不会把正在阅读历史的用户弹回底部。
 */
const tailSignature = computed(() => {
  const run = focusedRun.value
  const contents = run?.contents || []
  if (!run || contents.length === 0) return ''
  const last = contents[contents.length - 1]
  const parts = last?.parts || []
  const lastPart = parts[parts.length - 1]
  return [
    run.runId,
    last?.index ?? contents.length - 1,
    parts.length,
    (lastPart?.text || '').length
  ].join('|')
})

watch(tailSignature, () => {
  if (!shouldAutoFollow.value) return
  // 流式过程中用 instant，避免每个增量都触发一次被立刻打断的平滑滚动
  void nextTick(() => scrollbarRef.value?.scrollToBottom({ instant: true }))
})

const RUN_STATUS_LABEL_KEYS: Record<RunStatus, string> = {
  queued: 'queued',
  running: 'running',
  paused: 'paused',
  awaiting_monitor_action: 'awaitingMonitorAction',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted'
}

function statusLabel(status: RunStatus | undefined): string {
  if (!status) return ''
  const key = RUN_STATUS_LABEL_KEYS[status]
  return key ? t(`components.subagents.monitor.status.${key}`) : status
}
const focusedRunIsActive = computed(() => !!focusedRun.value && activeRunIds.value.has(focusedRun.value.runId))
const focusedWindow = computed(() => focusedRun.value ? windowsByRunId.value[focusedRun.value.runId] : undefined)
const focusedOlderLoading = computed(() => !!focusedRun.value && loadingOlderRunWindows.value.has(focusedRun.value.runId))
const latestRetryEvent = computed(() => {
  const events = focusedRun.value?.events || []
  // 修改原因：SubAgent 自动重试状态已通过 runEventBus 路由到 Monitor，需要在聊天视图顶部给用户可见反馈。
  // 修改方式：从当前 run 的事件列表倒序查找 retrying/retrySuccess/retryFailed 最新事件。
  // 修改目的：不把内部重试推到主窗口，同时让 Monitor 能审计自动重试过程。
  return [...events].reverse().find(event => event.type === 'retrying' || event.type === 'retrySuccess' || event.type === 'retryFailed')
})

// P5：运行时间显示改为相对耗时（如「42s / 2m30s」），绝对本地时间戳对用户没有意义。
// 与 BackgroundTaskBar 的 formatDuration 语义一致：运行中显示已运行时长，结束后显示总耗时。
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

function selectRun(runId: string) {
  // 修改原因：用户在 Monitor 内点击 run tab 是显式选择，后续 run 事件不应再用旧 focusRunId 覆盖它。
  // 修改方式：除更新 focusedRunId 外，同步标记 hasUserSelectedRun，并在缺少窗口时按需拉取。
  // 修改目的：并发多个 SubAgent 时，用户可以稳定查看任意一个 run，且只为实际查看的 run 加载 Content[]。
  hasUserSelectedRun.value = true
  focusedRunId.value = runId
  void requestRunWindow(runId)
}

/** 控制操作未生效时的一次性提示（数秒后自动消失） */
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

function updateActiveRunIds(raw: unknown) {
  // 修改原因：activeRunIds 来自后端运行控制器，是判断顶部控制按钮是否可用的权威来源。
  // 修改方式：只接受字符串数组并转换为 Set，非法载荷回退为空集合。
  // 修改目的：避免前端根据历史状态猜测可控制性。
  activeRunIds.value = new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [])
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
  const response = await sendToExtension<{ success?: boolean; active?: boolean; status?: RunStatus }>(type, {
    runId: run.runId,
    reason: action === 'exit' ? '用户主动终止 SubAgent 执行' : undefined
  }, { clientId: 'subagent-monitor' })

  // 修改原因：控制请求失败时前端过去完全无反馈——按钮还在，点了却什么都不发生（run 刚好结束时必然如此）。
  // 修改方式：后端回传该 run 当前是否仍被运行控制器持有；不再活跃就本地摘掉控制按钮，并提示操作未生效。
  // 修改目的：按钮的可见性与可用性始终反映后端真实控制权。
  if (response?.active === false || (action === 'exit' && response?.success === true)) {
    const next = new Set(activeRunIds.value)
    next.delete(run.runId)
    activeRunIds.value = next
  }
  if (response?.success === false) {
    showControlNotice(t('components.subagents.monitor.controlUnavailable'))
  }
}

function pauseFocusedRun() {
  void controlFocusedRun('pause')
}

function resumeFocusedRun() {
  void controlFocusedRun('resume')
}

function exitFocusedRun() {
  void controlFocusedRun('exit')
}

function findContentIndexByMessageId(messageId: string): number | null {
  const message = renderMessages.value.find(item => item.id === messageId)
  return typeof message?.backendIndex === 'number' ? message.backendIndex : null
}

async function handleCopy(content: string) {
  // 修改原因：Monitor 复用 MessageItem 的复制按钮，但没有主窗口 MessageList 的上层 copy handler。
  // 修改方式：在 Monitor 内部直接调用 Clipboard API。
  // 修改目的：让子聊天窗口每一楼的复制按钮和主窗口一样可用，同时不依赖主聊天 store。
  if (!content) return
  await navigator.clipboard?.writeText(content)
}

async function mutateRunMessage(messageId: string, messageType: 'delete' | 'retry') {
  const run = focusedRun.value
  const contentIndex = findContentIndexByMessageId(messageId)
  if (!run || contentIndex === null) return

  // 修改原因：Monitor 的删除/重试只应该改 SubAgent 子对话，不影响主聊天历史。
  // 修改方式：向后端发送 runId、真实 contentIndex 和 conversationId，由后端基于 TranscriptMutation 更新 subAgentRuns 子记录。
  // 修改目的：保持子对话持久化记录为 source of truth，并复用后端配对删除规则。
  const type = messageType === 'delete' ? 'subagents.deleteRunMessage' : 'subagents.retryRunFromMessage'
  const response = await sendToExtension<{
    manifest?: SubAgentRunManifest
    window?: SubAgentRunContentWindow
    contentWindow?: SubAgentRunContentWindow
    snapshot?: SubAgentRunSnapshot
  }>(type, {
    runId: run.runId,
    contentIndex,
    conversationId: run.conversationId
  }, { clientId: 'subagent-monitor' })
  if (response?.manifest) upsertManifest(response.manifest)
  const returnedWindow = response?.window || response?.contentWindow
  if (returnedWindow) {
    // 修改原因：删除/重试后端响应已改为 manifest + window，不能再把完整 snapshot.contents 回传到 Monitor。
    // 修改方式：用后端返回的权威窗口替换当前 run 缓存；窗口内 Content[] 仍交给 MessageItem 渲染。
    // 修改目的：用户操作后校准当前 run，但大 run 不会因单次 mutation 全量进入前端。
    upsertWindow(returnedWindow)
  }
  if (response?.snapshot) {
    // 修改原因：保留旧协议兼容只用于防御旧扩展/测试夹层，新增后端不应再走这里。
    // 修改方式：只在没有 window 时从 snapshot 投影为窗口，避免新协议回退依赖 full snapshot。
    // 修改目的：不破坏运行中的旧消息，同时让测试锁定新 handler 不返回 snapshot。
    upsertManifest({
      runId: response.snapshot.runId,
      agentName: response.snapshot.agentName,
      status: response.snapshot.status,
      createdAt: response.snapshot.createdAt,
      updatedAt: response.snapshot.updatedAt,
      conversationId: response.snapshot.conversationId,
      contentCount: response.snapshot.contents.length,
      eventCount: response.snapshot.events.length,
      contentRevision: response.snapshot.contentRevision,
      eventSequence: response.snapshot.eventSequence,
      preview: response.snapshot.contents[response.snapshot.contents.length - 1]?.parts?.find(part => part.text)?.text?.slice(0, 160),
      lastMessageRole: response.snapshot.contents[response.snapshot.contents.length - 1]?.role
    })
    if (!returnedWindow) {
      upsertWindow({
        runId: response.snapshot.runId,
        contents: response.snapshot.contents,
        startIndex: 0,
        endIndex: response.snapshot.contents.length,
        totalCount: response.snapshot.contents.length,
        contentRevision: response.snapshot.contentRevision,
        eventSequence: response.snapshot.eventSequence,
        hasMoreBefore: false,
        hasMoreAfter: false
      })
    }
    eventsByRunId.value = { ...eventsByRunId.value, [response.snapshot.runId]: response.snapshot.events || [] }
  }
}

function handleDelete(messageId: string) {
  void mutateRunMessage(messageId, 'delete').catch(error => {
    showControlNotice(error instanceof Error ? error.message : String(error))
  })
}

function handleRetry(messageId: string) {
  void mutateRunMessage(messageId, 'retry').catch(error => {
    showControlNotice(error instanceof Error ? error.message : String(error))
  })
}

function noop() {
  // 修改原因：Monitor 当前阶段仍不支持编辑或回档编辑，避免误改主聊天历史或检查点。
  // 修改方式：仅保留 edit/restore edit/restore retry 的空处理，删除、复制、重试已接入子对话专用 handler。
  // 修改目的：逐步复用主窗口消息操作，同时不引入未设计好的编辑语义。
}

watch(
  () => focusedManifest.value?.runId,
  runId => {
    if (!runId) return
    // 切换 run 视为重新进入该会话：恢复跟随并滚到最新一条
    shouldAutoFollow.value = true
    void requestRunWindow(runId)
    void nextTick(() => scrollbarRef.value?.scrollToBottom({ instant: true }))
  }
)

// 修改原因：内嵌面板模式下，面板可见性由主窗口布局决定（v-show），组件本身不会销毁。
// 修改方式：监听 visible prop，向后端通知事件推送开关（隐藏时丢弃高频 llm_delta）。
// 修改目的：面板折叠时不接收高频事件，与独立窗口方案「不可见丢 delta」的语义一致。
watch(
  () => props.visible,
  (visible) => {
    sendToExtension('subagents.monitor.setVisible', { visible: !!visible }, { clientId: 'subagent-monitor' })
      .catch(() => undefined)
  },
  { immediate: true }
)

// 修改原因：主窗口「打开详情」时通过 host.openSubAgentMonitor 命令携带目标 runId，
//          面板已挂载（v-show）时组件收不到新的初始 runId，需要 prop 驱动导航。
// 修改方式：监听 focusRunId prop，出现新值时强制切换焦点并加载窗口。
// 修改目的：从工具卡打开详情能实时定位到对应 run，且覆盖用户手动选中的旧焦点。
watch(
  () => props.focusRunId,
  (runId) => {
    if (!runId) return
    hasUserSelectedRun.value = false
    focusedRunId.value = runId
    void requestRunWindow(runId)
  },
  { immediate: true }
)

onMounted(async () => {
  // 修改原因：Monitor 应渲染 SubAgent 子对话 Content[]，但不应在首屏拉取所有 run 的完整 transcript。
  // 修改方式：挂载后请求轻量 manifests，并订阅后续 manifest/event；聚焦 run 再请求窗口。
  // 修改目的：像主聊天窗口一样展示消息语义，同时避免大输出 Monitor 打开卡顿。
  disposeMessageListener = onMessageFromExtension((message: any) => {
    // 窗口焦点状态：音效控制器据此决定是否播放提示音（聚焦时不播），与主窗口同一套规则
    if (message.type === 'command' && message.command === 'windowFocusChanged') {
      setVscodeWindowFocused(message.data?.focused === true)
    }
    if (message.type === 'subagentMonitor.event') {
      if (message.data?.manifest) upsertManifest(message.data.manifest)
      if (shouldApplyEventFocus({
        currentFocusRunId: focusedRunId.value,
        incomingFocusRunId: message.data?.focusRunId,
        hasUserSelectedRun: hasUserSelectedRun.value
      })) {
        // 修改原因：实时事件携带的 focusRunId 是用户从主界面打开详情时的导航意图，delta 处理前需要先知道当前聚焦 run。
        // 修改方式：把焦点同步提前到 event 应用之前，后续无窗口 delta 才能进入当前 run 的有界缓冲。
        // 修改目的：修复“刚打开 Monitor 时首批 delta 被当成后台 run 丢弃”的时序漏洞。
        focusedRunId.value = message.data.focusRunId
      }
      if (message.data?.event) {
        appendEvent(message.data.event)
        // 重试类事件（retrying/retryFailed）经子代理独立开关播提示音
        handleMonitorRunSoundEvent(message.data.event)
        if (message.data.event.type === 'llm_delta') {
          // 修改原因：高频 llm_delta 不能每个都触发响应式更新，统一入队后由 rAF 批量 flush。
          // 修改方式：llm_delta 只入队；content_snapshot/tool_* 等状态事件仍即时处理保证低延迟。
          // 修改目的：事件回调变成 O(1) 入队，Vue 更新频率与帧率对齐。
          enqueueLlmDelta(message.data.event)
        } else {
          if (message.data.event.type === 'content_snapshot') {
            clearSupersededLiveDeltaBuffer(
              message.data.event.runId,
              message.data.event.contentRevision ?? message.data.event.payload?.contentRevision
            )
          }
          if (message.data.event.runId === focusedRun.value?.runId) {
            // 修改原因：低频事件代表后端真源可能已推进，聚焦窗口需要跟上，但不能接收完整 snapshot。
            // 修改方式：交给 requestRunWindow 内部的 revision 判据决定是否真的发起请求——
            //          transcript 真的变了才拉，tool_started 这类纯状态事件不再触发无谓往返。
            // 修改目的：保证当前可见内容最终一致，同时避免高频工具调用把窗口请求打成风暴。
            void requestRunWindow(message.data.event.runId)
          }
        }
      }
      updateActiveRunIds(message.data?.activeRunIds)
    }
    if (message.type === 'subagentMonitor.manifest') {
      applyManifestPayload(message.data)
      // 修改原因：面板从后台标签页回到前台时，扩展端会补推一次 manifest——期间被丢弃的正文增量必须在这里补回来。
      // 修改方式：按同一套 revision 判据校准当前聚焦窗口；没有落后就是一次空操作。
      // 修改目的：不可见期间零推送，恢复可见后立刻与后端 transcript 一致。
      void requestRunWindow(focusedManifest.value?.runId)
    }
  })

  const container = scrollbarRef.value?.getContainer()
  if (container) {
    container.addEventListener('scroll', handleScroll, { passive: true })
    detachScrollListener = () => container.removeEventListener('scroll', handleScroll)
  }

  const initial = await sendToExtension<{ manifests: SubAgentRunManifest[]; focusRunId?: string; activeRunIds?: string[] }>(MESSAGE_NAMES['subagents.monitorReady'], {}, { clientId: 'subagent-monitor' })
  applyManifestPayload(initial)
  const initialFocus = initial?.focusRunId || focusedManifest.value?.runId
  if (initialFocus) {
    focusedRunId.value = initialFocus
    await requestRunWindow(initialFocus)
    await nextTick()
    scrollbarRef.value?.scrollToBottom({ instant: true })
  }
})

onBeforeUnmount(() => {
  disposeMessageListener?.()
  detachScrollListener?.()
  detachScrollListener = undefined
  if (elapsedTicker) {
    clearInterval(elapsedTicker)
    elapsedTicker = undefined
  }
  if (llmDeltaFlushFallbackTimer) {
    clearTimeout(llmDeltaFlushFallbackTimer)
    llmDeltaFlushFallbackTimer = undefined
  }
  pendingLlmDeltaEvents.clear()
  llmDeltaFlushScheduled = false
  if (controlNoticeTimer) {
    clearTimeout(controlNoticeTimer)
    controlNoticeTimer = undefined
  }
})
</script>


<template>
  <div class="monitor-root" :class="{ embedded: props.embedded }">
    <header class="monitor-header">
      <div>
        <h1>{{ t('components.subagents.monitor.title') }}</h1>
        <p>{{ t('components.subagents.monitor.subtitle') }}</p>
      </div>
      <div class="monitor-header-actions">
        <span class="run-count">{{ t('components.subagents.monitor.runCount', { count: orderedRuns.length }) }}</span>
        <button
          v-if="props.embedded"
          class="monitor-close-btn"
          type="button"
          :title="t('components.subagents.monitor.closePanel')"
          @click="emit('close')"
        >
          <span class="codicon codicon-close"></span>
        </button>
      </div>
    </header>

    <div v-if="orderedRuns.length > 1" class="run-tabs">
      <button
        v-for="run in orderedRuns"
        :key="run.runId"
        class="run-tab"
        :class="{ active: focusedRun?.runId === run.runId }"
        type="button"
        @click="selectRun(run.runId)"
      >
        <span class="run-name">{{ run.agentName || t('components.subagents.monitor.defaultAgentName') }}</span>
        <span class="run-meta">{{ statusLabel(run.status) }} · {{ runElapsed(run) }}</span>
      </button>
    </div>

    <!--
      修改原因：写死的 max-height: calc(100vh - 96px) 与外层 flex 布局冲突——run tabs 行出现时头部实际高度
                超过 96px，滚动区会溢出到视口以外，底部消息被裁掉。
      修改方式：去掉 max-height，让 CustomScrollbar 回到 height:100% 模式，由 .message-scroll 的 flex:1 决定高度。
      修改目的：无论是否显示 run tabs、重试状态行，滚动区都精确占满剩余空间。
    -->
    <CustomScrollbar ref="scrollbarRef" class="message-scroll">
      <div v-if="!focusedRun" class="empty">
        <i class="codicon codicon-hubot"></i>
        <span>{{ t('components.subagents.monitor.empty') }}</span>
      </div>

      <div v-else class="message-shell">
        <div class="run-title-row">
          <div class="run-title-info">
            <div class="run-title">{{ focusedRun.agentName || t('components.subagents.monitor.defaultAgentName') }}</div>
            <div class="run-subtitle">{{ focusedRun.runId }} · {{ statusLabel(focusedRun.status) }} · {{ runElapsed(focusedRun) }}</div>
            <div v-if="focusedWindow?.hasMoreBefore" class="run-window-note">
              <!--
                修改原因：当前窗口可能由多次向前分页拼接而来，文案不能继续暗示只显示“最近”尾部。
                修改方式：按当前窗口实际 contents.length / totalCount 展示已加载数量，顶部按钮负责继续加载更早。
                修改目的：让用户知道还有历史可取，同时不为首屏恢复全量加载。
              -->
              {{ t('components.subagents.monitor.loadedCount', { loaded: focusedWindow.contents.length, total: focusedWindow.totalCount }) }}
            </div>
            <div v-if="latestRetryEvent" class="run-retry-status" :class="`retry-${latestRetryEvent.type}`">
              <span class="codicon" :class="latestRetryEvent.type === 'retrying' ? 'codicon-sync codicon-modifier-spin' : latestRetryEvent.type === 'retrySuccess' ? 'codicon-check' : 'codicon-warning'"></span>
              <span>
                {{ latestRetryEvent.type === 'retrying'
                  ? t('components.subagents.monitor.retrying', { attempt: latestRetryEvent.payload?.attempt ?? '', maxAttempts: latestRetryEvent.payload?.maxAttempts ?? '' })
                  : latestRetryEvent.type === 'retrySuccess'
                    ? t('components.subagents.monitor.retrySuccess')
                    : t('components.subagents.monitor.retryFailed', { error: latestRetryEvent.payload?.error || '' }) }}
              </span>
            </div>
          </div>
          <!--
            修改原因：历史 run 的控制按钮整组消失，界面上没有任何说明，用户会以为按钮加载失败或功能坏了。
            修改方式：非活跃 run 显示只读徽标，明确"这是历史运行，只能查看"。
            修改目的：控制能力的缺失是有解释的状态，而不是无声的空白。
          -->
          <div class="run-title-actions">
            <!-- 提示独立于控制按钮组：历史 run 上的删除/重试失败同样需要被看见 -->
            <span v-if="controlNotice" class="control-notice">
              <span class="codicon codicon-warning"></span>
              {{ controlNotice }}
            </span>
            <span v-if="focusedRun && !focusedRunIsActive" class="run-readonly-badge">
              <span class="codicon codicon-history"></span>
              {{ t('components.subagents.monitor.readOnly') }}
            </span>
            <div v-if="focusedRunIsActive" class="run-control-buttons">
            <!--
              修改原因：活跃 SubAgent run 需要能从 Monitor 顶部暂停、继续或退出。
              修改方式：按钮只在 activeRunIds 包含当前 run 时显示，并把操作发送给后端 runController。
              修改目的：历史 run 只可查看，活跃 run 才能影响主窗口工具调用。
            -->
            <!--
              修改原因：按钮文案与实际语义不符——pause 标成「中止」容易和下面的「退出」混淆，resume 标成「重试」
                        更是误导（它是从暂停处继续同一个 run，不会重跑）。
              修改方式：改用与动作一致的「暂停 / 继续」文案，并全部走 i18n。
              修改目的：用户能从按钮直接判断后果，不会误触真正终止 run 的操作。
            -->
            <button v-if="focusedRun.status === 'running'" class="control-btn" type="button" @click="pauseFocusedRun">
              <span class="codicon codicon-debug-pause"></span>
              {{ t('components.subagents.monitor.pause') }}
            </button>
            <button v-if="focusedRun.status === 'paused' || focusedRun.status === 'awaiting_monitor_action'" class="control-btn primary" type="button" @click="resumeFocusedRun">
              <span class="codicon codicon-debug-continue"></span>
              {{ t('components.subagents.monitor.resume') }}
            </button>
            <button class="control-btn danger" type="button" @click="exitFocusedRun">
              <span class="codicon codicon-debug-stop"></span>
              {{ t('components.subagents.monitor.exit') }}
            </button>
            </div>
          </div>
        </div>

        <div v-if="focusedWindow?.hasMoreBefore" class="load-older-row">
          <!--
            修改原因：默认只加载尾部 20 条时，用户需要可控地向前补齐历史，而不是误以为早期内容丢失。
            修改方式：按钮调用同一个 getRunWindow 协议，以当前 window.startIndex 为 endIndex 拉取上一页并 prepend。
            修改目的：继续保持 manifest/window 按需加载，不回退到一次性完整 snapshot。
          -->
          <button class="load-older-btn" type="button" :disabled="focusedOlderLoading" @click="loadOlderMessages">
            <span v-if="focusedOlderLoading" class="codicon codicon-sync codicon-modifier-spin"></span>
            <span v-else class="codicon codicon-arrow-up"></span>
            {{ focusedOlderLoading ? t('components.subagents.monitor.loadingOlder') : t('components.subagents.monitor.loadOlder') }}
          </button>
        </div>

        <MessageItem
          v-for="(message, index) in renderMessages"
          :key="message.id"
          :message="message"
          :message-index="message.backendIndex ?? index"
          @edit="noop"
          @restore-and-edit="noop"
          @delete="handleDelete"
          @retry="handleRetry"
          @restore-and-retry="noop"
          @copy="handleCopy"
        />
      </div>
    </CustomScrollbar>
  </div>
</template>

<style scoped>
.monitor-root {
  height: 100vh;
  min-width: 0;
  overflow-x: hidden;
  box-sizing: border-box;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  display: flex;
  flex-direction: column;
}

/* 内嵌面板模式：铺满宿主容器（主窗口右侧分区） */
.monitor-root.embedded {
  height: 100%;
}

.monitor-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  padding: 14px 16px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.monitor-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.monitor-close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s, background 0.15s;
}

.monitor-close-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.monitor-header > div {
  min-width: 0;
  flex: 1 1 180px;
}

.monitor-header h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.monitor-header p {
  margin: 4px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.run-count {
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 11px;
  white-space: nowrap;
}

.run-tabs {
  display: flex;
  min-width: 0;
  overflow-x: hidden;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
  /* 修改原因：子 agent 数量多时单行横向滚动不好翻，改为多行换行。
     修改方式：flex-wrap 自动折行；限制最大高度，run 极多时退化为纵向滚动而不是占满整个面板。 */
  max-height: 172px;
  overflow-y: auto;
}

.run-tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  /* 修改原因：多行换行后若保持定宽，最后一行会留出难看的缺口。
     修改方式：允许 tab 在行内伸展铺满，但每行至少 170px，避免单个 tab 过窄。 */
  flex: 1 1 170px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 7px;
  background: var(--vscode-sideBar-background);
  color: var(--vscode-foreground);
  cursor: pointer;
}

.run-tab.active {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
}

.run-name,
.run-meta {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-name {
  font-size: 12px;
  font-weight: 600;
}

.run-meta,
.run-subtitle {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.run-window-note {
  /* 修改原因：Monitor 默认只拉尾部窗口时，用户需要知道当前不是完整 transcript。
     修改方式：使用与 subtitle 一致的弱提示样式，避免抢占主状态信息。
     修改目的：优化可理解性，同时保持按需加载性能边界。 */
  margin-top: 3px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.run-retry-status {
  /* 修改原因：Monitor 需要展示 SubAgent 内部自动重试状态，但不能像主窗口一样弹全局 retry 提示。
     修改方式：在 run 标题区添加紧凑状态行，并按 retry 类型调整颜色。
     修改目的：让内部 API 抖动和恢复过程在 Monitor 中可审计。 */
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.run-retry-status.retry-retrySuccess {
  color: var(--vscode-testing-iconPassed);
}

.run-retry-status.retry-retryFailed {
  color: var(--vscode-testing-iconFailed);
}

.load-older-row {
  /* 修改原因：历史分页入口属于消息列表的一部分，应该出现在当前窗口顶部而不是标题区。
     修改方式：居中放置小按钮，并与消息楼层保持同样的横向留白。
     修改目的：用户向上阅读时自然发现“加载更早”，同时不影响 run 控制按钮。 */
  display: flex;
  justify-content: center;
  padding: 10px 16px 4px;
}

.load-older-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  background: var(--vscode-sideBar-background);
  color: var(--vscode-foreground);
  font-size: 11px;
  cursor: pointer;
}

.load-older-btn:disabled {
  cursor: wait;
  opacity: 0.7;
}

.load-older-btn:not(:disabled):hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.message-scroll {
  flex: 1;
  min-height: 0;
}

.message-shell {
  min-height: 100%;
}

.run-title-row {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}

.run-title-info {
  flex: 1 1 220px;
  min-width: 0;
}

.run-subtitle {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.run-control-buttons {
  /* 修改原因：Monitor 顶部控制按钮需要醒目但仍保持 VS Code 工具栏风格。
     修改方式：使用紧凑 inline-flex 按钮组，并通过 primary/danger 变体区分继续和退出。
     修改目的：避免误触“退出并让主工具失败”，同时不引入与主窗口不一致的视觉组件。 */
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.control-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-foreground);
  font-size: 11px;
  cursor: pointer;
}

.control-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.control-btn.primary {
  border-color: var(--vscode-button-background);
}

.control-btn.danger {
  border-color: var(--vscode-errorForeground);
  color: var(--vscode-errorForeground);
}

.run-title-actions {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.control-notice {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
}

.run-readonly-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

.run-title {
  font-size: 13px;
  font-weight: 700;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 260px;
  color: var(--vscode-descriptionForeground);
}
</style>
