<script lang="ts">
/**
 * R3-#5: 后台任务消息三段式视图模式的模块级持久化。
 * 组件实例会随列表滚动（虚拟化）、新增消息、重载等场景销毁重建；
 * 若折叠态只是组件实例级 ref，重建后会复位为 collapsed。
 * 仿照 MessageList 的 messageListUiStateByTab：以 messageId 为 key 存于模块级 Map，
 * 组件重建时按 id 恢复用户上次选择的视图模式。
 * 使用 reactive(Map) 以便 computed getter 追踪 key 访问、setter 触发更新。
 */
import { reactive } from 'vue'
export type BackgroundTaskViewMode = 'collapsed' | 'medium' | 'expanded'
export const backgroundTaskViewModeByMessageId = reactive(new Map<string, BackgroundTaskViewMode>())

/**
 * M1-1：视图模式 Map 容量上限（防御性兜底；正常路径由 pruneBackgroundTaskViewModes 定期清理）。
 * 消息删除/窗口裁剪/重试截断/对话关闭都会留下不再被渲染的 messageId 记录，
 * 该上限保证 Map 大小有界，避免无限增长。
 */
export const BACKGROUND_TASK_VIEW_MODE_CAP = 500

/**
 * M1-1：清理不再活跃（消息被删除/窗口裁剪/重试截断/对话关闭）的视图模式记录。
 *
 * @param activeIds 仍可能被渲染的消息 ID 集合（当前窗口 + 各标签页快照的并集）；
 *                  不在集合中的 messageId 记录会被删除。
 */
export function pruneBackgroundTaskViewModes(activeIds: Set<string>): void {
  for (const messageId of Array.from(backgroundTaskViewModeByMessageId.keys())) {
    if (!activeIds.has(messageId)) {
      backgroundTaskViewModeByMessageId.delete(messageId)
    }
  }
}
</script>

<script setup lang="ts">
/**
 * MessageItem - 单条消息组件
 * 扁平化设计，所有消息统一靠左布局
 * 按 parts 原始顺序显示内容
 */

import { ref, computed, watch, onUnmounted } from 'vue'
import MessageActions from './MessageActions.vue'
import MessageAttachments from './MessageAttachments.vue'
import InlineContextMessage from './InlineContextMessage.vue'
import MessageTaskCards from './MessageTaskCards.vue'
import ResponseViewerDialog from './ResponseViewerDialog.vue'
import MessageRenderBlock from './MessageRenderBlock.vue'
import { buildResponseViewerData } from './responseViewer/buildResponseViewerData'
import type { ResponseViewerData } from './responseViewer/buildResponseViewerData'
import { MarkdownRenderer, RetryDialog, EditDialog } from '../common'
import type { Message, ToolUsage, CheckpointRecord, Attachment } from '../../types'
import { hasContextBlocks } from '../../types/contextParser'
import { formatTime } from '../../utils/format'
import { calculateTokenRate, formatTokenRate } from '../../utils/tokenRate'
import { isPerfEnabled } from '../../utils/perf'
import { buildFunctionCallToolRenderEntry, upsertToolRenderEntry } from '../../utils/toolRenderEntries'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useI18n } from '../../i18n'
import { type RenderBlock, getRenderBlockKey, getRenderBlockMemoDeps } from './renderBlocks'
import type { SmoothDisplayText } from '../../stores/chat/types'
import { registerSmoothDisplay, unregisterSmoothDisplay } from '../../stores/chat/smoothStreamManager'

const { t } = useI18n()

const props = defineProps<{
  message: Message
  messageIndex: number  // 后端消息索引
}>()

const emit = defineEmits<{
  edit: [messageId: string, newContent: string, attachments: Attachment[], mode?: 'branch' | 'keep']
  restoreAndEdit: [messageId: string, newContent: string, attachments: Attachment[], checkpointId: string]
  delete: [messageId: string]
  retry: [messageId: string]
  restoreAndRetry: [messageId: string, checkpointId: string]
  copy: [content: string]
  branch: [messageId: string]
}>()

const chatStore = useChatStore()
const settingsStore = useSettingsStore()

// 流式输出指示器文本：支持用户自定义（外观设置），为空时使用 i18n 默认值
const streamingIndicatorText = computed(() => {
  const custom = (settingsStore.appearanceLoadingText || '').trim()
  return custom || t('common.loading') || 'Loading'
})

// 使用 Array.from 以更好地支持中文等多字节字符
const streamingIndicatorChars = computed(() => Array.from(streamingIndicatorText.value))

const showActions = ref(false)
const showRetryDialog = ref(false)
const showEditDialog = ref(false)
const showResponseDialog = ref(false)

// 消息角色判断
const isUser = computed(() => props.message.role === 'user')
const isTool = computed(() => props.message.role === 'tool')

// 是否为总结消息
const isSummary = computed(() => props.message.isSummary === true)

// 是否为后台任务回流消息
const isBackgroundTask = computed(() => props.message.source === 'background_task')

// 后台任务回流消息的三段式视图：折叠（默认） / 中展开（滚动查看） / 完全展开
// R3-#5: 读写模块级 Map（按 messageId 持久化），组件实例重建后恢复
const backgroundTaskViewMode = computed<BackgroundTaskViewMode>({
  get: () => backgroundTaskViewModeByMessageId.get(props.message.id) ?? 'collapsed',
  set: (mode: BackgroundTaskViewMode) => {
    // M1-1：容量上限兜底（Map 保持插入序，超限时淘汰最旧记录，不侵入渲染热路径）
    if (
      !backgroundTaskViewModeByMessageId.has(props.message.id) &&
      backgroundTaskViewModeByMessageId.size >= BACKGROUND_TASK_VIEW_MODE_CAP
    ) {
      const oldestKey = backgroundTaskViewModeByMessageId.keys().next().value
      if (oldestKey !== undefined) {
        backgroundTaskViewModeByMessageId.delete(oldestKey)
      }
    }
    backgroundTaskViewModeByMessageId.set(props.message.id, mode)
  }
})

// 是否为流式消息
const isStreaming = computed(() => props.message.streaming === true)

