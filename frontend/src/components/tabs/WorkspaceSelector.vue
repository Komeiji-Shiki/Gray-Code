<script setup lang="ts">
/**
 * WorkspaceSelector - 工作区选择器（多工作区支持）
 *
 * 顶部栏常驻操作区中的紧凑下拉：
 *  - 默认跟随活动编辑器（auto）
 *  - 可选固定到某个打开的工作区文件夹
 *  - 无工作区打开时禁用并显示「未打开工作区」
 */

import { computed } from 'vue'
import { useI18n } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'

const { t } = useI18n()
const chatStore = useChatStore()

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

function handleChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  void chatStore.setActiveWorkspace(value || null)
}
</script>

<template>
  <span
    class="ws-selector"
    :class="{ disabled: isEmpty }"
    :title="displayTooltip"
  >
    <i class="codicon codicon-folder"></i>
    <span class="ws-label">{{ displayLabel }}</span>
    <i class="codicon codicon-chevron-down ws-caret"></i>
    <select
      class="ws-select"
      :value="selectedValue"
      :disabled="isEmpty"
      @change="handleChange"
    >
      <option value="">{{ t('components.tabs.workspaceSelector.auto') }}</option>
      <option
        v-for="ws in chatStore.workspaceList"
        :key="ws.uri"
        :value="ws.uri"
        :title="ws.fsPath"
      >
        {{ ws.name }}
      </option>
    </select>
  </span>
</template>

<style scoped>
.ws-selector {
  position: relative;
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
  transition: opacity var(--transition-fast, 0.1s ease),
              background var(--transition-fast, 0.1s ease);
}

.ws-selector:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.1));
}

.ws-selector.disabled {
  opacity: 0.5;
  cursor: default;
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

/* 透明的原生 select 覆盖整个触发按钮，保持原生下拉行为 */
.ws-select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.ws-selector.disabled .ws-select {
  cursor: default;
}
</style>
