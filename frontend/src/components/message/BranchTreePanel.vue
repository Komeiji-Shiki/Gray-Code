<script setup lang="ts">
/**
 * BranchTreePanel - 完整分支树查看面板（TREE-11）
 *
 * 独立浮层（position: fixed + 透明背板），入口按钮挂在输入区底部工具栏、与 Skills 并排；
 * 仅在确实存在额外候选分支时显示，线性对话 / 只有单子节点的分支图不显示入口。
 *
 * 数据源：chatStore.branchGraph（TREE-10 已接线的 conversation.getBranchGraph）。
 * 树形组装（本地，不依赖后端新 API）：
 * - buildChildrenIndex 按 parentId 建索引（镜像后端 childrenIndex 排序），
 *   从 root 沿 childrenIndex DFS 展平成带深度的行；
 * - buildActivePathIds 沿 activeChildId 推导当前活跃路径（镜像后端 activePath），
 *   活跃路径用蓝色导线和节点图标表达；只有 activeTailNodeId 显示「当前」，避免每行重复标记。
 * - 每个节点根据子候选数量标记分支点，候选从对应父节点横向连接出来；
 *
 * 交互（复用 chatStore 既有动作）：
 * - 点击非活跃、非软删节点 = switchBranchCandidate（活跃节点禁用）；
 * - 删除（软删）= deleteBranchCandidate，两步确认防误删（风格同 BranchSwitcherBar）；
 * - 恢复 = restoreBranchCandidate（软删节点灰显 + 恢复入口）；
 * - 重命名 = renameBranchCandidate（行内输入，Enter 保存 / Esc 取消）。
 *
 * 竞态：isSwitchingBranch 期间全部动作按钮禁用（store 侧同时拒绝并发操作）。
 */
import { ref, computed } from 'vue'
import { useChatStore } from '../../stores/chatStore'
import { useI18n } from '../../i18n'
import { buildActivePathIds, buildChildrenIndex, needsWorkspaceConfirm } from '../../stores/chat/branchActions'
import { ConfirmDialog } from '../common'
import type { BranchNodeData } from '../../stores/chat/types'
import type { SwitchBranchWorkspaceMode } from '../../stores/chat/branchActions'
import { formatTime } from '../../utils/format'

const { t } = useI18n()
const chatStore = useChatStore()

const panelOpen = ref(false)
/** 两步删除确认：第一次点击进入待确认态，再次点击同一节点才真正删除 */
const pendingDeleteNodeId = ref<string | null>(null)
/** BCP-04：待确认「是否连工作区一起恢复」的节点 */
const pendingWorkspaceSwitchNodeId = ref<string | null>(null)
const showWorkspaceConfirm = ref(false)
/** 行内重命名编辑中的节点 ID */
const renamingNodeId = ref<string | null>(null)
const renameInput = ref('')

/** 入口显示条件：只有确实存在额外候选分支时才显示（线性图不显示入口） */
const triggerVisible = computed(() => {
  const graph = chatStore.branchGraph
  if (!chatStore.currentConversationId || !graph?.nodes) return false

  const childCountByParent = new Map<string, number>()
  for (const node of Object.values(graph.nodes)) {
    if (!node || node.parentId === null) continue
    const count = childCountByParent.get(node.parentId) ?? 0
    childCountByParent.set(node.parentId, count + 1)
  }
  return Array.from(childCountByParent.values()).some(count => count >= 2)
})

const activePathIds = computed(() => buildActivePathIds(chatStore.branchGraph))
const childrenIndex = computed(() => buildChildrenIndex(chatStore.branchGraph))

interface TreeRow {
  node: BranchNodeData
  depth: number
  /** 当前节点是否是父节点的最后一个子节点，决定连接线是否在本行中止 */
  isLastChild: boolean
  /** 更高层祖先是否还有后续兄弟，用于绘制连续的竖向导线 */
  ancestorHasNext: boolean[]
  /** 当前节点的非删除子候选数量；≥2 时是可切换分支点 */
  candidateCount: number
}

/** 从 root 沿 childrenIndex DFS 展平为带树形导线元数据的行 */
const rows = computed<TreeRow[]>(() => {
  const graph = chatStore.branchGraph
  const out: TreeRow[] = []
  if (!graph?.nodes || graph.rootNodeId === null) return out

  const walk = (
    nodeId: string,
    depth: number,
    ancestorHasNext: boolean[],
    isLastChild: boolean
  ): void => {
    const node = graph.nodes[nodeId]
    if (!node) return
    const children = childrenIndex.value.get(nodeId) ?? []
    const candidateCount = children.filter(child => !child.deleted).length
    out.push({ node, depth, isLastChild, ancestorHasNext, candidateCount })

    children.forEach((child, index) => {
      // 当前节点自身若不是父节点的最后子节点，子树之后仍需延续这一层导线。
      const childAncestorHasNext = depth === 0
        ? []
        : [...ancestorHasNext, !isLastChild]
      walk(child.id, depth + 1, childAncestorHasNext, index === children.length - 1)
    })
  }

  walk(graph.rootNodeId, 0, [], true)
  return out
})

