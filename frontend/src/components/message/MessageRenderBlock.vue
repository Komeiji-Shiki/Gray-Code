<script lang="ts">
/**
 * 中展开裁剪提示按 messageId 记忆（模块级）：内容超长被裁是消息内容的属性，不是视图
 * 切换的状态。切到完全展开再切回中展开时 watch 重新注册、CharFlow restore 恢复的尾巴
 * 可能 ≤ 窗口、不再触发 onTrimmed——若无条件重置 mediumTrimmed，提示条会消失而内容
 * 仍被裁过。模块级 Map + 清理函数（与 MessageItem 的视图模式 Map 同模式）。
 */
export const mediumTrimmedByMessageId = new Map<string, boolean>()
export const MEDIUM_TRIMMED_CAP = 500

/**
 * 裁剪提示记录清理（与 MessageList 的 pruneBackgroundTaskViewModes 同口径调用）：
 * 消息删除/窗口裁剪后移除不再渲染的 messageId，避免 Map 只靠容量上限兜底淘汰
 * 仍在渲染的消息记录。
 */
export function pruneMediumTrimmedByMessageId(activeIds: Set<string>): void {
  for (const messageId of Array.from(mediumTrimmedByMessageId.keys())) {
    if (!activeIds.has(messageId)) {
      mediumTrimmedByMessageId.delete(messageId)
    }
  }
}
</script>

<script setup lang="ts">
/**
 * MessageRenderBlock 是渲染块纯展示子组件。
 * memo 边界由父组件 MessageItem.vue 放在 v-for 同一组件元素上；本组件内部不声明 memo，也不引入 display:contents 或额外 wrapper。
 */

import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { RenderBlock, ThoughtViewMode } from './renderBlocks'
import { hasContextBlocks } from '../../types/contextParser'
import { useI18n } from '../../i18n'
import ToolMessage from './ToolMessage.vue'
import InlineContextMessage from './InlineContextMessage.vue'
import { MarkdownRenderer } from '../common'
import { registerSmoothDisplay, unregisterSmoothDisplay } from '../../stores/chat/smoothStreamManager'

const { t } = useI18n()

const props = defineProps<{
  block: RenderBlock
  /** 消息 ID；仅活动思维 CharFlow 注册时需要 */
  messageId?: string
  /** 消息角色，决定 Markdown 是否仅渲染 LaTeX */
  messageRole: 'user' | 'assistant' | 'tool'
  /** 消息是否仍在流式输出 */
  isStreaming: boolean
  /** 思考块三段式视图模式（由父组件统一管理）：折叠 / 中展开 / 完全展开 */
  thoughtViewMode: ThoughtViewMode
  /** 是否正在思考中（决定灯泡动画） */
  isThinking: boolean
  /** 思考时间显示文本 */
  thinkingTimeDisplay: string | null
  /** 后端消息索引，透传给 ToolMessage 保持 diff/action 语义 */
  messageBackendIndex?: number
  /** 当前思维块是否由 CharFlow 直接驱动显示 */
  smoothDisplayActive?: boolean
  /** 三段式视图模式切换，由父组件提供以避免本展示组件新增 emits */
  setThoughtViewMode: (mode: ThoughtViewMode) => void
}>()

// 三段式切换顺序：折叠 → 中展开 → 完全展开 → 折叠（头部单击循环）
const THOUGHT_VIEW_CYCLE: ThoughtViewMode[] = ['collapsed', 'medium', 'expanded']
function cycleThoughtViewMode(): void {
  const idx = THOUGHT_VIEW_CYCLE.indexOf(props.thoughtViewMode)
  props.setThoughtViewMode(THOUGHT_VIEW_CYCLE[(idx + 1) % THOUGHT_VIEW_CYCLE.length])
}

