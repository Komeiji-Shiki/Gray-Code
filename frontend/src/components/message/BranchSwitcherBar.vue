<script setup lang="ts">
/**
 * BranchSwitcherBar - 消息内联候选切换器（DeepSeek 风格，TREE-10）
 *
 * 展示位置：由 MessageActions.vue 挂载在对应消息的操作栏内，和复制 / 重试按钮同一行；
 * 也支持普通模式单独挂载（用于组件测试与独立复用）。
 * 在哪条消息处重 roll / 编辑过分支，切换器就跟随那条消息（当前活跃候选），而非父节点或消息区顶部。
 *
 * 数据源：chatStore.branchGraph + nodeId（buildCandidateGroupForNode 推导该消息节点所属的候选组）。
 * 交互：
 * - ‹ / ›：切换到上一个 / 下一个候选（conversation.switchBranchCandidate，TREE-07 重建链路）；
 * - 中间「2 / 3」：展开候选列表（fixed 定位浮层，防滚动容器裁剪），点击候选切换；
 *   hover 展示模型版本 / 节点类型；
 * - 列表项删除按钮：软删除非活跃候选（conversation.deleteBranchCandidate，两步确认防误删）。
 *
 * 竞态：isSwitchingBranch 期间禁用全部按钮（store 侧同时拒绝并发操作）。
 */
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'
import { useChatStore } from '../../stores/chatStore'
import { useI18n } from '../../i18n'
import { buildCandidateGroupForNode, needsWorkspaceConfirm } from '../../stores/chat/branchActions'
import { ConfirmDialog } from '../common'
import type { BranchNodeData } from '../../stores/chat/types'
import type { SwitchBranchWorkspaceMode } from '../../stores/chat/branchActions'

const props = defineProps<{
  /** 消息自身的节点 ID；该消息是某候选组（≥2 候选）的当前活跃成员时显示切换器 */
  nodeId: string
  /** 是否作为消息操作栏内的紧凑按钮组渲染 */
  compact?: boolean
}>()

const { t } = useI18n()
const chatStore = useChatStore()

const listOpen = ref(false)
/** 候选列表使用视口坐标定位，并通过 Teleport 脱离消息节点的 contain 定位上下文。 */
const positionRef = ref<HTMLElement | null>(null)
const candidateListRef = ref<HTMLElement | null>(null)
const listStyle = ref({
  left: '8px',
  top: '8px',
  width: '260px',
  maxHeight: '320px'
})

const VIEWPORT_MARGIN = 8
const LIST_GAP = 4
const LIST_MIN_WIDTH = 260
const LIST_MAX_WIDTH = 420
const LIST_MAX_HEIGHT = 320
const LIST_MIN_VISIBLE_HEIGHT = 80
let positionListenersAttached = false
/** 两步删除确认：第一次点击进入待确认态，再次点击同一候选才真正删除 */
const pendingDeleteNodeId = ref<string | null>(null)
/** BCP-04：待确认「是否连工作区一起恢复」的候选节点（决策 1：默认仅切聊天） */
const pendingWorkspaceSwitchNodeId = ref<string | null>(null)
const showWorkspaceConfirm = ref(false)

/** 该消息节点所属的候选组（null = 无图 / 无候选 / 单候选 / 非活跃成员） */
const group = computed(() => buildCandidateGroupForNode(chatStore.branchGraph, props.nodeId))

/** 无当前对话 / 无候选组时隐藏 */
const visible = computed(() => {
  if (!chatStore.currentConversationId) return false
  return group.value !== null
})

const total = computed(() => group.value?.candidates.length ?? 0)
const activeIndex = computed(() => group.value?.activeIndex ?? -1)
const activeCandidate = computed<BranchNodeData | null>(() => {
  const g = group.value
  if (!g || g.activeIndex < 0) return null
  return g.candidates[g.activeIndex] ?? null
})