function isActive(nodeId: string): boolean {
  return activePathIds.value.includes(nodeId)
}

function isCurrentTail(nodeId: string): boolean {
  return chatStore.branchGraph?.activeTailNodeId === nodeId
}

function isDeleted(node: BranchNodeData): boolean {
  return node.deleted === true
}

function isBranchPoint(row: TreeRow): boolean {
  return row.candidateCount >= 2
}

function preview(node: BranchNodeData): string {
  if (typeof node.label === 'string' && node.label.trim()) return node.label.trim()
  const text = (node.parts ?? [])
    .map(part => part.text ?? '')
    .join(' ')
    .trim()
  if (text) return text.slice(0, 60)
  return t('components.message.branch.noPreview')
}

function metaTitle(node: BranchNodeData): string {
  const meta: string[] = []
  if (typeof node.modelVersion === 'string' && node.modelVersion) meta.push(node.modelVersion)
  if (typeof node.kind === 'string' && node.kind) meta.push(node.kind)
  meta.push(node.role)
  return meta.join(' · ')
}

function nodeTime(node: BranchNodeData): string {
  if (typeof node.createdAt !== 'number') return ''
  return formatTime(node.createdAt, 'MM-DD HH:mm')
}

function openPanel(): void {
  panelOpen.value = true
  resetTransient()
}

function closePanel(): void {
  panelOpen.value = false
  resetTransient()
}

function resetTransient(): void {
  pendingDeleteNodeId.value = null
  renamingNodeId.value = null
  renameInput.value = ''
}