const thoughtFlowHostRef = ref<HTMLElement | null>(null)
// 中展开滚动容器（.thought-medium：max-height + overflow-y auto 的元素）
const mediumScrollContainerRef = ref<HTMLElement | null>(null)
// 中展开吸底状态：默认贴底跟随最新内容；用户滚离底部后暂停，滚回底部附近恢复
const stickToBottom = ref(true)
// 用户是否滚动过容器：false 时无条件贴底（刚注册/刚切回中展开，内容在底部起步）；
// true 后按位置复验——scroll 事件由浏览器合帧派发、滞后于实际滚动，
// 内容更新时不能只信状态，要实时核对当前位置
const userScrolled = ref(false)
// 距底部多少 px 内视为「贴底意图」（用户滚回底部即恢复自动吸底）
const STICK_BOTTOM_THRESHOLD = 40
// 用户滚动输入后的冷静期（ms）：期间不执行贴底跟随。高 tps 下内容增长会
// 抵消滚动距离（滚 50px 内容长 40px），无冷静期时连续滚动也会被拉回。
// wheel 输入事件同步派发、早于 scroll 事件，是可靠的「用户滚动意图」信号
const USER_SCROLL_COOLDOWN_MS = 250
/** 最近一次用户滚动输入的时间（performance.now 时间轴） */
let lastUserScrollInputAt = 0
// 上次复验时的 scrollTop：内容增长只改 scrollHeight 不改 scrollTop。
// scrollTop 未变 = 用户没动 → 保持吸底状态（大段输出/md 解析不丢吸底）；
// scrollTop 变化 = 用户滚动或程序贴底写入 → 按当前位置重新判定
let lastCheckedScrollTop = -1
// 中展开是否发生过尾部窗口裁剪（内容过长，显示提示条）
const mediumTrimmed = ref(false)
/** 稳定引用（CharFlow 注册幂等比较依赖函数身份）：内容更新时是否应贴底。
 * 用户滚动事件可能滞后：scrollTop 变化能立即反映用户意图（浏览器同步更新），
 * 已滚离底部（事件未到）时同步置 false，避免 append 把用户拉回；
 * scrollTop 未变则用户没动，内容增长不改变吸底意图 */
function shouldStickBottom(): boolean {
  // 用户滚动输入冷静期内不贴底：让滚动真正生效（内容增长可能抵消滚动距离）。
  // 不修改 stickToBottom：冷静期结束后用户若仍在底部可无缝恢复吸底
  if (performance.now() - lastUserScrollInputAt < USER_SCROLL_COOLDOWN_MS) return false
  if (!stickToBottom.value) return false
  if (!userScrolled.value) return true
  const el = mediumScrollContainerRef.value
  if (!el) return true
  // 用户没滚动（scrollTop 未变）：内容增长/渲染不改变吸底意图
  if (el.scrollTop !== lastCheckedScrollTop) {
    lastCheckedScrollTop = el.scrollTop
    // 用户滚动过（或程序贴底写入后）：按当前位置判定贴底意图
    if (el.scrollHeight - el.scrollTop - el.clientHeight >= STICK_BOTTOM_THRESHOLD) {
      stickToBottom.value = false
      return false
    }
    stickToBottom.value = true
  }
  // 即将返回 true：调用方（CharFlow scrollToEnd / promote 校正）会同步贴底写入
  // scrollTop。程序写入会改变 scrollTop，若不记录，紧随其后的异步高度增长
  // （代码块 hljs 高亮渲染）会让 scrollTop 变化检测把程序写入误判为「用户滚动」，
  // 位置复验按涨量判定「不在底部」→ 丢吸底。微任务读回写入后的实际值
  // （浏览器对 scrollTop 赋值有钳制，读回最准）
  queueMicrotask(() => {
    const el2 = mediumScrollContainerRef.value
    if (el2) lastCheckedScrollTop = el2.scrollTop
  })
  return true
}
/** 稳定引用：尾部窗口首次裁剪时置标志，显示「内容过长」提示（按 messageId 记忆） */
function handleTrimmed(): void {
  mediumTrimmed.value = true
  if (props.messageId) {
    if (!mediumTrimmedByMessageId.has(props.messageId) && mediumTrimmedByMessageId.size >= MEDIUM_TRIMMED_CAP) {
      const oldestKey = mediumTrimmedByMessageId.keys().next().value
      if (oldestKey !== undefined) {
        mediumTrimmedByMessageId.delete(oldestKey)
      }
    }
    mediumTrimmedByMessageId.set(props.messageId, true)
  }
}
/** 滚动容器滚动事件：标记用户已干预；滚离底部即暂停吸底，滚回底部附近恢复 */
function onMediumScroll(): void {
  userScrolled.value = true
  const el = mediumScrollContainerRef.value
  if (!el) return
  lastCheckedScrollTop = el.scrollTop
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_BOTTOM_THRESHOLD
}
/** 滚动容器 wheel 输入：标记冷静期（输入事件早于 scroll 事件派发，高 tps 下防止拉回） */
function onMediumWheel(): void {
  lastUserScrollInputAt = performance.now()
}
/** 渐进 markdown 提升后校正贴底：promote 同步剥离 CharFlow 内容（host 立即变矮），
 * 而 MarkdownRenderer 在下一 tick 才渲染变高——两段式高度变化会让贴底位置
 * 停在中间。必须等 Vue 完成渲染（nextTick）后按最终 scrollHeight 校正 */