// 平滑流式显示层：当前消息正在流出的段落（最后一个 text/thought part）的平滑文本。
// 流式期间存在（含空字符串占位，表示新段落从 0 开始打字），终结后由 store 删除。
// 测试 mock 状态可能不含 smoothTexts，缺失时按 undefined 处理（无可选链兜底语义不变）
const smoothText = computed<SmoothDisplayText | undefined>(() => chatStore.smoothTexts?.get(props.message.id))

// 活动尾块信息：流式期间最后一个 text/thought part（与 smoothText.partKey 匹配）
// 由 CharFlow 显示层托管。text 尾块在本组件挂载独立 host；thought 尾块保留思维卡片，
// 由 MessageRenderBlock 在折叠预览或展开内容中挂载 host。
const tailInfo = computed<{ type: 'text' | 'thought'; partKey: string } | null>(() => {
  const smooth = smoothText.value
  if (!smooth || !isStreaming.value) return null
  const parts = props.message.parts
  if (!parts || parts.length === 0) return null
  const lastPart = parts[parts.length - 1]
  if (typeof lastPart.text !== 'string' || !lastPart.text.trim()) return null

  const type = lastPart.thought === true ? 'thought' : 'text'
  const prevPart = parts[parts.length - 2]
  const prevType = prevPart?.thought === true ? 'thought' : 'text'
  if (prevPart && typeof prevPart.text === 'string' && prevType === type) return null

  const key = `${type}:${parts.length - 1}`
  if (key !== smooth.partKey) return null
  return { type, partKey: key }
})

function isSmoothThoughtBlock(block: RenderBlock): boolean {
  const tail = tailInfo.value
  return block.type === 'thought' && tail?.type === 'thought' && block.partKey === tail.partKey
}

// text 活动尾块 host 生命周期。监听 primitive partKey 而不是整个 smoothText，避免每次
// 低频快照都注销并重建同一个 CharFlow。
const tailHostRef = ref<HTMLElement | null>(null)
let registeredTextHost: HTMLElement | null = null
let registeredTextMessageId: string | null = null

// 渐进 markdown：流式期间已定型且完成段落（\n\n + fence 配对）由 CharFlow promote 到这里，
// 即时渲染格式；未完成尾巴仍在 tailHost 逐字流出。段落切换/终结时清空（稳定块完整接管）。
const tailRendered = ref('')
function handleTailPromote(text: string): void {
  tailRendered.value += text
}

function releaseTextDisplay(): void {
  if (!registeredTextHost || !registeredTextMessageId) return
  unregisterSmoothDisplay(registeredTextMessageId, registeredTextHost)
  registeredTextHost = null
  registeredTextMessageId = null
  // 渐进渲染内容随显示层释放：旧段落由稳定块（renderBlocks）完整接管，避免重复显示
  if (tailRendered.value) tailRendered.value = ''
}

watch(
  [
    () => props.message.id,
    () => tailInfo.value?.type === 'text' ? tailInfo.value.partKey : null,
    tailHostRef
  ],
  ([messageId, partKey, host]) => {
    if (
      registeredTextHost &&
      (!partKey || registeredTextHost !== host || registeredTextMessageId !== messageId)
    ) {
      releaseTextDisplay()
    }
    if (partKey && host && !registeredTextHost) {
      registerSmoothDisplay(messageId, host, { onPromote: handleTailPromote })
      registeredTextHost = host
      registeredTextMessageId = messageId
    }
  },
  { immediate: true, flush: 'post' }
)


// 总结消息展开状态
const isSummaryExpanded = ref(false)

// 思考内容展开状态
const isThoughtExpanded = ref(false)


const todoDebugPrinted = new Set<string>()
function debugTodoOnce(key: string, data: Record<string, unknown>) {
  if (!isPerfEnabled()) return
  if (todoDebugPrinted.has(key)) return
  todoDebugPrinted.add(key)
  console.debug('[todo-debug][MessageItem]', data)
}

// 实时思考时间（用于动态更新显示）
const elapsedThinkingTime = ref(0)
let thinkingTimer: ReturnType<typeof setInterval> | null = null

/**
 * 格式化时间显示（毫秒转秒）
 * @param ms 毫秒数
 * @returns 格式化后的时间字符串（秒为单位）
 */
function formatDuration(ms: number): string {
  const seconds = ms / 1000
  return `${seconds.toFixed(1)}s`
}

// 启动思考计时器
function startThinkingTimer() {
  if (thinkingTimer) return
  
  const startTime = props.message.metadata?.thinkingStartTime
  if (!startTime) return
  
  // 立即更新一次
  elapsedThinkingTime.value = Date.now() - startTime
  
  // M1-2：计时器从 100ms 降频到 500ms。
  // 说明：thinkingTimeDisplay 是 v-memo 依赖之一（MessageRenderBlock 上的 v-memo），
  // 100ms tick 会每秒失效 10 次、强制重渲染思考块；500ms 把失效频率降到 2 次/秒。
  // 不把 thinkingTimeDisplay 从 v-memo 依赖中移除的原因：v-memo 命中时整个子树（含
  // 时间徽标）会被冻结，时间文本将停止刷新，破坏现有显示体验；降频在保留 0.5s 粒度
  // 刷新体验的同时把热路径重渲染成本降低 5 倍。
  thinkingTimer = setInterval(() => {
    elapsedThinkingTime.value = Date.now() - startTime
  }, 500)
}

// 停止思考计时器
function stopThinkingTimer() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer)
    thinkingTimer = null
  }
}

// 组件卸载时清理定时器
onUnmounted(() => {
  stopThinkingTimer()
  // 注销当前组件持有的正文 CharFlow 宿主；按 host 校验，不影响刚切换出的 thought host。
  releaseTextDisplay()
})

/**
 * 将 parts 转换为渲染块，保持原始顺序
 *
 * 连续的 text 块会合并，连续的 functionCall 块会合并成一个 tools 块。
 *
 * 性能优化：对 text/thought 类型的 block 做引用稳定化——
 * 当仅工具状态变更（message.tools 变化而 parts 不变）导致 computed 重算时，
 * text/thought block 的内容不会变化。通过复用上一次的对象引用，
 * 避免下游 MarkdownRenderer 的 watch 被触发。
 */