/** 行主区点击 = 切换候选（活跃节点 / 软删节点不可切换） */
function switchTo(nodeId: string): void {
  const node = chatStore.branchGraph?.nodes[nodeId]
  if (!node || isActive(nodeId) || isDeleted(node)) return
  pendingDeleteNodeId.value = null
  // BCP-04（决策 1）：目标分支执行过写工具 / 有工作区存档 → 先弹「仅切聊天 or 连工作区一起恢复」确认框
  if (needsWorkspaceConfirm(node)) {
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

function toggleDelete(nodeId: string): void {
  if (pendingDeleteNodeId.value === nodeId) {
    pendingDeleteNodeId.value = null
    void chatStore.deleteBranchCandidate(nodeId)
    return
  }
  pendingDeleteNodeId.value = nodeId
}

function restore(nodeId: string): void {
  void chatStore.restoreBranchCandidate(nodeId)
}

function startRename(node: BranchNodeData): void {
  renamingNodeId.value = node.id
  renameInput.value = typeof node.label === 'string' ? node.label : ''
}

function commitRename(): void {
  const nodeId = renamingNodeId.value
  if (!nodeId) return
  renamingNodeId.value = null
  void chatStore.renameBranchCandidate(nodeId, renameInput.value)
}

function cancelRename(): void {
  renamingNodeId.value = null
  renameInput.value = ''
}
</script>

<template>
  <div class="branch-tree-panel">
    <!-- 入口按钮：有分支图即显示（消息区顶部的全局分支树入口） -->
    <button
      v-if="triggerVisible"
      class="branch-tree-trigger"
      :title="t('components.message.branchTree.open')"
      @click="panelOpen ? closePanel() : openPanel()"
    >
      <i class="codicon codicon-git-branch"></i>
    </button>

    <!-- 独立浮层（fixed + 透明背板，点击背板关闭） -->
    <div v-if="panelOpen" class="branch-tree-overlay">
      <div class="branch-tree-backdrop" @click="closePanel"></div>
      <div class="branch-tree-panel-box">
        <div class="branch-tree-header">
          <span class="branch-tree-title">
            <i class="codicon codicon-git-branch"></i>
            {{ t('components.message.branchTree.title') }}
          </span>
          <span v-if="chatStore.isSwitchingBranch" class="branch-tree-busy">
            <i class="codicon codicon-loading codicon-modifier-spin"></i>
          </span>
          <button
            class="branch-tree-close"
            :title="t('components.message.branchTree.close')"
            @click="closePanel"
          >
            <i class="codicon codicon-close"></i>
          </button>
        </div>

        <div v-if="!chatStore.branchGraph || rows.length === 0" class="branch-tree-empty">
          {{ t('components.message.branchTree.empty') }}
        </div>

        <div v-else class="branch-tree-body">
          <div
            v-for="row in rows"
            :key="row.node.id"
            class="branch-tree-row"
            :class="{
              active: isActive(row.node.id),
              current: isCurrentTail(row.node.id),
              branchPoint: isBranchPoint(row),
              deleted: isDeleted(row.node),
              renaming: renamingNodeId === row.node.id
            }"
            :style="{ '--depth': row.depth }"
          >
            <!-- 树形导线：祖先层竖线 + 当前节点横向连接线，不再只靠 padding-left 伪装层级 -->
            <div class="branch-tree-guides" aria-hidden="true">
              <span
                v-for="(hasNext, index) in row.ancestorHasNext"
                :key="`ancestor-${index}`"
                class="branch-tree-guide"
                :class="{ continued: hasNext }"
              ></span>
              <span
                v-if="row.depth > 0"
                class="branch-tree-connector"
                :class="{ last: row.isLastChild }"
              ></span>
            </div>

            <!-- 行主区：点击切换（活跃 / 软删节点不响应） -->
            <div
              class="branch-tree-row-main"
              :title="metaTitle(row.node)"
              @click="switchTo(row.node.id)"
            >
              <i
                class="codicon branch-tree-node-icon"
                :class="
                  isBranchPoint(row)
                    ? 'codicon-git-branch'
                    : row.node.role === 'user'
                      ? 'codicon-account'
                      : row.node.role === 'system'
                        ? 'codicon-settings-gear'
                        : 'codicon-comment'
                "
              ></i>
              <span class="branch-tree-preview">{{ preview(row.node) }}</span>
              <span v-if="nodeTime(row.node)" class="branch-tree-time">{{ nodeTime(row.node) }}</span>
              <span v-if="isCurrentTail(row.node.id)" class="branch-tree-badge branch-tree-badge-active">
                {{ t('components.message.branch.active') }}
              </span>
              <span v-else-if="isBranchPoint(row)" class="branch-tree-badge branch-tree-badge-candidates">
                {{ t('components.message.branchTree.candidateCount', { count: row.candidateCount }) }}
              </span>
              <span v-if="isDeleted(row.node)" class="branch-tree-badge branch-tree-badge-deleted">
                {{ t('components.message.branchTree.deleted') }}
              </span>
            </div>

            <!-- 行操作 -->
            <div class="branch-tree-actions">
              <template v-if="renamingNodeId === row.node.id">
                <input
                  v-model="renameInput"
                  class="branch-tree-rename-input"
                  :placeholder="t('components.message.branchTree.renamePlaceholder')"
                  @keydown.enter.prevent="commitRename"
                  @keydown.esc="cancelRename"
                />
                <button
                  class="branch-tree-action"
                  :title="t('components.message.branchTree.save')"
                  :disabled="chatStore.isSwitchingBranch"
                  @click="commitRename"
                >
                  <i class="codicon codicon-check"></i>
                </button>
                <button
                  class="branch-tree-action"
                  :title="t('components.message.branchTree.cancel')"
                  @click="cancelRename"
                >
                  <i class="codicon codicon-close"></i>
                </button>
              </template>

              <template v-else>
                <!-- 软删节点：恢复入口 -->
                <button
                  v-if="isDeleted(row.node)"
                  class="branch-tree-action"
                  :title="t('components.message.branchTree.restore')"
                  :disabled="chatStore.isSwitchingBranch"
                  @click="restore(row.node.id)"
                >
                  <i class="codicon codicon-undo"></i>
                </button>

                <!-- 非软删节点：重命名（含活跃节点，仅改 label 不影响路径） -->
                <button
                  v-if="!isDeleted(row.node)"
                  class="branch-tree-action"
                  :title="t('components.message.branchTree.rename')"
                  :disabled="chatStore.isSwitchingBranch"
                  @click="startRename(row.node)"
                >
                  <i class="codicon codicon-edit"></i>
                </button>

                <!-- 非活跃、非软删节点：删除（两步确认防误删） -->
                <button
                  v-if="!isActive(row.node.id) && !isDeleted(row.node)"
                  class="branch-tree-action"
                  :class="{ confirming: pendingDeleteNodeId === row.node.id }"
                  :title="
                    pendingDeleteNodeId === row.node.id
                      ? t('components.message.branch.deleteConfirm')
                      : t('components.message.branch.delete')
                  "
                  :disabled="chatStore.isSwitchingBranch"
                  @click="toggleDelete(row.node.id)"
                >
                  <i
                    class="codicon"
                    :class="pendingDeleteNodeId === row.node.id ? 'codicon-check' : 'codicon-trash'"
                  ></i>
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
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
  </div>
</template>

<style scoped>
/* 样式沿用 BranchSwitcherBar / 检查点条的 VS Code 主题 token（GrayCode 面板风格） */
.branch-tree-panel {
  flex-shrink: 0;
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

.branch-tree-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.branch-tree-trigger:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.branch-tree-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
}

.branch-tree-backdrop {
  position: absolute;
  inset: 0;
  background: transparent;
}

.branch-tree-panel-box {
  position: absolute;
  top: auto;
  right: auto;
  bottom: 72px;
  left: 12px;
  width: min(560px, calc(100vw - 24px));
  max-height: min(70vh, 560px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  background: var(--vscode-editor-background);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  user-select: none;
}

.branch-tree-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.branch-tree-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.branch-tree-busy {
  display: flex;
  align-items: center;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.branch-tree-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm, 2px);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.branch-tree-close:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.branch-tree-body {
  overflow: auto;
  padding: 4px 0;
}

.branch-tree-empty {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
}

.branch-tree-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: stretch;
  min-height: 34px;
  padding: 0 8px 0 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
}

.branch-tree-row:last-child {
  border-bottom: none;
}

/* 祖先层导线：每一格代表一层，只有仍有后续兄弟时才延续竖线 */
.branch-tree-guides {
  display: flex;
  align-self: stretch;
  flex-shrink: 0;
}

.branch-tree-guides:empty {
  width: 4px;
}

.branch-tree-guide,
.branch-tree-connector {
  position: relative;
  display: block;
  width: 18px;
  min-width: 18px;
}

.branch-tree-guide.continued::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  border-left: 1px solid var(--vscode-panel-border);
}