async function scrollMediumToBottomIfStuck(): Promise<void> {
  if (!stickToBottom.value) return
  const el = mediumScrollContainerRef.value
  if (!el) return
  await nextTick()
  // 组件可能已重建（虚拟列表）：只写仍挂载的同一容器
  if (mediumScrollContainerRef.value !== el) return
  // 复验当前位置：用户已滚离（scroll 事件滞后）时不拉回
  if (!shouldStickBottom()) return
  el.scrollTop = el.scrollHeight
  // 同步记录程序写入位置：避免下次 scrollTop 变化检测误判为用户滚动
  // （代码块异步渲染导致 scrollHeight 骤增时，误判会丢吸底）
  lastCheckedScrollTop = el.scrollTop
}
let registeredThoughtHost: HTMLElement | null = null
let registeredThoughtMessageId: string | null = null
let registeredThoughtPartKey: string | null = null

// 渐进 markdown：展开/中展开态下已定型段落与完整表格行由 CharFlow promote 到这里，
// 即时渲染格式（思维链分段渲染）；未完成尾巴仍在 CharFlow host 逐字淡出。
// 折叠态不启用（无内容区）。
const thoughtRendered = ref('')
const thoughtRenderGeneration = ref(0)
let lastThoughtRenderedSource = ''
interface PendingThoughtRender {
  source: string
  resolve: () => void
}
const pendingThoughtRenders: PendingThoughtRender[] = []

/** 折叠视图预览文本：思考内容第一行（非流式路径；流式路径由 CharFlow host 托管） */
const collapsedPreview = computed(() => {
    const firstLine = (props.block.text ?? '').split('\n').find(line => line.trim().length > 0) ?? ''
    return firstLine.trim()
})

function handleThoughtPromote(text: string, kind: 'delta' | 'replay' = 'delta'): Promise<void> {
  thoughtRendered.value = kind === 'replay' ? text : thoughtRendered.value + text
  const source = thoughtRendered.value

  if (lastThoughtRenderedSource.startsWith(source)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    pendingThoughtRenders.push({ source, resolve })
  })
}

function handleThoughtMarkdownRendered(source: string): void {
  lastThoughtRenderedSource = source
  for (let i = pendingThoughtRenders.length - 1; i >= 0; i--) {
    const pending = pendingThoughtRenders[i]
    if (!source.startsWith(pending.source)) continue
    pendingThoughtRenders.splice(i, 1)
    pending.resolve()
  }

  // bridge 的 release 会排在上面的 Promise resolve 之后；现有滚动函数再等一个
  // nextTick，最终按“Markdown 已落地且 raw bridge 已移除”的真实高度校正。
  void scrollMediumToBottomIfStuck()
}

function resolvePendingThoughtRenders(): void {
  for (const pending of pendingThoughtRenders.splice(0)) pending.resolve()
}

