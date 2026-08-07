<script setup lang="ts">
/**
 * WorkspaceSelector - 工作区选择器（多工作区支持）
 *
 * 顶部栏常驻操作区中的紧凑下拉：
 *  - 默认跟随活动编辑器（auto）
 *  - 可选固定到某个打开的工作区文件夹
 *  - 收藏工作区列表（持久化）：点击快速打开，条目上的 × 可移除收藏
 *  - 底部「打开工作区文件夹…」入口（加号图标）：弹窗选择并自动加入收藏
 */

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import type { WorkspaceFolderInfo } from '../../stores/chat/types'

const { t } = useI18n()
const chatStore = useChatStore()

const isOpen = ref(false)
const triggerRef = ref<HTMLElement>()
const menuPosition = ref({ left: '0px', top: '0px' })

/** 无工作区打开时仅禁用固定操作，菜单仍可打开（提供「打开工作区文件夹」入口） */
const isEmpty = computed(() => chatStore.workspaceList.length === 0)

/**
 * Windows 路径大小写不敏感：同一目录以不同大小写路径打开/收藏时 URI 字符串
 * 可能漂移，比较时统一小写归一（与扩展端 WorkspaceManager 的匹配口径一致）。
 */
function sameUri(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** 当前选中值：空字符串 = auto（跟随活动编辑器） */
const selectedValue = computed<string>(() => {
  return chatStore.currentWorkspaceUri ?? ''
})

/** 解析绑定工作区：优先打开列表，其次收藏列表，找不到时按 URI 生成占位信息 */
const boundWorkspace = computed<WorkspaceFolderInfo | null>(() => {
  const current = chatStore.currentWorkspaceUri
  if (!current) return null
  return (
    chatStore.workspaceList.find(ws => sameUri(ws.uri, current)) ??
    chatStore.savedWorkspaces.find(ws => sameUri(ws.uri, current)) ??
    null
  )
})

/** 从 URI 反解目录名（绑定工作区已关闭且不在收藏时兜底展示） */
function workspaceNameFromUri(uri: string): string {
  try {
    const u = new URL(uri)
    if (u.protocol === 'file:') {
      const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean)
      if (parts.length > 0) return parts[parts.length - 1] ?? uri
    }
  } catch {
    // fallthrough
  }
  return uri
}

/** 当前固定选中的工作区（含绑定但未打开的场景，用于标题/菜单展示） */
const selectedWorkspace = computed(() => {
  const current = chatStore.currentWorkspaceUri
  if (!current) return null
  const resolved = boundWorkspace.value
  if (resolved) return resolved
  return {
    name: workspaceNameFromUri(current),
    uri: current,
    fsPath: current,
    index: -1
  } as WorkspaceFolderInfo
})

/** 绑定工作区已不在当前打开列表（桌面版打开新文件夹会替换旧文件夹） */
const boundWorkspaceClosed = computed(() => {
  const current = chatStore.currentWorkspaceUri
  if (!current) return false
  return !chatStore.workspaceList.some(ws => sameUri(ws.uri, current))
})

/** 触发按钮显示的文本 */
const displayLabel = computed(() => {
  if (selectedWorkspace.value) return selectedWorkspace.value.name
  if (isEmpty.value) return t('components.tabs.workspaceSelector.noWorkspace')
  return t('components.tabs.workspaceSelector.auto')
})

/** 触发按钮 tooltip（显示完整路径） */
const displayTooltip = computed(() => {
  if (selectedWorkspace.value) return selectedWorkspace.value.fsPath
  if (isEmpty.value) return t('components.tabs.workspaceSelector.noWorkspace')
  return t('components.tabs.workspaceSelector.auto')
})

/** 已打开的工作区 URI 集合（大小写不敏感归一，收藏条目据此区分展示/点击行为） */
const openUriSet = computed(() => {
  const norm = (u: string) => u.toLowerCase()
  return new Set(chatStore.workspaceList.map(ws => norm(ws.uri)))
})

/** 收藏工作区：完整展示全部收藏（含已打开条目，标注状态而非过滤掉，避免收藏「缺失」的观感） */
const savedWorkspaces = computed(() => {
  return chatStore.savedWorkspaces.map(ws => ({
    ...ws,
    isOpen: openUriSet.value.has(ws.uri.toLowerCase())
  }))
})

function updatePosition() {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  menuPosition.value = {
    left: `${Math.max(8, rect.right - 260)}px`,
    top: `${rect.bottom + 4}px`
  }
}

function toggleMenu() {
  if (isOpen.value) {
    closeMenu()
  } else {
    updatePosition()
    isOpen.value = true
  }
}