let _prevRenderBlocks: RenderBlock[] = []

const renderBlocks = computed<RenderBlock[]>(() => {
  const parts = props.message.parts
  if (!parts || parts.length === 0) {
    _prevRenderBlocks = []
    return []
  }
  
  const blocks: RenderBlock[] = []
  let currentTextBlock: string[] = []
  let currentToolBlock: ToolUsage[] = []
  let currentThoughtBlock: string[] = []
  // 块级段落身份（H2-B）：记录合并进当前块的最后一个 part 索引与 part 数量，
  // 与平滑显示层的 partKey 对齐，供流式期间按段落精确替换。
  let currentTextPartIndex = -1
  let currentTextPartCount = 0
  let currentThoughtPartIndex = -1
  let currentThoughtPartCount = 0

  const messageTools = props.message.tools || []
  let functionCallOrdinal = 0

  // 辅助函数：刷新文本块
  const flushText = () => {
    if (currentTextBlock.length > 0) {
      const text = currentTextBlock.join('')
      if (text.trim()) {
        // 修改原因：流式正文每个 delta 都会改变 text.length；把长度/正文片段写进 key 会让 Vue 销毁重建 MarkdownRenderer，触发闪烁。
        // 修改方式：key 只表达结构身份（第几个 block + 类型），内容增长只通过 props 更新。
        // 修改目的：让主聊天与 Monitor 的流式文本块都复用同一组件实例，保留旧 HTML 直到新 HTML 渲染完成。
        blocks.push({ type: 'text', text, key: `${blocks.length}:text`, partKey: `text:${currentTextPartIndex}`, partCount: currentTextPartCount })
      }
      currentTextBlock = []
      currentTextPartIndex = -1
      currentTextPartCount = 0
    }
  }
  
  // 辅助函数：刷新工具块
  const flushTools = () => {
    if (currentToolBlock.length > 0) {
      blocks.push({
        type: 'tool',
        tools: [...currentToolBlock],
        key: `${blocks.length}:tool:${currentToolBlock.map(tool => tool.id).join('|')}`
      })
      currentToolBlock = []
    }
  }
  
  // 辅助函数：刷新思考块
  const flushThought = () => {
    if (currentThoughtBlock.length > 0) {
      const text = currentThoughtBlock.join('')
      if (text.trim()) {
        // 修改原因：thought 与正文共享同一 RenderBlock 身份契约；思考内容增长也不应改变组件身份。
        // 修改方式：移除 text.length/text.slice 这类内容派生 key，只保留结构位置和类型。
        // 修改目的：避免展开思考块接入流式渲染后重现正文闪烁问题。
        blocks.push({ type: 'thought', text, key: `${blocks.length}:thought`, partKey: `thought:${currentThoughtPartIndex}`, partCount: currentThoughtPartCount })
      }
      currentThoughtBlock = []
      currentThoughtPartIndex = -1
      currentThoughtPartCount = 0
    }
  }

  const upsertToolAcrossRenderedBlocks = (entry: ToolUsage) => {
    const currentIndex = currentToolBlock.findIndex(tool => tool.id === entry.id)
    if (currentIndex !== -1) {
      upsertToolRenderEntry(currentToolBlock, entry)
      return
    }

    for (const block of blocks) {
      if (block.type !== 'tool' || !block.tools) continue
      if (block.tools.some(tool => tool.id === entry.id)) {
        // 为什么要跨 block 去重：流式快照/终结事件可能让同一逻辑工具的占位 part 和最终 part 中间夹着文本或思考片段，
        // 只在当前连续工具块里 upsert 仍会渲染成两张工具卡。
        // 怎么改：如果之前任意工具块里已经有同一 stable tool id，就更新那一项，不再创建新的工具块。
        // 目的：等待执行、MCP 请求中、diff 自动确认倒计时等 pending 阶段都只显示一张最后工具卡。
        upsertToolRenderEntry(block.tools, entry)
        return
      }
    }

    upsertToolRenderEntry(currentToolBlock, entry)
  }
  
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]
    // 处理思考内容
    if (part.thought && part.text) {
      // 思考内容：先刷新其他块
      flushText()
      flushTools()
      currentThoughtBlock.push(part.text)
      currentThoughtPartIndex = partIndex
      currentThoughtPartCount += 1
      continue
    }
    
    // 处理文本
    if (part.text) {
      // 文本块：先刷新思考块和工具块
      flushThought()
      flushTools()
      currentTextBlock.push(part.text)
      currentTextPartIndex = partIndex
      currentTextPartCount += 1
    }
    
    // 处理工具调用（即使同一个 part 有 thoughtSignature）
    if (part.functionCall) {
      // 工具调用：先刷新文本块和思考块
      flushText()
      flushThought()
      
      // 为什么工具渲染不再只按 functionCall.id 解析：pending 阶段可能同时存在临时占位 part 和最终 call_id part，
      // 旧逻辑看到临时 id 后不会回退到 message.tools 的同序位真实工具，导致最后一个工具显示两次。
      // 怎么改：统一通过 toolRenderEntries 按 id -> itemId -> index -> 序位解析，并对同一 stable id 做 upsert。
      // 目的：让渲染层与流式合并层共享同一逻辑工具识别方式，pending/awaiting/complete 都只显示一张工具卡。
      const renderTool = buildFunctionCallToolRenderEntry({
        messageId: props.message.id,
        functionCall: part.functionCall,
        messageTools,
        functionCallOrdinal
      })
      const toolIdFromPart = typeof part.functionCall.id === 'string' ? part.functionCall.id : ''
      
      debugTodoOnce(`function-call-${props.message.id}-${functionCallOrdinal}-${renderTool.id}`, {
        messageId: props.message.id,
        messageBackendIndex: props.message.backendIndex,
        functionCallOrdinal,
        functionCallName: part.functionCall.name,
        functionCallIdFromPart: toolIdFromPart || null,
        resolvedToolId: renderTool.id,
        existingToolId: renderTool.id || null
      })

      upsertToolAcrossRenderedBlocks(renderTool)

      functionCallOrdinal += 1
    }
    // 忽略其他类型（如 inlineData、fileData 等，后续可扩展）
  }
  
  // 刷新剩余块
  flushThought()
  flushText()
  flushTools()

  // 平滑流式显示：活动 text 尾块摘出，活动 thought 尾块保留卡片外壳但正文由
  // MessageRenderBlock 内的 CharFlow host 托管。两条高频路径都绕过 Vue/Markdown。
  // 条件（与 tailInfo 严格对齐）：partKey 匹配 + 单 part 块（partCount===1）。
  // ① 新段落前导空白不推入显示层（H2-A），不会覆盖上一段已完成块；
  // ② partKey 切换瞬间（switchPart flush 尾巴提交旧段落文本）命中的是旧段落块（文本相同，无视觉变化）；
  // ③ 合并块（多个同类型 part 合入一块）无法按段落粒度摘出，跳过（回退真实文本，安全）。
  const smooth = smoothText.value
  const tail = tailInfo.value
  if (tail && smooth !== undefined && isStreaming.value) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (tail.type === 'text' && b.type === 'text' && b.partKey === tail.partKey && b.partCount === 1) {
        blocks.splice(i, 1) // 摘出：该段落显示由 CharFlow 托管
        break
      }
      if (tail.type === 'thought' && b.type === 'thought' && b.partKey === tail.partKey && b.partCount === 1) {
        // block.text 仅保留低频恢复快照；活动态视觉文本由 CharFlow 逐帧写入。
        blocks[i] = { ...b, text: smooth.text }
        break
      }
    }
  }

  // 引用稳定化：复用上一次内容相同的 text/thought block 的对象引用，
  // 避免仅因工具状态变更而触发下游 MarkdownRenderer 的无效重渲染
  const prev = _prevRenderBlocks
  if (prev.length === blocks.length) {
    for (let i = 0; i < blocks.length; i++) {
      const cur = blocks[i]
      const old = prev[i]
      if (
        cur.type === old.type &&
        (cur.type === 'text' || cur.type === 'thought') &&
        cur.text === old.text
      ) {
        blocks[i] = old
      }
    }
  }
  _prevRenderBlocks = blocks
  
  return blocks
})