function candidatePreview(node: BranchNodeData): string {
  if (typeof node.label === 'string' && node.label.trim()) return node.label.trim()
  const text = (node.parts ?? [])
    .map(part => part.text ?? '')
    .join(' ')
    .trim()
  if (text) return text.slice(0, 120)
  return t('components.message.branch.noPreview')
}

function candidateTitle(node: BranchNodeData): string {
  const meta: string[] = []
  if (typeof node.modelVersion === 'string' && node.modelVersion) meta.push(node.modelVersion)
  if (typeof node.kind === 'string' && node.kind) meta.push(node.kind)
  return meta.join(' · ')
}

/**
 * 根据当前视口计算列表位置。
 * 消息项使用 contain: layout，会成为 fixed 元素的定位上下文，因此列表本身必须 Teleport 到 body。
 */
function updateListPosition(): void {
  if (!listOpen.value) return
  const anchor = positionRef.value
  if (!anchor) return

  const rect = anchor.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const availableWidth = Math.max(1, viewportWidth - VIEWPORT_MARGIN * 2)
  const responsiveWidth = Math.min(
    LIST_MAX_WIDTH,
    Math.max(LIST_MIN_WIDTH, viewportWidth * 0.6)
  )
  const width = Math.floor(Math.min(responsiveWidth, availableWidth))
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width)
  const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.left), maxLeft)

  const measuredHeight = candidateListRef.value?.scrollHeight ?? LIST_MAX_HEIGHT
  const desiredHeight = Math.min(
    LIST_MAX_HEIGHT,
    Math.max(LIST_MIN_VISIBLE_HEIGHT, measuredHeight || LIST_MAX_HEIGHT)
  )
  const availableBelow = Math.max(0, viewportHeight - rect.bottom - LIST_GAP - VIEWPORT_MARGIN)
  const availableAbove = Math.max(0, rect.top - LIST_GAP - VIEWPORT_MARGIN)
  const placeAbove = availableBelow < desiredHeight && availableAbove > availableBelow
  const availableHeight = placeAbove ? availableAbove : availableBelow
  const maxHeight = Math.min(LIST_MAX_HEIGHT, availableHeight)
  const top = placeAbove
    ? Math.max(VIEWPORT_MARGIN, rect.top - LIST_GAP - Math.min(desiredHeight, maxHeight))
    : Math.min(rect.bottom + LIST_GAP, viewportHeight - VIEWPORT_MARGIN)

  listStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(0, Math.floor(maxHeight))}px`
  }
}

function attachPositionListeners(): void {
  if (positionListenersAttached) return
  window.addEventListener('resize', updateListPosition)
  window.addEventListener('scroll', updateListPosition, true)
  positionListenersAttached = true
}

function detachPositionListeners(): void {
  if (!positionListenersAttached) return
  window.removeEventListener('resize', updateListPosition)
  window.removeEventListener('scroll', updateListPosition, true)
  positionListenersAttached = false
}

function closeList(): void {
  listOpen.value = false
  detachPositionListeners()
}

/** 展开 / 收起候选列表，并在渲染后按实际高度校正位置。 */
function toggleList(): void {
  if (listOpen.value) {
    closeList()
    return
  }
  if (!positionRef.value) return

  listOpen.value = true
  updateListPosition()
  attachPositionListeners()
  void nextTick(updateListPosition)
}

watch(visible, value => {
  if (!value) closeList()
})

onBeforeUnmount(detachPositionListeners)

function switchTo(nodeId: string): void {
  closeList()
  pendingDeleteNodeId.value = null
  const target = chatStore.branchGraph?.nodes[nodeId]
  // BCP-04（决策 1）：目标分支执行过写工具 / 有工作区存档 → 先弹「仅切聊天 or 连工作区一起恢复」确认框
  if (needsWorkspaceConfirm(target)) {
    pendingWorkspaceSwitchNodeId.value = nodeId
    showWorkspaceConfirm.value = true
    return
  }
  void chatStore.switchBranchCandidate(nodeId)
}

/** BCP-04：按用户选择执行切换（chat-only / chat-and-workspace） */
function confirmSwitchMode(mode: SwitchBranchWorkspaceMode): void {
  const nodeId = pendingWorkspaceSwitchNodeId.value
  pendingWorkspaceSwitchNodeId.value = null
  showWorkspaceConfirm.value = false
  if (!nodeId) return
  void chatStore.switchBranchCandidate(nodeId, { mode })
}

/** 上 / 下一个候选（循环） */
function step(delta: number): void {
  const g = group.value
  if (!g || g.candidates.length === 0) return
  const current = g.activeIndex >= 0 ? g.activeIndex : 0
  const next = (current + delta + g.candidates.length) % g.candidates.length
  const target = g.candidates[next]
  if (target) switchTo(target.id)
}

function toggleDelete(nodeId: string): void {
  if (pendingDeleteNodeId.value === nodeId) {
    pendingDeleteNodeId.value = null
    void chatStore.deleteBranchCandidate(nodeId)
    return
  }
  pendingDeleteNodeId.value = nodeId
}
</script>

<template>
  <div v-if="visible" class="branch-switcher-bar" :class="{ compact: props.compact }">
    <button
      class="branch-switcher-btn"
      :disabled="chatStore.isSwitchingBranch"
      :title="t('components.message.branch.previous')"
      @click="step(-1)"
    >
      <i class="codicon codicon-chevron-left"></i>
    </button>

    <div ref="positionRef" class="branch-switcher-center">
      <button
        class="branch-switcher-position"
        :disabled="chatStore.isSwitchingBranch"
        :title="t('components.message.branch.candidateList')"
        @click="toggleList"
      >
        <span class="branch-switcher-position-text">{{ activeIndex + 1 }} / {{ total }}</span>
        <i class="codicon" :class="listOpen ? 'codicon-chevron-up' : 'codicon-chevron-down'"></i>
      </button>
    </div>

    <button
      class="branch-switcher-btn"
      :disabled="chatStore.isSwitchingBranch"
      :title="t('components.message.branch.next')"
      @click="step(1)"
    >
      <i class="codicon codicon-chevron-right"></i>
    </button>

    <span v-if="chatStore.isSwitchingBranch" class="branch-switcher-loading">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
    </span>
  </div>

  <Teleport to="body">
    <div
      v-if="listOpen && visible"
      ref="candidateListRef"
      class="branch-candidate-list"
      :style="listStyle"
    >
      <div
        v-for="candidate in group?.candidates ?? []"
        :key="candidate.id"
        class="branch-candidate-row"
        :class="{ active: candidate.id === activeCandidate?.id }"
      >
        <button
          class="branch-candidate-main"
          :title="candidateTitle(candidate) || t('components.message.branch.switchTo')"
          @click="switchTo(candidate.id)"
        >
          <span class="branch-candidate-preview">{{ candidatePreview(candidate) }}</span>
          <span v-if="candidate.id === activeCandidate?.id" class="branch-candidate-active">
            {{ t('components.message.branch.active') }}
          </span>
        </button>
        <button
          v-if="candidate.id !== activeCandidate?.id"
          class="branch-candidate-delete"
          :class="{ confirming: pendingDeleteNodeId === candidate.id }"
          :title="
            pendingDeleteNodeId === candidate.id
              ? t('components.message.branch.deleteConfirm')
              : t('components.message.branch.delete')
          "
          @click="toggleDelete(candidate.id)"
        >
          <i class="codicon" :class="pendingDeleteNodeId === candidate.id ? 'codicon-check' : 'codicon-trash'"></i>
        </button>
      </div>
    </div>
  </Teleport>

  <!-- BCP-04：目标分支执行过写工具 / 有工作区存档时的模式确认框（决策 1：默认仅切聊天） -->
  <ConfirmDialog
    v-model="showWorkspaceConfirm"
    :title="t('components.message.branch.workspaceConfirmTitle')"
    :message="t('components.message.branch.workspaceConfirmMessage')"
    :confirm-text="t('components.message.branch.workspaceConfirmChatOnly')"
    :cancel-text="t('components.message.branch.workspaceConfirmCancel')"
    @confirm="confirmSwitchMode('chat-only')"
    @cancel="pendingWorkspaceSwitchNodeId = null"
  >
    <button class="workspace-confirm-secondary" @click="confirmSwitchMode('chat-and-workspace')">
      <i class="codicon codicon-workspace-trusted"></i>
      {{ t('components.message.branch.workspaceConfirmChatAndWorkspace') }}
    </button>
  </ConfirmDialog>
</template>

<style scoped>
/* 普通模式：保留为独立消息内联条（兼容单独挂载与组件测试） */
.branch-switcher-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  margin: 2px 0 6px var(--spacing-md, 16px);
  padding: 2px 4px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  background: var(--vscode-editor-background);
  user-select: none;
}

/* 消息操作栏内的紧凑按钮组：与复制 / 重试 IconButton 共用同一行和高度 */
.branch-switcher-bar.compact {
  height: 24px;
  margin: 0 2px;
  padding: 0;
  gap: 0;
  border: none;
  background: transparent;
  /* 与 IconButton 一致：窄侧边栏下不被压缩变形，保持等宽等高 */
  flex-shrink: 0;
}

.branch-switcher-bar.compact .branch-switcher-btn {
  width: 18px;
  height: 22px;
  padding: 0;
}

.branch-switcher-bar.compact .branch-switcher-position {
  height: 22px;
  padding: 1px 3px;
  background: transparent;
}

.branch-switcher-bar.compact .branch-switcher-position:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground);
}

.branch-switcher-bar.compact .branch-switcher-position-text {
  min-width: 28px;
}

.branch-switcher-bar.compact .branch-switcher-loading {
  padding: 0 2px;
}


.branch-switcher-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: var(--radius-sm, 2px);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.branch-switcher-btn:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.branch-switcher-center {
  min-width: 0;
}

.branch-switcher-position {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: none;
  border-radius: var(--radius-sm, 2px);
  background: var(--vscode-editor-inactiveSelectionBackground);
  color: var(--vscode-foreground);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s;
}

.branch-switcher-position:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground);
}

.branch-switcher-position-text {
  min-width: 30px;
  text-align: center;
}

/* fixed 浮层通过 Teleport 挂到 body，避免消息项 contain: layout 改写定位参照。 */
.branch-candidate-list {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  min-width: 0;
  overflow: auto;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  background: var(--vscode-editor-background);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}

.branch-candidate-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.branch-candidate-row:last-child {
  border-bottom: none;
}

.branch-candidate-row.active {
  background: var(--vscode-editor-inactiveSelectionBackground);
}

.branch-candidate-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  text-align: left;
  cursor: pointer;
}

.branch-candidate-main:hover {
  background: var(--vscode-list-hoverBackground);
}

.branch-candidate-preview {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--vscode-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.branch-candidate-active {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--vscode-charts-blue, #3794ff);
}

.branch-candidate-delete {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-right: 4px;
  border: none;
  border-radius: var(--radius-sm, 2px);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}

.branch-candidate-delete:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-testing-iconFailed, #f14c4c);
}

.branch-candidate-delete.confirming {
  color: var(--vscode-testing-iconFailed, #f14c4c);
  background: var(--vscode-inputValidation-errorBackground, rgba(241, 76, 76, 0.12));
}

.branch-switcher-loading {
  display: flex;
  align-items: center;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.workspace-confirm-secondary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 10px;
  padding: 6px 14px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, 0.15));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.workspace-confirm-secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127, 127, 127, 0.25));
}
</style>
