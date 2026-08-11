<script lang="ts">
/**
 * MessageList UI 状态（H5/M2-1）：模块级保存与清理逻辑已提升到 messageListUiState.ts，
 * 避免 store 层（tabActions.closeTab 清理接线）与组件层循环导入；此处仅保留对外再导出。
 */
export type { RestoreNoticeState, MessageListUiState } from './messageListUiState'
export {
  messageListUiStateByTab,
  MESSAGE_LIST_UI_STATE_CAP,
  pruneMessageListUiStateByTab
} from './messageListUiState'
</script>

<script setup lang="ts">
/**
 * MessageList - 消息列表容器
 * 扁平化设计，简洁加载动画
 *
 * S4 批次：todo 面板 / build 面板 / checkpoint 恢复确认流 / 虚拟窗口
 * 已拆分到 useTodoPanel / useBuildPanel / useCheckpointRestoreFlow / useVirtualMessageWindow；
 * 本文件仅保留编排与轻量直通逻辑（共享辅助 + 消息操作 + 忙时投递回显）。
 */

import { computed, watch } from 'vue'
import { CustomScrollbar, DeleteDialog, Tooltip, ConfirmDialog } from '../common'
import MessageItem from './MessageItem.vue'
import SummaryMessage from './SummaryMessage.vue'
import DirtyFilesConfirm from './DirtyFilesConfirm.vue'
import { useChatStore } from '../../stores'
import { useI18n } from '../../i18n'
import type { Message, Attachment } from '../../types'
import { isRetryableError, recentInterruptDeliveries, clearInterruptDeliveries } from '../../stores/chat/messageActions'
import { getAllMessageIndexBoundsCached } from '../../stores/chat/windowUtils'
import { useBuildPanel } from './useBuildPanel'
import { useTodoPanel } from './useTodoPanel'
import { useCheckpointRestoreFlow } from './useCheckpointRestoreFlow'
import { useVirtualMessageWindow } from './useVirtualMessageWindow'

const { t, actualLanguage } = useI18n()

const props = defineProps<{
  messages: Message[]
  /** 标签页 ID，标识此 MessageList 实例所属的标签页 */
  tabId: string
}>()

// 从 store 读取等待状态
const chatStore = useChatStore()

/** 共享辅助：todo/build 两侧共用的工具结果合并（以参数注入两个 composable，不搞全局） */
function getMergedToolResult(tool: any): Record<string, unknown> {
  const fromTool = tool?.result && typeof tool.result === 'object' ? tool.result as Record<string, unknown> : {}
  const fromResponseRaw = typeof tool?.id === 'string' && tool.id
    ? chatStore.getToolResponseById(tool.id)
    : undefined
  const fromResponse = fromResponseRaw && typeof fromResponseRaw === 'object'
    ? fromResponseRaw as Record<string, unknown>
    : {}

  return { ...fromTool, ...fromResponse }
}

/** 共享辅助：全量消息 backendIndex 边界（todo/build 锚点计算共用）。
 * 走 windowUtils.getAllMessageIndexBoundsCached（引用指纹 + 尾部增量模式），
 * 流式期间每个 chunk 的数组原地变更不再全量扫 800 条。 */
const allMessageIndexBounds = computed(() => {
  const bounds = getAllMessageIndexBoundsCached(chatStore.allMessages, chatStore.windowStartIndex)
  return {
    firstIndexed: bounds.firstIndexed,
    lastIndexed: bounds.lastIndexed,
    nextFallbackIndex: chatStore.windowStartIndex + chatStore.allMessages.length
  }
})

