<script setup lang="ts">
/**
 * ToolItem - 单张工具调用卡片（从 ToolMessage.vue 抽出，F-07）。
 *
 * 纯展示 + 本地动作执行；确认/拒绝、diff 孤儿检测、确认流绑定等状态与副作用
 * 全部保留在 ToolMessage.vue，通过 props/emits 交互，不改变既有语义。
 */
import type { Component, ComponentPublicInstance } from 'vue'
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
  return ['tool-action-btn', `tool-action-${variant}`]
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
    <!-- 工具头部 - 可点击展开/收起（如果可展开） -->
    <div
      :class="['tool-header', { 'not-expandable': !isExpandable }]"
      @click="isExpandable && emit('toggle')"
    >
      <div class="tool-info">
        <!-- 展开/收起图标（仅当可展开时显示） -->
        <span
          v-if="isExpandable"
          :class="[
            'expand-icon',
            'codicon',
            isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'
          ]"
        ></span>

        <!-- 工具图标 -->
        <span :class="['tool-icon', 'codicon', getToolIcon(tool)]"></span>

        <!-- 工具名称 -->
        <span class="tool-name">{{ getToolLabel(tool) }}</span>

        <!-- 状态图标 -->
        <div v-if="tool.status || tool.awaitingConfirmation" class="status-icon-wrapper">
          <span
            :class="[
              'status-icon',
              'codicon',
              getStatusIcon(tool.status, tool.awaitingConfirmation),
              getStatusClass(tool.status, tool.awaitingConfirmation)
            ]"
          ></span>
        </div>

        <!-- 执行时间 -->
        <span v-if="tool.duration" class="tool-duration">
          {{ tool.duration }}ms
        </span>
      </div>

      <!-- 工具描述和操作按钮 -->
      <div class="tool-description-row">
        <div class="tool-description">
          {{ getToolDescription(tool) }}
        </div>

        <div class="tool-action-buttons">
          <!-- 确认按钮：当工具等待用户批准时显示 -->
          <button
            v-if="tool.status === 'awaiting_approval' && !isProcessing"
            class="confirm-btn"
            :title="t('components.message.tool.confirmExecution')"
            :disabled="isProcessing"
            @click.stop="emit('confirm')"
          >
            <span class="confirm-btn-icon codicon codicon-check"></span>
            <span class="confirm-btn-text">{{ t('components.message.tool.confirm') }}</span>
          </button>

          <!-- 拒绝按钮：当工具等待用户批准时显示 -->
          <button
            v-if="tool.status === 'awaiting_approval' && !isProcessing"
            class="reject-btn"
            :title="t('components.message.tool.reject')"
            :disabled="isProcessing"
            @click.stop="emit('reject')"
          >
            <span class="reject-btn-icon codicon codicon-close"></span>
            <span class="reject-btn-text">{{ t('components.message.tool.reject') }}</span>
          </button>

          <!-- 通用工具操作按钮：diff 预览、SubAgent 详情等都走 ToolConfig.actions -->
          <button
            v-for="action in getVisibleToolActions(tool)"
            :key="action.id"
            :class="getToolActionClass(action)"
            :title="getToolActionTitle(action, tool)"
            @click.stop="runToolAction(action, tool)"
          >
            <span
              v-if="action.icon"
              :class="['tool-action-icon', 'codicon', action.icon]"
            ></span>
            <span class="tool-action-text">{{ getToolActionLabel(action, tool) }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 流式参数预览 - streaming 状态时自动显示 -->
    <div
      v-if="showStreamingPreview"
      class="streaming-preview"
      :ref="registerStreamingPreviewRef"
    >
      <pre class="streaming-preview-content">{{ streamingPreviewText }}</pre>
    </div>

    <!-- 工具详细内容 - 展开时显示（仅当可展开时） -->
    <div v-if="showContent" class="tool-content">
      <component :is="contentHost" :tool="tool" />
    </div>

    <!-- Diff 警戒值警告（pending 或已结束都可展示） -->
    <div v-if="diffGuardWarning" class="diff-guard-warning">
      <i class="codicon codicon-warning"></i>
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
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
}

.tool-header {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs, 4px);
  padding: 4px var(--spacing-sm, 8px);
  cursor: pointer;
  transition: background-color var(--transition-fast, 0.1s);
}

.tool-header:hover {
  background: var(--vscode-list-hoverBackground);
}

