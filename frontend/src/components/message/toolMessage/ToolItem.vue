<script setup lang="ts">
/**
 * ToolItem - 单张工具调用卡片（从 ToolMessage.vue 抽出，F-07）。
 *
 * 纯展示 + 本地动作执行；确认/拒绝、diff 孤儿检测、确认流绑定等状态与副作用
 * 全部保留在 ToolMessage.vue，通过 props/emits 交互，不改变既有语义。
 */
import { getCurrentInstance, type Component, type ComponentPublicInstance } from 'vue'
import type { ToolUsage } from '../../../types'
import { getToolConfig, type ToolActionConfig, type ToolActionContext } from '../../../utils/toolRegistry'
import { useChatStore } from '../../../stores'
import { showNotification } from '../../../utils/vscode'
import { useI18n } from '../../../i18n'
import DiffActionList from './DiffActionList.vue'
import type { PendingDiffView } from './types'

const { t } = useI18n()
const chatStore = useChatStore()

defineProps<{
  tool: ToolUsage
  isExpanded: boolean
  isExpandable: boolean
  showContent: boolean
  isProcessing: boolean
  showStreamingPreview: boolean
  streamingPreviewText: string
  pendingDiffs: PendingDiffView[]
  diffGuardWarning: { warning: string; deletePercent: number } | null
  contentHost: Component
  registerStreamingPreviewRef: (el: Element | ComponentPublicInstance | null) => void
}>()

const emit = defineEmits<{
  toggle: []
  confirm: []
  reject: []
}>()

const instanceId = getCurrentInstance()?.uid ?? 0
const contentId = `gc-tool-content-${instanceId}`
const streamingPreviewId = `gc-tool-streaming-${instanceId}`

function getToolStatusLabel(tool: ToolUsage): string {
  if (tool.awaitingConfirmation || tool.status === 'awaiting_approval') {
    return t('components.message.responseViewer.toolStatuses.awaitingApproval')
  }

  const statusKey: Record<string, string> = {
    streaming: 'streaming',
    queued: 'queued',
    executing: 'executing',
    awaiting_apply: 'awaitingApply',
    background: 'background',
    success: 'success',
    warning: 'warning',
    error: 'error'
  }
  const key = tool.status ? statusKey[tool.status] : undefined
  return key
    ? t(`components.message.responseViewer.toolStatuses.${key}`)
    : t('components.message.responseViewer.toolStatuses.unknown')
}

// 获取工具显示名称
function getToolLabel(tool: ToolUsage): string {
  const config = getToolConfig(tool.name)
  // 优先使用动态 labelFormatter
  if (config?.labelFormatter) {
    return config.labelFormatter(tool.args)
  }
  return config?.label || tool.name
}

// 获取工具图标
function getToolIcon(tool: ToolUsage): string {
  const config = getToolConfig(tool.name)
  return config?.icon || 'codicon-tools'
}

// 获取工具描述
function getToolDescription(tool: ToolUsage): string {
  const config = getToolConfig(tool.name)

  // 流式状态：如果 args 有数据（partialArgs 已成功解析），仍尝试用 formatter
  // 否则显示 "正在生成参数..."
  if (tool.status === 'streaming') {
    const hasArgs = tool.args && Object.keys(tool.args).length > 0
    if (hasArgs && config?.descriptionFormatter) {
      try {
        return config.descriptionFormatter(tool.args)
      } catch {
        // formatter 崩溃时降级显示，避免整个工具块渲染失败
      }
    }
    return t('components.message.tool.streamingArgs')
  }

  if (config?.descriptionFormatter) {
    try {
      return config.descriptionFormatter(tool.args)
    } catch {
      // formatter 崩溃时降级到默认描述
    }
  }
  // 默认描述：显示参数数量
  const argCount = Object.keys(tool.args || {}).length
  return t('components.message.tool.paramCount', { count: argCount })
}

