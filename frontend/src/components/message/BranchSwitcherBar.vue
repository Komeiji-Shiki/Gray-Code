<script setup lang="ts">
/**
 * BranchSwitcherBar - 候选切换器 + 分支状态 UI（TREE-10）
 *
 * 展示位置：消息区顶部（MessageList.vue 挂载）。
 * 展示条件：当前对话存在分支图，且当前活跃尾节点的父节点下有 ≥2 个候选；
 * 无分支图 / 单候选 / 无当前对话时整个组件隐藏。
 *
 * 数据源：chatStore.branchGraph（loadBranchGraph / refreshBranchGraph 拉取 conversation.getBranchGraph）。
 * 交互：
 * - ‹ / ›：切换到上一个 / 下一个候选（conversation.switchBranchCandidate，TREE-07 重建链路）；
 * - 中间「2 / 3」：展开候选列表，点击候选切换；hover 展示模型版本 / 节点类型；
 * - 列表项删除按钮：软删除非活跃候选（conversation.deleteBranchCandidate，两步确认防误删）。
 *
 * 竞态：isSwitchingBranch 期间禁用全部按钮（store 侧同时拒绝并发操作）。
 */
import { ref, computed } from 'vue'
import { useChatStore } from '../../stores/chatStore'
import { useI18n } from '../../i18n'
import { buildCandidateGroup, needsWorkspaceConfirm } from '../../stores/chat/branchActions'
import { ConfirmDialog } from '../common'
import DirtyFilesConfirm from './DirtyFilesConfirm.vue'
import type { BranchNodeData } from '../../stores/chat/types'
import type { SwitchBranchWorkspaceMode } from '../../stores/chat/branchActions'

const { t } = useI18n()
const chatStore = useChatStore()

const listOpen = ref(false)
/** 两步删除确认：第一次点击进入待确认态，再次点击同一候选才真正删除 */
const pendingDeleteNodeId = ref<string | null>(null)
/** BCP-04：待确认「是否连工作区一起恢复」的候选节点（决策 1：默认仅切聊天） */
const pendingWorkspaceSwitchNodeId = ref<string | null>(null)
const showWorkspaceConfirm = ref(false)

/** 当前活跃尾节点的兄弟候选组（null = 无图 / 无候选） */
const group = computed(() => buildCandidateGroup(chatStore.branchGraph))

/** 无分支图 / 单候选 / 无当前对话时隐藏 */
const visible = computed(() => {
  if (!chatStore.currentConversationId) return false
  const g = group.value
  return g !== null && g.candidates.length >= 2
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

function switchTo(nodeId: string): void {
  listOpen.value = false
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
  <div v-if="visible" class="branch-switcher-bar">
    <button
      class="branch-switcher-btn"
      :disabled="chatStore.isSwitchingBranch"
      :title="t('components.message.branch.previous')"
      @click="step(-1)"
    >
      <i class="codicon codicon-chevron-left"></i>
    </button>

    <div class="branch-switcher-center">
      <button
        class="branch-switcher-position"
        :disabled="chatStore.isSwitchingBranch"
        :title="t('components.message.branch.candidateList')"
        @click="listOpen = !listOpen"
      >
        <span class="branch-switcher-position-text">{{ activeIndex + 1 }} / {{ total }}</span>
        <i class="codicon" :class="listOpen ? 'codicon-chevron-up' : 'codicon-chevron-down'"></i>
      </button>

      <div v-if="listOpen" class="branch-candidate-list">
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

  <!-- BCP-05（决策 11）：恢复 / 切换恢复的未保存文件确认框（常驻挂载） -->
  <DirtyFilesConfirm />
</template>

<style scoped>
/* 样式沿用 MessageList build-bar / 检查点条的 VS Code 主题 token（GrayCode 面板风格） */
.branch-switcher-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: 6px var(--spacing-md, 16px);
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
  flex-shrink: 0;
  user-select: none;
}

.branch-switcher-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--vscode-panel-border);
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
  position: relative;
  min-width: 0;
}

.branch-switcher-position {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--vscode-panel-border);
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
  min-width: 34px;
  text-align: center;
}

.branch-candidate-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  min-width: 260px;
  max-width: min(420px, 60vw);
  max-height: min(40vh, 320px);
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
