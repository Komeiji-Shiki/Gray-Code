<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentLoopState, AgentTraceEvent, AgentTraceEventStatus, PromptContextPreview } from '../../types'
import PromptContextPreviewDialog from './PromptContextPreviewDialog.vue'

const props = defineProps<{
  trace: AgentTraceEvent[]
  promptContextPreview?: PromptContextPreview
}>()

const expanded = ref(false)
const showPromptPreview = ref(false)

const latestEvent = computed(() => props.trace[props.trace.length - 1])
const visibleEvents = computed(() => expanded.value ? props.trace : props.trace.slice(-6))
const hiddenCount = computed(() => Math.max(0, props.trace.length - visibleEvents.value.length))
const latestPreview = computed(() => props.promptContextPreview || [...props.trace].reverse().find(event => event.promptContextPreview)?.promptContextPreview)

const stateLabels: Record<AgentLoopState, string> = {
  prepare_context: '准备上下文',
  context_trim: '裁剪上下文',
  summarizing: '自动总结',
  request_model: '请求模型',
  streaming: '接收响应',
  parse_tool_calls: '解析工具',
  waiting_confirmation: '等待确认',
  executing_tools: '执行工具',
  append_tool_results: '写入结果',
  completed: '完成',
  aborted: '已中止',
  failed: '失败'
}

const statusLabels: Record<AgentTraceEventStatus, string> = {
  started: '开始',
  completed: '完成',
  info: '信息',
  failed: '失败'
}

function stateLabel(state?: AgentLoopState): string {
  return state ? stateLabels[state] || state : '未知状态'
}

function statusLabel(status: AgentTraceEventStatus): string {
  return statusLabels[status] || status
}

function formatEventTime(timestamp: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function eventIcon(event: AgentTraceEvent): string {
  if (event.status === 'failed' || event.state === 'failed') return 'codicon-error'
  if (event.state === 'waiting_confirmation') return 'codicon-question'
  if (event.state === 'executing_tools') return 'codicon-tools'
  if (event.state === 'request_model' || event.state === 'streaming') return 'codicon-radio-tower'
  if (event.state === 'context_trim' || event.state === 'prepare_context') return 'codicon-list-tree'
  if (event.state === 'completed' || event.status === 'completed') return 'codicon-check'
  return 'codicon-circle-large-outline'
}
</script>

<template>
  <section class="agent-trace-panel">
    <button class="trace-summary" type="button" @click="expanded = !expanded">
      <span class="summary-left">
        <span class="status-dot" :class="`status-dot--${latestEvent?.status || 'info'}`"></span>
        <span class="summary-title">Agent 运行轨迹</span>
        <span v-if="latestEvent" class="summary-state">{{ stateLabel(latestEvent.state) }}</span>
      </span>
      <span class="summary-right">
        <span class="event-count">{{ trace.length }} events</span>
        <i class="codicon" :class="expanded ? 'codicon-chevron-up' : 'codicon-chevron-down'"></i>
      </span>
    </button>

    <div class="trace-body">
      <div v-if="latestPreview" class="prompt-preview-row">
        <button class="prompt-preview-button" type="button" @click="showPromptPreview = true">
          <i class="codicon codicon-eye"></i>
          查看 Prompt Context 预览
          <span class="preview-meta">
            #{{ latestPreview.iteration }} · {{ latestPreview.sections.length }} sections · ≈
            {{ latestPreview.sections.reduce((sum, section) => sum + section.estimatedTokens, 0).toLocaleString() }} tokens
          </span>
        </button>
      </div>

      <div v-if="hiddenCount > 0" class="hidden-events">
        已折叠较早的 {{ hiddenCount }} 个事件，展开后可查看全部。
      </div>

      <ol class="trace-list">
        <li
          v-for="event in visibleEvents"
          :key="event.id"
          class="trace-event"
          :class="[`trace-event--${event.status}`, `trace-event--${event.state}`]"
        >
          <span class="event-icon">
            <i class="codicon" :class="eventIcon(event)"></i>
          </span>
          <div class="event-content">
            <div class="event-main">
              <span class="event-label">{{ event.label }}</span>
              <span class="event-status">{{ statusLabel(event.status) }}</span>
            </div>
            <div class="event-meta">
              <span>{{ formatEventTime(event.createdAt) }}</span>
              <span>{{ stateLabel(event.state) }}</span>
              <span v-if="event.iteration">iter #{{ event.iteration }}</span>
              <span v-if="event.tool?.name">tool: {{ event.tool.name }}</span>
              <span v-if="formatDuration(event.durationMs)">{{ formatDuration(event.durationMs) }}</span>
            </div>
            <p v-if="event.detail" class="event-detail">{{ event.detail }}</p>
          </div>
        </li>
      </ol>
    </div>

    <PromptContextPreviewDialog
      v-model="showPromptPreview"
      :preview="latestPreview"
    />
  </section>
</template>

<style scoped>
.agent-trace-panel {
  margin-top: 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.trace-summary {
  width: 100%;
  border: none;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, 0.08));
}

.trace-summary:hover {
  background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
}

.summary-left,
.summary-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.summary-title {
  font-size: 12px;
  font-weight: 600;
}

.summary-state,
.event-count,
.preview-meta {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--vscode-charts-blue);
  flex-shrink: 0;
}

.status-dot--completed {
  background: var(--vscode-charts-green);
}

.status-dot--failed {
  background: var(--vscode-errorForeground);
}

.status-dot--started {
  background: var(--vscode-charts-yellow);
}

.trace-body {
  padding: 8px 10px 10px;
}

.prompt-preview-row {
  margin-bottom: 8px;
}

.prompt-preview-button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--vscode-foreground);
  background: var(--vscode-button-secondaryBackground, transparent);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}

.prompt-preview-button:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.preview-meta {
  margin-left: auto;
}

.hidden-events {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.trace-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.trace-event {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 7px;
  align-items: flex-start;
}

.event-icon {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, 0.08));
}

.event-icon .codicon {
  font-size: 12px;
}

.trace-event--completed .event-icon {
  color: var(--vscode-charts-green);
}

.trace-event--failed .event-icon {
  color: var(--vscode-errorForeground);
}

.trace-event--started .event-icon {
  color: var(--vscode-charts-yellow);
}

.event-content {
  min-width: 0;
}

.event-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.event-label {
  font-size: 12px;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-status {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  padding: 1px 5px;
}

.event-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.event-detail {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