// 获取状态图标
function getStatusIcon(status?: string, awaitingConfirmation?: boolean): string {
  // 向后兼容：awaitingConfirmation 逐步迁移到 status = awaiting_approval
  if (awaitingConfirmation || status === 'awaiting_approval') {
    return 'codicon-shield'
  }

  switch (status) {
    case 'streaming':
      return 'codicon-loading'
    case 'queued':
      return 'codicon-clock'
    case 'executing':
      return 'codicon-loading'
    case 'awaiting_apply':
      return 'codicon-diff'
    case 'background':
      return 'codicon-server-process'
    case 'success':
      return 'codicon-check'
    case 'warning':
      return 'codicon-warning'
    case 'error':
      return 'codicon-error'
    default:
      return ''
  }
}

// 获取状态类名
function getStatusClass(status?: string, awaitingConfirmation?: boolean): string {
  if (awaitingConfirmation || status === 'awaiting_approval') {
    return 'status-warning'
  }

  switch (status) {
    case 'background':
      return 'status-background'
    case 'success':
      return 'status-success'
    case 'error':
      return 'status-error'
    case 'warning':
      return 'status-warning'
    case 'executing':
    case 'streaming':
      return 'status-running'
    case 'queued':
    case 'awaiting_apply':
      return 'status-pending'
    default:
      return ''
  }
}

function getToolActionContext(): ToolActionContext {
  return {
    conversationId: chatStore.currentConversationId || null
  }
}

function getToolActionLabel(action: ToolActionConfig, tool: ToolUsage): string {
  const context = getToolActionContext()
  return typeof action.label === 'function' ? action.label(tool, context) : action.label
}

function getToolActionTitle(action: ToolActionConfig, tool: ToolUsage): string {
  const context = getToolActionContext()
  if (!action.title) return getToolActionLabel(action, tool)
  return typeof action.title === 'function' ? action.title(tool, context) : action.title
}

function getVisibleToolActions(tool: ToolUsage): ToolActionConfig[] {
  const config = getToolConfig(tool.name)
  const context = getToolActionContext()
  return (config?.actions || []).filter(action => {
    if (!action.visible) return true
    try {
      return action.visible(tool, context)
    } catch (error) {
      console.error(`[ToolMessage] Failed to evaluate action visibility for ${tool.name}:${action.id}`, error)
      return false
    }
  })
}

function getToolActionClass(action: ToolActionConfig): string[] {
  const variant = action.variant || 'default'
  return [
    'gc-button',
    variant === 'primary' ? 'gc-button--primary' : variant === 'danger' ? 'gc-button--danger' : 'gc-button--ghost',
    'tool-action-btn',
    `tool-action-${variant}`
  ]
}

function getActionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  const maybeMessage = (error as any)?.message
  return typeof maybeMessage === 'string' && maybeMessage.trim() ? maybeMessage : fallback
}

async function runToolAction(action: ToolActionConfig, tool: ToolUsage) {
  try {
    await action.run(tool, getToolActionContext())
  } catch (error) {
    const message = getActionErrorMessage(error, `Failed to run action: ${action.id}`)
    await showNotification(message, 'error')
    console.error(`[ToolMessage] Failed to run action ${action.id} for ${tool.name}`, error)
  }
}
</script>