// ============ 面板 / 恢复流 / 虚拟窗口 composable 编排（S4） ============
const buildPanel = useBuildPanel({ chatStore, getMergedToolResult, allMessageIndexBounds })
const todoPanel = useTodoPanel({
  chatStore,
  t,
  props,
  actualLanguage,
  showBuildBar: buildPanel.showBuildBar,
  replayedBuildTodoState: buildPanel.replayedBuildTodoState,
  replayedBuildTodoList: buildPanel.replayedBuildTodoList,
  allMessageIndexBounds,
  getMergedToolResult
})
const checkpointFlow = useCheckpointRestoreFlow({ chatStore, t })
const virtualWindow = useVirtualMessageWindow({
  chatStore,
  props,
  checkpointsByMsgIndex: checkpointFlow.checkpointsByMsgIndex,
  showBuildBar: buildPanel.showBuildBar,
  showTodoBar: todoPanel.showTodoBar,
  buildAnchorBackendIndex: buildPanel.buildAnchorBackendIndex,
  todoAnchorBackendIndex: todoPanel.todoAnchorBackendIndex,
  isBuildExpanded: buildPanel.isBuildExpanded,
  isTodoExpanded: todoPanel.isTodoExpanded,
  restoreNotice: checkpointFlow.restoreNotice,
  restoreTodoExpandedState: todoPanel.restoreTodoExpandedState
})

// —— 供模板引用的解构（名称与拆分前一致，模板零改动）——
const {
  isBuildExpanded,
  buildPanelLabel,
  buildPanelName,
  buildTotal,
  buildCompleted,
  buildCurrentText,
  buildTodoItems
} = buildPanel
const {
  isTodoExpanded,
  toggleTodoExpanded,
  todoPanelName,
  todoTotal,
  todoCompleted,
  todoCurrentText,
  todoBarItems
} = todoPanel
const {
  showDeleteConfirm,
  deleteCount,
  deleteCheckpoints,
  confirmDelete,
  cancelDelete,
  handleDelete,
  handleRestoreAndDelete,
  showRestoreConfirm,
  restoreConfirmTitle,
  restoreConfirmMessage,
  confirmRestore,
  cancelRestoreConfirm,
  restoreDeletablePaths,
  restoreHasUntrackedPaths,
  restoreShownDeletablePaths,
  restoreHiddenDeletableCount,
  restoreUnbackedPaths,
  isRestorePreviewing,
  previewingCheckpointId,
  restoreNotice,
  showRestoreNotice,
  restoreNoticeIconClass,
  restoreNoticeTitle,
  restoreCheckpoint,
  handleRestoreCheckpoint,
  handleRestoreAndRetry,
  handleRestoreAndEdit,
  shouldMergeForTool,
  getCheckpointLabel,
  getMergedLabel,
  formatCheckpointTime
} = checkpointFlow
const {
  scrollbarRef,
  hasMore,
  loadMore,
  messageRenderRows
} = virtualWindow

const emit = defineEmits<{
  edit: [messageId: string, newContent: string, attachments: Attachment[], mode?: 'branch' | 'keep']
  delete: [messageId: string]
  retry: [messageId: string]
  copy: [content: string]
  restoreCheckpoint: [checkpointId: string]
  restoreAndRetry: [messageId: string, checkpointId: string]
  restoreAndEdit: [messageId: string, newContent: string, attachments: Attachment[], checkpointId: string]
}>()

// ============ U1 忙时投递（M3-1）轻量回显 ============
// 忙时发送的用户消息改走 chat.sendInterruptMessage（主会话 inbox），窗口内无痕迹；
// 这里读取 messageActions 记录的「最近投递 / 投递失败」状态，在消息区给出轻量提示。
const interruptNotices = computed(() => {
  const convId = chatStore.currentConversationId
  if (!convId) return []
  return recentInterruptDeliveries.value.filter(n => n.conversationId === convId)
})

// 当前回合结束（流式与等待均结束）时，清除本会话的投递提示——
// 提示文案承诺「将在当前回合结束后处理」，回合结束即失效。
watch(
  [() => chatStore.isStreaming, () => chatStore.isWaitingForResponse],
  ([streaming, waiting]) => {
    if (!streaming && !waiting) {
      const convId = chatStore.currentConversationId
      if (convId) clearInterruptDeliveries(convId)
    }
  }
)

// ============ 消息操作（emit / store 直通，无重逻辑） ============