function releaseThoughtDisplay(): void {
  if (registeredThoughtHost && registeredThoughtMessageId) {
    unregisterSmoothDisplay(registeredThoughtMessageId, registeredThoughtHost)
  }
  registeredThoughtHost = null
  registeredThoughtMessageId = null
  registeredThoughtPartKey = null
  resolvePendingThoughtRenders()
  lastThoughtRenderedSource = ''
  // 同一 tick 内 S → '' → replay(S) 会被 Vue 合并；换 key 强制新 renderer 发 rendered ack。
  thoughtRenderGeneration.value++
  // 渐进渲染内容随显示层释放：稳定块（renderBlocks）完整接管，避免重复显示
  if (thoughtRendered.value) thoughtRendered.value = ''
}

watch(
  [
    () => props.messageId,
    () => props.block.partKey ?? null,
    () => props.smoothDisplayActive === true,
    () => props.thoughtViewMode,
    thoughtFlowHostRef,
    mediumScrollContainerRef
  ],
  ([messageId, partKey, active, viewMode, host, scrollContainer]) => {
    if (
      registeredThoughtHost &&
      (
        !active ||
        registeredThoughtHost !== host ||
        registeredThoughtMessageId !== messageId ||
        registeredThoughtPartKey !== partKey
      )
    ) {
      releaseThoughtDisplay()
    }
    if (active && messageId && host && !registeredThoughtHost) {
      if (viewMode === 'collapsed') {
        // 折叠：单行预览。noFade 直接追加、换行折叠为零宽空格、followEnd 始终
        // 滚动到最新字符、tailWindow 让超长思考内容有界（防撑爆单行容器）；
        // 无渐进渲染层，restoreFull 注册时恢复完整累计文本。
        registerSmoothDisplay(messageId, host, {
          noFade: true,
          squashLineBreaks: true,
          tailWindow: 120,
          followEnd: true,
          restoreFull: true
        })
      } else if (viewMode === 'expanded') {
        // 完全展开：保留逐字淡入 + 渐进 markdown（已定型完整段落即时渲染格式）
        registerSmoothDisplay(messageId, host, { onPromote: handleThoughtPromote })
      } else {
        // 中展开（collapsed 无 host 不会到达这里）：多行滚动预览。
        // noFade 直接追加（预览不做逐字动画）；渐进 markdown 同展开态；
        // tailWindow 保护超长未完成段落（触发 onTrimmed 显示裁剪提示）；
        // scrollContainer + stickBottom：贴底写在滚动容器上，用户滚上去时暂停跟随。
        // 重新进入中展开（切模式/重建）重置吸底状态：默认看最新内容。
        // 裁剪提示不重置：内容超长是消息属性，按 messageId 记忆（切走再切回仍显示）。
        mediumTrimmed.value = messageId ? mediumTrimmedByMessageId.get(messageId) ?? false : false
        stickToBottom.value = true
        userScrolled.value = false
        lastUserScrollInputAt = 0 // 重置冷静期：重新进入中展开立即恢复贴底
        registerSmoothDisplay(messageId, host, {
          noFade: true,
          tailWindow: 4096,
          scrollContainer: scrollContainer ?? undefined,
          stickBottom: shouldStickBottom,
          onTrimmed: handleTrimmed,
          onPromote: handleThoughtPromote
        })
      }
      registeredThoughtHost = host
      registeredThoughtMessageId = messageId
      registeredThoughtPartKey = partKey
    }
  },
  { immediate: true, flush: 'post' }
)

onUnmounted(releaseThoughtDisplay)
</script>