<template>
  <div class="tool-item">
    <div class="tool-header">
      <component
        :is="isExpandable ? 'button' : 'div'"
        :type="isExpandable ? 'button' : undefined"
        :class="['tool-summary', { 'tool-summary-static': !isExpandable }]"
        :aria-expanded="isExpandable ? isExpanded : undefined"
        :aria-controls="isExpandable ? contentId : undefined"
        @click="isExpandable && emit('toggle')"
      >
        <div class="tool-info">
          <span
            v-if="isExpandable"
            :class="[
              'expand-icon',
              'codicon',
              isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'
            ]"
            aria-hidden="true"
          ></span>

          <span :class="['tool-icon', 'codicon', getToolIcon(tool)]" aria-hidden="true"></span>
          <span class="tool-name">{{ getToolLabel(tool) }}</span>

          <div
            v-if="tool.status || tool.awaitingConfirmation"
            class="status-icon-wrapper"
            role="status"
            :aria-label="getToolStatusLabel(tool)"
          >
            <span
              :class="[
                'status-icon',
                'codicon',
                getStatusIcon(tool.status, tool.awaitingConfirmation),
                getStatusClass(tool.status, tool.awaitingConfirmation)
              ]"
              aria-hidden="true"
            ></span>
          </div>

          <span v-if="tool.duration" class="tool-duration">
            {{ tool.duration }}ms
          </span>
        </div>

        <span class="tool-description">
          {{ getToolDescription(tool) }}
        </span>
      </component>

      <div class="tool-action-buttons">
        <button
          v-if="tool.status === 'awaiting_approval' && !isProcessing"
          type="button"
          class="gc-button gc-button--primary confirm-btn"
          :title="t('components.message.tool.confirmExecution')"
          :disabled="isProcessing"
          @click.stop="emit('confirm')"
        >
          <span class="confirm-btn-icon codicon codicon-check" aria-hidden="true"></span>
          <span class="confirm-btn-text">{{ t('components.message.tool.confirm') }}</span>
        </button>

        <button
          v-if="tool.status === 'awaiting_approval' && !isProcessing"
          type="button"
          class="gc-button gc-button--ghost reject-btn"
          :title="t('components.message.tool.reject')"
          :disabled="isProcessing"
          @click.stop="emit('reject')"
        >
          <span class="reject-btn-icon codicon codicon-close" aria-hidden="true"></span>
          <span class="reject-btn-text">{{ t('components.message.tool.reject') }}</span>
        </button>

        <button
          v-for="action in getVisibleToolActions(tool)"
          :key="action.id"
          type="button"
          :class="getToolActionClass(action)"
          :title="getToolActionTitle(action, tool)"
          @click.stop="runToolAction(action, tool)"
        >
          <span
            v-if="action.icon"
            :class="['tool-action-icon', 'codicon', action.icon]"
            aria-hidden="true"
          ></span>
          <span class="tool-action-text">{{ getToolActionLabel(action, tool) }}</span>
        </button>
      </div>
    </div>

    <!-- 流式参数预览 - streaming 状态时自动显示 -->
    <div
      v-if="showStreamingPreview"
      class="streaming-preview"
      :id="streamingPreviewId"
      :aria-label="t('components.message.tool.streamingArgs')"
      :ref="registerStreamingPreviewRef"
    >
      <pre class="streaming-preview-content">{{ streamingPreviewText }}</pre>
    </div>

    <!-- 工具详细内容 - 展开时显示（仅当可展开时） -->
    <div v-if="showContent" :id="contentId" class="tool-content">
      <component :is="contentHost" :tool="tool" />
    </div>

    <!-- Diff 警戒值警告（pending 或已结束都可展示） -->
    <div v-if="diffGuardWarning" class="diff-guard-warning" role="alert">
      <i class="codicon codicon-warning" aria-hidden="true"></i>
      <span class="diff-guard-text">
        {{ diffGuardWarning.warning }}
      </span>
    </div>

    <!-- Diff 工具确认操作栏（按独立 pending diff 渲染，不随展开面板隐藏） -->
    <DiffActionList v-if="pendingDiffs.length > 0" :pending-diffs="pendingDiffs" />
  </div>
</template>

<style scoped>
.tool-item {
  display: flex;
  flex-direction: column;
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
  overflow: hidden;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  padding: var(--gc-space-1) var(--gc-space-2);
  transition: background-color var(--gc-duration-fast) var(--gc-ease-standard);
}

.tool-header:hover {
  background: var(--gc-surface-hover);
}

.tool-summary {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-1);
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.tool-summary-static {
  cursor: default;
}

.tool-summary:focus-visible {
  outline: 1px solid var(--gc-focus-border);
  outline-offset: 2px;
}

.tool-info {
  display: flex;
  align-items: center;
  gap: var(--gc-space-1);
}

.expand-icon {
  font-size: var(--gc-font-size-body);
  color: var(--gc-text-muted);
  transition: transform var(--transition-fast, 0.1s);
}

.tool-icon {
  font-size: var(--gc-font-size-title);
  color: var(--gc-info);
}

