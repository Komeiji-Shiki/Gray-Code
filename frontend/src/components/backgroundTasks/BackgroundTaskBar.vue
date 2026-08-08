<script setup lang="ts">
/**
 * BackgroundTaskBar - 后台任务状态条
 *
 * 显示运行中/已完成的后台任务（SubAgent 与后台命令）：
 * - 点击 subagent 任务打开 Monitor 聚焦对应 run（思维链/输出/工具调用细节）
 * - 点击 terminal 任务展开命令输出面板（terminalStore 实时数据）
 * - 运行中任务可取消；已结束任务可清除
 */

import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { sendToExtension } from '../../utils/vscode'
import { useI18n } from '../../i18n'
import { ConfirmDialog } from '../common'
import type { BackgroundTaskRecord } from '../../stores/backgroundTasks/reportBuilder'

const { t } = useI18n()
const store = useBackgroundTaskStore()
const terminalStore = useTerminalStore()

/** 展开的终端输出面板 */
const expandedTerminalId = ref<string | null>(null)

/** 一键清除确认框（存在未回流任务时弹出） */
const showClearConfirm = ref(false)

/** 每秒刷新一次，驱动运行中任务的耗时显示 */
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined

// 修改原因：now 只被运行中任务的耗时显示消费，但旧实现让 1 秒 ticker 在组件整个生命周期内无条件运行，
//          没有任何后台任务时也会每秒触发一次响应式更新与重渲染，且持续整个 VS Code 会话。
// 修改方式：按 runningCount 启停 ticker，只有存在运行中任务时才计时。
// 修改目的：空闲状态下不产生任何周期性开销。
function startTicker() {
  if (ticker) return
  now.value = Date.now()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
}

function stopTicker() {
  if (!ticker) return
  clearInterval(ticker)
  ticker = undefined
}

watch(() => store.runningCount, count => {
  if (count > 0) startTicker()
  else stopTicker()
}, { immediate: true })

let stopStoreListeners: (() => void) | undefined

onMounted(() => {
  stopStoreListeners = store.initialize()
})

onUnmounted(() => {
  stopTicker()
  stopStoreListeners?.()
  stopStoreListeners = undefined
})

const visibleTasks = computed(() => store.taskList)

/** 可一键清除的任务数：已结束（非运行中） */
const dismissibleCount = computed(() =>
  visibleTasks.value.filter(t => t.status !== 'running').length
)

/** 已结束但回执尚未汇报给模型的任务数（清除会丢弃回执，需要确认） */
const unreportedCount = computed(() =>
  visibleTasks.value.filter(t => t.status !== 'running' && !t.reported).length
)

function handleClearCompleted(): void {
  if (unreportedCount.value > 0) {
    showClearConfirm.value = true
    return
  }
  store.dismissCompletedTasks()
}

const expandedTerminal = computed(() =>
  expandedTerminalId.value ? terminalStore.getTerminal(expandedTerminalId.value) : undefined
)

function statusIcon(task: BackgroundTaskRecord): string {
  switch (task.status) {
    case 'running': return 'codicon-loading codicon-modifier-spin'
    case 'completed': return 'codicon-check'
    case 'cancelled': return 'codicon-circle-slash'
    default: return 'codicon-error'
  }
}

function kindIcon(task: BackgroundTaskRecord): string {
  return task.kind === 'subagent' ? 'codicon-hubot' : 'codicon-terminal'
}

