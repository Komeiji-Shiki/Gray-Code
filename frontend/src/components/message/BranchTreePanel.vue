<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatStore } from '../../stores/chatStore'
import { useI18n } from '../../i18n'
import { needsWorkspaceConfirm } from '../../stores/chat/branchActions'
import { ConfirmDialog } from '../common'
import type { BranchNodeData } from '../../stores/chat/types'
import type { SwitchBranchWorkspaceMode } from '../../stores/chat/branchActions'
import { formatTime } from '../../utils/format'
import {
  buildNavigationBranchRows,
  buildTrackGraphRows,
  type BranchTreeViewMode
} from './branchTreeLayout'

const { t } = useI18n()
const chatStore = useChatStore()

const panelOpen = ref(false)
const viewMode = ref<BranchTreeViewMode>('navigation')
/** 完整消息图是否展开全部节点（默认折叠连续线性段） */
const expandAll = ref(false)
const pendingDeleteNodeId = ref<string | null>(null)
const pendingWorkspaceSwitchNodeId = ref<string | null>(null)
const showWorkspaceConfirm = ref(false)
const renamingNodeId = ref<string | null>(null)
const renameInput = ref('')

const triggerVisible = computed(() => {
  const graph = chatStore.branchGraph
  if (!chatStore.currentConversationId || !graph?.nodes) return false

  const childCountByParent = new Map<string, number>()
  for (const node of Object.values(graph.nodes)) {
    if (!node || node.parentId === null) continue
    childCountByParent.set(node.parentId, (childCountByParent.get(node.parentId) ?? 0) + 1)
  }
  return Array.from(childCountByParent.values()).some(count => count >= 2)
})

/** 分支导航（缩略版）：折叠连续线性消息，只保留分支管理相关节点 */
const navRows = computed(() => buildNavigationBranchRows(chatStore.branchGraph))
/** 完整消息图（高级模式）：轨道式泳道布局，轨道数由同时存在的候选分支决定 */
const trackGraph = computed(() => buildTrackGraphRows(chatStore.branchGraph, expandAll.value))
const nodeCount = computed(() => Object.keys(chatStore.branchGraph?.nodes ?? {}).length)