.tool-header.not-expandable {
  cursor: default;
}

.tool-header.not-expandable:hover {
  background: transparent;
}

.tool-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
}

.expand-icon {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  transition: transform var(--transition-fast, 0.1s);
}

.tool-icon {
  font-size: 14px;
  color: var(--vscode-charts-blue);
}

.tool-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
}

.status-icon {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin-left: var(--spacing-xs, 4px);
}

.status-icon.status-background {
  color: var(--vscode-charts-purple, var(--vscode-descriptionForeground));
}

.status-icon.status-success {
  color: var(--vscode-testing-iconPassed);
}

.status-icon.status-error {
  color: var(--vscode-testing-iconFailed);
}

.status-icon.status-running {
  color: var(--vscode-testing-runAction);
  animation: spin 1s linear infinite;
}

.status-icon.status-warning {
  color: var(--vscode-charts-yellow);
}

.status-icon.status-pending {
  color: var(--vscode-inputValidation-warningForeground);
}

.status-icon-wrapper {
  display: flex;
  align-items: center;
  margin-left: var(--spacing-xs, 4px);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tool-duration {
  margin-left: auto;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.tool-description-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-sm, 8px);
  margin-left: 28px; /* 对齐图标 */
}

.tool-action-buttons {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  flex-shrink: 0;
}

.tool-description {
  flex: 1;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.4;
  font-family: var(--vscode-editor-font-family);
}

/* 确认按钮 - 极简无边框设计 */
.confirm-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  background: transparent;
  border: none;
  border-radius: 2px;
  color: var(--vscode-foreground);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s ease;
  flex-shrink: 0;
}

.confirm-btn:hover {
  background: rgba(128, 128, 128, 0.15);
}

.confirm-btn:active {
  background: rgba(128, 128, 128, 0.2);
}

.confirm-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.confirm-btn-icon {
  font-size: 12px;
}

.confirm-btn-text {
  white-space: nowrap;
}

/* 拒绝按钮 - 无边框设计 */
.reject-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  background: transparent;
  border: none;
  border-radius: 2px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s ease;
  flex-shrink: 0;
}

.reject-btn:hover {
  background: rgba(128, 128, 128, 0.1);
  color: var(--vscode-foreground);
}

.reject-btn:active {
  background: rgba(128, 128, 128, 0.15);
}

.reject-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.reject-btn-icon {
  font-size: 12px;
}

.reject-btn-text {
  white-space: nowrap;
}

.tool-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  background: transparent;
  border: 1px solid #555555;
  border-radius: 2px;
  color: var(--vscode-foreground);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s ease;
  flex-shrink: 0;
}

.tool-action-btn:hover {
  background: rgba(128, 128, 128, 0.1);
  border-color: #777777;
}

.tool-action-btn:active {
  background: rgba(128, 128, 128, 0.2);
}

.tool-action-primary {
  border-color: var(--vscode-button-background);
}

.tool-action-primary:hover {
  background: var(--vscode-button-hoverBackground);
  color: var(--vscode-button-foreground);
}

.tool-action-danger {
  border-color: var(--vscode-errorForeground);
  color: var(--vscode-errorForeground);
}

.tool-action-icon {
  font-size: 12px;
  opacity: 0.85;
}

.tool-action-text {
  white-space: nowrap;
}

/* 流式参数预览 */
.streaming-preview {
  max-height: 150px;
  overflow-y: auto;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-inactiveSelectionBackground);
  padding: 4px var(--spacing-sm, 8px);
}

.streaming-preview-content {
  margin: 0;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-foreground);
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.4;
  opacity: 0.85;
}

.tool-content {
  padding: 4px var(--spacing-sm, 8px);
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-inactiveSelectionBackground);
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
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  font-size: 11px;
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
  background: var(--vscode-inputValidation-warningBackground, rgba(255, 170, 0, 0.1));
  border: 1px solid var(--vscode-inputValidation-warningBorder, #ffaa00);
  border-radius: 4px;
  margin-bottom: 4px;
}

.diff-guard-warning .codicon {
  font-size: 13px;
  color: var(--vscode-editorWarning-foreground, #ffaa00);
  flex-shrink: 0;
  margin-top: 1px;
}

.diff-guard-text {
  font-size: 11px;
  line-height: 1.4;
  color: var(--vscode-foreground);
  word-break: break-word;
}
</style>