// 处理编辑
function handleEdit(messageId: string, newContent: string, attachments: Attachment[], mode: 'branch' | 'keep' = 'branch') {
  emit('edit', messageId, newContent, attachments, mode)
}

// 处理重试 - 直接调用 store 方法（确认已在 MessageItem 的 RetryDialog 中完成）
function handleRetry(messageId: string) {
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
  if (actualIndex !== -1) chatStore.retryFromMessage(actualIndex)
}

// 从某条消息创建分支对话
async function handleBranch(messageId: string) {
  const msg = chatStore.allMessages.find(m => m.id === messageId)
  const backendIndex = msg?.backendIndex
  if (typeof backendIndex !== 'number' || !Number.isFinite(backendIndex)) {
    return
  }
  try {
    await chatStore.branchFromMessage(backendIndex)
  } catch (error) {
    console.error('[MessageList] Failed to create branch:', error)
    showRestoreNotice('error', error instanceof Error ? error.message : t('components.message.checkpoint.restoreResultFailed'))
  }
}

// 处理复制
function handleCopy(content: string) {
  emit('copy', content)
}

// 处理错误后重试
function handleErrorRetry() {
  chatStore.retryAfterError()
}

// 处理继续对话（工具执行后中断时）
function handleContinue() {
  chatStore.retryAfterError()
}
</script>

