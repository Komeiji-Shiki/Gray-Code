<script setup lang="ts">
/**
 * SettingsSidebar - 设置面板左侧页签栏（可折叠）
 *
 * 从 SettingsPanel.vue 模板拆分（T12 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：页签列表/选中态/折叠态/搜索高亮全部由父组件通过 props 注入，
 *   自身不持有任何响应式状态；选择与折叠切换通过 emits 回传父组件。
 */
import { t } from '@/i18n'
import type { SettingsTab } from '@/stores/settingsStore'
import type { TabItem } from './types'

defineProps<{
  tabs: TabItem[]
  activeTab: SettingsTab
  collapsed: boolean
  searchActive: boolean
  tabsWithMatches: Set<SettingsTab>
}>()

defineEmits<{
  (e: 'select', tabId: SettingsTab): void
  (e: 'update:collapsed', value: boolean): void
}>()
</script>

<template>
  <!-- 左侧页签（可折叠：展开显示图标+文字，折叠仅图标+tooltip；汉堡按钮在顶部） -->
  <div class="settings-sidebar" :class="{ collapsed }">
    <button
      class="settings-tab settings-sidebar-toggle"
      :data-tooltip="collapsed ? t('components.settings.settingsPanel.sidebarExpand') : t('components.settings.settingsPanel.sidebarCollapse')"
      @click="$emit('update:collapsed', !collapsed)"
    >
      <i class="codicon codicon-menu"></i>
    </button>
    <button
      v-for="tab in tabs"
      :key="tab.id"
      :class="['settings-tab', {
        active: activeTab === tab.id,
        'has-match': searchActive && tabsWithMatches.has(tab.id),
        dimmed: searchActive && !tabsWithMatches.has(tab.id)
      }]"
      :data-tooltip="tab.label"
      @click="$emit('select', tab.id)"
    >
      <i :class="['codicon', tab.icon]"></i>
      <span v-if="!collapsed" class="settings-tab-label">{{ tab.label }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 左侧页签（可折叠：默认展开显示图标+文字，折叠仅图标） */
.settings-sidebar {
  width: 132px;
  border-right: 1px solid var(--vscode-panel-border);
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  transition: width 0.2s ease;
}

.settings-sidebar.collapsed {
  width: 48px;
}

/* 顶部汉堡按钮：与页签同款；margin 在展开/收起时保持一致，避免切换时列表整体跳动 */
.settings-sidebar-toggle {
  margin-bottom: 2px;
}

.settings-tab {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--vscode-foreground);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.settings-tab:hover {
  background: var(--vscode-list-hoverBackground);
}

.settings-tab-label {
  flex: 1;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 自定义 tooltip 显示在右侧 */
.settings-tab::after {
  content: attr(data-tooltip);
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-left: 8px;
  padding: 4px 8px;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 4px;
  font-size: 12px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s, visibility 0.15s;
  pointer-events: none;
  z-index: 1000;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.settings-sidebar.collapsed .settings-tab:hover::after {
  opacity: 1;
  visibility: visible;
}

/* 汉堡按钮在展开/收起状态下都显示 tooltip */
.settings-sidebar-toggle:hover::after {
  opacity: 1;
  visibility: visible;
}

.settings-tab.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.settings-tab .codicon {
  font-size: 18px;
}

/* 搜索生效时侧边栏：命中页签高亮，未命中置灰 */
.settings-tab.has-match {
  color: var(--vscode-textLink-foreground, #3794ff);
}

.settings-tab.has-match.active {
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
}

.settings-tab.dimmed {
  opacity: 0.35;
}
</style>