/**
 * 主内容区渲染块
 */
const contentRenderBlocks = computed<RenderBlock[]>(() => {
  // 不隐藏任何工具，按原始渲染块完整展示
  return renderBlocks.value
})

// 判断是否正在思考中（有思考块但没有普通文本块也没有工具调用块，且消息正在流式输出，且没有最终的思考时间）
// 注意：必须在 renderBlocks 定义之后才能使用
const isThinking = computed(() => {
  if (!isStreaming.value) return false
  if (tailInfo.value?.type === 'text') return false
  
  // 如果已经有后端计算的思考时间，说明思考已完成
  if (props.message.metadata?.thinkingDuration) return false
  
  const hasThoughtBlock = renderBlocks.value.some(b => b.type === 'thought')
  const hasTextBlock = renderBlocks.value.some(b => b.type === 'text' && b.text && b.text.trim())
  const hasToolBlock = renderBlocks.value.some(b => b.type === 'tool')
  
  // 有思考块，且没有文本块和工具调用块时，才认为正在思考
  // 当有工具调用时，思考已完成，正在等待工具响应
  return hasThoughtBlock && !hasTextBlock && !hasToolBlock
})

// 获取思考时间显示文本
// 优先使用后端提供的最终时间，否则使用实时计算的时间
const thinkingTimeDisplay = computed(() => {
  // 如果有最终的思考时间，使用它
  const duration = props.message.metadata?.thinkingDuration
  if (duration && duration > 0) {
    return formatDuration(duration)
  }
  
  // 如果正在思考中，显示实时时间
  if (isThinking.value && elapsedThinkingTime.value > 0) {
    return formatDuration(elapsedThinkingTime.value)
  }
  
  return null
})

// 监听思考状态变化
watch(isThinking, (thinking) => {
  if (thinking) {
    startThinkingTimer()
  } else {
    stopThinkingTimer()
  }
}, { immediate: true })

// 监听 thinkingStartTime 变化（确保首次有值时启动）
watch(
  () => props.message.metadata?.thinkingStartTime,
  (startTime) => {
    if (startTime && isThinking.value && !thinkingTimer) {
      startThinkingTimer()
    }
  },
  { immediate: true }
)

// 获取当前消息及之前所有消息的检查点
// 之前消息的存档点：包含所有阶段（before/after），因为这些代表已完成的操作状态
// 当前消息的存档点：只包含 before 阶段，因为用户要撤销的是这条消息的效果
const availableCheckpoints = computed<CheckpointRecord[]>(() => {
  return chatStore.checkpoints
    .filter(cp => {
      if (cp.messageIndex < props.messageIndex) return true          // 之前的消息：包含所有阶段
      if (cp.messageIndex === props.messageIndex && cp.phase === 'before') return true  // 当前消息：只包含 before
      return false
    })
})

// 获取用于编辑用户消息的最新检查点
// 优先显示该用户消息的"消息前存档"（如果存在）
// 如果不存在，则显示之前最近的一个存档点
const checkpointsBeforeMessage = computed<CheckpointRecord[]>(() => {
  // 首先查找该消息的"用户消息前"存档点
  const userMessageBefore = chatStore.checkpoints.find(cp =>
    cp.messageIndex === props.messageIndex &&
    cp.toolName === 'user_message' &&
    cp.phase === 'before'
  )
  
  if (userMessageBefore) {
    // 如果有该消息的"消息前存档"，只返回这一个
    return [userMessageBefore]
  }
  
  // 否则，找之前最近的一个存档点（按 messageIndex 降序排列取第一个）
  const previousCheckpoints = chatStore.checkpoints
    .filter(cp => cp.messageIndex < props.messageIndex)
    .sort((a, b) => b.messageIndex - a.messageIndex)
  
  if (previousCheckpoints.length > 0) {
    return [previousCheckpoints[0]]
  }
  
  return []
})

// 模型版本
const modelVersion = computed(() => props.message.metadata?.modelVersion)

