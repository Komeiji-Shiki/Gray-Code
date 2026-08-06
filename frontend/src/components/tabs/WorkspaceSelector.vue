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

/** 当前选中值：空字符串 = auto（跟随活动编辑器） */
const selectedValue = computed<string>(() => {
  const current = chatStore.currentWorkspaceUri
  if (current && chatStore.workspaceList.some(ws => ws.uri === current)) {
    return current
  }
  return ''
})

/** 当前固定选中的工作区 */
const selectedWorkspace = computed(() => {
  const current = chatStore.currentWorkspaceUri
  if (!current) return null
  return chatStore.workspaceList.find(ws => ws.uri === current) ?? null
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

/** 收藏中且未在当前窗口打开的工作区（避免与上方「已打开」列表重复展示） */
const savedWorkspaces = computed(() => {
  const openUris = new Set(chatStore.workspaceList.map(ws => ws.uri))
  return chatStore.savedWorkspaces.filter(ws => !openUris.has(ws.uri))
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

        <template v-if="chatStore.workspaceList.length > 0">
          <div class="ws-menu-header">
            {{ t('components.tabs.workspaceSelector.openWorkspaces') }}
          </div>
          <div
            v-for="ws in chatStore.workspaceList"
            :key="ws.uri"
            class="ws-menu-item"
            :class="{ active: selectedValue === ws.uri }"
            :title="ws.fsPath"
            @click="selectWorkspace(ws.uri)"
          >
            <i
              v-if="selectedValue === ws.uri"
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
            :title="ws.fsPath"
            @click="onOpenSaved(ws)"
          >
            <span class="ws-item-label">{{ ws.name }}</span>
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
          v-if="selectedWorkspace"
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