function closeMenu() {
  isOpen.value = false
}

function handleOutsideClick(event: MouseEvent) {
  if (!isOpen.value) return
  const target = event.target as Node
  if (triggerRef.value?.contains(target)) return
  if (!(event.target as HTMLElement).closest('.ws-menu')) {
    closeMenu()
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isOpen.value) {
    closeMenu()
  }
}

function selectAuto() {
  void chatStore.setActiveWorkspace(null)
  closeMenu()
}

function selectWorkspace(uri: string) {
  void chatStore.setActiveWorkspace(uri)
  closeMenu()
}

function onRemoveSaved(fsPath: string, event: MouseEvent) {
  event.stopPropagation()
  void chatStore.removeSavedWorkspace(fsPath)
}

function onOpenSaved(entry: WorkspaceFolderInfo) {
  void chatStore.openSavedWorkspace(entry)
  closeMenu()
}

function onOpenWorkspaceFolder() {
  closeMenu()
  void chatStore.openWorkspaceFolder()
}

/** 保存当前工作区到收藏（显式「保存工作区」入口） */
function onSaveCurrentWorkspace() {
  closeMenu()
  void chatStore.saveCurrentWorkspace()
}

/** 当前激活的工作区是否已在收藏中（避免重复保存） */
const isCurrentSaved = computed(() => {
  const current = chatStore.currentWorkspaceUri
  if (!current) return false
  const norm = (p: string) => (p || '').replace(/\\/g, '/').toLowerCase()
  const currentFs = chatStore.workspaceList.find(ws => ws.uri === current)?.fsPath
  return currentFs
    ? chatStore.savedWorkspaces.some(ws => norm(ws.fsPath) === norm(currentFs))
    : false
})

onMounted(() => {
  document.addEventListener('click', handleOutsideClick)
  document.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', updatePosition)
})

onUnmounted(() => {
  document.removeEventListener('click', handleOutsideClick)
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', updatePosition)
})
</script>

<template>
  <span
    ref="triggerRef"
    class="ws-selector"
    role="button"
    tabindex="0"
    :class="{ 'menu-open': isOpen }"
    :title="displayTooltip"
    @click="toggleMenu"
    @keydown.enter.prevent="toggleMenu"
    @keydown.space.prevent="toggleMenu"
  >
    <i class="codicon codicon-folder"></i>
    <span class="ws-label">{{ displayLabel }}</span>
    <i class="codicon codicon-chevron-down ws-caret"></i>
  </span>

  <Teleport to="body">
    <Transition name="ws-dropdown">
      <div
        v-if="isOpen"
        class="ws-menu"
        :style="menuPosition"
        @click.stop
      >
        <div
          class="ws-menu-item"
          :class="{ active: !selectedValue }"
          @click="selectAuto"
        >
          <i
            v-if="!selectedValue"
            class="codicon codicon-check ws-item-check"
          ></i>
          <span class="ws-item-label">{{ t('components.tabs.workspaceSelector.auto') }}</span>
        </div>

        <template v-if="chatStore.workspaceList.length > 0 || boundWorkspaceClosed">
          <div class="ws-menu-header">
            {{ t('components.tabs.workspaceSelector.openWorkspaces') }}
          </div>
          <div
            v-if="boundWorkspaceClosed"
            class="ws-menu-item ws-locked-item"
            :class="{ active: !!selectedValue }"
            :title="selectedWorkspace?.fsPath"
          >
            <i class="codicon codicon-lock ws-item-check"></i>
            <span class="ws-item-label">{{ selectedWorkspace?.name }}</span>
            <span class="ws-item-open-tag ws-locked-tag">
              {{ t('components.tabs.workspaceSelector.notOpen') }}
            </span>
          </div>
          <div
            v-for="ws in chatStore.workspaceList"
            :key="ws.uri"
            class="ws-menu-item"
            :class="{ active: !!selectedValue && sameUri(selectedValue, ws.uri) }"
            :title="ws.fsPath"
            @click="selectWorkspace(ws.uri)"
          >
            <i
              v-if="selectedValue && sameUri(selectedValue, ws.uri)"
              class="codicon codicon-check ws-item-check"
            ></i>
            <span class="ws-item-label">{{ ws.name }}</span>
          </div>
        </template>

        <template v-if="savedWorkspaces.length > 0">
          <div class="ws-menu-header">
            {{ t('components.tabs.workspaceSelector.savedWorkspaces') }}
          </div>
          <div
            v-for="ws in savedWorkspaces"
            :key="ws.uri"
            class="ws-menu-item"
            :class="{ active: !!selectedValue && sameUri(selectedValue, ws.uri) }"
            :title="ws.fsPath"
            @click="ws.isOpen ? selectWorkspace(ws.uri) : onOpenSaved(ws)"
          >
            <i
              v-if="selectedValue && sameUri(selectedValue, ws.uri)"
              class="codicon codicon-check ws-item-check"
            ></i>
            <span class="ws-item-label">{{ ws.name }}</span>
            <span v-if="ws.isOpen" class="ws-item-open-tag">
              {{ t('components.tabs.workspaceSelector.openTag') }}
            </span>
            <button
              class="ws-item-remove"
              :title="t('components.tabs.workspaceSelector.removeWorkspace')"
              @click="onRemoveSaved(ws.fsPath, $event)"
            >
              <i class="codicon codicon-close"></i>
            </button>
          </div>
        </template>

        <div v-if="savedWorkspaces.length === 0" class="ws-menu-empty">
          {{ t('components.tabs.workspaceSelector.noSavedWorkspaces') }}
        </div>

        <div class="ws-menu-divider"></div>

        <div
          v-if="selectedWorkspace && !boundWorkspaceClosed"
          class="ws-menu-item ws-menu-action"
          :class="{ 'ws-menu-disabled': isCurrentSaved }"
          :title="isCurrentSaved ? t('components.tabs.workspaceSelector.saveWorkspaceSaved') : t('components.tabs.workspaceSelector.saveWorkspaceHint')"
          @click="isCurrentSaved ? undefined : onSaveCurrentWorkspace()"
        >
          <i class="codicon codicon-save ws-item-plus"></i>
          <span class="ws-item-label">{{ t('components.tabs.workspaceSelector.saveWorkspace') }}</span>
        </div>

        <div class="ws-menu-item ws-menu-action" @click="onOpenWorkspaceFolder">
          <i class="codicon codicon-add ws-item-plus"></i>
          <span class="ws-item-label">{{ t('components.tabs.workspaceSelector.openWorkspaceFolder') }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ws-selector {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 190px;
  height: 100%;
  padding: 0 6px;
  color: var(--vscode-foreground);
  font-size: 11px;
  cursor: pointer;
  opacity: 0.7;
  outline: none;
  transition: opacity var(--transition-fast, 0.1s ease),
              background var(--transition-fast, 0.1s ease);
}

.ws-selector:hover,
.ws-selector.menu-open {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.1));
}