// 角色显示名称
const roleDisplayName = computed(() => {
  if (isBackgroundTask.value) return t('components.backgroundTasks.completed')
  if (isUser.value) return t('components.message.roles.user')
  if (isTool.value) return t('components.message.roles.tool')
  // 助手消息显示模型版本
  return modelVersion.value || t('components.message.roles.assistant')
})

// Token 使用情况
const usageMetadata = computed(() => props.message.metadata?.usageMetadata)
const hasUsage = computed(() =>
  !isUser.value && !isTool.value && usageMetadata.value &&
  (usageMetadata.value.totalTokenCount || usageMetadata.value.promptTokenCount || usageMetadata.value.candidatesTokenCount)
)

// 响应持续时间（从请求发送到响应结束，使用后端提供的数据）
const responseDuration = computed(() => {
  const duration = props.message.metadata?.responseDuration
  if (duration && duration > 0) {
    return formatDuration(duration)
  }
  return null
})

// Token 速率计算
// 修改原因：主聊天曾内联一份旧公式并以 streamDuration 作分母，会在上游攒包时出现畸高速度，且与详情页 / Monitor 口径分叉。
// 修改方式：直接复用公共工具 calculateTokenRate（优先 responseDuration，回退 streamDuration）+ formatTokenRate。
// 修改目的：让所有入口共享同一套 token 速度语义，避免后续再各自维护公式。
const tokenRate = computed(() => {
  const rate = calculateTokenRate(props.message.metadata)
  return typeof rate === 'number' ? formatTokenRate(rate) : null
})

// 消息类名