<template>
  <div class="message-list">
    <div class="message-scroll-area">
      <CustomScrollbar ref="scrollbarRef" sticky-bottom show-jump-buttons marker-selector=".user-message, .summary-message" :width="10" :marker-height="10">
      <div class="messages-container">
        <!-- 自动加载更多指示器：点击可手动触发加载（自动补载的兜底入口） -->
        <div v-if="hasMore" class="load-more-container" @click="loadMore()">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span v-if="chatStore.historyFolded" class="load-more-text">
            {{ t('components.message.historyFolded', { count: chatStore.foldedMessageCount }) }}
          </span>
        </div>

        <template v-for="row in messageRenderRows" :key="row.key">
          <div v-if="row.kind === 'build'" class="build-sticky-shell">
            <div class="build-bar" :class="{ expanded: isBuildExpanded }">
              <div class="build-header" @click="isBuildExpanded = !isBuildExpanded">
                <div class="build-title">
                  <i class="codicon codicon-tools build-icon"></i>
                  <span class="build-label">{{ buildPanelLabel }}</span>
                  <span class="build-sep">·</span>
                  <span class="build-name">{{ buildPanelName }}</span>
                </div>

                <div class="build-actions">
                  <span v-if="buildTotal > 0" class="build-progress">{{ buildCompleted }}/{{ buildTotal }}</span>
                  <span v-else class="build-progress">—</span>

                  <button
                    class="build-btn"
                    :title="isBuildExpanded ? t('common.collapse') : t('common.expand')"
                    @click.stop="isBuildExpanded = !isBuildExpanded"
                  >
                    <i class="codicon" :class="isBuildExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down'"></i>
                  </button>
                </div>
              </div>

              <div v-if="!isBuildExpanded && buildCurrentText" class="build-current">
                {{ buildCurrentText }}
              </div>

              <div v-if="isBuildExpanded" class="build-body">
                <div v-if="buildTodoItems.length === 0" class="build-empty">
                  <i class="codicon codicon-info"></i>
                  <span>{{ t('components.message.tool.todoPanel.empty') }}</span>
                </div>

                <div v-else class="build-todos">
                  <div
                    v-for="t in buildTodoItems"
                    :key="t.id"
                    class="build-todo"
                    :class="`status-${t.status}`"
                  >
                    <span class="todo-dot" :class="t.status"></span>
                    <span class="todo-text">{{ t.text }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <template v-else-if="row.kind === 'message'">
            <!-- 消息前的检查点（或合并显示） -->
            <template v-if="row.item.beforeCheckpoints.length > 0">
              <div
                v-for="cp in row.item.beforeCheckpoints"
                :key="cp.id"
                class="checkpoint-bar"
                :class="shouldMergeForTool(row.item.backendIndex, cp.toolName) ? 'checkpoint-merged' : 'checkpoint-before'"
              >
                <div class="checkpoint-icon">
                  <i class="codicon" :class="shouldMergeForTool(row.item.backendIndex, cp.toolName) ? 'codicon-check' : 'codicon-archive'"></i>
                </div>
                <div class="checkpoint-info">
                  <span class="checkpoint-label">
                    {{ shouldMergeForTool(row.item.backendIndex, cp.toolName) ? getMergedLabel(cp) : getCheckpointLabel(cp, 'before') }}
                  </span>
                  <span class="checkpoint-meta">{{ t('components.message.checkpoint.fileCount', { count: cp.fileCount }) }}</span>
                </div>
                <span class="checkpoint-time">{{ formatCheckpointTime(cp.timestamp) }}</span>
                <Tooltip :text="t('components.message.checkpoint.restoreTooltip')">
                  <button class="checkpoint-action" :disabled="isRestorePreviewing || showRestoreConfirm" @click="restoreCheckpoint(cp)">
                    <i v-if="isRestorePreviewing && previewingCheckpointId === cp.id" class="codicon codicon-loading codicon-modifier-spin"></i>
                    <i v-else class="codicon codicon-discard"></i>
                  </button>
                </Tooltip>
              </div>
            </template>
            
            <!-- 总结消息使用专用组件 -->
            <SummaryMessage
              v-if="row.item.message.isSummary"
              :message="row.item.message"
            :message-index="row.item.backendIndex"
            />
            
            <!-- 普通消息使用 MessageItem -->
            <MessageItem
              v-else
              :message="row.item.message"
            :message-index="row.item.backendIndex"
              @edit="handleEdit"
              @delete="handleDelete"
              @retry="handleRetry"
              @copy="handleCopy"
              @branch="handleBranch"
              @restore-checkpoint="handleRestoreCheckpoint"
              @restore-and-retry="handleRestoreAndRetry"
              @restore-and-edit="handleRestoreAndEdit"
            />

            <!-- 消息操作栏内已包含候选切换器（与复制 / 重试同一行） -->
            
            <!-- 消息后的检查点（仅当该工具的内容有变化时显示） -->
            <template v-if="row.item.afterCheckpoints.length > 0">
              <template v-for="cp in row.item.afterCheckpoints" :key="cp.id">
                <!-- 只有当该工具没有被合并时才显示 after 检查点 -->
                <div
                  v-if="!shouldMergeForTool(row.item.backendIndex, cp.toolName)"
                  class="checkpoint-bar checkpoint-after"
                >
                  <div class="checkpoint-icon">
                    <i class="codicon codicon-archive"></i>
                  </div>
                  <div class="checkpoint-info">
                    <span class="checkpoint-label">{{ getCheckpointLabel(cp, 'after') }}</span>
                    <span class="checkpoint-meta">{{ t('components.message.checkpoint.fileCount', { count: cp.fileCount }) }}</span>
                  </div>
                  <span class="checkpoint-time">{{ formatCheckpointTime(cp.timestamp) }}</span>
                  <Tooltip :text="t('components.message.checkpoint.restoreTooltip')">
                    <button class="checkpoint-action" :disabled="isRestorePreviewing || showRestoreConfirm" @click="restoreCheckpoint(cp)">
                      <i v-if="isRestorePreviewing && previewingCheckpointId === cp.id" class="codicon codicon-loading codicon-modifier-spin"></i>
                      <i v-else class="codicon codicon-discard"></i>
                    </button>
                  </Tooltip>
                </div>
              </template>
            </template>
          </template>

          <!-- 已总结区域 / 未总结区域分隔线（逻辑截断：原文保留，仅视觉分界）。
          滚动条黄色标记由每条 SummaryMessage 自身提供，使多次总结都能独立定位。 -->
          <div
            v-else-if="row.kind === 'summarize-divider'"
            class="summarize-divider"
            aria-hidden="true"
          >
            <div class="summarize-divider-line"></div>
          </div>

          <div v-else-if="row.kind === 'todo'" class="todo-sticky-shell">
            <div class="build-bar todo-snapshot-bar" :class="{ expanded: isTodoExpanded }">
              <div class="build-header" @click="toggleTodoExpanded()">
                <div class="build-title">
                  <i class="codicon codicon-checklist build-icon todo-snapshot-icon"></i>
                  <span class="build-label">{{ t('components.message.tool.todoWrite.label') }}</span>
                  <span class="build-sep">·</span>
                  <span class="build-name">{{ todoPanelName }}</span>
                </div>

                <div class="build-actions">
                  <span v-if="todoTotal > 0" class="build-progress">{{ todoCompleted }}/{{ todoTotal }}</span>
                  <span v-else class="build-progress">—</span>

                  <button
                    class="build-btn"
                    :title="isTodoExpanded ? t('common.collapse') : t('common.expand')"
                    @click.stop="toggleTodoExpanded()"
                  >
                    <i class="codicon" :class="isTodoExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down'"></i>
                  </button>
                </div>
              </div>

              <div v-if="!isTodoExpanded && todoCurrentText" class="build-current">
                {{ todoCurrentText }}
              </div>

              <div v-if="isTodoExpanded" class="build-body">
                <div v-if="todoBarItems.length === 0" class="build-empty">
                  <i class="codicon codicon-info"></i>
                  <span>{{ t('components.message.tool.todoPanel.empty') }}</span>
                </div>

                <div v-else class="build-todos">
                  <div v-for="t in todoBarItems" :key="t.id" class="build-todo" :class="`status-${t.status}`">
                    <span class="todo-dot" :class="t.status"></span>
                    <span class="todo-text">{{ t.text }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
        
        <!-- 继续对话提示 - 当最后一条是工具响应时显示 -->
        <div v-if="chatStore.needsContinueButton" class="continue-message">
          <div class="continue-icon">
            <i class="codicon codicon-debug-pause"></i>
          </div>
          <div class="continue-content">
            <div class="continue-title">{{ t('components.message.continue.title') }}</div>
            <div class="continue-text">{{ t('components.message.continue.description') }}</div>
          </div>
          <div class="continue-actions">
            <button class="continue-btn" @click="handleContinue">
              <span class="codicon codicon-play"></span>
              <span class="btn-text">{{ t('components.message.continue.button') }}</span>
            </button>
          </div>
        </div>
        
        <!-- 错误提示 - 显示在消息末尾 -->
        <div v-if="chatStore.error" class="error-message">
          <div class="error-header">
            <div class="error-icon">⚠</div>
            <div class="error-title">{{ t('components.message.error.title') }}</div>
            <div class="error-actions">
              <!-- H-3: 重试按钮仅在可重试错误码（STREAM_ERROR 等流式生成错误）时显示，
                   恢复/预览类错误（RESTORE_ERROR 等）走独立提示，不触发 LLM 重新生成 -->
              <button
                v-if="isRetryableError(chatStore.error)"
                class="error-retry"
                @click="handleErrorRetry"
                :title="t('components.message.error.retry')"
              >
                <span class="codicon codicon-refresh"></span>
              </button>
              <button class="error-dismiss" @click="chatStore.dismissError()" :title="t('components.message.error.dismiss')">
                ✕
              </button>
            </div>
          </div>
          <div class="error-body">
            <CustomScrollbar :max-height="120" :width="4">
              <pre class="error-text-code">{{ chatStore.error.code }}: {{ chatStore.error.message }}</pre>
            </CustomScrollbar>
          </div>
        </div>

        <!-- 恢复结果提示（H-3）：恢复类结果独立展示，不占用错误条，也不提供 LLM 重试 -->
        <div v-if="restoreNotice" class="restore-notice" :class="`restore-notice-${restoreNotice.kind}`">
          <div class="restore-notice-header">
            <div class="restore-notice-icon">
              <i class="codicon" :class="restoreNoticeIconClass"></i>
            </div>
            <div class="restore-notice-title">{{ restoreNoticeTitle }}</div>
            <div class="restore-notice-actions">
              <button class="restore-notice-dismiss" @click="restoreNotice = null" :title="t('components.message.error.dismiss')">
                ✕
              </button>
            </div>
          </div>
          <div class="restore-notice-body">
            <pre class="restore-notice-text">{{ restoreNotice.message }}</pre>
          </div>
        </div>

        <!-- U1 忙时投递（M3-1）轻量回显：已投递 / 投递失败，不占用错误条 -->
        <div v-if="interruptNotices.length > 0" class="interrupt-notices">
          <div
            v-for="notice in interruptNotices"
            :key="notice.createdAt"
            class="interrupt-notice"
            :class="`interrupt-notice-${notice.kind}`"
          >
            <i class="codicon" :class="notice.kind === 'delivered' ? 'codicon-check' : 'codicon-warning'"></i>
            <span class="interrupt-notice-text">
              {{
                notice.kind === 'delivered'
                  ? t('components.message.interrupt.delivered', { text: notice.text })
                  : t('components.message.interrupt.deliverFailed', { detail: notice.errorMessage || notice.errorCode || '' })
              }}
            </span>
          </div>
        </div>
      </div>
      </CustomScrollbar>
    </div>
    
    <!-- 删除确认对话框 -->
    <DeleteDialog
      v-model="showDeleteConfirm"
      :checkpoints="deleteCheckpoints"
      :delete-count="deleteCount"
      @delete="confirmDelete"
      @restore-and-delete="handleRestoreAndDelete"
      @cancel="cancelDelete"
    />

    <!-- BCP-05（决策 11）：恢复 / 切换恢复的未保存文件确认框（常驻挂载，不随分支切换器显隐） -->
    <DirtyFilesConfirm />
    
    <!-- 恢复检查点确认对话框（CP-09: 展示待删除文件清单，确认后才执行恢复） -->
    <ConfirmDialog
      v-model="showRestoreConfirm"
      :title="restoreConfirmTitle"
      :message="restoreConfirmMessage"
      :confirm-text="t('components.message.checkpoint.restoreConfirmBtn')"
      is-danger
      @confirm="confirmRestore"
      @cancel="cancelRestoreConfirm"
    >
      <div v-if="restoreDeletablePaths.length > 0" class="restore-delete-section">
        <div class="restore-delete-title">
          {{ t('components.message.checkpoint.restoreDeleteListTitle', { count: restoreDeletablePaths.length }) }}
        </div>
        <div v-if="restoreHasUntrackedPaths" class="restore-delete-untracked-note">
          {{ t('components.message.checkpoint.restoreDeleteUntrackedNote') }}
        </div>
        <div class="restore-delete-items">
          <div v-for="path in restoreShownDeletablePaths" :key="path" class="restore-delete-item">
            <i class="codicon codicon-close"></i>
            <span class="restore-delete-path">{{ path }}</span>
          </div>
          <div v-if="restoreHiddenDeletableCount > 0" class="restore-delete-more">
            {{ t('components.message.checkpoint.restoreDeleteListMore', { count: restoreHiddenDeletableCount }) }}
          </div>
        </div>
      </div>
      <div v-else class="restore-delete-empty">
        {{ t('components.message.checkpoint.restoreDeleteListEmpty') }}
      </div>
      <div v-if="restoreUnbackedPaths.length > 0" class="restore-unbacked-tip">
        {{ t('components.message.checkpoint.restoreUnbackedTip', { paths: restoreUnbackedPaths.slice(0, 5).join('、') }) }}
      </div>
    </ConfirmDialog>
    
  </div>
</template>

<style scoped>
.message-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.message-scroll-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ============ Build 顶部卡片（Cursor-like，保持 GrayCode 面板风格） ============ */
.build-sticky-shell {
  position: sticky;
  top: 0;
  z-index: 6;
  padding: 8px var(--spacing-md, 16px) 0;
  background: var(--vscode-editor-background);
}


.todo-sticky-shell {
  position: sticky;
  top: 0;
  z-index: 5;
  padding: 8px var(--spacing-md, 16px) 0;
  background: var(--vscode-editor-background);
}

.todo-snapshot-icon {
  color: var(--vscode-charts-blue, #3794ff);
}

.build-bar {
  margin: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
  background: var(--vscode-editor-background);
  flex-shrink: 0;
}

.build-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm, 8px);
  padding: 6px 10px;
  background: var(--vscode-editor-inactiveSelectionBackground);
  cursor: pointer;
  user-select: none;
}

.build-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.build-icon {
  font-size: 12px;
  color: var(--vscode-charts-orange, #e69500);
  flex-shrink: 0;
}

.build-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-foreground);
  flex-shrink: 0;
}