.ws-selector .codicon {
  font-size: 12px;
  flex-shrink: 0;
}

.ws-caret {
  font-size: 10px !important;
}

.ws-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}

/* ===== 下拉菜单（Teleport 到 body，避免被 .tabs-bar 的 overflow: hidden 裁剪） ===== */

.ws-menu {
  position: fixed;
  z-index: 2147482000;
  width: 260px;
  max-height: 420px;
  overflow-y: auto;
  padding: 4px 0;
  background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, #454545));
  border-radius: 4px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  font-size: 12px;
  color: var(--vscode-foreground);
}

.ws-menu-header {
  padding: 4px 10px 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  user-select: none;
}

.ws-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  cursor: pointer;
  min-width: 0;
}

.ws-menu-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.2));
}

.ws-menu-item.active {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
}

.ws-item-check {
  font-size: 11px;
  flex-shrink: 0;
}

.ws-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}

.ws-item-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  opacity: 0.7;
}

.ws-item-remove:hover {
  opacity: 1;
  background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.2));
  color: var(--vscode-errorForeground, #f14c4c);
}

.ws-item-remove .codicon {
  font-size: 11px;
}

.ws-item-open-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 14px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  background: rgba(127, 127, 127, 0.15);
  user-select: none;
}

/* 绑定但未打开的工作区条目：锁定图标 + 未打开标签，展示「对话锁定」状态 */
.ws-locked-item {
  cursor: default;
}

.ws-locked-item .ws-item-check {
  color: var(--vscode-textLink-foreground, #3794ff);
}

.ws-locked-tag {
  color: var(--vscode-editorWarning-foreground, #cca700);
  background: rgba(204, 167, 0, 0.12);
}

.ws-item-plus {
  font-size: 12px;
  flex-shrink: 0;
}

.ws-menu-action {
  color: var(--vscode-textLink-foreground, #3794ff);
}

.ws-menu-disabled {
  opacity: 0.55;
  cursor: default;
}

.ws-menu-disabled:hover {
  background: transparent;
}

.ws-menu-empty {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  user-select: none;
}

.ws-menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-dropdown-border, var(--vscode-widget-border, #454545));
}

.ws-dropdown-enter-active,
.ws-dropdown-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.ws-dropdown-enter-from,
.ws-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