// 用户消息预览文本（供滚动条 marker tooltip 使用）
const previewText = computed(() => {
  if (!isUser.value) return ''
  const raw = props.message.content || ''
  // 去除 context 标签、多余空白，截断到 80 字符
  const cleaned = raw
    .replace(/<lim-context[\s\S]*?<\/lim-context>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 80 ? cleaned.slice(0, 80) + '…' : cleaned
})

const messageClass = computed(() => ({
  'message-item': true,
  'user-message': isUser.value,
  'assistant-message': !isUser.value,
  'streaming': isStreaming.value,
  'summary-message': isSummary.value,
  'background-task-message': isBackgroundTask.value
}))

// 格式化时间（只有有效时间戳时才显示）
const formattedTime = computed(() => {
  if (!props.message.timestamp || props.message.timestamp === 0) {
    return null
  }
  return formatTime(props.message.timestamp, 'HH:mm')
})

// 开始编辑（显示编辑对话框）
function startEdit() {
  showEditDialog.value = true
}

// 处理编辑保存
function handleEdit(newContent: string, attachments: Attachment[], mode: 'branch' | 'keep' = 'branch') {
  emit('edit', props.message.id, newContent, attachments, mode)
}

// 处理回档并编辑
function handleRestoreAndEdit(newContent: string, attachments: Attachment[], checkpointId: string) {
  emit('restoreAndEdit', props.message.id, newContent, attachments, checkpointId)
}

// 处理操作
function handleCopy() {
  emit('copy', props.message.content)
}

function handleDelete() {
  emit('delete', props.message.id)
}

function handleRetryClick() {
  // 始终显示重试对话框
  showRetryDialog.value = true
}

function handleViewResponse() {
  showResponseDialog.value = true
}

// R3-#6: 响应查看数据仅在对话框打开时构建一次（此前为无条件 computed，
// 流式期间每收到新消息都会重算整包数据）。关闭状态下保持 null，避免无谓重算。
const responseViewerData = ref<ResponseViewerData | null>(null)
watch(showResponseDialog, (open) => {
  if (!open) return
  responseViewerData.value = buildResponseViewerData(props.message, {
    allMessages: chatStore.allMessages
  })
})

function toggleThought() {
  isThoughtExpanded.value = !isThoughtExpanded.value
}

function handleRetry() {
  emit('retry', props.message.id)
}

function handleRestoreAndRetry(checkpointId: string) {
  emit('restoreAndRetry', props.message.id, checkpointId)
}

</script>

<template>
  <div
    :class="messageClass"
    :data-preview="isUser ? previewText : undefined"
    @mouseenter="showActions = true"
    @mouseleave="showActions = false"
  >
    <div class="message-header">
      <div class="message-role-indicator">
        <span class="role-label">
          {{ roleDisplayName }}
        </span>
      </div>

      <!-- 操作按钮 -->
      <MessageActions
        :class="{ 'actions-visible': showActions }"
        :message="message"
        :can-edit="isUser"
        :can-retry="!isUser"
        :can-branch="typeof message.backendIndex === 'number' && !isStreaming"
        :can-view-response="!isUser"
        @edit="startEdit"
        @copy="handleCopy"
        @delete="handleDelete"
        @retry="handleRetryClick"
        @branch="emit('branch', message.id)"
        @view-response="handleViewResponse"
      />
    </div>
    
    <!-- 重试对话框 -->
    <RetryDialog
      v-model="showRetryDialog"
      :checkpoints="availableCheckpoints"
      @retry="handleRetry"
      @restore-and-retry="handleRestoreAndRetry"
    />
    
    <!-- 编辑对话框 -->
    <EditDialog
      v-model="showEditDialog"
      :checkpoints="checkpointsBeforeMessage"
      :original-content="message.content"
      :original-attachments="message.attachments || []"
      @edit="handleEdit"
      @restore-and-edit="handleRestoreAndEdit"
    />

    <!-- 回复查看 -->
    <ResponseViewerDialog
      v-model="showResponseDialog"
      :value="responseViewerData as ResponseViewerData"
      :title="t('components.message.actions.viewResponse')"
      width="960px"
    />

    <div class="message-body">
      <!-- 总结消息特殊显示 -->
      <div v-if="isSummary" class="summary-block">
        <div
          class="summary-header"
          @click="isSummaryExpanded = !isSummaryExpanded"
        >
          <i class="codicon" :class="isSummaryExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'"></i>
          <i class="codicon codicon-fold summary-icon"></i>
          <span class="summary-label">{{ t('components.message.summary.title') }}</span>
          <span v-if="message.summarizedMessageCount" class="summary-count">
            {{ t('components.message.summary.compressed', { count: message.summarizedMessageCount }) }}
          </span>
        </div>
        <div v-if="isSummaryExpanded" class="summary-content">
          <MarkdownRenderer
            :content="message.content"
            :latex-only="false"
            class="summary-text"
          />
        </div>
      </div>
      
      <!-- 后台任务回流消息：紧凑卡片，与用户消息明确区分 -->
      <div v-else-if="isBackgroundTask" class="background-task-card">
        <div class="bg-task-header">
          <i class="codicon codicon-hubot bg-task-icon"></i>
          <span class="bg-task-label">{{ t('components.backgroundTasks.completed') || 'Background task completed' }}</span>
          <!-- 三段式视图切换：折叠 / 中展开（滚动） / 完全展开 -->
          <div class="bg-task-view-controls">
            <button
              class="bg-task-view-btn"
              :class="{ active: backgroundTaskViewMode === 'collapsed' }"
              :title="t('components.backgroundTasks.viewCollapsed')"
              @click="backgroundTaskViewMode = 'collapsed'"
            >
              <i class="codicon codicon-chevron-up"></i>
            </button>
            <button
              class="bg-task-view-btn"
              :class="{ active: backgroundTaskViewMode === 'medium' }"
              :title="t('components.backgroundTasks.viewMedium')"
              @click="backgroundTaskViewMode = 'medium'"
            >
              <i class="codicon codicon-list-flat"></i>
            </button>
            <button
              class="bg-task-view-btn"
              :class="{ active: backgroundTaskViewMode === 'expanded' }"
              :title="t('components.backgroundTasks.viewExpanded')"
              @click="backgroundTaskViewMode = 'expanded'"
            >
              <i class="codicon codicon-chevron-down"></i>
            </button>
          </div>
        </div>
        <div
          class="bg-task-content"
          :class="`view-${backgroundTaskViewMode}`"
        >{{ message.content }}</div>
      </div>

      <!-- 普通消息显示 -->
      <template v-else>
        <!-- 用户消息的上下文块显示 -->
        <!-- 用户消息现在支持将 <lim-context> 以内联徽章的形式渲染在正文中 -->
        
        <!-- 用户消息的附件显示 -->
        <MessageAttachments
          v-if="isUser && message.attachments && message.attachments.length > 0"
          :attachments="message.attachments"
        />

        <!-- 显示模式 -->
        <div class="message-content">
        <!-- 有 parts 时渲染内容块（TODO 工具块会下沉到消息底部） -->
        <template v-if="renderBlocks.length > 0">
          <!--
            WP31 修复：v-memo 与 v-for 现在共处同一 MessageRenderBlock 组件元素上。
            修改原因：Vue 官方明确警告 v-memo 不能放在 v-for 内部子节点上。
            修改方式：通过组件提取 + 共享类型，让 v-memo 和 v-for 在同一元素。
            修改目的：符合 Vue 官方语义，同时保持完成态消息不重渲染的优化不变。
          -->
          <MessageRenderBlock
            v-for="block in contentRenderBlocks"
            :key="getRenderBlockKey(block)"
            :block="block"
            :message-id="message.id"
            :message-role="isUser ? 'user' : 'assistant'"
            :message-backend-index="message.backendIndex"
            :is-streaming="isStreaming"
            :is-thought-expanded="isThoughtExpanded"
            :is-thinking="isThinking"
            :thinking-time-display="thinkingTimeDisplay"
            :smooth-display-active="isSmoothThoughtBlock(block)"
            :toggle-thought="toggleThought"
            v-memo="getRenderBlockMemoDeps(block, isStreaming, isUser, isThoughtExpanded, isThinking, thinkingTimeDisplay, isSmoothThoughtBlock(block))"
          />
        </template>

        <!-- 活动正文尾块：已完成段落渐进 markdown + 活动尾巴 CharFlow 托管（批内错峰淡入流水） -->
        <div v-if="tailInfo?.type === 'text'" class="tail-stream">
          <MarkdownRenderer
            v-if="tailRendered"
            :content="tailRendered"
            :latex-only="false"
            :is-streaming="true"
            class="content-text"
          />
          <div ref="tailHostRef" class="char-flow-host"></div>
        </div>

        <!-- 仅在没有 parts 渲染块和活动尾块时使用 content 兜底。显式互斥，避免新增兄弟节点拆断 v-else-if 链。 -->
        <template v-if="renderBlocks.length === 0 && !tailInfo">
          <!-- 用户消息仅渲染 LaTeX；有上下文块时使用内联上下文渲染。 -->
          <InlineContextMessage
            v-if="isUser && message.content && hasContextBlocks(message.content)"
            :content="message.content"
          />

          <MarkdownRenderer
            v-else-if="message.content"
            :content="message.content"
            :latex-only="isUser"
            :is-streaming="isStreaming"
            class="content-text"
          />

          <!-- 无内容兜底（模型返回空内容/仅返回签名等场景） -->
          <div v-else-if="!isStreaming" class="empty-response">
            {{ t('components.message.emptyResponse') }}
          </div>
        </template>
        
        <!-- 流式指示器 - Loading 逐字波动 -->
        <span
          v-if="isStreaming"
          class="streaming-indicator"
          role="status"
          :aria-label="streamingIndicatorText"
          :style="{
            '--loading-duration': '2.8s',
            '--loading-idle-color': 'var(--vscode-descriptionForeground, #8a8a8a)',
            '--loading-active-color': 'var(--vscode-charts-blue, #3794ff)',
            '--loading-amp': '4px'
          }"
        >
          <span
            v-for="(ch, i) in streamingIndicatorChars"
            :key="i"
            class="streaming-indicator__char"
            :class="{
              'streaming-indicator__char--underline': true
            }"
            :style="{ '--loading-delay': `${i * 0.16}s` }"
          >
            {{ ch }}
          </span>
        </span>

        <!-- 消息底部信息：时间 + 响应时间 + Token 速率 + Token 统计 -->
        <div class="message-footer">
          <div class="message-footer-left">
            <span v-if="formattedTime" class="message-time">{{ formattedTime }}</span>
            
            <!-- 响应持续时间 -->
            <span v-if="responseDuration" class="response-duration" :title="t('components.message.stats.responseDuration')">
              <i class="codicon codicon-clock"></i>{{ responseDuration }}
            </span>
            
            <!-- Token 速率 -->
            <span v-if="tokenRate" class="token-rate" :title="t('components.message.stats.tokenRate')">
              <i class="codicon codicon-zap"></i>{{ tokenRate }} t/s
            </span>
          </div>
          
          <!-- Token 使用统计 -->
          <div v-if="hasUsage" class="token-usage">
            <span v-if="usageMetadata?.totalTokenCount" class="token-total">
              {{ usageMetadata.totalTokenCount }}
            </span>
            <span v-if="usageMetadata?.promptTokenCount" class="token-item token-prompt">
              <span class="token-arrow">↑</span>{{ usageMetadata.promptTokenCount }}
            </span>
            <span v-if="usageMetadata?.cachedContentTokenCount" class="token-item token-cached">
              <span class="token-arrow">⚡</span>{{ usageMetadata.cachedContentTokenCount }}
            </span>
            <span v-if="usageMetadata?.candidatesTokenCount" class="token-item token-candidates">
              <span class="token-arrow">↓</span>{{ usageMetadata.candidatesTokenCount }}
            </span>
          </div>
        </div>

        <!-- Cursor 风格任务卡片：Plan/SubAgent 缩略预览，放在消息内容下方 -->
        <MessageTaskCards
          v-if="!isUser && message.tools && message.tools.length > 0"
          :tools="message.tools"
          :message-model-version="modelVersion"
        />
        </div>

      </template>
    </div>
  </div>