<template>
  <!-- 每个分支沿用原真实根，不用额外 wrapper 或 display:contents。 -->

  <!-- 思考块：三段式视图（折叠 / 中展开 / 完全展开），对齐后台任务回流消息 -->
  <div v-if="block.type === 'thought'" class="thought-block" :class="`view-${thoughtViewMode}`">
    <div class="thought-header" @click="cycleThoughtViewMode">
      <i
        class="codicon"
        :class="thoughtViewMode === 'collapsed' ? 'codicon-chevron-right' : 'codicon-chevron-down'"
      ></i>
      <i
        class="codicon codicon-lightbulb thought-icon"
        :class="{ 'thinking-pulse': isThinking }"
      ></i>
      <span class="thought-label">
        {{ isThinking ? t('components.message.thought.thinking') : t('components.message.thought.thoughtProcess') }}
      </span>
      <span
        v-if="thinkingTimeDisplay"
        class="thought-time"
        :class="{ 'thinking-active': isThinking }"
      >
        {{ thinkingTimeDisplay }}
      </span>
      <!-- 三段式视图切换：折叠 / 中展开（滚动） / 完全展开（参考后台任务） -->
      <div class="thought-view-controls" @click.stop>
        <button
          class="thought-view-btn"
          :class="{ active: thoughtViewMode === 'collapsed' }"
          :title="t('components.message.thought.viewCollapsed')"
          @click="setThoughtViewMode('collapsed')"
        >
          <i class="codicon codicon-chevron-up"></i>
        </button>
        <button
          class="thought-view-btn"
          :class="{ active: thoughtViewMode === 'medium' }"
          :title="t('components.message.thought.viewMedium')"
          @click="setThoughtViewMode('medium')"
        >
          <i class="codicon codicon-list-flat"></i>
        </button>
        <button
          class="thought-view-btn"
          :class="{ active: thoughtViewMode === 'expanded' }"
          :title="t('components.message.thought.viewExpanded')"
          @click="setThoughtViewMode('expanded')"
        >
          <i class="codicon codicon-chevron-down"></i>
        </button>
      </div>
    </div>
    <!-- 折叠：单行显示思考内容最新字符作为预览（流式 CharFlow / 非流式第一行） -->
    <div v-if="thoughtViewMode === 'collapsed'" class="thought-collapsed-preview">
      <template v-if="smoothDisplayActive">
        <div ref="thoughtFlowHostRef" class="thought-collapsed-text"></div>
      </template>
      <span v-else class="thought-collapsed-text">{{ collapsedPreview }}</span>
    </div>
    <!-- 中展开：固定行数滚动查看（流式渐进 markdown + CharFlow 尾巴，非流式 markdown 渲染） -->
    <div
      v-if="thoughtViewMode === 'medium'"
      ref="mediumScrollContainerRef"
      class="thought-medium"
      @scroll="onMediumScroll"
      @wheel="onMediumWheel"
    >
      <!-- 尾部窗口裁剪提示：内容过长仅显示最近部分 -->
      <div v-if="mediumTrimmed && smoothDisplayActive" class="thought-trim-hint">
        <i class="codicon codicon-info"></i>
        <span>{{ t('components.message.thought.trimmedHint') }}</span>
      </div>
      <template v-if="smoothDisplayActive">
        <!-- 渐进 markdown：已定型完整段落即时渲染格式 + 未完成尾巴 CharFlow 逐字流出 -->
        <MarkdownRenderer
          v-if="thoughtRendered"
          :key="thoughtRenderGeneration"
          :content="thoughtRendered"
          :latex-only="false"
          :is-streaming="true"
          class="thought-text"
          @rendered="handleThoughtMarkdownRendered"
        />
        <div ref="thoughtFlowHostRef" class="thought-medium-text thought-flow-medium"></div>
      </template>
      <MarkdownRenderer
        v-else
        :content="block.text || ''"
        :latex-only="false"
        :is-streaming="isStreaming"
        class="thought-text"
      />
    </div>
    <!-- 完全展开 -->
    <div v-if="thoughtViewMode === 'expanded'" class="thought-content">
      <template v-if="smoothDisplayActive">
        <!-- 展开态流式：已定型完整段落渐进 markdown 即时渲染 + 未完成尾巴 CharFlow 逐字淡出 -->
        <MarkdownRenderer
          v-if="thoughtRendered"
          :key="thoughtRenderGeneration"
          :content="thoughtRendered"
          :latex-only="false"
          :is-streaming="true"
          class="thought-text"
          @rendered="handleThoughtMarkdownRendered"
        />
        <div ref="thoughtFlowHostRef" class="thought-text thought-flow-content"></div>
      </template>
      <MarkdownRenderer
        v-else
        :content="block.text || ''"
        :latex-only="false"
        :is-streaming="isStreaming"
        class="thought-text"
      />
    </div>
  </div>

  <!-- 文本块（用户消息带 context 块） -->
  <InlineContextMessage
    v-else-if="block.type === 'text' && messageRole === 'user' && hasContextBlocks(block.text || '')"
    :content="block.text || ''"
  />

  <!-- 文本块（Markdown 渲染） -->
  <MarkdownRenderer
    v-else-if="block.type === 'text'"
    :content="block.text || ''"
    :latex-only="messageRole === 'user'"
    :is-streaming="isStreaming"
    class="content-text"
  />

  <!-- 工具调用块 -->
  <ToolMessage
    v-else-if="block.type === 'tool'"
    class="tool-message-block"
    :tools="block.tools!"
    :message-backend-index="messageBackendIndex"
  />