.tool-name {
  font-size: var(--gc-font-size-body);
  font-weight: var(--gc-font-weight-semibold);
  color: var(--gc-text-primary);
  font-family: var(--vscode-font-family);
}

.status-icon {
  font-size: var(--gc-font-size-body);
  color: var(--gc-text-muted);
  margin-left: var(--spacing-xs, 4px);
}

.status-icon.status-background {
  color: var(--vscode-charts-purple, var(--vscode-descriptionForeground));
}

.status-icon.status-success {
  color: var(--gc-success);
}

.status-icon.status-error {
  color: var(--gc-danger);
}

.status-icon.status-running {
  color: var(--gc-info);
  animation: gc-spin 1s linear infinite;
}

.status-icon.status-warning {
  color: var(--gc-warning);
}

.status-icon.status-pending {
  color: var(--gc-warning);
}

.status-icon-wrapper {
  display: flex;
  align-items: center;
  margin-left: var(--spacing-xs, 4px);
}

.tool-duration {
  margin-left: auto;
  font-size: var(--gc-font-size-caption);
  color: var(--gc-text-muted);
}

.tool-action-buttons {
  display: flex;
  align-items: center;
  gap: var(--gc-space-1);
  flex-shrink: 0;
}

.tool-description {
  margin-left: 28px;
  overflow: hidden;
  color: var(--gc-text-muted);
  font-family: var(--vscode-editor-font-family);
  font-size: var(--gc-font-size-caption);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Tool actions share the global button primitive; local rules only preserve compact density. */
.confirm-btn,
.reject-btn,
.tool-action-btn {
  min-height: var(--gc-control-height-sm);
  padding: 0 var(--gc-space-3);
  font-size: var(--gc-font-size-caption);
  white-space: nowrap;
}

.confirm-btn-icon,
.reject-btn-icon,
.tool-action-icon {
  font-size: var(--gc-font-size-body);
}

.tool-action-danger {
  color: var(--gc-danger);
}

.tool-action-text,
.confirm-btn-text,
.reject-btn-text {
  white-space: nowrap;
}

/* 流式参数预览 */
.streaming-preview {
  max-height: 150px;
  overflow-y: auto;
  border-top: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-muted);
  padding: 4px var(--spacing-sm, 8px);
}

.streaming-preview-content {
  margin: 0;
  font-size: var(--gc-font-size-caption);
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-foreground);
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.4;
  opacity: 0.85;
}

.tool-content {
  padding: 4px var(--spacing-sm, 8px);
  border-top: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-muted);
}

/* 默认内容样式 */
.tool-content-default {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

.content-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs, 4px);
}

.section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.section-data {
  padding: var(--spacing-xs, 4px);
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-xs);
  font-size: var(--gc-font-size-caption);
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-foreground);
  white-space: pre;
  overflow-x: auto;
  margin: 0;
}

.error-section {
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: var(--radius-sm, 2px);
}

.error-message {
  font-size: 12px;
  color: var(--vscode-inputValidation-errorForeground);
  font-family: var(--vscode-editor-font-family);
}

.tool-content-text {
  font-size: 12px;
  color: var(--vscode-foreground);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Diff 警戒值警告 */
.diff-guard-warning {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 10px;
  background: var(--vscode-inputValidation-warningBackground, color-mix(in srgb, var(--gc-warning) 10%, transparent));
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--gc-warning));
  border-radius: var(--gc-radius-sm);
  margin-bottom: 4px;
}

.diff-guard-warning .codicon {
  font-size: 13px;
  color: var(--gc-warning);
  flex-shrink: 0;
  margin-top: 1px;
}

.diff-guard-text {
  font-size: var(--gc-font-size-caption);
  line-height: 1.4;
  color: var(--vscode-foreground);
  word-break: break-word;
}

@media (max-width: 520px) {
  .tool-header {
    align-items: stretch;
    flex-direction: column;
  }

  .tool-action-buttons {
    margin-left: 28px;
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-icon.status-running {
    animation: none;
  }
}
</style>
