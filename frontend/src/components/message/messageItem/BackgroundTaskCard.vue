<script setup lang="ts">
/**
 * BackgroundTaskCard - 后台任务/代理回流消息紧凑卡片（从 MessageItem.vue 抽出，F-07）。
 * 三段式视图模式读写模块级 Map（按 messageId 持久化），组件实例重建后恢复。
 */
import { computed } from 'vue'
import { useI18n } from '../../../i18n'
import {
  type BackgroundTaskViewMode,
  backgroundTaskViewModeByMessageId,
  BACKGROUND_TASK_VIEW_MODE_CAP
} from '../messageViewModes'

const { t } = useI18n()

const props = defineProps<{
  messageId: string
  content: string
  isAgent: boolean
}>()

// 后台任务回流消息的三段式视图：折叠（默认） / 中展开（滚动查看） / 完全展开
// R3-#5: 读写模块级 Map（按 messageId 持久化），组件实例重建后恢复
const backgroundTaskViewMode = computed<BackgroundTaskViewMode>({
  get: () => backgroundTaskViewModeByMessageId.get(props.messageId) ?? 'collapsed',
  set: (mode: BackgroundTaskViewMode) => {
    // M1-1：容量上限兜底（Map 保持插入序，超限时淘汰最旧记录，不侵入渲染热路径）
    if (
      !backgroundTaskViewModeByMessageId.has(props.messageId) &&
      backgroundTaskViewModeByMessageId.size >= BACKGROUND_TASK_VIEW_MODE_CAP
    ) {
      const oldestKey = backgroundTaskViewModeByMessageId.keys().next().value
      if (oldestKey !== undefined) {
        backgroundTaskViewModeByMessageId.delete(oldestKey)
      }
    }
    backgroundTaskViewModeByMessageId.set(props.messageId, mode)
  }
})
</script>

<template>
  <div class="background-task-card">
    <div class="bg-task-header">
      <i class="codicon codicon-hubot bg-task-icon"></i>
      <span class="bg-task-label">{{ isAgent ? t('components.message.roles.agent') : t('components.backgroundTasks.completed') }}</span>
      <!-- 三段式视图切换：折叠 / 中展开（滚动） / 完全展开 -->
      <div class="bg-task-view-controls">
        <button
          class="bg-task-view-btn"
          :class="{ active: backgroundTaskViewMode === 'collapsed' }"
          :title="t('components.backgroundTasks.viewCollapsed')"
          @click="backgroundTaskViewMode = 'collapsed'"
        >
          <i class="codicon codicon-chevron-up"></i>
        </button>
        <button
          class="bg-task-view-btn"
          :class="{ active: backgroundTaskViewMode === 'medium' }"
          :title="t('components.backgroundTasks.viewMedium')"
          @click="backgroundTaskViewMode = 'medium'"
        >
          <i class="codicon codicon-list-flat"></i>
        </button>
        <button
          class="bg-task-view-btn"
          :class="{ active: backgroundTaskViewMode === 'expanded' }"
          :title="t('components.backgroundTasks.viewExpanded')"
          @click="backgroundTaskViewMode = 'expanded'"
        >
          <i class="codicon codicon-chevron-down"></i>
        </button>
      </div>
    </div>
    <div
      class="bg-task-content"
      :class="`view-${backgroundTaskViewMode}`"
    >{{ content }}</div>
  </div>
</template>

<style scoped>
.background-task-card {
  border: 1px solid var(--vscode-panel-border);
  border-left: 3px solid var(--vscode-focusBorder);
  border-radius: 6px;
  padding: 8px 12px;
  margin: 4px 0;
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-focusBorder) 5%);
  font-size: 12px;
}

.bg-task-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.bg-task-icon {
  font-size: 14px;
  color: var(--vscode-focusBorder);
}

.bg-task-label {
  font-weight: 600;
  color: var(--vscode-foreground);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.5px;
}

.bg-task-content {
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  line-height: 1.4;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}

/* 三段式视图：折叠（两行省略） / 中展开（约 15 行滚动） / 完全展开 */
.bg-task-view-controls {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.bg-task-view-btn {
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

.bg-task-view-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.bg-task-view-btn.active {
  background: var(--vscode-toolbar-activeBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-foreground);
}

.bg-task-content.view-collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.bg-task-content.view-medium {
  max-height: 21em;  /* 行高 1.4em × 15 行 */
  overflow-y: auto;
}

.bg-task-content.view-expanded {
  max-height: none;
  overflow: visible;
}
</style>