.build-sep {
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  flex-shrink: 0;
}

.build-name {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.build-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.build-progress {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
  min-width: 42px;
  text-align: right;
}

.build-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.build-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.build-current {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.build-body {
  max-height: min(40vh, 320px);
  padding: 8px 10px 10px;
  background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border);
  overflow: auto;
  overscroll-behavior: contain;
}

.build-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
  padding: 6px 2px;
}

.build-todos {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 6px;
}

.build-todo {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.todo-dot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 999px;
  background: var(--vscode-panel-border);
  flex-shrink: 0;
}

.todo-dot.pending {
  background: color-mix(in srgb, var(--vscode-foreground) 25%, transparent);
}

.todo-dot.in_progress {
  background: var(--vscode-charts-blue, #3794ff);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-charts-blue) 18%, transparent);
}

.todo-dot.completed {
  background: var(--vscode-testing-iconPassed);
}

.todo-dot.cancelled {
  background: var(--vscode-testing-iconFailed);
}

.build-todo.status-completed .todo-text {
  color: var(--vscode-descriptionForeground);
  text-decoration: line-through;
  opacity: 0.85;
}

.build-todo.status-cancelled .todo-text {
  color: var(--vscode-descriptionForeground);
  text-decoration: line-through;
  opacity: 0.6;
}

.todo-text {
  line-height: 1.35;
  word-break: break-word;
}

.messages-container {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* 加载更多指示器 */
.load-more-container {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  /* 点击可手动触发加载更多 */
  cursor: pointer;
}

.load-more-container .codicon {
  font-size: 16px;
}

.load-more-text {
  font-size: 11px;
  line-height: 1.3;
  max-width: 90%;
  text-align: center;
  white-space: normal;
}

/* 错误提示 - 扁平化设计，类似重试面板样式 */
.error-message {
  display: flex;
  flex-direction: column;
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  flex-shrink: 0;
  overflow: hidden;
}

.error-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.1);
  border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.2));
}