</template>

<style scoped>
/* 消息项 - 扁平化设计，统一靠左 */
.message-item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-md, 16px) var(--spacing-md, 16px);
  border-bottom: 1px solid var(--vscode-panel-border);
  transition: background-color var(--transition-fast, 0.1s);
  /* 性能优化：布局隔离 */
  contain: layout;
  /* 长对话性能：视口外消息跳过渲染/样式计算（原生 content-visibility；
     兼容性回退 = 无样式类特性，仅失去优化）。流式消息在视口内不受影响。 */
  content-visibility: auto;
  contain-intrinsic-size: auto 160px;
}

.message-item:last-child {
  border-bottom: none;
}

/* 所有消息统一靠左 */
.user-message,
.assistant-message {
  align-self: stretch;
  max-width: 100%;
}

/* 用户消息淡蓝色背景 — 滚动时快速定位 */
.user-message {
  background-color: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent);
}

/* 消息头部 */
.message-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm, 8px);
}

.message-role-indicator {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.role-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.user-message .role-label {
  color: var(--vscode-foreground);
}

.assistant-message .role-label {
  color: var(--vscode-descriptionForeground);
}

/* 工具消息标签 */
.message-item[class*="tool"] .role-label {
  color: var(--vscode-charts-blue);
}

/* 消息底部信息 */
.message-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--spacing-sm, 8px);
}

