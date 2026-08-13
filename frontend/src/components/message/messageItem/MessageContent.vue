<script setup lang="ts">
/**
 * MessageContent - MessageItem 的普通消息正文区块（F-07 巨型组件拆分）。
 *
 * 负责：附件、渲染块（text/thought/tool）、活动尾块平滑流式、兜底内容、
 * 流式指示器、底部统计、任务卡片。所有状态与副作用从 MessageItem 原样迁入，
 * 对外仅接收 message 一个 prop。
 */
import { ref, computed, watch, onUnmounted } from 'vue'
import MessageAttachments from '../MessageAttachments.vue'
import MessageTaskCards from '../MessageTaskCards.vue'
import InlineContextMessage from '../InlineContextMessage.vue'
import MessageRenderBlock from '../MessageRenderBlock.vue'
import { MarkdownRenderer } from '../../common'
import type { Message, ToolUsage } from '../../../types'
import { hasContextBlocks } from '../../../types/contextParser'
import { formatTime } from '../../../utils/format'
import { calculateTokenRate, formatTokenRate } from '../../../utils/tokenRate'
import { buildFunctionCallToolRenderEntry, upsertToolRenderEntry } from '../../../utils/toolRenderEntries'
import { useChatStore } from '../../../stores/chatStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useI18n } from '../../../i18n'
import { type RenderBlock, getRenderBlockKey, getRenderBlockMemoDeps, type ThoughtViewMode } from '../renderBlocks'
import {
  thoughtViewModeByMessageId,
  THOUGHT_VIEW_MODE_CAP
} from '../messageViewModes'
import type { SmoothDisplayText } from '../../../stores/chat/types'
import { useMessageTextTail } from '../../../composables/useMessageTextTail'
import StreamingIndicator from './StreamingIndicator.vue'
import MessageFooter from './MessageFooter.vue'

const { t } = useI18n()

const props = defineProps<{
  message: Message
}>()

const chatStore = useChatStore()
const settingsStore = useSettingsStore()

// 流式输出指示器文本：支持用户自定义（外观设置），为空时使用 i18n 默认值
const streamingIndicatorText = computed(() => {
  const custom = (settingsStore.appearanceLoadingText || '').trim()
  return custom || t('common.loading')
})

const isUser = computed(() => props.message.role === 'user')
const isTool = computed(() => props.message.role === 'tool')

// 是否为流式消息
const isStreaming = computed(() => props.message.streaming === true)

// 平滑流式显示层：当前消息正在流出的段落（最后一个 text/thought part）的平滑文本。
// 流式期间存在（含空字符串占位，表示新段落从 0 开始打字），终结后由 store 删除。
// 测试 mock 状态可能不含 smoothTexts，缺失时按 undefined 处理（无可选链兜底语义不变）
const smoothText = computed<SmoothDisplayText | undefined>(() => chatStore.smoothTexts?.get(props.message.id))

// 活动尾块平滑显示层：tailInfo + 正文 text 尾块 CharFlow 宿主生命周期
const {
  tailInfo,
  isSmoothThoughtBlock,
  tailHostRef,
  tailRendered,
  tailRenderGeneration,
  handleTailMarkdownRendered
} = useMessageTextTail(() => props.message, isStreaming, smoothText)