.error-icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--vscode-errorForeground, #f48771);
}

.error-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.error-body {
  padding: 12px;
}

.error-text-code {
  font-size: 11px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(0, 0, 0, 0.15);
  padding: 8px;
  border-radius: 4px;
  margin: 0;
}

.error-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.error-retry,
.error-dismiss {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  opacity: 0.6;
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  transition: opacity 0.2s, background 0.2s;
}

.error-retry:hover,
.error-dismiss:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.error-retry .codicon {
  font-size: 14px;
}

/* 恢复结果提示（H-3）：独立于错误条，按成功/部分成功/警告/失败分级着色 */
.restore-notice {
  display: flex;
  flex-direction: column;
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  flex-shrink: 0;
  overflow: hidden;
}

.restore-notice-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.1);
  border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.2));
}

.restore-notice-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.restore-notice-error .restore-notice-icon {
  color: var(--vscode-errorForeground, #f48771);
}

.restore-notice-partial .restore-notice-icon {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.restore-notice-warning .restore-notice-icon {
  color: var(--vscode-descriptionForeground);
}

.restore-notice-success .restore-notice-icon {
  color: var(--vscode-testing-iconPassed, #89d185);
}

.restore-notice-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.restore-notice-body {
  padding: 12px;
}

.restore-notice-text {
  font-size: 11px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(0, 0, 0, 0.15);
  padding: 8px;
  border-radius: 4px;
  margin: 0;
}

.restore-notice-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.restore-notice-dismiss {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  opacity: 0.6;
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  transition: opacity 0.2s, background 0.2s;
}

.restore-notice-dismiss:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

/* U1 忙时投递（M3-1）轻量回显：细条提示，随消息区滚动，不占错误条 */
.interrupt-notices {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  flex-shrink: 0;
}

.interrupt-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 4px;
}

.interrupt-notice .codicon {
  flex-shrink: 0;
  font-size: 13px;
}

.interrupt-notice-delivered .codicon {
  color: var(--vscode-testing-iconPassed, #89d185);
}

.interrupt-notice-error .codicon {
  color: var(--vscode-errorForeground, #f48771);
}

.interrupt-notice-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 继续对话提示 */
.continue-message {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-md, 16px);
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 2px;
  flex-shrink: 0;
}

.continue-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--vscode-descriptionForeground);
}

.continue-icon .codicon {
  font-size: 16px;
}

.continue-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.continue-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.continue-text {
  font-size: 11px;
  line-height: 1.4;
  color: var(--vscode-descriptionForeground);
}

.continue-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.continue-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--vscode-toolbar-activeBackground, rgba(127, 127, 127, 0.2));
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.continue-btn:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.3));
}