.message-footer-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.message-time {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

/* 响应持续时间 */
.response-duration {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.response-duration .codicon {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

/* Token 速率 */
.token-rate {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.token-rate .codicon {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

/* 消息体 */
.message-body {
  padding-left: 0;
}

.message-content {
  position: relative;
}

.todo-tool-blocks {
  margin-top: var(--spacing-sm, 8px);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

.empty-response {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px dashed var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  opacity: 0.85;
}

/* .content-text 样式由 MarkdownRenderer 组件内部处理 */

/* 正文与工具调用块的垂直间距，与思考面板和正文的间距保持一致 */
.tool-message-block {
  margin: 8px 0;
}

/* 流式指示器 - Loading 从左到右逐字波动 */
.streaming-indicator {
  display: inline-flex;
  align-items: flex-end;
  margin-left: 6px;
  line-height: 1;
  letter-spacing: 0.02em;
  user-select: none;
}

.streaming-indicator__char {
  position: relative;
  display: inline-block;
  padding: 0 0.5px;
  color: var(--loading-idle-color);
  opacity: 0.78;

  /* “播完停顿”的关键：每个字母在一整轮里只在前 22% 左右动，后面都静止 */
  animation: loading-wave var(--loading-duration) ease-in-out infinite;
  animation-delay: var(--loading-delay);
  will-change: transform, color, opacity;
}

/* 下划线胶囊：跟随每个字母的波动 */
.streaming-indicator__char--underline::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -4px;
  width: 10px;
  height: 2px;
  border-radius: 999px;
  background: var(--loading-active-color);

  opacity: 0;
  transform: translateX(-50%) scaleX(0.35);

  animation: loading-underline var(--loading-duration) ease-in-out infinite;
  animation-delay: var(--loading-delay);
  will-change: transform, opacity;
}

@keyframes loading-wave {
  /* 0~22%：完成一次“跳一下”；22%~100%：保持静止 */
  0%, 22%, 100% {
    transform: translateY(0) scale(1);
    color: var(--loading-idle-color);
    opacity: 0.78;
  }
  11% {
    transform: translateY(calc(var(--loading-amp) * -1)) scale(1.06);
    color: var(--loading-active-color);
    opacity: 1;
  }
}

@keyframes loading-underline {
  0%, 22%, 100% {
    opacity: 0;
    transform: translateX(-50%) scaleX(0.35);
  }
  11% {
    opacity: 0.9;
    transform: translateX(-50%) scaleX(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .streaming-indicator__char,
  .streaming-indicator__char--underline::after {
    animation: none;
    opacity: 1;
  }

  .streaming-indicator__char--underline::after {
    opacity: 0;
  }
}

/* Token 使用统计 */
.token-usage {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.token-total {
  font-weight: 500;
  color: var(--vscode-descriptionForeground);
}

.token-item {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.token-arrow {
  font-size: 10px;
  opacity: 0.8;
}

.token-prompt .token-arrow {
  color: var(--vscode-charts-green, #89d185);
}

.token-candidates .token-arrow {
  color: var(--vscode-charts-blue, #75beff);
}

.token-cached .token-arrow {
  color: var(--vscode-charts-yellow, #e2c08d);
}

/* 编辑模式 - 扁平化 */
.message-edit {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

.edit-textarea {
  width: 100%;
  min-height: 60px;
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm, 2px);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: none;
  outline: none;
  overflow: hidden;
  transition: border-color var(--transition-fast, 0.1s);
}

.edit-textarea:focus {
  border-color: var(--vscode-focusBorder);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm, 8px);
}

.btn-cancel,
.btn-save {
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  border-radius: var(--radius-sm, 2px);
  font-size: 12px;
  cursor: pointer;
  border: none;
  transition: background-color var(--transition-fast, 0.1s);
}

.btn-cancel {
  background: transparent;
  color: var(--vscode-foreground);
}

.btn-cancel:hover {
  background: var(--vscode-list-hoverBackground);
}

.btn-save {
  background: var(--vscode-foreground);
  color: var(--vscode-editor-background);
}

.btn-save:hover {
  opacity: 0.9;
}

/* 操作按钮淡入淡出效果 */
.message-header :deep(.message-actions) {
  opacity: 0;
  transition: opacity var(--transition-fast, 0.15s);
}

.message-header :deep(.message-actions.actions-visible) {
  opacity: 1;
}

/* 思考块样式 - 使用灰色调、斜体，保持简洁 */
.thought-block {
  /*
   * 思考内容（MarkdownRenderer）样式覆写：
   * - 以前通过 .thought-text（父组件 scoped）控制，但 scoped CSS 不会作用到子组件根节点
   * - 改为用 CSS 变量传递给 MarkdownRenderer（变量可跨组件继承）
   */
  --lim-md-font-size: 12px;
  --lim-md-line-height: 1.5;
  --lim-md-color: var(--vscode-descriptionForeground);
  --lim-md-font-style: italic;

  margin: 8px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  overflow: hidden;
}

.thought-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s;
}

.thought-header:hover {
  background: var(--vscode-list-hoverBackground);
}

.thought-header .codicon {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.thought-icon {
  color: var(--vscode-descriptionForeground) !important;
}

/* 思考中灯泡闪烁动画 */
.thought-icon.thinking-pulse {
  color: var(--vscode-charts-yellow, #ddb92f) !important;
  animation: lightbulb-pulse 1.2s ease-in-out infinite;
}

@keyframes lightbulb-pulse {
  0%, 100% {
    opacity: 0.4;
    text-shadow: none;
  }
  50% {
    opacity: 1;
    text-shadow: 0 0 8px var(--vscode-charts-yellow, #ddb92f);
  }
}

.thought-label {
  font-size: 12px;
  font-weight: 500;
  font-style: italic;
  color: var(--vscode-descriptionForeground);
}

.thought-time {
  font-size: 11px;
  font-weight: 500;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background);
  padding: 1px 6px;
  border-radius: 10px;
  margin-left: 4px;
  transition: all 0.2s ease;
}

.thought-time.thinking-active {
  color: var(--vscode-charts-yellow, #ddb92f);
  animation: time-pulse 1.5s ease-in-out infinite;
}

@keyframes time-pulse {
  0%, 100% {
    opacity: 0.8;
  }
  50% {
    opacity: 1;
  }
}

.thought-preview {
  flex: 1;
  font-size: 11px;
  font-style: italic;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thought-content {
  padding: 12px;
  /*
   * 不在标题与内容之间绘制明显分界线：
   * 与深色模式视觉风格保持一致，改为无硬边框分隔。
   */
  border-top: none;
}

/*
 * 注意：.thought-text 是挂在 MarkdownRenderer 根节点上的 class。
 * 由于本文件是 scoped CSS，如需影响子组件内容，需要使用 :deep。
 * 这里保留段落间距微调。
 */
.thought-block :deep(.thought-text p) {
  margin: 0.5em 0;
}

.thought-block :deep(.thought-text p:first-child) {
  margin-top: 0;
}

.thought-block :deep(.thought-text p:last-child) {
  margin-bottom: 0;
}

/* 总结消息样式 */
.summary-message {
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textLink-foreground);
}

.summary-block {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
  overflow: hidden;
}

.summary-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s;
  background: var(--vscode-textBlockQuote-background);
}

.summary-header:hover {
  background: var(--vscode-list-hoverBackground);
}

.summary-header .codicon {
  font-size: 12px;
  color: var(--vscode-textLink-foreground);
}

.summary-icon {
  color: var(--vscode-textLink-foreground) !important;
}

.summary-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-textLink-foreground);
}

.summary-count {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-left: 4px;
}

.summary-content {
  padding: 12px;
  border-top: 1px solid var(--vscode-panel-border);
}

.summary-text {
  font-size: 13px;
  color: var(--vscode-foreground);
  line-height: 1.5;
}

.summary-text :deep(p) {
  margin: 0.5em 0;
}

.summary-text :deep(p:first-child) {
  margin-top: 0;
}

/* 后台任务回流卡片 */
.background-task-message .message-header {
  opacity: 0.6;
}

.background-task-card {
  border: 1px solid var(--vscode-panel-border);
  border-left: 3px solid var(--vscode-focusBorder);
  border-radius: 6px;
  padding: 8px 12px;
  margin: 4px 0;
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-focusBorder) 5%);
  font-size: 12px;
}

.bg-task-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.bg-task-icon {
  font-size: 14px;
  color: var(--vscode-focusBorder);
}

.bg-task-label {
  font-weight: 600;
  color: var(--vscode-foreground);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.5px;
}

.bg-task-content {
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  line-height: 1.4;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}

/* 三段式视图：折叠（两行省略） / 中展开（约 15 行滚动） / 完全展开 */
.bg-task-view-controls {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.bg-task-view-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 3px;
}

.bg-task-view-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.bg-task-view-btn.active {
  background: var(--vscode-toolbar-activeBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-foreground);
}

.bg-task-content.view-collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.bg-task-content.view-medium {
  max-height: 21em;  /* 行高 1.4em × 15 行 */
  overflow-y: auto;
}

.bg-task-content.view-expanded {
  max-height: none;
  overflow: visible;
}

</style>