function formatDuration(task: BackgroundTaskRecord): string {
  const end = task.finishedAt ?? now.value
  const seconds = Math.max(0, Math.floor((end - task.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${seconds % 60}s`
}

function statusTitle(task: BackgroundTaskRecord): string {
  switch (task.status) {
    case 'running': return t('components.backgroundTasks.running')
    case 'completed': return t('components.backgroundTasks.completed')
    case 'cancelled': return t('components.backgroundTasks.cancelled')
    default: return t('components.backgroundTasks.failed')
  }
}

async function openDetails(task: BackgroundTaskRecord): Promise<void> {
  if (task.kind === 'subagent' && task.runId) {
    try {
      await sendToExtension('subagents.openMonitor', {
        runId: task.runId,
        conversationId: task.conversationId
      })
    } catch (error) {
      console.error('Failed to open SubAgent Monitor:', error)
    }
    return
  }
  if (task.kind === 'terminal' && task.terminalId) {
    expandedTerminalId.value = expandedTerminalId.value === task.terminalId ? null : task.terminalId
  }
}
</script>

<template>
  <div v-if="visibleTasks.length > 0" class="background-task-bar">
    <div class="task-chips">
      <div
        v-for="task in visibleTasks"
        :key="task.taskId"
        class="task-chip"
        :class="[`status-${task.status}`, { unreported: !task.reported && task.status !== 'running' }]"
        :title="statusTitle(task) + (!task.reported && task.status !== 'running' ? ` · ${t('components.backgroundTasks.pendingReport')}` : '')"
        @click="openDetails(task)"
      >
        <i class="codicon" :class="kindIcon(task)"></i>
        <i class="codicon status-icon" :class="statusIcon(task)"></i>
        <span class="task-label">{{ task.label }}</span>
        <span class="task-duration">{{ formatDuration(task) }}</span>
        <button
          v-if="task.status === 'running'"
          class="chip-btn"
          :title="t('components.backgroundTasks.cancel')"
          @click.stop="store.cancelTask(task.taskId)"
        >
          <i class="codicon codicon-stop-circle"></i>
        </button>
        <button
          v-else
          class="chip-btn"
          :title="t('components.backgroundTasks.dismiss')"
          @click.stop="store.dismissTask(task.taskId)"
        >
          <i class="codicon codicon-close"></i>
        </button>
      </div>

      <!-- 一键清除所有已完成（已结束）的任务 chip；未回流任务弹出确认框 -->
      <button
        v-if="dismissibleCount > 0"
        class="clear-completed-btn"
        :title="t('components.backgroundTasks.dismissAllCompletedTitle')"
        @click="handleClearCompleted"
      >
        <i class="codicon codicon-clear-all"></i>
        <span>{{ t('components.backgroundTasks.dismissAllCompleted') }} ({{ dismissibleCount }})</span>
      </button>
    </div>

    <!-- 未回流任务确认框：清除后回执不会进入对话历史，模型将收不到任务结果 -->
    <ConfirmDialog
      v-model="showClearConfirm"
      :title="t('components.backgroundTasks.dismissAllConfirmTitle')"
      :message="t('components.backgroundTasks.dismissAllConfirmMessage', { count: unreportedCount })"
      :confirm-text="t('components.backgroundTasks.dismissAllConfirmAction')"
      is-danger
      @confirm="store.dismissCompletedTasks()"
    />

    <!-- 终端输出展开面板 -->
    <div v-if="expandedTerminal" class="task-output-panel">
      <div class="output-header">
        <span class="output-title">{{ expandedTerminal.command || t('components.backgroundTasks.outputTitle') }}</span>
        <button class="chip-btn" @click="expandedTerminalId = null">
          <i class="codicon codicon-close"></i>
        </button>
      </div>
      <pre class="output-content">{{ expandedTerminal.output || t('components.backgroundTasks.noOutput') }}</pre>
    </div>
  </div>
</template>

<style scoped>
.background-task-bar {
  padding: 4px 8px 0;
}

.task-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.task-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  font-size: 11px;
  cursor: pointer;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  max-width: 100%;
}

.task-chip:hover {
  background: var(--vscode-list-hoverBackground);
}

.task-chip .codicon {
  font-size: 12px;
}

.status-icon {
  color: var(--vscode-descriptionForeground);
}

.task-chip.status-completed .status-icon {
  color: var(--vscode-testing-iconPassed);
}

.task-chip.status-error .status-icon {
  color: var(--vscode-testing-iconFailed);
}

.task-chip.status-cancelled .status-icon {
  color: var(--vscode-descriptionForeground);
}

.task-chip.unreported {
  border-color: var(--vscode-focusBorder);
}

.task-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.task-duration {
  color: var(--vscode-descriptionForeground);
  font-variant-numeric: tabular-nums;
}

.chip-btn {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
}

.chip-btn:hover {
  color: var(--vscode-foreground);
}

/* 一键清除已完成任务按钮：与 task-chip 同高，弱化视觉 */
.clear-completed-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px dashed var(--vscode-panel-border);
  border-radius: 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}

.clear-completed-btn:hover {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground);
}

.task-output-panel {
  margin-top: 4px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
  overflow: hidden;
}

.output-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.output-title {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.output-content {
  margin: 0;
  padding: 6px 8px;
  max-height: 180px;
  overflow: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