.branch-tree-connector::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  border-left: 1px solid var(--vscode-panel-border);
}

.branch-tree-connector.last::before {
  bottom: 50%;
}

.branch-tree-connector::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 50%;
  border-top: 1px solid var(--vscode-panel-border);
}

.branch-tree-row.active .branch-tree-guide.continued::before,
.branch-tree-row.active .branch-tree-connector::before,
.branch-tree-row.active .branch-tree-connector::after {
  border-color: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 72%, var(--vscode-panel-border));
}

.branch-tree-row.current {
  background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 12%, transparent);
  box-shadow: inset 2px 0 0 var(--vscode-charts-blue, #3794ff);
}

.branch-tree-row.deleted {
  opacity: 0.55;
}

.branch-tree-row-main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 4px;
  border-radius: var(--radius-sm, 2px);
  cursor: default;
}

.branch-tree-row:not(.active):not(.deleted) .branch-tree-row-main {
  cursor: pointer;
}

.branch-tree-row:not(.active):not(.deleted) .branch-tree-row-main:hover {
  background: var(--vscode-list-hoverBackground);
}

.branch-tree-node-icon {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
}

.branch-tree-row.active .branch-tree-node-icon,
.branch-tree-row.branchPoint .branch-tree-node-icon {
  color: var(--vscode-charts-blue, #3794ff);
}

.branch-tree-preview {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--vscode-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.branch-tree-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

.branch-tree-badge {
  flex-shrink: 0;
  font-size: 10px;
  border-radius: var(--radius-sm, 2px);
  padding: 0 4px;
}

.branch-tree-badge-active {
  color: var(--vscode-charts-blue, #3794ff);
  border: 1px solid var(--vscode-charts-blue, #3794ff);
}

.branch-tree-badge-candidates {
  color: var(--vscode-charts-orange, #e69500);
  border: 1px solid color-mix(in srgb, var(--vscode-charts-orange, #e69500) 70%, transparent);
}

.branch-tree-badge-deleted {
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
}

.branch-tree-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.branch-tree-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm, 2px);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.branch-tree-action:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.branch-tree-action.confirming {
  color: var(--vscode-testing-iconFailed, #f14c4c);
  background: var(--vscode-inputValidation-errorBackground, rgba(241, 76, 76, 0.12));
}

.branch-tree-action:disabled {
  opacity: 0.5;
  cursor: default;
}

.branch-tree-rename-input {
  width: 120px;
  font-size: 11px;
  padding: 2px 6px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm, 2px);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  outline: none;
}

.branch-tree-rename-input:focus {
  border-color: var(--vscode-focusBorder, #3794ff);
}
</style>