</template>

<style scoped>
/* 思考块样式：三段式视图（折叠 / 中展开 / 完全展开） */
.thought-block {
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
  0%, 100% { opacity: 0.8; }
  50% { opacity: 1; }
}

/* 三段式视图切换：折叠 / 中展开（滚动） / 完全展开（参考后台任务） */
.thought-view-controls {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.thought-view-btn {
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

.thought-view-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.thought-view-btn.active {
  background: var(--vscode-toolbar-activeBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-foreground);
}

.thought-view-btn .codicon {
  font-size: 13px;
}

/* 中展开裁剪提示：tailWindow 丢弃开头、内容过长时显示 */
.thought-trim-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  margin-bottom: 8px;
  font-size: 11px;
  font-style: normal;
  line-height: 1.4;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-warningForeground, #cca700) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--vscode-warningForeground, #cca700) 28%, transparent);
  border-radius: 3px;
}

.thought-trim-hint .codicon {
  font-size: 12px;
  flex-shrink: 0;
}

/* 折叠预览：单行显示第一行/最新字符，超出省略 */
.thought-collapsed-preview {
  padding: 0 12px 8px;
  border-top: none;
}

.thought-collapsed-text {
  display: block;
  font-size: var(--lim-md-font-size, 12px);
  line-height: var(--lim-md-line-height, 1.5);
  color: var(--lim-md-color, var(--vscode-descriptionForeground));
  font-style: var(--lim-md-font-style, italic);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thought-medium {
  padding: 12px;
  border-top: none;
  max-height: 15em; /* 行高 1.5em × 10 行 */
  overflow-y: auto;
  overscroll-behavior: contain;
}

.thought-medium-text {
  font-size: var(--lim-md-font-size, 12px);
  line-height: var(--lim-md-line-height, 1.5);
  color: var(--lim-md-color, var(--vscode-descriptionForeground));
  font-style: var(--lim-md-font-style, italic);
  white-space: pre-wrap;
  word-break: break-word;
}

.thought-flow-medium {
  scroll-behavior: auto;
}

.thought-content {
  padding: 12px;
  border-top: none;
}

.thought-flow-content {
  min-height: 1lh;
  /* 与 .thought-block 内 MarkdownRenderer 的字体规格保持一致（12px 灰斜体）：
   * CharFlow 手动 DOM 不经过 Vue，但字体属性可继承，host 上对齐后
   * 已提升的 md 段落与正在流式的尾巴不再有字号/颜色/字重跳变 */
  font-size: var(--lim-md-font-size, 12px);
  line-height: var(--lim-md-line-height, 1.5);
  color: var(--lim-md-color, var(--vscode-descriptionForeground));
  font-style: var(--lim-md-font-style, italic);
  word-break: break-word;
}

.thought-block :deep(.thought-text p) {
  margin: 0.5em 0;
}

.thought-block :deep(.thought-text p:first-child) {
  margin-top: 0;
}

.thought-block :deep(.thought-text p:last-child) {
  margin-bottom: 0;
}

/* 正文与工具调用块的垂直间距 */
.tool-message-block {
  margin: 8px 0;
}
</style>