function preview(node: BranchNodeData): string {
  if (typeof node.label === 'string' && node.label.trim()) return node.label.trim()
  const text = (node.parts ?? [])
    .map(part => part.text ?? (part.functionCall?.name ? `${t('components.message.roles.tool')}: ${part.functionCall.name}` : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, 80) : t('components.message.branch.noPreview')
}

function roleLabel(node: BranchNodeData): string {
  if (node.role === 'user') return t('components.message.roles.user')
  if (node.role === 'system') return t('components.message.branchTree.system')
  return t('components.message.roles.assistant')
}

function metaTitle(node: BranchNodeData): string {
  const meta = [roleLabel(node)]
  if (node.modelVersion) meta.push(node.modelVersion)
  if (node.kind) meta.push(node.kind)
  if (node.createdAt) meta.push(formatTime(node.createdAt, 'YYYY-MM-DD HH:mm:ss'))
  return meta.join(' · ')
}

function nodeTime(node: BranchNodeData): string {
  return typeof node.createdAt === 'number' && node.createdAt > 0
    ? formatTime(node.createdAt, 'HH:mm')
    : ''
}

function nodeIcon(row: { candidateCount: number; node: BranchNodeData }): string {
  if (row.candidateCount >= 2) return 'codicon-git-branch'
  if (row.node.role === 'user') return 'codicon-account'
  if (row.node.role === 'system') return 'codicon-settings-gear'
  return 'codicon-comment'
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

function setViewMode(mode: BranchTreeViewMode): void {
  viewMode.value = mode
  expandAll.value = false
  resetTransient()
}

function switchTo(row: { id: string; node: BranchNodeData; active: boolean }): void {
  const node = row.node
  if (row.active || node.deleted) return
  pendingDeleteNodeId.value = null
  if (needsWorkspaceConfirm(node)) {
    pendingWorkspaceSwitchNodeId.value = node.id
    showWorkspaceConfirm.value = true
    return
  }
  void chatStore.switchBranchCandidate(node.id)
}

function confirmSwitchMode(mode: SwitchBranchWorkspaceMode): void {
  const nodeId = pendingWorkspaceSwitchNodeId.value
  pendingWorkspaceSwitchNodeId.value = null
  showWorkspaceConfirm.value = false
  if (nodeId) void chatStore.switchBranchCandidate(nodeId, { mode })
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
  renameInput.value = node.label ?? ''
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
    <button
      v-if="triggerVisible"
      class="branch-tree-trigger"
      :title="t('components.message.branchTree.open')"
      @click="panelOpen ? closePanel() : openPanel()"
    >
      <i class="codicon codicon-git-branch"></i>
    </button>

    <div v-if="panelOpen" class="branch-tree-overlay">
      <div class="branch-tree-backdrop" @click="closePanel"></div>
      <section class="branch-tree-panel-box" role="dialog" :aria-label="t('components.message.branchTree.title')">
        <header class="branch-tree-header">
          <span class="branch-tree-title">
            <i class="codicon codicon-git-branch"></i>
            {{ t('components.message.branchTree.title') }}
            <span class="branch-tree-node-count">{{ t('components.message.branchTree.nodeCount', { count: nodeCount }) }}</span>
          </span>
          <span v-if="chatStore.isSwitchingBranch" class="branch-tree-busy">
            <i class="codicon codicon-loading codicon-modifier-spin"></i>
          </span>
          <button class="branch-tree-close" :title="t('components.message.branchTree.close')" @click="closePanel">
            <i class="codicon codicon-close"></i>
          </button>
        </header>

        <div class="branch-tree-view-tabs" role="tablist">
          <button
            class="branch-tree-view-tab"
            :class="{ selected: viewMode === 'navigation' }"
            role="tab"
            :aria-selected="viewMode === 'navigation'"
            @click="setViewMode('navigation')"
          >
            <i class="codicon codicon-list-tree"></i>
            {{ t('components.message.branchTree.navigationMode') }}
          </button>
          <button
            class="branch-tree-view-tab"
            :class="{ selected: viewMode === 'full' }"
            role="tab"
            :aria-selected="viewMode === 'full'"
            @click="setViewMode('full')"
          >
            <i class="codicon codicon-list-flat"></i>
            {{ t('components.message.branchTree.fullMode') }}
          </button>
          <span class="branch-tree-view-hint">
            {{ t(`components.message.branchTree.${viewMode === 'navigation' ? 'navigationHint' : 'fullHint'}`) }}
          </span>
          <button
            v-if="viewMode === 'full'"
            class="branch-tree-expand-toggle"
            :title="t(expandAll ? 'components.message.branchTree.collapseLinearMessages' : 'components.message.branchTree.expandAllMessages')"
            @click="expandAll = !expandAll"
          >
            <i class="codicon" :class="expandAll ? 'codicon-collapse-all' : 'codicon-expand-all'"></i>
            {{ t(expandAll ? 'components.message.branchTree.collapseLinearMessages' : 'components.message.branchTree.expandAllMessages') }}
          </button>
        </div>

        <div
          v-if="!chatStore.branchGraph || (viewMode === 'navigation' ? navRows.length === 0 : trackGraph.rows.length === 0)"
          class="branch-tree-empty"
        >
          {{ t('components.message.branchTree.empty') }}
        </div>

        <div v-else class="branch-tree-body" :class="`mode-${viewMode}`">
          <template v-if="viewMode === 'navigation'">
            <template v-for="row in navRows" :key="row.id">
              <div
                v-if="row.type === 'collapsed'"
                class="branch-tree-collapsed-row"
                :class="{ active: row.active }"
                :style="{ '--lane': row.lane }"
              >
                <span class="branch-tree-rail"></span>
                <span class="branch-tree-collapsed-dot">•••</span>
                <span>{{ t('components.message.branchTree.collapsedMessages', { count: row.count }) }}</span>
              </div>

              <div
                v-else
                class="branch-tree-row"
                :class="{
                  active: row.active,
                  current: row.current,
                  branchPoint: row.candidateCount >= 2,
                  candidateRoot: row.isCandidateRoot,
                  deleted: row.node.deleted,
                  renaming: renamingNodeId === row.node.id
                }"
                :style="{ '--lane': row.lane }"
              >
                <span class="branch-tree-rail" aria-hidden="true"></span>
                <span class="branch-tree-node-marker" aria-hidden="true">
                  <i class="codicon" :class="nodeIcon(row)"></i>
                </span>

                <div class="branch-tree-row-content">
                  <div
                    class="branch-tree-row-main"
                    :title="metaTitle(row.node)"
                    @click="switchTo(row)"
                  >
                    <span class="branch-tree-role">{{ roleLabel(row.node) }}</span>
                    <span class="branch-tree-preview">{{ preview(row.node) }}</span>
                    <span v-if="nodeTime(row.node)" class="branch-tree-time">{{ nodeTime(row.node) }}</span>
                    <span v-if="row.current" class="branch-tree-badge branch-tree-badge-active">
                      {{ t('components.message.branch.active') }}
                    </span>
                    <span v-else-if="row.candidateCount >= 2" class="branch-tree-badge branch-tree-badge-candidates">
                      {{ t('components.message.branchTree.candidateCount', { count: row.candidateCount }) }}
                    </span>
                    <span v-if="row.node.deleted" class="branch-tree-badge branch-tree-badge-deleted">
                      {{ t('components.message.branchTree.deleted') }}
                    </span>
                  </div>

                  <div class="branch-tree-actions">
                    <template v-if="renamingNodeId === row.node.id">
                      <input
                        v-model="renameInput"
                        class="branch-tree-rename-input"
                        :placeholder="t('components.message.branchTree.renamePlaceholder')"
                        @keydown.enter.prevent="commitRename"
                        @keydown.esc="cancelRename"
                      />
                      <button class="branch-tree-action" :title="t('components.message.branchTree.save')" :disabled="chatStore.isSwitchingBranch" @click="commitRename">
                        <i class="codicon codicon-check"></i>
                      </button>
                      <button class="branch-tree-action" :title="t('components.message.branchTree.cancel')" @click="cancelRename">
                        <i class="codicon codicon-close"></i>
                      </button>
                    </template>
                    <template v-else>
                      <button
                        v-if="row.node.deleted"
                        class="branch-tree-action"
                        :title="t('components.message.branchTree.restore')"
                        :disabled="chatStore.isSwitchingBranch"
                        @click="restore(row.node.id)"
                      >
                        <i class="codicon codicon-undo"></i>
                      </button>
                      <button
                        v-if="!row.node.deleted"
                        class="branch-tree-action"
                        :title="t('components.message.branchTree.rename')"
                        :disabled="chatStore.isSwitchingBranch"
                        @click="startRename(row.node)"
                      >
                        <i class="codicon codicon-edit"></i>
                      </button>
                      <button
                        v-if="!row.active && !row.node.deleted"
                        class="branch-tree-action"
                        :class="{ confirming: pendingDeleteNodeId === row.node.id }"
                        :title="pendingDeleteNodeId === row.node.id ? t('components.message.branch.deleteConfirm') : t('components.message.branch.delete')"
                        :disabled="chatStore.isSwitchingBranch"
                        @click="toggleDelete(row.node.id)"
                      >
                        <i class="codicon" :class="pendingDeleteNodeId === row.node.id ? 'codicon-check' : 'codicon-trash'"></i>
                      </button>
                    </template>
                  </div>
                </div>
              </div>
            </template>
          </template>

          <template v-else>
            <template v-for="row in trackGraph.rows" :key="row.id">
              <div
                v-if="row.kind === 'collapsed'"
                class="branch-track-row branch-track-row-collapsed"
                :class="{ active: row.active }"
              >
                <div class="branch-track-graph" :style="{ '--track-count': trackGraph.laneCount }">
                  <div class="branch-track-cell" :style="{ '--lane': row.lane }">
                    <span class="branch-track-collapsed-dot">•••</span>
                  </div>
                  <div
                    v-for="line in row.lines"
                    :key="`line-${line.lane}`"
                    class="branch-track-cell"
                    :style="{ '--lane': line.lane }"
                  >
                    <span class="branch-track-line" :class="{ active: line.active }">
                      <i v-if="line.vline" class="branch-track-line-v"></i>
                      <i v-if="line.left" class="branch-track-line-h left"></i>
                      <i v-if="line.right" class="branch-track-line-h right"></i>
                    </span>
                  </div>
                </div>
                <div class="branch-track-info">
                  {{ t('components.message.branchTree.collapsedMessages', { count: row.count }) }}
                </div>
              </div>

              <div
                v-else
                class="branch-track-row"
                :class="{
                  active: row.active,
                  current: row.current,
                  deleted: row.node.deleted,
                  renaming: renamingNodeId === row.node.id
                }"
              >
                <div class="branch-track-graph" :style="{ '--track-count': trackGraph.laneCount }">
                  <div class="branch-track-cell" :style="{ '--lane': row.lane }">
                    <span class="branch-tree-node-marker" :class="{ branchPoint: row.candidateCount >= 2 }">
                      <i class="codicon" :class="nodeIcon(row)"></i>
                    </span>
                  </div>
                  <div
                    v-for="line in row.lines"
                    :key="`line-${line.lane}`"
                    class="branch-track-cell"
                    :style="{ '--lane': line.lane }"
                  >
                    <span class="branch-track-line" :class="{ active: line.active }">
                      <i v-if="line.vline" class="branch-track-line-v"></i>
                      <i v-if="line.left" class="branch-track-line-h left"></i>
                      <i v-if="line.right" class="branch-track-line-h right"></i>
                    </span>
                  </div>
                </div>

                <div class="branch-tree-row-content">
                  <div
                    class="branch-tree-row-main"
                    :title="metaTitle(row.node)"
                    @click="switchTo(row)"
                  >
                    <span class="branch-tree-role">{{ roleLabel(row.node) }}</span>
                    <span class="branch-tree-preview">{{ preview(row.node) }}</span>
                    <span v-if="nodeTime(row.node)" class="branch-tree-time">{{ nodeTime(row.node) }}</span>
                    <span v-if="row.current" class="branch-tree-badge branch-tree-badge-active">
                      {{ t('components.message.branch.active') }}
                    </span>
                    <span v-else-if="row.candidateCount >= 2" class="branch-tree-badge branch-tree-badge-candidates">
                      {{ t('components.message.branchTree.candidateCount', { count: row.candidateCount }) }}
                    </span>
                    <span v-if="row.node.deleted" class="branch-tree-badge branch-tree-badge-deleted">
                      {{ t('components.message.branchTree.deleted') }}
                    </span>
                  </div>

                  <div class="branch-tree-actions">
                    <template v-if="renamingNodeId === row.node.id">
                      <input
                        v-model="renameInput"
                        class="branch-tree-rename-input"
                        :placeholder="t('components.message.branchTree.renamePlaceholder')"
                        @keydown.enter.prevent="commitRename"
                        @keydown.esc="cancelRename"
                      />
                      <button class="branch-tree-action" :title="t('components.message.branchTree.save')" :disabled="chatStore.isSwitchingBranch" @click="commitRename">
                        <i class="codicon codicon-check"></i>
                      </button>
                      <button class="branch-tree-action" :title="t('components.message.branchTree.cancel')" @click="cancelRename">
                        <i class="codicon codicon-close"></i>
                      </button>
                    </template>
                    <template v-else>
                      <button
                        v-if="row.node.deleted"
                        class="branch-tree-action"
                        :title="t('components.message.branchTree.restore')"
                        :disabled="chatStore.isSwitchingBranch"
                        @click="restore(row.node.id)"
                      >
                        <i class="codicon codicon-undo"></i>
                      </button>
                      <button
                        v-if="!row.node.deleted"
                        class="branch-tree-action"
                        :title="t('components.message.branchTree.rename')"
                        :disabled="chatStore.isSwitchingBranch"
                        @click="startRename(row.node)"
                      >
                        <i class="codicon codicon-edit"></i>
                      </button>
                      <button
                        v-if="!row.active && !row.node.deleted"
                        class="branch-tree-action"
                        :class="{ confirming: pendingDeleteNodeId === row.node.id }"
                        :title="pendingDeleteNodeId === row.node.id ? t('components.message.branch.deleteConfirm') : t('components.message.branch.delete')"
                        :disabled="chatStore.isSwitchingBranch"
                        @click="toggleDelete(row.node.id)"
                      >
                        <i class="codicon" :class="pendingDeleteNodeId === row.node.id ? 'codicon-check' : 'codicon-trash'"></i>
                      </button>
                    </template>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </div>
      </section>
    </div>

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
.branch-tree-panel { flex-shrink: 0; }
.branch-tree-trigger,
.branch-tree-close,
.branch-tree-action,
.branch-tree-view-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
}
.branch-tree-trigger {
  width: 24px;
  height: 24px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
}
.branch-tree-trigger:hover,
.branch-tree-close:hover,
.branch-tree-action:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground);
}
.branch-tree-overlay { position: fixed; inset: 0; z-index: 100; }
.branch-tree-backdrop { position: absolute; inset: 0; background: transparent; }
.branch-tree-panel-box {
  position: absolute;
  bottom: 72px;
  left: 12px;
  width: min(680px, calc(100vw - 24px));
  max-height: min(76vh, 680px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editor-background);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.38);
  user-select: none;
}
.branch-tree-header {
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.branch-tree-title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; }
.branch-tree-node-count { color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 400; }
.branch-tree-busy { color: var(--vscode-descriptionForeground); }
.branch-tree-close { width: 24px; height: 24px; border-radius: 3px; }
.branch-tree-view-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-sideBar-background) 45%, transparent);
}
.branch-tree-view-tab { gap: 5px; height: 25px; padding: 0 9px; border-radius: 4px; font-size: 11px; }
.branch-tree-view-tab:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
.branch-tree-view-tab.selected { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.branch-tree-view-hint { min-width: 0; margin-left: 6px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.branch-tree-body { overflow: auto; padding: 6px 8px 10px; }
.branch-tree-empty { padding: 22px 12px; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center; }
.branch-tree-row,
.branch-tree-collapsed-row {
  --lane-size: 22px;
  position: relative;
  margin-left: calc(var(--lane) * var(--lane-size));
  padding-left: 24px;
}
.branch-tree-row { min-height: 36px; display: flex; align-items: stretch; }
.branch-tree-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 10px;
  width: 1px;
  background: var(--vscode-panel-border);
}
.branch-tree-node-marker {
  position: absolute;
  z-index: 1;
  top: 8px;
  left: 1px;
  width: 19px;
  height: 19px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 50%;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  font-size: 11px;
}
.branch-tree-row.candidateRoot::before {
  content: '';
  position: absolute;
  top: 17px;
  right: calc(100% - 2px);
  width: calc(var(--lane-size) - 7px);
  border-top: 1px solid var(--vscode-panel-border);
}
.branch-tree-row.branchPoint .branch-tree-node-marker { border-radius: 4px; color: var(--vscode-charts-orange, #e69500); }
.branch-tree-row.current .branch-tree-node-marker { color: #fff; border-color: var(--vscode-charts-blue, #3794ff); background: var(--vscode-charts-blue, #3794ff); }
.branch-tree-row-content { min-width: 0; flex: 1; display: flex; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 62%, transparent); }
.branch-tree-row-main { min-width: 0; flex: 1; display: flex; align-items: center; gap: 7px; padding: 7px 6px; border-radius: 4px; }
.branch-tree-row:not(.active):not(.deleted) .branch-tree-row-main { cursor: pointer; }
.branch-tree-row:not(.active):not(.deleted) .branch-tree-row-main:hover { background: var(--vscode-list-hoverBackground); }
.branch-tree-row.current .branch-tree-row-content { background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 9%, transparent); }
.branch-tree-row.deleted { opacity: 0.55; }
.branch-tree-role { flex-shrink: 0; min-width: 30px; color: var(--vscode-descriptionForeground); font-size: 10px; }
.branch-tree-preview { min-width: 0; flex: 1; overflow: hidden; color: var(--vscode-foreground); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.branch-tree-time { flex-shrink: 0; color: var(--vscode-descriptionForeground); font-size: 10px; }
.branch-tree-badge { flex-shrink: 0; padding: 0 4px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; font-size: 10px; }
.branch-tree-badge-active { color: var(--vscode-charts-blue, #3794ff); border-color: var(--vscode-charts-blue, #3794ff); }
.branch-tree-badge-candidates { color: var(--vscode-charts-orange, #e69500); border-color: color-mix(in srgb, var(--vscode-charts-orange, #e69500) 70%, transparent); }
.branch-tree-badge-deleted { color: var(--vscode-descriptionForeground); }
.branch-tree-actions { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity 0.12s; }
.branch-tree-row:hover .branch-tree-actions,
.branch-tree-row.renaming .branch-tree-actions,
.branch-tree-action.confirming { opacity: 1; }
.branch-tree-action { width: 23px; height: 23px; border-radius: 3px; }
.branch-tree-action.confirming { color: var(--vscode-testing-iconFailed, #f14c4c); background: var(--vscode-inputValidation-errorBackground, rgba(241, 76, 76, 0.12)); }
.branch-tree-action:disabled { opacity: 0.45; cursor: default; }
.branch-tree-rename-input { width: 140px; padding: 3px 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; outline: none; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font-size: 11px; }
.branch-tree-rename-input:focus { border-color: var(--vscode-focusBorder, #3794ff); }
.branch-tree-collapsed-row { height: 27px; display: flex; align-items: center; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 10px; }
.branch-tree-collapsed-dot { position: relative; z-index: 1; margin-left: -3px; padding: 0 3px; letter-spacing: 1px; background: var(--vscode-editor-background); }
.branch-tree-collapsed-row.active .branch-tree-rail { background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 45%, var(--vscode-panel-border)); }
.mode-navigation .branch-tree-row { min-height: 40px; }
.branch-tree-expand-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding: 0 9px;
  margin-left: auto;
  border: none;
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
  font-size: 11px;
}
.branch-tree-expand-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
/* ===== 轨道式完整消息图（高级模式） ===== */
.branch-track-row { min-height: 36px; display: flex; align-items: stretch; }
.branch-track-row-collapsed { min-height: 27px; align-items: center; }
.branch-track-graph {
  --track-size: 22px;
  position: relative;
  flex-shrink: 0;
  display: grid;
  grid-template-columns: repeat(var(--track-count), var(--track-size));
}
.branch-track-cell { position: relative; grid-column: calc(var(--lane) + 1); }
.branch-track-line { position: absolute; inset: 0; pointer-events: none; }
.branch-track-line-v,
.branch-track-line-h { position: absolute; border-color: var(--vscode-panel-border); }
.branch-track-line-v { left: 50%; top: 0; bottom: 0; border-left: 1px solid; }
.branch-track-line-h { top: 50%; height: 0; border-top: 1px solid; }
.branch-track-line-h.left { left: 0; right: 50%; }
.branch-track-line-h.right { left: 50%; right: 0; }
.branch-track-line.active .branch-track-line-v,
.branch-track-line.active .branch-track-line-h {
  border-color: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 55%, var(--vscode-panel-border));
}
.branch-track-collapsed-dot {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 0 2px;
  letter-spacing: 1px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  font-size: 10px;
}
.branch-track-info {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 6px;
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 62%, transparent);
}
.branch-track-row.current .branch-tree-row-content { background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 9%, transparent); }
.branch-track-row.deleted { opacity: 0.55; }
.branch-track-row:not(.active):not(.deleted) .branch-tree-row-main { cursor: pointer; }
.branch-track-row:not(.active):not(.deleted) .branch-tree-row-main:hover { background: var(--vscode-list-hoverBackground); }
.branch-track-row:hover .branch-tree-actions,
.branch-track-row.renaming .branch-tree-actions,
.branch-tree-action.confirming { opacity: 1; }
.workspace-confirm-secondary { width: 100%; margin-top: 10px; padding: 6px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, 0.15)); cursor: pointer; }
.workspace-confirm-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127, 127, 127, 0.25)); }
@media (max-width: 520px) {
  .branch-tree-panel-box { left: 6px; width: calc(100vw - 12px); }
  .branch-tree-view-hint { display: none; }
  .branch-tree-row,
  .branch-tree-collapsed-row { --lane-size: 16px; }
  .branch-track-graph { --track-size: 16px; }
  .branch-tree-role { display: none; }
}
</style>