// 思考内容三段式视图模式（对齐后台任务）：折叠 / 中展开 / 完全展开，默认中展开。
// 模块级 Map 按 messageId 持久化（与 backgroundTaskViewModeByMessageId 同模式）：
// 虚拟列表滚动回收 MessageItem 后恢复用户选择，而不是复位为 medium。
const thoughtViewMode = computed<ThoughtViewMode>({
  get: () => thoughtViewModeByMessageId.get(props.message.id) ?? 'medium',
  set: (mode: ThoughtViewMode) => {
    if (
      !thoughtViewModeByMessageId.has(props.message.id) &&
      thoughtViewModeByMessageId.size >= THOUGHT_VIEW_MODE_CAP
    ) {
      const oldestKey = thoughtViewModeByMessageId.keys().next().value
      if (oldestKey !== undefined) {
        thoughtViewModeByMessageId.delete(oldestKey)
      }
    }
    thoughtViewModeByMessageId.set(props.message.id, mode)
  }
})
// 用户是否手动切换过视图模式（自动模式切换只在用户未干预时生效）
const thoughtViewTouched = ref(false)

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

      // 为什么工具渲染不再只按 functionCall.id 解析：pending 阶段可能同时存在临时占位 part 和最终 call_id part。
      const renderTool = buildFunctionCallToolRenderEntry({
        messageId: props.message.id,
        functionCall: part.functionCall,
        messageTools,
        functionCallOrdinal
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

  // 引用稳定化：复用上一次内容相同的 text/thought block 的对象引用。
  const prev = _prevRenderBlocks
  if (prev.length === blocks.length) {
    for (let i = 0; i < blocks.length; i++) {
      const cur = blocks[i]
      const old = prev[i]
      if (
        cur.type === old.type &&
        (cur.type === 'text' || cur.type === 'thought') &&
        cur.text === old.text &&
        cur.partKey === old.partKey &&
        cur.partCount === old.partCount
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

// 思考视图自动模式：思考中默认中展开；思考与输出都结束后自动折叠为第一行预览。
let isInitialThoughtViewSync = true
watch([isThinking, isStreaming], ([thinking, streaming]) => {
  if (thoughtViewTouched.value) return
  const hasThought = renderBlocks.value.some(block => block.type === 'thought')
  if (!hasThought) return
  if (isInitialThoughtViewSync) {
    isInitialThoughtViewSync = false
    if (thoughtViewModeByMessageId.has(props.message.id)) return
  }
  if (thinking) {
    thoughtViewMode.value = 'medium'
  } else if (!streaming) {
    thoughtViewMode.value = 'collapsed'
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

// 格式化时间（只有有效时间戳时才显示）
const formattedTime = computed(() => {
  if (!props.message.timestamp || props.message.timestamp === 0) {
    return null
  }
  return formatTime(props.message.timestamp, 'HH:mm')
})

// 响应持续时间（从请求发送到响应结束，使用后端提供的数据）
const responseDuration = computed(() => {
  const duration = props.message.metadata?.responseDuration
  if (duration && duration > 0) {
    return formatDuration(duration)
  }
  return null
})

// 首字延迟（TTFT：从请求发送到第一个流式块到达，后端计算）
const ttft = computed(() => {
  const ms = props.message.metadata?.ttft
  if (ms && ms > 0) {
    return formatDuration(ms)
  }
  return null
})

// Token 速率计算
const tokenRate = computed(() => {
  const rate = calculateTokenRate(props.message.metadata)
  return typeof rate === 'number' ? formatTokenRate(rate) : null
})

// Token 使用情况
const usageMetadata = computed(() => props.message.metadata?.usageMetadata)
const hasUsage = computed<boolean>(() => {
  if (isUser.value || isTool.value) return false
  const usage = usageMetadata.value
  if (!usage) return false
  return !!(usage.totalTokenCount || usage.promptTokenCount || usage.candidatesTokenCount)
})

// 模型版本
const modelVersion = computed(() => props.message.metadata?.modelVersion)

function setThoughtViewMode(mode: ThoughtViewMode) {
  thoughtViewTouched.value = true
  thoughtViewMode.value = mode
}
</script>

<template>
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
        :thought-view-mode="thoughtViewMode"
        :is-thinking="isThinking"
        :thinking-time-display="thinkingTimeDisplay"
        :smooth-display-active="isSmoothThoughtBlock(block)"
        :set-thought-view-mode="setThoughtViewMode"
        v-memo="getRenderBlockMemoDeps(block, isStreaming, isUser, thoughtViewMode, isThinking, thinkingTimeDisplay, isSmoothThoughtBlock(block))"
      />
    </template>

    <!-- 活动正文尾块：已完成段落渐进 markdown + 活动尾巴 CharFlow 托管（批内错峰淡入流水） -->
    <div v-if="tailInfo?.type === 'text'" class="tail-stream">
      <MarkdownRenderer
        v-if="tailRendered"
        :key="tailRenderGeneration"
        :content="tailRendered"
        :latex-only="false"
        :is-streaming="true"
        class="content-text"
        @rendered="handleTailMarkdownRendered"
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
    <StreamingIndicator
      v-if="isStreaming"
      :text="streamingIndicatorText"
    />

    <!-- 消息底部信息：时间 + 响应时间 + Token 速率 + Token 统计 -->
    <MessageFooter
      :formatted-time="formattedTime"
      :ttft="ttft"
      :response-duration="responseDuration"
      :token-rate="tokenRate"
      :usage="usageMetadata"
      :has-usage="hasUsage"
    />

    <!-- Cursor 风格任务卡片：Plan/SubAgent 缩略预览，放在消息内容下方 -->
    <MessageTaskCards
      v-if="!isUser && message.tools && message.tools.length > 0"
      :tools="message.tools"
      :message-model-version="modelVersion"
    />
  </div>
</template>

<style scoped>
/* 消息内容 */
.message-content {
  position: relative;
}

/* 活动正文尾块：流式尾巴（CharFlow）与同容器 md 渲染字体规格对齐。
 * 正文 md 默认 13px/1.6 正常色（未定义 --lim-md-* 变量时），
 * 若不固定，CharFlow 会继承全局 --vscode-font-size，用户调大字号后
 * 已提升的 md 段落与正在流式的尾巴同样会出现字号跳变 */
.tail-stream {
  font-size: var(--lim-md-font-size, 13px);
  line-height: var(--lim-md-line-height, 1.6);
  color: var(--lim-md-color, var(--vscode-foreground));
  word-break: break-word;
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
</style>