.continue-btn .codicon {
  font-size: 12px;
}

.btn-text {
  font-weight: 500;
}

/* 检查点条 */
.checkpoint-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 0;
  background: var(--vscode-editor-background);
  border-left: 2px solid var(--vscode-charts-yellow, #ddb92f);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* 已总结区域 / 未总结区域分隔线（逻辑截断：原文保留，仅视觉分界） */
.summarize-divider {
  display: flex;
  align-items: center;
  padding: 6px 16px;
}

.summarize-divider-line {
  flex: 1;
  height: 1px;
  background: var(--vscode-editor-lineHighlightBorder, rgba(128, 128, 128, 0.35));
}

.checkpoint-bar.checkpoint-before {
  border-left-color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-bar.checkpoint-after {
  border-left-color: var(--vscode-charts-green, #89d185);
}

.checkpoint-bar.checkpoint-merged {
  border-left-color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.checkpoint-before .checkpoint-icon {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-after .checkpoint-icon {
  color: var(--vscode-charts-green, #89d185);
}

.checkpoint-merged .checkpoint-icon {
  color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-icon .codicon {
  font-size: 14px;
}

.checkpoint-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.checkpoint-label {
  font-weight: 500;
}

.checkpoint-before .checkpoint-label {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-after .checkpoint-label {
  color: var(--vscode-charts-green, #89d185);
}

.checkpoint-merged .checkpoint-label {
  color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-meta {
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
}

.checkpoint-time {
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  font-size: 11px;
  flex-shrink: 0;
  margin-left: auto;
}

.checkpoint-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 4px;
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}

.checkpoint-action:hover {
  opacity: 1;
  background: var(--vscode-list-hoverBackground);
}

.checkpoint-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: transparent;
}

.checkpoint-action .codicon {
  font-size: 14px;
}

/* ============ 恢复确认：待删除文件清单（CP-09） ============ */
.restore-delete-section {
  margin-top: 10px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  border-radius: 4px;
}

.restore-delete-title {
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-errorForeground);
  background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  position: sticky;
  top: 0;
}

.restore-delete-untracked-note {
  padding: 5px 10px;
  font-size: 12px;
  color: var(--vscode-editorWarning-foreground);
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
}

.restore-delete-items {
  padding: 4px 0;
}

.restore-delete-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.restore-delete-item .codicon {
  font-size: 12px;
  color: var(--vscode-errorForeground);
  flex-shrink: 0;
}

.restore-delete-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.restore-delete-more {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.restore-delete-empty {
  margin-top: 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.restore-unbacked-tip {
  margin-top: 10px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  border: 1px dashed var(--vscode-panel-border);
  border-radius: 4px;
}
</style>
